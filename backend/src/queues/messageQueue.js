const { Queue, Worker, QueueEvents } = require('bullmq');
const { redisClient } = require('../config/redis');
const messageService = require('../services/messageService');
const logger = require('../utils/logger');

const MESSAGE_QUEUE_NAME = 'message-jobs';

class MessageQueueManager {
  constructor() {
    this.queue = null;
    this.worker = null;
    this.queueEvents = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(MESSAGE_QUEUE_NAME, {
      connection: redisClient,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 3600, count: 100 },
        removeOnFail: { age: 86400 },
      },
    });

    this.worker = new Worker(
      MESSAGE_QUEUE_NAME,
      async (job) => {
        const { type, sessionId, targetId, message, options, userId, sourceId, messageId, groupId, params } = job.data;

        if (type === 'send') {
          return await messageService.sendMessage(sessionId, targetId, message, options, userId);
        } else if (type === 'bulk') {
          return await messageService.sendBulkMessage(params, userId);
        } else if (type === 'group-message') {
          return await messageService.sendMessageToGroup(sessionId, groupId, message, userId);
        } else if (type === 'forward') {
          return await messageService.forwardMessage(sessionId, targetId, messageId, sourceId, userId);
        }
      },
      { connection: redisClient, concurrency: 5 }
    );

    this.queueEvents = new QueueEvents(MESSAGE_QUEUE_NAME, { connection: redisClient });

    this.worker.on('completed', (job) => {
      logger.info(`Message job ${job.id} completed`, { jobId: job.id });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('message:completed', {
          jobId: job.id,
          result: job.returnvalue,
        });
      }
    });

    this.worker.on('failed', (job, err) => {
      logger.error(`Message job ${job.id} failed: ${err.message}`, { jobId: job.id });
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('message:failed', {
          jobId: job.id,
          error: err.message,
        });
      }
    });

    this.worker.on('progress', (job, progress) => {
      if (global.io) {
        global.io.to(`user:${job.data.userId}`).emit('message:progress', {
          jobId: job.id,
          progress,
        });
      }
    });

    this.initialized = true;
    logger.info('Message queue initialized');
  }

  async addJob(jobData) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add('message', jobData);
    logger.info(`Message job added to queue`, { jobId: job.id });
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

module.exports = new MessageQueueManager();
