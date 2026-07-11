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

const DEFAULT_MEMORY_LIMIT = 100;
module.exports.DEFAULT_MEMORY_LIMIT = DEFAULT_MEMORY_LIMIT;

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
   * @param {number} [limit=100]
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
   * Bulk-insert chat history into the memory JSONB array, replacing the
   * existing window. Useful for backfilling a brand-new AI chat from
   * the recent Telegram history so the first AI reply has context.
   *
   * The incoming `messages` array is merged with whatever already exists
   * (de-duplicated by `telegramMessageId`), then sorted by timestamp and
   * trimmed to the most recent `DEFAULT_MEMORY_LIMIT` entries. This
   * makes the operation idempotent — calling seed twice with overlapping
   * windows does not duplicate rows.
   *
   * `last_incoming_at` / `last_outgoing_at` are recomputed from the
   * resulting array so the management UI stays accurate.
   *
   * @param {string|number} sessionId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {Array<object>} messages - memory-shaped items (see append)
   * @returns {Promise<{ stored: number, lastIncomingAt: string|null, lastOutgoingAt: string|null }>}
   */
  async seedFromHistory(sessionId, peerType, peerId, messages) {
    const incoming = Array.isArray(messages) ? messages : [];
    await this.ensureRow(sessionId, peerType, peerId);

    const { rows } = await pool.query(
      `SELECT messages FROM ai_chat_memories
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
    const existing = rows.length && Array.isArray(rows[0].messages) ? rows[0].messages : [];

    const merged = [...existing, ...incoming];
    const dedup = new Map();
    for (const item of merged) {
      if (!item || typeof item !== 'object') continue;
      const key = item.telegramMessageId != null
        ? `tg-${item.telegramMessageId}`
        : (item.id != null ? String(item.id) : null);
      if (!key) continue;
      dedup.set(key, item);
    }

    const sorted = Array.from(dedup.values())
      .map((m) => ({ ...m, ts: Number(m.timestamp) || 0 }))
      .sort((a, b) => a.ts - b.ts);

    const trimmed = sorted.slice(-DEFAULT_MEMORY_LIMIT).map(({ ts, ...rest }) => rest);

    let lastIncomingAt = null;
    let lastOutgoingAt = null;
    for (const m of trimmed) {
      if (m.isIncoming && m.timestamp != null) {
        const iso = new Date(m.timestamp).toISOString();
        if (!lastIncomingAt || iso > lastIncomingAt) lastIncomingAt = iso;
      } else if (!m.isIncoming && m.timestamp != null) {
        const iso = new Date(m.timestamp).toISOString();
        if (!lastOutgoingAt || iso > lastOutgoingAt) lastOutgoingAt = iso;
      }
    }

    await pool.query(
      `UPDATE ai_chat_memories
       SET messages = $4::jsonb,
           message_count = $5,
           last_incoming_at = $6,
           last_outgoing_at = $7,
           updated_at = NOW()
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [
        sessionId,
        peerType,
        peerId,
        JSON.stringify(trimmed),
        trimmed.length,
        lastIncomingAt,
        lastOutgoingAt,
      ]
    );

    return {
      stored: trimmed.length,
      lastIncomingAt,
      lastOutgoingAt,
    };
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
