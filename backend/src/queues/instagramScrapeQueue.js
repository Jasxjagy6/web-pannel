/**
 * BullMQ queue for Instagram scrape jobs.
 *
 * Independent from the Telegram scrape queue (`scrape-jobs`) so the
 * worker pool can be tuned per platform — IG has different rate-limit
 * profiles than TG and benefits from its own concurrency knobs.
 *
 * Same shape as scrapeQueue.js: setJobExecutor(), initialize(), addJob().
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const logger = require('../utils/logger');

const QUEUE_NAME = 'scrape:instagram';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

class InstagramScrapeQueueManager {
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
        attempts: 3,
        backoff: { type: 'exponential', delay: 10000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    });

    const concurrency = parseInt(process.env.IG_SCRAPE_CONCURRENCY || '3');
    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data;
        if (!this.executeJobFn) {
          throw new Error('IG scrape executor not registered');
        }
        return this.executeJobFn(jobId);
      },
      { connection: redisConnection, concurrency }
    );

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`IG scrape job ${job.id} completed`, { jobId: job.id });
      if (global.io && job.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('scrape:completed', {
          jobId: job.id, platform: 'instagram', result: job.returnvalue,
        });
      }
    });
    this.worker.on('failed', (job, err) => {
      logger.error(`IG scrape job ${job?.id} failed: ${err.message}`);
      if (global.io && job?.data?.userId) {
        global.io.to(`user:${job.data.userId}`).emit('scrape:failed', {
          jobId: job.id, platform: 'instagram', error: err.message,
        });
      }
    });

    this.initialized = true;
    logger.info(`IG scrape queue initialized (concurrency=${concurrency})`);
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

module.exports = new InstagramScrapeQueueManager();
