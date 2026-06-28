/**
 * AiSessionManager — manages persistent NewMessage listeners for AI.
 *
 * Unlike `telegramClientStream.js`, which only listens while a browser
 * window is subscribed, this manager attaches a NewMessage handler as
 * soon as a session becomes connected/logged-in and detaches it on
 * logout or disconnect.
 *
 * The manager is idempotent: attaching the same session twice is a no-op.
 */

const tgService = require('./telegramService');
const logger = require('../utils/logger');

class AiSessionManager {
  constructor() {
    /**
     * @type {Map<string, () => Promise<void>>}
     */
    this._handlers = new Map();
  }

  /**
   * Attach a NewMessage listener to the GramJS client for `sessionId`.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ attached: boolean, error?: string }>}
   */
  async attach(sessionId) {
    const sid = String(sessionId);
    if (this._handlers.has(sid)) {
      return { attached: false, reason: 'already_attached' };
    }

    try {
      const off = await tgService.addNewMessageHandler(sid, async (event) => {
        try {
          // Lazy require to avoid a circular dependency with aiChatService.
          const aiChatService = require('./aiChatService');
          await aiChatService.handleIncomingMessage(sid, event);
        } catch (err) {
          logger.warn(`AI incoming-message handler error for ${sid}: ${err.message}`);
        }
      });

      this._handlers.set(sid, off);
      logger.info(`AI listener attached for session ${sid}`);
      return { attached: true };
    } catch (err) {
      logger.warn(`AI listener attach failed for session ${sid}: ${err.message}`);
      return { attached: false, error: err.message };
    }
  }

  /**
   * Detach the NewMessage listener for `sessionId`.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ detached: boolean }>}
   */
  async detach(sessionId) {
    const sid = String(sessionId);
    const off = this._handlers.get(sid);
    if (!off) {
      return { detached: false, reason: 'not_attached' };
    }

    this._handlers.delete(sid);
    try {
      await Promise.resolve(off());
    } catch (err) {
      logger.debug(`AI listener detach error for ${sid}: ${err.message}`);
    }

    logger.info(`AI listener detached for session ${sid}`);
    return { detached: true };
  }

  /**
   * Detach every active listener.  Used during graceful shutdown.
   */
  async detachAll() {
    const ids = Array.from(this._handlers.keys());
    await Promise.all(ids.map((id) => this.detach(id)));
  }

  /**
   * List session IDs that currently have an AI listener attached.
   */
  getAttachedSessionIds() {
    return Array.from(this._handlers.keys());
  }
}

module.exports = new AiSessionManager();
