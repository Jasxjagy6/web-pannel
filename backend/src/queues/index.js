const scrapeQueue = require('./scrapeQueue');
const messageQueue = require('./messageQueue');
const groupQueue = require('./groupQueue');
const loginEmailQueue = require('./loginEmailQueue');
const instagramScrapeQueue = require('./instagramScrapeQueue');
const instagramMessageQueue = require('./instagramMessageQueue');
const instagramLookupQueue = require('./instagramLookupQueue');
const redditScrapeQueue = require('./redditScrapeQueue');
const logger = require('../utils/logger');

async function initializeQueues() {
  try {
    await scrapeQueue.initialize();
    await messageQueue.initialize();
    await groupQueue.initialize();
    await loginEmailQueue.initialize();
    // IG queues — register executors lazily so a Redis-less dev environment
    // doesn't crash the panel on boot. The executors are wired via
    // queueManager.js below (require'd by the IG provider on first use).
    if (process.env.IG_QUEUES_ENABLED !== 'false') {
      await instagramScrapeQueue.initialize();
      await instagramMessageQueue.initialize();
      await instagramLookupQueue.initialize();
      try {
        const igScrape = require('../providers/instagram/scrape');
        const igMessaging = require('../providers/instagram/messaging');
        const igLookup = require('../providers/instagram/lookup');
        instagramScrapeQueue.setJobExecutor((jobId) => igScrape._executeScrapeJob(jobId));
        instagramMessageQueue.setJobExecutor((jobId) => igMessaging._executeMessagingJob(jobId));
        instagramLookupQueue.setJobExecutor((jobId) => igLookup.runJob(jobId));
      } catch (err) {
        logger.warn(`IG queue executors not registered: ${err.message}`);
      }
    }
    if (process.env.REDDIT_QUEUE_ENABLED !== 'false') {
      try {
        await redditScrapeQueue.initialize();
        // eslint-disable-next-line global-require
        const redditService = require('../services/redditCookieScrapeService');
        redditScrapeQueue.setJobExecutor((jobId) => redditService.executeJob(jobId));
      } catch (err) {
        logger.warn(`Reddit scrape queue not initialized: ${err.message}`);
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
  if (loginEmailQueue.initialized) await loginEmailQueue.close();
  if (instagramScrapeQueue.initialized) await instagramScrapeQueue.close();
  if (instagramMessageQueue.initialized) await instagramMessageQueue.close();
  if (instagramLookupQueue.initialized) await instagramLookupQueue.close();
  if (redditScrapeQueue.initialized) await redditScrapeQueue.close();
  logger.info('All queues closed');
}

module.exports = {
  scrapeQueue,
  scrapeQueueManager: scrapeQueue,
  messageQueue,
  groupQueue,
  loginEmailQueue,
  instagramScrapeQueue,
  instagramMessageQueue,
  instagramLookupQueue,
  redditScrapeQueue,
  initializeQueues,
  closeQueues,
};
