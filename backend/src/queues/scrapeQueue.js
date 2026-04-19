const { Queue, Worker, QueueEvents } = require('bullmq');
const logger = require('../utils/logger');

const SCRAPE_QUEUE_NAME = 'scrape-jobs';

// BullMQ requires ioredis-style connection config, not node-redis client
const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || undefined,
};

class ScrapeQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
    this.executeJobFn = null; // Set by scrapeService to avoid circular dependency
  }

  /**
   * Set the job execution function.
   * Called by scrapeService after initialization to break circular dependency.
   */
  setJobExecutor(fn) {
    this.executeJobFn = fn;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(SCRAPE_QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    });

    this.worker = new Worker(
      SCRAPE_QUEUE_NAME,
      async (job) => {
        const { jobId } = job.data;
        
        if (!this.executeJobFn) {
          throw new Error('Job executor not set. Call setJobExecutor() first.');
        }
        
        // Execute the scrape job using the new multi-session architecture
        return await this.executeJobFn(jobId);
      },
      { connection: redisConnection, concurrency: 5 }
    );

    this.queueEvents = new QueueEvents(SCRAPE_QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`Scrape job ${job.id} completed`, { jobId: job.id });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('scrape:completed', {
          jobId: job.id,
          result: job.returnvalue,
        });
      }
    });

    this.worker.on('failed', (job, err) => {
      logger.error(`Scrape job ${job.id} failed: ${err.message}`, { 
        jobId: job.id,
        stack: err.stack,
        cause: err.cause?.message,
      });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('scrape:failed', {
          jobId: job.id,
          error: err.message,
        });
      }
    });

    this.worker.on('progress', (job, progress) => {
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('scrape:progress', {
          jobId: job.id,
          progress,
        });
      }
    });

    this.initialized = true;
    logger.info('Scrape queue initialized');
  }

  async addJob(jobData) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add('scrape', jobData);
    logger.info(`Scrape job added to queue`, { jobId: job.id });
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

module.exports = new ScrapeQueueManager();
