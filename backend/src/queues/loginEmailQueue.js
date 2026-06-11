const { Queue, Worker, QueueEvents } = require('bullmq');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const loginEmailWorker = require('../workers/loginEmailWorker');

const QUEUE_NAME = 'login-email-jobs';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382'),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

class LoginEmailQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    });

    this.worker = new Worker(
      QUEUE_NAME,
      async (job) => {
        return await loginEmailWorker.processJob(job.data.jobId);
      },
      { connection: redisConnection, concurrency: 2 }
    );

    this.queueEvents = new QueueEvents(QUEUE_NAME, { connection: redisConnection });

    this.worker.on('completed', (job) => {
      logger.info(`Login Email job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      logger.error(`Login Email job ${job.id} failed: ${err.message}`);
    });

    this.initialized = true;
    logger.info('Login Email queue initialized');
  }

  async add(name, data, opts) {
    if (!this.initialized) await this.initialize();
    return this.queue.add(name, data, opts);
  }

  async close() {
    if (this.worker) await this.worker.close();
    if (this.queueEvents) await this.queueEvents.close();
    if (this.queue) await this.queue.close();
    this.initialized = false;
  }
}

module.exports = new LoginEmailQueueManager();
