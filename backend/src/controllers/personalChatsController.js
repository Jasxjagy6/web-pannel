/**
 * PersonalChatsController — scrape ALL personal (DM) chats from one or
 * more sessions and return them as a downloadable CSV / JSON / TXT file.
 *
 * Leisure-friendly "contact dump": unlike the group/channel scraper this
 * reads the user's own dialog list (their DMs), so the only data we get
 * is chats the session already has — no writing to Telegram, no member
 * enumeration. It is synchronous: the requests resolves once all
 * selected sessions have been walked and the file is streamed back.
 */

const tcService = require('../services/telegramClientService');
const reportService = require('../services/reportService');
const { AppError, asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');
const { resolveSessionIdsFromRequest } = require('../utils/resolveSessions');

function _bool(v) {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  return String(v).toLowerCase() === 'true';
}

const personalChatsController = {
  /**
   * POST /api/telegram/client/scrape/chats
   *
   * Body:
   *   - sessionIds: number[]  (explicit sessions)
   *   - sessionListId: number  (or sessionListIds: number[]) — expands to
   *     that list's sessions
   *   - format: 'csv' | 'json' | 'txt'   (default 'csv')
   *   - limit: number  (max dialogs inspected per session, default 200)
   *   - withBio: boolean (default true)
   *
   * Returns the generated file as an attachment. Records are de-duped
   * by Telegram user id across all selected sessions.
   */
  scrapeChats: asyncHandler(async (req, res) => {
    const userId = req.user.id;
    const format = String(req.body.format || req.query.format || 'csv').toLowerCase();
    const limit = parseInt(req.body.limit, 10) || 200;
    const withBio = req.body.withBio === undefined ? true : _bool(req.body.withBio);

    const rawSessions = Array.isArray(req.body.sessionIds) ? req.body.sessionIds : [];
    const sessions = await resolveSessionIdsFromRequest(req, rawSessions, { includeAll: true });
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new AppError(
        'Please select at least one session (or a session list)',
        400,
        'NO_SESSIONS'
      );
    }
    if (sessions.length > 50) {
      throw new AppError('Too many sessions (max 50)', 400, 'TOO_MANY_SESSIONS');
    }

    // Walk each session's personal chats and dedupe by user id.
    const seen = new Map();
    for (const sessionId of sessions) {
      try {
        const { chats } = await tcService.scrapePersonalChats(
          sessionId,
          userId,
          { limit, withBio }
        );
        for (const c of chats || []) {
          if (!seen.has(c.id)) seen.set(c.id, c);
        }
      } catch (err) {
        // Surface the first hard failure but keep walking the remaining
        // sessions so one bad/offline session doesn't abort the dump.
        logger.warn(`scrapePersonalChats session ${sessionId} failed: ${err.message}`);
      }
    }

    const users = Array.from(seen.values());
    users.sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')));

    const filename = `personal_chats_${Date.now()}`;
    let content, mimeType, extension;

    if (format === 'json') {
      content = JSON.stringify(users, null, 2);
      mimeType = 'application/json';
      extension = 'json';
    } else if (format === 'txt') {
      content = users.map((u) => {
        const parts = [];
        if (u.username) parts.push(`@${u.username}`);
        if (u.firstName || u.lastName) parts.push(`${u.firstName} ${u.lastName}`.trim());
        if (u.phone) parts.push(u.phone);
        return parts.join(' | ');
      }).join('\n');
      mimeType = 'text/plain';
      extension = 'txt';
    } else {
      const headers = ['username', 'id', 'firstname', 'lastname', 'bio', 'phone'];
      const esc = (val) => {
        if (val === null || val === undefined) return '';
        const s = String(val);
        if (s.includes(',') || s.includes('"') || s.includes('\n')) {
          return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
      };
      const rows = users.map((u) => [u.username, u.id, u.firstName, u.lastName, u.bio, u.phone]
        .map(esc).join(','));
      content = [headers.join(','), ...rows].join('\n');
      mimeType = 'text/csv';
      extension = 'csv';
    }

    await reportService.logActivity(userId, 'export', 'personal_chats', null, {
      format,
      recordCount: users.length,
      sessionCount: sessions.length,
    });

    res.setHeader('Content-Type', mimeType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=${filename}.${extension}`
    );
    res.send(content);
  }),
};

module.exports = personalChatsController;
