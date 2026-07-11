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
   * Idempotent: if a listener is already attached, returns
   * `{ attached: false, reason: 'already_attached' }` instead of throwing.
   *
   * On a real attach failure (e.g. session not connected, GramJS handler
   * registration rejected) the error is logged and re-thrown so the
   * caller can decide whether to surface it to the user. Callers in
   * best-effort paths (heartbeat, login bootstrap) should wrap in
   * try/catch and log a warning without failing the broader operation.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ attached: boolean, reason?: string }>}
   */
  async attach(sessionId) {
    const sid = String(sessionId);
    if (this._handlers.has(sid)) {
      return { attached: false, reason: 'already_attached' };
    }

    let off;
    try {
      off = await tgService.addNewMessageHandler(sid, async (event) => {
        try {
          // Lazy require to avoid a circular dependency with aiChatService.
          const aiChatService = require('./aiChatService');
          await aiChatService.handleIncomingMessage(sid, event);
        } catch (err) {
          logger.warn(`AI incoming-message handler error for ${sid}: ${err.message}`);
        }
      });
    } catch (err) {
      logger.error(`AI listener attach failed for session ${sid}: ${err.message}`, {
        stack: err.stack,
      });
      throw new Error(`AI listener attach failed for session ${sid}: ${err.message}`);
    }

    this._handlers.set(sid, off);
    logger.info(`AI listener attached for session ${sid}`);
    return { attached: true };
  }

  /**
   * Detach (if attached) then attach again. Used by heartbeat reconnects
   * where the GramJS client was rebuilt and the previously stored
   * unsubscribe function is stale — it points at the dead old client,
   * not the new one.
   *
   * If no listener is currently attached this is equivalent to a fresh
   * `attach`. If attach fails the error is logged and re-thrown.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ attached: boolean, reason?: string }>}
   */
  async reattach(sessionId) {
    const sid = String(sessionId);
    // detach() is idempotent and safe when nothing is attached; it never
    // throws — it logs and returns { detached: false, reason }.
    await this.detach(sid);
    return this.attach(sid);
  }

  /**
   * @param {string|number} sessionId
   * @returns {boolean} true if a NewMessage listener is currently attached.
   */
  isAttached(sessionId) {
    return this._handlers.has(String(sessionId));
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
