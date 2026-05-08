const { Queue, Worker, QueueEvents } = require('bullmq');
const groupService = require('../services/groupService');
const logger = require('../utils/logger');

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

    this.worker = new Worker(
      GROUP_QUEUE_NAME,
      async (job) => {
        const { type, sessionId, targetGroupId, userList, options, userId, groupId, settings, rules, title, members, userIdTarget, opId, sessionIds, targetIds } = job.data;

        if (type === 'add-members') {
          return await groupService.addMembersToGroup(sessionId, targetGroupId, userList, options, userId);
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
          // Bulk join/leave: sessions are processed in parallel (with a
          // concurrency cap) inside the service, against every target.
          // The opId / sessionIds / targetIds are pre-validated by the
          // controller so the worker just runs the loop.
          const operation = type === 'join-channels' ? 'join_channels' : 'leave_channels';
          return await groupService.runJoinLeaveJob({ opId, operation, userId, sessionIds, targetIds });
        }
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

    this.worker.on('failed', (job, err) => {
      logger.error(`Group job ${job.id} failed: ${err.message}`, { jobId: job.id });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('group:failed', {
          jobId: job.id,
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
