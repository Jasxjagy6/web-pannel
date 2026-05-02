const scrapeQueue = require('./scrapeQueue');
const messageQueue = require('./messageQueue');
const groupQueue = require('./groupQueue');
const instagramScrapeQueue = require('./instagramScrapeQueue');
const instagramMessageQueue = require('./instagramMessageQueue');
const logger = require('../utils/logger');

async function initializeQueues() {
  try {
    await scrapeQueue.initialize();
    await messageQueue.initialize();
    await groupQueue.initialize();
    // IG queues — register executors lazily so a Redis-less dev environment
    // doesn't crash the panel on boot. The executors are wired via
    // queueManager.js below (require'd by the IG provider on first use).
    if (process.env.IG_QUEUES_ENABLED !== 'false') {
      await instagramScrapeQueue.initialize();
      await instagramMessageQueue.initialize();
      try {
        const igScrape = require('../providers/instagram/scrape');
        const igMessaging = require('../providers/instagram/messaging');
        instagramScrapeQueue.setJobExecutor((jobId) => igScrape._executeScrapeJob(jobId));
        instagramMessageQueue.setJobExecutor((jobId) => igMessaging._executeMessagingJob(jobId));
      } catch (err) {
        logger.warn(`IG queue executors not registered: ${err.message}`);
      }
    }
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
  if (instagramScrapeQueue.initialized) await instagramScrapeQueue.close();
  if (instagramMessageQueue.initialized) await instagramMessageQueue.close();
  logger.info('All queues closed');
}

module.exports = {
  scrapeQueue,
  scrapeQueueManager: scrapeQueue,
  messageQueue,
  groupQueue,
  instagramScrapeQueue,
  instagramMessageQueue,
  initializeQueues,
  closeQueues,
};
