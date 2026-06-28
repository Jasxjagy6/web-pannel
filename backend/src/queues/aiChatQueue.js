/**
 * AiChatQueue — BullMQ queue for AI reply generation.
 *
 * The queue decouples incoming message detection (which runs on the
 * GramJS update loop) from the CupidBot HTTP call and the outbound
 * Telegram send.  This prevents a slow API or a flood-wait from
 * blocking updates for the session.
 */

const { Queue } = require('bullmq');
const logger = require('../utils/logger');

const QUEUE_NAME = 'ai-chat-jobs';

const redisConnection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6382', 10),
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null,
};

class AiChatQueue {
  constructor() {
    this.queue = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;

    this.queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { age: 3600, count: 200 },
        removeOnFail: { age: 86400 },
      },
    });

    this.initialized = true;
    logger.info('AI chat queue initialized');
  }

  async add(name, data) {
    if (!this.initialized) await this.initialize();
    const job = await this.queue.add(name, data);
    logger.debug(`AI chat job added`, { jobId: job.id, sessionId: data.sessionId });
    return job;
  }

  async close() {
    if (this.queue) {
      await this.queue.close();
    }
    this.initialized = false;
  }

  getQueue() {
    return this.queue;
  }
}

module.exports = new AiChatQueue();
