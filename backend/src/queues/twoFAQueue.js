/**
 * BullMQ queue for change-2FA jobs (Upgrade 2).
 *
 * Each enqueued message carries { jobId, userId } and triggers the worker
 * which delegates execution to twoFAJobService.runJob(). Concurrency is
 * intentionally low — one bulk job at a time per worker — because every
 * single 2FA operation must hit Telegram's API per session sequentially
 * to avoid flood-wait penalties.
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const logger = require('../utils/logger');

const QUEUE_NAME = 'change-2fa-jobs';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

class TwoFAQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    const twoFAJobService = require('../services/twoFAJobService');

    this.queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // we already retry per-item; queue retries would re-run the whole job
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400 },
      },
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data;
        return await twoFAJobService.runJob(jobId);
      },
      { connection: redisConnection, concurrency: 2 }
    );

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

    this.worker.on('failed', (job, err) => {
      logger.error(`2FA job ${job?.id} failed: ${err.message}`);
    });

    this.initialized = true;
    logger.info('Change-2FA queue initialized');
  }

  async addJob(data) {
    if (!this.initialized) await this.initialize();
    return this.queue.add('change-2fa', data);
  }

  async close() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    this.initialized = false;
  }
}

module.exports = new TwoFAQueueManager();
