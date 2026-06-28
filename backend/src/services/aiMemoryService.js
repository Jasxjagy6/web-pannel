/**
 * AiMemoryService — rolling per-chat conversation memory for the AI auto-responder.
 *
 * Memory is keyed by (session_id, peer_type, peer_id) and stored in
 * `ai_chat_memories.messages` as a JSONB array.  The array is trimmed to
 * the configured window on every append so the payload sent to CupidBot
 * stays bounded.
 */

const { pool } = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_MEMORY_LIMIT = 50;

function _now() {
  return new Date().toISOString();
}

class AiMemoryService {
  /**
   * Ensure a memory row exists for the chat.
   */
  async ensureRow(sessionId, peerType, peerId) {
    await pool.query(
      `INSERT INTO ai_chat_memories (session_id, peer_type, peer_id, messages, message_count)
       VALUES ($1, $2, $3, '[]', 0)
       ON CONFLICT (session_id, peer_type, peer_id) DO NOTHING`,
      [sessionId, peerType, peerId]
    );
  }

  /**
   * Append a message to the chat memory and trim to the configured limit.
   *
   * @param {string|number} sessionId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {object} message - { id, telegramMessageId, timestamp, msg, isIncoming, medias }
   * @param {number} [limit=50]
   */
  async append(sessionId, peerType, peerId, message, limit = DEFAULT_MEMORY_LIMIT) {
    const lim = Math.max(1, parseInt(limit, 10) || DEFAULT_MEMORY_LIMIT);
    await this.ensureRow(sessionId, peerType, peerId);

    const incomingAt = message.isIncoming ? _now() : null;
    const outgoingAt = message.isIncoming ? null : _now();

    try {
      await pool.query(
        `UPDATE ai_chat_memories
         SET messages = (
           SELECT jsonb_agg(item ORDER BY ord)
           FROM (
             SELECT value AS item, ord
             FROM jsonb_array_elements(messages) WITH ORDINALITY AS t(value, ord)
             ORDER BY ord
             LIMIT GREATEST($5 - 1, 0)
           ) sub
         ) || $4::jsonb,
           message_count = message_count + 1,
           last_incoming_at = COALESCE($6, last_incoming_at),
           last_outgoing_at = COALESCE($7, last_outgoing_at),
           updated_at = NOW()
         WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
        [sessionId, peerType, peerId, JSON.stringify(message), lim, incomingAt, outgoingAt]
      );
    } catch (err) {
      logger.error(`aiMemoryService.append failed for ${sessionId}/${peerType}/${peerId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Return the current message window for a chat.
   */
  async getMessages(sessionId, peerType, peerId, limit = DEFAULT_MEMORY_LIMIT) {
    const lim = Math.max(1, parseInt(limit, 10) || DEFAULT_MEMORY_LIMIT);
    const { rows } = await pool.query(
      `SELECT messages FROM ai_chat_memories
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
    if (!rows.length) return [];
    const arr = rows[0].messages || [];
    return arr.slice(-lim);
  }

  /**
   * Clear memory for a single chat.
   */
  async clear(sessionId, peerType, peerId) {
    await pool.query(
      `UPDATE ai_chat_memories
       SET messages = '[]', message_count = 0, updated_at = NOW()
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
  }

  /**
   * Clear memory for every chat belonging to a session.
   */
  async clearBySession(sessionId) {
    await pool.query(
      `DELETE FROM ai_chat_memories WHERE session_id = $1`,
      [sessionId]
    );
  }

  /**
   * List memory rows for a session, useful for the management UI.
   */
  async listBySession(sessionId, opts = {}) {
    const limit = Math.max(1, Math.min(100, parseInt(opts.limit, 10) || 50));
    const offset = Math.max(0, parseInt(opts.offset, 10) || 0);
    const { rows } = await pool.query(
      `SELECT peer_type, peer_id, message_count, last_incoming_at, last_outgoing_at, updated_at
       FROM ai_chat_memories
       WHERE session_id = $1
       ORDER BY last_incoming_at DESC NULLS LAST, updated_at DESC
       LIMIT $2 OFFSET $3`,
      [sessionId, limit, offset]
    );
    return rows;
  }
}

module.exports = new AiMemoryService();
