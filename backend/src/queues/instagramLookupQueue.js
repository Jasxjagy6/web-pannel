/**
 * BullMQ queue for Instagram identity-lookup jobs.
 *
 * Mirrors `instagramScrapeQueue.js` — same shape so the wiring in
 * `queues/index.js` looks identical. The lookup workload runs on its
 * own queue (separate from `scrape:instagram`) so an operator who has
 * a long-running scrape job doesn't block lookup throughput, and so
 * concurrency can be tuned independently (IG's reset-flow endpoint is
 * the most aggressively rate-limited surface in their bot model).
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const logger = require('../utils/logger');

const QUEUE_NAME = 'lookup:instagram';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382'),
  password: process.env.REDIS_PASSWORD || undefined,
};

class InstagramLookupQueueManager {
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
        attempts: 2,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400 },
      },
    });

    const concurrency = parseInt(process.env.IG_LOOKUP_CONCURRENCY || '2');
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data;
        if (!this.executeJobFn) {
          throw new Error('IG lookup executor not registered');
        }
        return this.executeJobFn(jobId);
      },
      { connection: redisConnection, concurrency }
    );

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`IG lookup job ${job.id} completed`, { jobId: job.id });
      if (global.io && job.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('lookup:completed', {
          jobId: job.id, platform: 'instagram', result: job.returnvalue,
        });
      }
    });
    this.worker.on('failed', (job, err) => {
      logger.error(`IG lookup job ${job?.id} failed: ${err.message}`);
      if (global.io && job?.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('lookup:failed', {
          jobId: job.id, platform: 'instagram', error: err.message,
        });
      }
    });

    this.initialized = true;
    logger.info(`IG lookup queue initialized (concurrency=${concurrency})`);
  }

  async addJob(jobData) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add('lookup', jobData);
    return job;
  }

  async close() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    this.initialized = false;
  }
}

module.exports = new InstagramLookupQueueManager();
