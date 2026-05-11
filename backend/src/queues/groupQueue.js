const { Queue, Worker, QueueEvents, UnrecoverableError } = require('bullmq');
const groupService = require('../services/groupService');
const logger = require('../utils/logger');
const { withJobLock, QUEUED_BEHIND_LOCK } = require('../utils/jobLock');
const { pool } = require('../config/database');

const GROUP_QUEUE_NAME = 'group-jobs';

// BullMQ talks to Redis via its own internal ioredis client. It does NOT
// accept a node-redis (v4) instance. Passing the shared `redisClient`
// here used to look like it worked at boot — `new Queue(...)` doesn't
// touch Redis — but every later `queue.add(...)` would silently hang
// because the client doesn't expose the ioredis surface BullMQ uses
// (Lua scripts via `defineCommand`, the `xadd`/`xread` semantics, etc.).
// We pass plain options so BullMQ creates its own ioredis connection,
// matching `scrapeQueue.js` / `instagramScrapeQueue.js`.
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

class GroupQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(GROUP_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    });

    // Errors caused by user input or pre-flight validation should NOT
    // be retried — re-running an audience filter on the same UUID-only
    // list will throw the same way three times in a row, polluting the
    // logs and (more importantly) leaving the op row stuck on
    // `queued`/`running` for the entire backoff window. We map those
    // codes to BullMQ's `UnrecoverableError` so the job moves to
    // `failed` immediately on the first attempt.
    const NON_RETRYABLE_ERROR_CODES = new Set([
      'NO_VALID_USERS',
      'NO_ELIGIBLE_USERS',
      'NO_VALID_SESSIONS',
      'EMPTY_USER_LIST',
      'NO_TARGETS',
      'MISSING_USER_ID',
      'SESSION_NOT_FOUND',
    ]);

    this.worker = new Worker(
      GROUP_QUEUE_NAME,
      async (job) => {
        const { type, sessionId, targetGroupId, userList, options, userId, groupId, settings, rules, title, members, userIdTarget, opId, sessionIds, targetIds, params } = job.data;

        // Job-types that drive heavy multi-session Telegram traffic must
        // run strictly one-at-a-time per (user, category). The lock is a
        // Redis SET-NX-EX with a long TTL; if it's held the job is
        // re-queued as a delayed job and a sentinel is returned so the
        // worker exits cleanly (BullMQ keeps the job alive).
        // Lighter inspection-style jobs (list-groups, get-info, etc.) skip
        // the lock so the operator can inspect groups even while a long
        // add-members run is in flight.
        const heavyCategory = (() => {
          if (type === 'add-members' || type === 'add-members-bulk') return 'group:add-members';
          if (type === 'join-channels') return 'group:join';
          if (type === 'leave-channels') return 'group:leave';
          return null;
        })();

        const run = async () => {
          if (type === 'add-members') {
            return await groupService.addMembersToGroup(sessionId, targetGroupId, userList, options, userId);
          } else if (type === 'add-members-bulk') {
            // Async UI path: groupController.addMembers handed us a
            // pre-created opId + the full add-members params. We run the
            // multi-session/multi-target add via addMembersToGroups so
            // progress, cancel, and error reporting stay in the existing
            // group_operations row.
            return await groupService.addMembersToGroups(
              { ...(params || {}), opId },
              userId
            );
          } else if (type === 'configure-spam') {
            return await groupService.configureGroupSpam(sessionId, groupId, settings, userId);
          } else if (type === 'auto-manage') {
            return await groupService.autoManageGroup(groupId, rules, userId);
          } else if (type === 'list-groups') {
            return await groupService.listGroups(sessionId, userId);
          } else if (type === 'get-info') {
            return await groupService.getGroupInfo(sessionId, groupId, userId);
          } else if (type === 'create-group') {
            return await groupService.createGroup(sessionId, title, members, userId);
          } else if (type === 'remove-member') {
            return await groupService.removeMember(sessionId, groupId, userIdTarget, userId);
          } else if (type === 'join-channels' || type === 'leave-channels') {
            const operation = type === 'join-channels' ? 'join_channels' : 'leave_channels';
            return await groupService.runJoinLeaveJob({ opId, operation, userId, sessionIds, targetIds });
          }
        };

        // Wrap the actual job runner so we can intercept user-input
        // errors and convert them into UnrecoverableError. Without this
        // BullMQ retries 3× and the op row stays in a non-terminal
        // state for the entire backoff window.
        const runWithErrorMapping = async () => {
          try {
            return await run();
          } catch (err) {
            const code = err && err.code;
            if (code && NON_RETRYABLE_ERROR_CODES.has(code)) {
              throw new UnrecoverableError(`${code}: ${err.message}`);
            }
            throw err;
          }
        };

        if (!heavyCategory) return runWithErrorMapping();

        const result = await withJobLock(
          job,
          { userId: String(userId), category: heavyCategory },
          runWithErrorMapping
        );
        if (result === QUEUED_BEHIND_LOCK) {
          // BullMQ has already moved this job to the delayed set; signal
          // success on this attempt so the worker doesn't spin.
          return { queuedBehindLock: true, lockCategory: heavyCategory };
        }
        return result;
      },
      { connection: redisConnection, concurrency: 5 }
    );

    this.queueEvents = new QueueEvents(GROUP_QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`Group job ${job.id} completed`, { jobId: job.id });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('group:completed', {
          jobId: job.id,
          result: job.returnvalue,
        });
      }
    });

    this.worker.on('failed', async (job, err) => {
      logger.error(`Group job ${job.id} failed: ${err.message}`, { jobId: job.id });

      // Backstop: if the job was an add-members-bulk run with a
      // pre-created op row and we somehow exited without finalising
      // (e.g. the runner threw before the existing in-service
      // try/catch ran), flip the row to `failed` here so the
      // Operation History panel doesn't show a stale spinner.
      try {
        const data = job?.data || {};
        const opId = data.opId;
        if (opId && (data.type === 'add-members-bulk' || data.type === 'join-channels' || data.type === 'leave-channels')) {
          const trimmed = (err && err.message ? String(err.message) : 'job failed').slice(0, 500);
          await pool.query(
            `UPDATE group_operations
                SET status       = CASE
                    WHEN status IN ('completed', 'cancelled', 'failed') THEN status
                    ELSE 'failed'
                  END,
                  options      = COALESCE(options, '{}'::jsonb) || $2::jsonb,
                  completed_at = COALESCE(completed_at, NOW())
              WHERE id = $1`,
            [opId, JSON.stringify({ error: trimmed, error_status: 'failed' })]
          );
        }
      } catch (uErr) {
        logger.warn(`group worker: failed to mark op as failed for job ${job?.id}: ${uErr.message}`);
      }

      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('group:failed', {
          jobId: job.id,
          opId: job?.data?.opId,
          error: err.message,
        });
      }
    });

    this.worker.on('progress', (job, progress) => {
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('group:progress', {
          jobId: job.id,
          progress,
        });
      }
    });

    this.initialized = true;
    logger.info('Group queue initialized');
  }

  async addJob(jobData) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add('group', jobData);
    logger.info(`Group job added to queue`, { jobId: job.id });
    return job;
  }

  async getJobs() {
    if (!this.initialized) await this.initialize();
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaiting(),
      this.queue.getActive(),
      this.queue.getCompleted(),
      this.queue.getFailed(),
    ]);
    return { waiting, active, completed, failed };
  }

  async getJob(jobId) {
    if (!this.initialized) await this.initialize();
    return this.queue.getJob(jobId);
  }

  async cancelJob(jobId) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.getJob(jobId);
    if (job) {
      await job.moveToFailed(new Error('Cancelled by user'), this.worker);
      return true;
    }
    return false;
  }

  async close() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    this.initialized = false;
  }

  getQueue() {
    return this.queue;
  }
}

module.exports = new GroupQueueManager();
