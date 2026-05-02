/**
 * Platform-aware queue dispatcher.
 *
 *   await queueManager.enqueueScrape({ jobId, platform })
 *   await queueManager.enqueueMessaging({ jobId, platform, userId })
 *
 * Routes Instagram jobs to the dedicated `scrape:instagram` /
 * `messaging:instagram` BullMQ queues, and Telegram jobs to the legacy
 * `scrape-jobs` / `message-jobs` queues. Platform defaults to 'telegram'
 * for backwards-compat with the existing Telegram-only callers.
 */

const logger = require('../utils/logger');

let _scrape, _messaging, _instagramScrape, _instagramMessaging;
function _lazy() {
  if (_scrape) return;
  // eslint-disable-next-line global-require
  _scrape = require('../queues/scrapeQueue');
  // eslint-disable-next-line global-require
  _messaging = require('../queues/messageQueue');
  // eslint-disable-next-line global-require
  _instagramScrape = require('../queues/instagramScrapeQueue');
  // eslint-disable-next-line global-require
  _instagramMessaging = require('../queues/instagramMessageQueue');
}

async function enqueueScrape({ jobId, platform = 'telegram', userId } = {}) {
  _lazy();
  const data = { jobId, userId };
  if (platform === 'instagram') {
    return _instagramScrape.addJob(data);
  }
  return _scrape.addJob(data);
}

async function enqueueMessaging({ jobId, platform = 'telegram', userId } = {}) {
  _lazy();
  const data = { jobId, userId };
  if (platform === 'instagram') {
    return _instagramMessaging.addJob(data);
  }
  return _messaging.addJob(data);
}

async function cancel({ jobId, platform = 'telegram' }) {
  _lazy();
  try {
    if (platform === 'instagram') {
      const j = await _instagramScrape.queue?.getJob(jobId);
      if (j) await j.moveToFailed(new Error('Cancelled by user'), _instagramScrape.worker);
    } else {
      await _scrape.cancelJob(jobId);
    }
    return true;
  } catch (err) {
    logger.warn(`queueManager.cancel failed: ${err.message}`);
    return false;
  }
}

module.exports = {
  enqueueScrape,
  enqueueMessaging,
  cancel,
};
