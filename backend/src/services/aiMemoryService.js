/**
 * AiMemoryService — rolling per-chat conversation memory for the AI auto-responder.
 *
 * Memory is keyed by (session_id, peer_type, peer_id) and stored in
 * `ai_chat_memories.messages` as a JSONB array.  The array is trimmed to
 * the configured window on every append so the payload sent to CupidBot
 * stays bounded.
 *
 * CRITICAL: For CupidBot API, we must track conversation state:
 * - Which AI messages have been confirmed delivered (sent back in next API call)
 * - The last message exchange for isFollowUp logic
 * - Recipient profile (bio, location) for context
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
   * @param {object} message - { id, telegramMessageId, timestamp, msg, isIncoming, medias, confirmed }
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
         SET messages = COALESCE(
           (
             SELECT jsonb_agg(item ORDER BY ord)
             FROM (
               SELECT value AS item, ord
               FROM jsonb_array_elements(COALESCE(messages, '[]'::jsonb)) WITH ORDINALITY AS t(value, ord)
               ORDER BY ord
               LIMIT GREATEST($5 - 1, 0)
             ) sub
           ),
           '[]'::jsonb
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
   * Mark AI messages as confirmed (delivered to recipient).
   * This is critical for CupidBot API - we must send confirmed messages
   * back in the next API call so CupidBot knows they were delivered.
   *
   * @param {string|number} sessionId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {Array<string>} confirmedMessageIds - Array of message IDs that were sent
   */
  async markMessagesConfirmed(sessionId, peerType, peerId, confirmedMessageIds) {
    if (!confirmedMessageIds || confirmedMessageIds.length === 0) return;

    await this.ensureRow(sessionId, peerType, peerId);

    try {
      await pool.query(
        `UPDATE ai_chat_memories
         SET messages = (
           SELECT jsonb_agg(
             CASE
               WHEN elem->>'telegramMessageId' IS NOT NULL
                AND (elem->>'telegramMessageId')::text = ANY($4)
                AND (elem->>'isIncoming')::boolean = false
               THEN jsonb_set(elem, '{confirmed}', 'true')
               ELSE elem
             END
           )
           FROM jsonb_array_elements(messages) AS elem
         ),
             updated_at = NOW()
         WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
        [sessionId, peerType, peerId, confirmedMessageIds]
      );
    } catch (err) {
      logger.error(`aiMemoryService.markMessagesConfirmed failed for ${sessionId}/${peerType}/${peerId}: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get the conversation state for CupidBot API.
   * Returns messages that need to be sent to CupidBot:
   * - All incoming messages (from user)
   * - Outgoing AI messages that haven't been confirmed yet
   * - The last message exchange for isFollowUp logic
   *
   * @param {string|number} sessionId
   * @param {string} peerType
   * @param {string|number} peerId
   * @param {number} [limit=100]
   * @returns {Promise<{messages: Array, lastExchange: {lastIncoming: object|null, lastOutgoing: object|null}}>}
   */
  async getConversationState(sessionId, peerType, peerId, limit = DEFAULT_MEMORY_LIMIT) {
    const lim = Math.max(1, parseInt(limit, 10) || DEFAULT_MEMORY_LIMIT);
    const { rows } = await pool.query(
      `SELECT messages FROM ai_chat_memories
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
    if (!rows.length) return { messages: [], lastExchange: { lastIncoming: null, lastOutgoing: null } };

    const allMessages = rows[0].messages || [];
    const recent = allMessages.slice(-lim);

    // Find last incoming and last outgoing messages for isFollowUp logic
    let lastIncoming = null;
    let lastOutgoing = null;
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m.isIncoming && !lastIncoming) lastIncoming = m;
      if (!m.isIncoming && !lastOutgoing) lastOutgoing = m;
      if (lastIncoming && lastOutgoing) break;
    }

    // For CupidBot, we need to send:
    // - All unconfirmed outgoing AI messages (they need to be confirmed as delivered)
    // - All incoming messages since the last confirmed outgoing
    // - The last message exchange
    const messagesForCupidBot = recent.filter(m => {
      if (m.isIncoming) return true; // Always include incoming
      // Include outgoing if not confirmed yet
      return m.confirmed !== true;
    });

    return {
      messages: messagesForCupidBot,
      lastExchange: { lastIncoming, lastOutgoing },
      allRecent: recent,
    };
  }

  /**
   * Return the current message window for a chat (for UI/debugging).
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
   * Get full memory including confirmed status (for debugging/admin).
   */
  async getFullMemory(sessionId, peerType, peerId) {
    const { rows } = await pool.query(
      `SELECT messages, message_count, last_incoming_at, last_outgoing_at, updated_at
       FROM ai_chat_memories
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
    if (!rows.length) return null;
    return rows[0];
  }

  /**
   * Store/update recipient profile (bio, location) for better AI context.
   */
  async setRecipientProfile(sessionId, peerType, peerId, profile) {
    await this.ensureRow(sessionId, peerType, peerId);

    await pool.query(
      `UPDATE ai_chat_memories
       SET recipient_profile = $4::jsonb,
           updated_at = NOW()
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId, JSON.stringify(profile)]
    );
  }

  /**
   * Get recipient profile.
   */
  async getRecipientProfile(sessionId, peerType, peerId) {
    const { rows } = await pool.query(
      `SELECT recipient_profile FROM ai_chat_memories
       WHERE session_id = $1 AND peer_type = $2 AND peer_id = $3`,
      [sessionId, peerType, peerId]
    );
    if (!rows.length) return null;
    return rows[0].recipient_profile || null;
  }

  /**
   * Bulk-insert chat history into the memory JSONB array, replacing the
   * existing window. Useful for backfilling a brand-new AI chat from
   * the recent Telegram history so the first AI reply has context.
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
   * Clear memory for a single chat.
   */
  async clear(sessionId, peerType, peerId) {
    await pool.query(
      `UPDATE ai_chat_memories
       SET messages = '[]', message_count = 0, recipient_profile = NULL, updated_at = NOW()
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
      `SELECT peer_type, peer_id, message_count, last_incoming_at, last_outgoing_at, updated_at, recipient_profile
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
