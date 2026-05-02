/**
 * Instagram DM threads (provider.threads.*).
 *
 * The Threads page on the IG panel is the analog of TG's groups page —
 * lists active DM threads, lets you open one to read recent messages and
 * send a reply.
 *
 * Backed by the ig_threads / ig_thread_messages cache tables (v9_2). The
 * cache is populated lazily: an empty list triggers a refresh from the IG
 * API (`client.feed.directInbox()`), which then upserts ig_threads rows.
 */

const { pool } = require('../../config/database');
const logger = require('../../utils/logger');
const igClient = require('./client');

const PLATFORM = 'instagram';

async function _getSession({ userId, sessionId }) {
  const r = await pool.query(
    `SELECT id, user_id, username, proxy_url, session_data, platform_state
       FROM sessions
      WHERE id = $1 AND user_id = $2 AND platform = 'instagram'
        AND is_logged_in = TRUE`,
    [sessionId, userId]
  );
  if (r.rows.length === 0) {
    const e = new Error('Instagram session not found or not logged-in');
    e.statusCode = 404;
    throw e;
  }
  return r.rows[0];
}

async function _upsertThread(session, t) {
  await pool.query(
    `INSERT INTO ig_threads
       (session_id, user_id, thread_id, thread_title, participant_count,
        participants, last_activity_at, is_group, is_pinned, is_muted,
        unread_count, last_seen_message_id, raw_metadata, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb,
             to_timestamp($7::bigint), $8, $9, $10,
             $11, $12, $13::jsonb, NOW())
     ON CONFLICT (session_id, thread_id) DO UPDATE
       SET thread_title = EXCLUDED.thread_title,
           participant_count = EXCLUDED.participant_count,
           participants = EXCLUDED.participants,
           last_activity_at = EXCLUDED.last_activity_at,
           is_group = EXCLUDED.is_group,
           is_pinned = EXCLUDED.is_pinned,
           is_muted = EXCLUDED.is_muted,
           unread_count = EXCLUDED.unread_count,
           last_seen_message_id = EXCLUDED.last_seen_message_id,
           raw_metadata = EXCLUDED.raw_metadata,
           updated_at = NOW()`,
    [
      session.id,
      session.user_id,
      String(t.thread_id),
      t.thread_title || (Array.isArray(t.users) ? t.users.map((u) => u.username).join(', ') : null),
      Array.isArray(t.users) ? t.users.length : 0,
      JSON.stringify(t.users || []),
      Math.floor((t.last_activity_at || Date.now() * 1000) / 1_000_000),
      !!t.is_group,
      !!t.is_pinned,
      !!t.muted,
      Number(t.read_state || 0) > 0 ? Number(t.read_state) : 0,
      t.last_seen_at?.[t.thread_id]?.item_id || null,
      JSON.stringify({
        thread_v2_id: t.thread_v2_id || null,
        is_spam: !!t.is_spam,
        last_permanent_item_id: t.last_permanent_item?.item_id || null,
      }),
    ]
  );
}

/**
 * List threads for a session — uses the cache if it's fresh
 * (updated_at within `cacheTtlMs`), otherwise refreshes from the IG API.
 *
 *   await provider.threads.list({ userId, sessionId, page, limit })
 */
async function listThreads({ userId, sessionId, page = 1, limit = 20, cacheTtlMs = 60_000 }) {
  const session = await _getSession({ userId, sessionId });

  const stale = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (NOW() - MAX(updated_at)))::int * 1000 AS age_ms
       FROM ig_threads WHERE session_id = $1`,
    [session.id]
  );
  const ageMs = stale.rows[0]?.age_ms ?? Infinity;

  if (ageMs > cacheTtlMs) {
    try {
      const client = await igClient.getClient(session);
      const inbox = client.feed.directInbox();
      const items = await inbox.items();
      for (const item of items) {
        await _upsertThread(session, item);
      }
    } catch (err) {
      logger.warn(`IG.threads.list refresh failed: ${err.message}`);
    }
  }

  const offset = Math.max(0, (page - 1) * limit);
  const rows = await pool.query(
    `SELECT id, thread_id, thread_title, participant_count, participants,
            last_activity_at, is_group, is_pinned, is_muted, unread_count,
            updated_at
       FROM ig_threads
      WHERE session_id = $1 AND user_id = $2
      ORDER BY last_activity_at DESC NULLS LAST
      LIMIT $3 OFFSET $4`,
    [session.id, userId, limit, offset]
  );
  const count = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ig_threads WHERE session_id = $1 AND user_id = $2`,
    [session.id, userId]
  );
  return { threads: rows.rows, total: count.rows[0].n, page, limit };
}

/**
 * Get a single thread + recent messages.
 *
 *   await provider.threads.get({ userId, sessionId, threadId, refresh? })
 */
async function getThread({ userId, sessionId, threadId, refresh = true, messageLimit = 50 }) {
  const session = await _getSession({ userId, sessionId });

  if (refresh) {
    try {
      const client = await igClient.getClient(session);
      const feed = client.feed.directThread({ thread_id: String(threadId) });
      const items = await feed.items();
      const placeholders = [];
      const values = [];
      let p = 1;
      for (const m of items) {
        placeholders.push(
          `($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}, to_timestamp($${p++}::bigint), $${p++}::jsonb)`
        );
        values.push(
          String(threadId),
          session.id,
          session.user_id,
          String(m.item_id),
          m.user_id ? Number(m.user_id) : null,
          m.user_id && session.platform_state?.fingerprint?.user_pk &&
            String(m.user_id) === String(session.platform_state.fingerprint.user_pk)
            ? 'out'
            : 'in',
          m.item_type || 'unknown',
          m.text || null,
          m.media ? JSON.stringify(m.media) : null,
          m.replied_to_message?.item_id || null,
          Math.floor((m.timestamp || Date.now() * 1000) / 1_000_000),
          JSON.stringify(m)
        );
      }
      if (placeholders.length > 0) {
        await pool.query(
          `INSERT INTO ig_thread_messages
             (thread_id, session_id, user_id, ig_message_id, ig_user_pk,
              direction, message_type, text, media, reply_to_message_id, sent_at, raw)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT DO NOTHING`,
          values
        );
      }
    } catch (err) {
      logger.warn(`IG.threads.get refresh failed for thread=${threadId}: ${err.message}`);
    }
  }

  const meta = await pool.query(
    `SELECT * FROM ig_threads WHERE session_id = $1 AND thread_id = $2`,
    [session.id, String(threadId)]
  );
  const messages = await pool.query(
    `SELECT id, ig_message_id, ig_user_pk, direction, message_type, text,
            media, reply_to_message_id, sent_at
       FROM ig_thread_messages
      WHERE session_id = $1 AND thread_id = $2
      ORDER BY sent_at DESC NULLS LAST
      LIMIT $3`,
    [session.id, String(threadId), messageLimit]
  );
  return { thread: meta.rows[0] || null, messages: messages.rows };
}

/**
 * Send a single text message to a thread.
 *
 *   await provider.threads.send({ userId, sessionId, threadId, text })
 */
async function sendToThread({ userId, sessionId, threadId, text }) {
  if (!text) throw new Error('text required');
  const session = await _getSession({ userId, sessionId });
  const client = await igClient.getClient(session);
  const thread = client.entity.directThread([]);
  // .threadId is the property the lib uses to bind to an existing thread.
  thread.threadId = String(threadId);
  await thread.broadcastText(text);
  return { ok: true, threadId: String(threadId) };
}

module.exports = {
  PLATFORM,
  list: listThreads,
  listThreads,
  get: getThread,
  getThread,
  send: sendToThread,
  sendToThread,
};
