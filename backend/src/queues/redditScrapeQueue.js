/**
 * BullMQ queue for Reddit cookie-scrape jobs.
 *
 * Sibling of `instagramLookupQueue.js`. The Reddit feature lives under
 * the Telegram panel UI but has its own queue so a long-running
 * Telegram scrape doesn't starve cookie-scrape latency, and so
 * concurrency can be tuned independently (Reddit's login endpoint is
 * the rate-limited bottleneck).
 */

'use strict';

const { Queue, Worker, QueueEvents } = require('bullmq');
const logger = require('../utils/logger');

const QUEUE_NAME = 'reddit:scrape';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382'),
  password: process.env.REDIS_PASSWORD || undefined,
};

class RedditScrapeQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
    this.executeJobFn = null;
  }

  setJobExecutor(fn) {
    this.executeJobFn = fn;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1, // we don't retry login attempts — too risky
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400 },
      },
    });

    const concurrency = parseInt(process.env.REDDIT_SCRAPE_CONCURRENCY || '2');
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data;
        if (!this.executeJobFn) {
          throw new Error('Reddit scrape executor not registered');
        }
        return this.executeJobFn(jobId);
      },
      { connection: redisConnection, concurrency }
    );

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`Reddit scrape job ${job.id} completed`, { jobId: job.id });
      if (global.io && job.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('reddit:completed', {
          jobId: job.id, accountId: job.data?.accountId, result: job.returnvalue,
        });
      }
    });
    this.worker.on('failed', (job, err) => {
      logger.error(`Reddit scrape job ${job?.id} failed: ${err.message}`);
      if (global.io && job?.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('reddit:failed', {
          jobId: job.id, accountId: job.data?.accountId, error: err.message,
        });
      }
    });
    this.worker.on('progress', (job, progress) => {
      if (global.io && job?.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('reddit:progress', {
          jobId: job.id, accountId: job.data?.accountId, progress,
        });
      }
    });

    this.initialized = true;
    logger.info(`Reddit scrape queue initialized (concurrency=${concurrency})`);
  }

  async addJob(jobData) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add('scrape', jobData);
    return job;
  }

  async close() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    this.initialized = false;
  }
}

module.exports = new RedditScrapeQueueManager();
