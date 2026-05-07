/**
 * Session-Lists controller.
 *
 * Mounted under `/api/{platform}/session-lists` so the platform is
 * resolved by the platform middleware (`req.platform`).
 */

const path = require('path');
const fs = require('fs-extra');
const AdmZip = require('adm-zip');
const { pool } = require('../config/database');
const { uploadDir } = require('../middleware/upload');
const sessionListService = require('../services/sessionListService');
const reportService = require('../services/reportService');
const { asyncHandler, AppError } = require('../utils/errorHandler');
const { decrypt } = require('../utils/crypto');
const logger = require('../utils/logger');

const TG_DOWNLOAD_FORMATS = new Set(['json', 'session']);
const ENCRYPTED_SESSION_RE = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

/**
 * Sanitize a filename component so we can safely embed it inside the
 * ZIP without colliding with the host filesystem rules.
 */
function _safeName(name) {
  return String(name || '').replace(/[^A-Za-z0-9+_-]/g, '');
}

/**
 * For a Telegram session row, return a Buffer + filename pair for the
 * requested export format (json or session). Returns null if the
 * session can't be exported in the requested format (e.g. no session
 * file on disk, or .session export requires a GramJS string we can't
 * recover). On failure the caller records a per-row note that ends
 * up in the ZIP's _README.txt manifest.
 *
 * Sessions ARE decrypted before being placed in the ZIP — the zip
 * payload itself is intentionally plain so the operator can take it
 * to Telethon / GramJS / other tooling without our crypto secret.
 */
async function _exportTelegramSession(row, format) {
  if (!row.session_file_path) {
    return { error: 'Session has no file on disk' };
  }
  const fullPath = path.join(uploadDir, row.session_file_path);
  if (!(await fs.pathExists(fullPath))) {
    return { error: 'Session file is missing on disk' };
  }
  const ext = path.extname(row.session_file_path) || '.json';
  const safePhone = _safeName(row.phone || `session-${row.id}`) || `session-${row.id}`;

  // Read & decrypt the GramJS string from the JSON envelope when
  // possible (this is the same logic as sessionController.downloadSession).
  let plain = null;
  let parsedEnvelope = null;
  if (ext.toLowerCase() === '.json') {
    try {
      const raw = await fs.readFile(fullPath, 'utf8');
      const parsed = JSON.parse(raw);
      parsedEnvelope = parsed;
      if (parsed && typeof parsed.session === 'string') {
        plain = parsed.session;
        if (ENCRYPTED_SESSION_RE.test(plain)) {
          try {
            plain = decrypt(plain);
          } catch (err) {
            logger.warn(
              `session-list download: decrypt failed for session ${row.id}: ${err.message}`
            );
            plain = null;
          }
        }
      }
    } catch (err) {
      logger.warn(
        `session-list download: failed to parse session ${row.id}: ${err.message}`
      );
    }
  }

  if (format === 'session') {
    if (!plain) {
      return {
        error:
          'No recoverable GramJS string on disk; .session export not available. Try the JSON format.',
      };
    }
    let buffer;
    try {
      const { writeTelethonSessionBuffer, writeTelethonSessionFile } = require('../utils/gramjsToTelethon');
      if (typeof writeTelethonSessionBuffer === 'function') {
        buffer = writeTelethonSessionBuffer(plain);
      } else {
        // Fallback — write to a temp file and read it back.
        const tmpDir = path.join(uploadDir, '_tmp');
        await fs.ensureDir(tmpDir);
        const tmpPath = path.join(
          tmpDir,
          `tg-${row.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.session`
        );
        try {
          writeTelethonSessionFile(plain, tmpPath);
          buffer = await fs.readFile(tmpPath);
        } finally {
          fs.remove(tmpPath).catch(() => {});
        }
      }
    } catch (err) {
      logger.warn(
        `session-list download: Telethon export failed for session ${row.id}: ${err.message}`
      );
      return { error: `Failed to build .session file: ${err.message}` };
    }
    return { filename: `${safePhone}.session`, buffer };
  }

  // format === 'json' — emit a plain (decrypted) envelope.
  if (ext.toLowerCase() === '.json' && plain && parsedEnvelope) {
    const body = {
      session: plain,
      createdAt:
        parsedEnvelope.createdAt ||
        parsedEnvelope.uploadedAt ||
        new Date().toISOString(),
      originalName: parsedEnvelope.originalName || `${safePhone}.json`,
    };
    if (parsedEnvelope.convertedFrom) body.convertedFrom = parsedEnvelope.convertedFrom;
    if (parsedEnvelope.createdVia) body.createdVia = parsedEnvelope.createdVia;
    return {
      filename: `${safePhone}.json`,
      buffer: Buffer.from(JSON.stringify(body, null, 2), 'utf8'),
    };
  }

  // Fall-through: ship the raw on-disk file. This covers legacy
  // Telethon binary uploads and other unexpected shapes — they are
  // already plain (no app-level encryption) so we can include them
  // as-is.
  try {
    const buffer = await fs.readFile(fullPath);
    return { filename: `${safePhone}${ext}`, buffer };
  } catch (err) {
    return { error: `Could not read session file: ${err.message}` };
  }
}

/**
 * For an Instagram session row, return a Buffer + filename pair.
 * Always JSON regardless of the requested format — IG sessions are
 * cookie/device blobs and we don't have a `.session` equivalent.
 */
async function _exportInstagramSession(row) {
  try {
    const provider = require('../providers/instagram');
    const out = await provider.sessions.download(row.id, row.user_id);
    const safeName = _safeName(out.username || `instagram-${row.id}`) || `instagram-${row.id}`;
    const body = {
      platform: 'instagram',
      username: out.username,
      sessionBlob: out.blob,
      exportedAt: new Date().toISOString(),
    };
    return {
      filename: `${safeName}.json`,
      buffer: Buffer.from(JSON.stringify(body, null, 2), 'utf8'),
    };
  } catch (err) {
    return { error: `Instagram session export failed: ${err.message}` };
  }
}

function _platform(req) {
  return req.platform || 'telegram';
}

function _listId(req) {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    throw new AppError('Invalid list id', 400, 'BAD_ID');
  }
  return id;
}

module.exports = {
  /** GET /api/{platform}/session-lists */
  list: asyncHandler(async (req, res) => {
    const platform = _platform(req);
    const search = (req.query.search || '').trim() || null;
    const lists = await sessionListService.listLists({
      userId: req.user.id,
      platform,
      search,
    });
    return res.json({ success: true, data: { lists } });
  }),

  /** POST /api/{platform}/session-lists */
  create: asyncHandler(async (req, res) => {
    const platform = _platform(req);
    const { name, description, sessionIds } = req.body || {};
    const list = await sessionListService.createList({
      userId: req.user.id,
      platform,
      name,
      description,
      sessionIds,
    });
    reportService
      .logActivity(req.user.id, 'session_list_create', 'session_list', list.id, {
        platform,
        name: list.name,
        sessions: Array.isArray(sessionIds) ? sessionIds.length : 0,
      })
      .catch(() => {});
    return res.status(201).json({ success: true, data: list });
  }),

  /** GET /api/{platform}/session-lists/:id */
  get: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const list = await sessionListService.getList({ userId: req.user.id, listId: id });
    return res.json({ success: true, data: list });
  }),

  /** GET /api/{platform}/session-lists/:id/sessions */
  getSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const includeAll = req.query.includeAll === 'true' || req.query.include_all === 'true';
    const sessions = await sessionListService.getListSessions({
      userId: req.user.id,
      listId: id,
      includeAll,
    });
    return res.json({ success: true, data: { sessions } });
  }),

  /** PUT /api/{platform}/session-lists/:id */
  update: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { name, description } = req.body || {};
    const list = await sessionListService.updateList({
      userId: req.user.id,
      listId: id,
      name,
      description,
    });
    reportService
      .logActivity(req.user.id, 'session_list_update', 'session_list', id, {
        name: list.name,
      })
      .catch(() => {});
    return res.json({ success: true, data: list });
  }),

  /** DELETE /api/{platform}/session-lists/:id */
  remove: asyncHandler(async (req, res) => {
    const id = _listId(req);
    await sessionListService.deleteList({ userId: req.user.id, listId: id });
    reportService
      .logActivity(req.user.id, 'session_list_delete', 'session_list', id, {})
      .catch(() => {});
    return res.json({ success: true, data: { id } });
  }),

  /** POST /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } */
  addSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.addSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),

  /** DELETE /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } */
  removeSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.removeSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),

  /** PUT /api/{platform}/session-lists/:id/sessions  body: { sessionIds: [...] } — replace */
  setSessions: asyncHandler(async (req, res) => {
    const id = _listId(req);
    const { sessionIds } = req.body || {};
    const list = await sessionListService.setSessions({
      userId: req.user.id,
      listId: id,
      sessionIds,
    });
    return res.json({ success: true, data: list });
  }),

  /**
   * GET /api/{platform}/session-lists/:id/download?format=json|session
   *
   * Builds a ZIP archive containing every exportable session in the
   * list, in the requested format. Sessions are decrypted before
   * being placed into the archive — the archive itself is plain
   * (unencrypted) so it can be loaded into Telethon / GramJS / other
   * tooling without our crypto secret. A `_README.txt` manifest is
   * included with one line per session listing whether it was
   * exported successfully or skipped (with the reason).
   */
  download: asyncHandler(async (req, res) => {
    const platform = _platform(req);
    const userId = req.user.id;
    const id = _listId(req);

    const requestedFormat = String(
      req.query.format || req.query.fmt || 'json'
    ).toLowerCase();
    if (!TG_DOWNLOAD_FORMATS.has(requestedFormat)) {
      throw new AppError(
        `Unsupported download format "${requestedFormat}". ` +
          `Allowed: ${[...TG_DOWNLOAD_FORMATS].join(', ')}`,
        400,
        'BAD_DOWNLOAD_FORMAT'
      );
    }

    if (platform === 'instagram' && requestedFormat === 'session') {
      throw new AppError(
        'Instagram session lists only support the json format.',
        400,
        'UNSUPPORTED_FORMAT_FOR_PLATFORM'
      );
    }

    // Owner-check + scope to the list's platform.
    const list = await sessionListService.getList({ userId, listId: id });
    if (list.platform !== platform) {
      throw new AppError(
        `Session list ${id} belongs to platform '${list.platform}', not '${platform}'`,
        400,
        'PLATFORM_MISMATCH'
      );
    }

    // Pull every session row in the list (including logged-out ones
    // — the operator may want to back up dead accounts too).
    const rowsRes = await pool.query(
      `SELECT s.id, s.user_id, s.phone, s.platform, s.session_file_path,
              s.account_info, s.is_logged_in, s.status
         FROM session_list_members m
         JOIN sessions s ON s.id = m.session_id
        WHERE m.list_id = $1 AND s.user_id = $2
        ORDER BY s.id ASC`,
      [id, userId]
    );

    if (rowsRes.rows.length === 0) {
      throw new AppError(
        `Session list "${list.name}" is empty`,
        404,
        'EMPTY_LIST'
      );
    }

    const zip = new AdmZip();
    const manifestLines = [
      `Session list:  ${list.name} (id=${list.id})`,
      `Platform:      ${list.platform}`,
      `Format:        ${requestedFormat}`,
      `Exported at:   ${new Date().toISOString()}`,
      `Total entries: ${rowsRes.rows.length}`,
      '',
      'Note: session payloads in this ZIP are decrypted (plain).',
      '',
      'Files:',
    ];
    const usedNames = new Set();
    let exportedCount = 0;
    let skippedCount = 0;

    for (const row of rowsRes.rows) {
      const result =
        platform === 'instagram'
          ? await _exportInstagramSession(row)
          : await _exportTelegramSession(row, requestedFormat);

      if (result && result.buffer && result.filename) {
        // Disambiguate duplicate filenames (e.g. two sessions with the
        // same phone) by suffixing the row id.
        let name = result.filename;
        if (usedNames.has(name)) {
          const ext = path.extname(name);
          const base = name.slice(0, name.length - ext.length);
          name = `${base}_id${row.id}${ext}`;
        }
        usedNames.add(name);
        zip.addFile(name, result.buffer);
        manifestLines.push(`  [OK]    ${name}  (session id=${row.id})`);
        exportedCount++;
      } else {
        const reason = (result && result.error) || 'Unknown error';
        const label = _safeName(row.phone || `session-${row.id}`) || `session-${row.id}`;
        manifestLines.push(`  [SKIP]  ${label}  (session id=${row.id}): ${reason}`);
        skippedCount++;
      }
    }

    if (exportedCount === 0) {
      throw new AppError(
        `Could not export any sessions from list "${list.name}". ` +
          `Tried ${rowsRes.rows.length} session(s); see logs for details.`,
        409,
        'EXPORT_EMPTY'
      );
    }

    zip.addFile(
      '_README.txt',
      Buffer.from(manifestLines.join('\n') + '\n', 'utf8')
    );

    reportService
      .logActivity(userId, 'session_list_download', 'session_list', list.id, {
        platform,
        format: requestedFormat,
        exported: exportedCount,
        skipped: skippedCount,
      })
      .catch(() => {});

    const safeListName = _safeName(list.name) || `session-list-${list.id}`;
    const downloadName = `${safeListName}_${requestedFormat}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${downloadName}"`
    );
    return res.send(zip.toBuffer());
  }),
};
