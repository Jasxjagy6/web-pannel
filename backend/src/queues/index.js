const scrapeQueue = require('./scrapeQueue');
const messageQueue = require('./messageQueue');
const groupQueue = require('./groupQueue');
const logger = require('../utils/logger');

async function initializeQueues() {
  try {
    await scrapeQueue.initialize();
    await messageQueue.initialize();
    await groupQueue.initialize();
    logger.info('All queues initialized');
  } catch (error) {
    logger.error('Failed to initialize queues', error);
    throw error;
  }
}

async function closeQueues() {
  await scrapeQueue.close();
  await messageQueue.close();
  await groupQueue.close();
  logger.info('All queues closed');
}

module.exports = {
  scrapeQueue,
  scrapeQueueManager: scrapeQueue,
  messageQueue,
  groupQueue,
  initializeQueues,
  closeQueues,
};
