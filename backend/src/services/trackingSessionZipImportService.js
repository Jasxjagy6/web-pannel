const fs = require('fs-extra');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/database');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');

const trackingAccountService = require('./trackingAccountService');
const trackingSessionInfoService = require('./trackingSessionInfoService');
const trackingSecurityService = require('./trackingSecurityService');
const trackingTelegramMetaService = require('./trackingTelegramMetaService');
const { uploadDir } = require('../middleware/trackingUpload');

// Mirrors sessionService.js's zip-bomb guards for the general session
// upload pipeline (see backend/src/services/sessionService.js).
const ZIP_ENTRY_EXTENSIONS = ['.session', '.json'];
const ZIP_ENTRY_MAX_BYTES = 100 * 1024 * 1024;
const ZIP_TOTAL_MAX_BYTES = parseInt(
  process.env.TRACKING_ZIP_TOTAL_MAX_BYTES || String(1024 * 1024 * 1024),
  10
);

function normalizeExtra(value) {
  if (typeof value === 'string' && value.trim().toLowerCase() === 'null') return null;
  return value === undefined ? null : value;
}

function toIntOrUndefined(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Extracts a zip's `.session` + `.json` entries into a temp dir, pairing
 * them by basename (e.g. `917025116940.session` + `917025116940.json`).
 * Same path-traversal and size-cap guards as the general session-upload
 * zip pipeline. Returns { pairs: Map<basename, {sessionPath?, jsonPath?}>, tempDir }.
 */
async function extractZip(zipFilePath) {
  let zip;
  try {
    zip = new AdmZip(zipFilePath);
  } catch (err) {
    throw new AppError(`Invalid zip archive: ${err.message}`, 400, 'INVALID_ZIP');
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `tracking-zip-${uuidv4()}-`));
  const pairs = new Map();
  let cumulative = 0;

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const entryName = entry.entryName.replace(/\\/g, '/');
    const baseName = path.basename(entryName);
    if (!baseName || baseName.startsWith('.') || entryName.startsWith('__MACOSX/') || /Thumbs\.db$/i.test(baseName)) {
      continue;
    }
    const ext = path.extname(baseName).toLowerCase();
    if (!ZIP_ENTRY_EXTENSIONS.includes(ext)) continue;

    const key = baseName.slice(0, baseName.length - ext.length);
    const safeName = `${uuidv4()}${ext}`;
    const targetPath = path.join(tempDir, safeName);
    if (!path.resolve(targetPath).startsWith(path.resolve(tempDir) + path.sep)) {
      logger.warn(`Skipping tracking zip entry with unsafe path: ${entryName}`);
      continue;
    }

    let buf;
    try {
      buf = entry.getData();
    } catch (err) {
      logger.warn(`Failed to read tracking zip entry ${entryName}: ${err.message}`);
      continue;
    }
    if (buf.length > ZIP_ENTRY_MAX_BYTES) {
      logger.warn(`Tracking zip entry ${entryName} exceeds per-entry cap; skipping`);
      continue;
    }
    cumulative += buf.length;
    if (cumulative > ZIP_TOTAL_MAX_BYTES) {
      await fs.remove(tempDir).catch(() => {});
      throw new AppError('Aggregate decompressed size too large (possible zip bomb)', 400, 'ZIP_TOO_LARGE');
    }

    await fs.writeFile(targetPath, buf);
    const pair = pairs.get(key) || {};
    if (ext === '.session') pair.sessionPath = targetPath;
    else pair.jsonPath = targetPath;
    pair.originalSessionName = ext === '.session' ? baseName : pair.originalSessionName;
    pairs.set(key, pair);
  }

  return { pairs, tempDir };
}

async function findAccountByPhone(phone) {
  if (!phone) return null;
  const { rows } = await pool.query(
    'SELECT id FROM tracking_accounts WHERE phone_number = $1 AND is_deleted = FALSE LIMIT 1',
    [phone]
  );
  return rows[0] || null;
}

/**
 * Maps one parsed metadata JSON (the session-selling-tool export format)
 * onto the four places its fields live: basic account info, session
 * client/device fingerprint, encrypted security (2FA), and passive
 * Telegram account metadata (spamblock/premium/dob/stats).
 */
function mapMetadata(meta) {
  const phone = meta.phone || meta.session_file || null;
  return {
    phone,
    basic: {
      phoneNumber: phone || undefined,
      telegramUserId: toIntOrUndefined(meta.id),
      username: meta.username || undefined,
      isPremium: typeof meta.is_premium === 'boolean' ? meta.is_premium : undefined,
      lastSeenAt: meta.last_connect_date || undefined,
    },
    session: {
      appId: toIntOrUndefined(meta.app_id),
      appHash: meta.app_hash || undefined,
      deviceModel: meta.device || undefined,
      systemVersion: meta.sdk || undefined,
      clientAppVersion: meta.app_version || undefined,
      langPack: meta.lang_pack || undefined,
      systemLangPack: meta.system_lang_pack || undefined,
      appConfigHash: meta.app_config_hash || undefined,
      sessionCreatedAt: meta.session_created_date || undefined,
    },
    security: {
      twoFaPassword: meta.twoFA !== undefined ? String(meta.twoFA) : undefined,
    },
    telegramMeta: {
      telegramRole: meta.role || undefined,
      dateOfBirth: meta.date_of_birth || undefined,
      dateOfBirthVerified: typeof meta.date_of_birth_integrity === 'boolean' ? meta.date_of_birth_integrity : undefined,
      premiumExpiresAt: meta.premium_expiry || undefined,
      spamblockStatus: meta.spamblock || undefined,
      spamblockUntil: meta.spamblock_end_date || undefined,
      hasProfilePic: typeof meta.has_profile_pic === 'boolean' ? meta.has_profile_pic : undefined,
      statsSpamCount: typeof meta.stats_spam_count === 'number' ? meta.stats_spam_count : undefined,
      statsInvitesCount: typeof meta.stats_invites_count === 'number' ? meta.stats_invites_count : undefined,
      extraParams: meta.extra_params !== undefined ? normalizeExtra(meta.extra_params) : undefined,
    },
  };
}

const trackingSessionZipImportService = {
  /**
   * Imports a ZIP of paired `<name>.session` + `<name>.json` files (the
   * common session-selling-tool export format). Each pair is processed
   * independently — one malformed pair doesn't fail the batch. An
   * existing non-deleted account with a matching phone number is
   * updated; otherwise a new one is created. The session file itself is
   * never parsed or connected to — only stored as an opaque attachment.
   */
  async importZip(userId, zipFile) {
    const { pairs, tempDir } = await extractZip(zipFile.path);
    const results = { created: 0, updated: 0, total: pairs.size, errors: [] };

    try {
      for (const [key, pair] of pairs) {
        try {
          if (!pair.sessionPath) throw new Error('Missing .session file for this entry');
          if (!pair.jsonPath) throw new Error('Missing metadata .json file for this entry');

          let meta;
          try {
            meta = JSON.parse(await fs.readFile(pair.jsonPath, 'utf8'));
          } catch (err) {
            throw new Error(`Invalid JSON metadata: ${err.message}`);
          }

          const mapped = mapMetadata(meta);
          const existing = await findAccountByPhone(mapped.phone);

          let account;
          let isNew = false;
          if (existing) {
            account = await trackingAccountService.updateAccount(userId, existing.id, mapped.basic);
          } else {
            account = await trackingAccountService.createAccount(userId, mapped.basic);
            isNew = true;
          }

          // Move the extracted session file out of the temp extraction dir
          // (which gets wiped in `finally`) into permanent tracking
          // storage before recording it as an attachment — attachment
          // rows store the path directly, they don't copy on write.
          const permDir = path.join(uploadDir, String(userId), 'tracking', String(account.id));
          await fs.ensureDir(permDir);
          const permPath = path.join(permDir, `${uuidv4()}.session`);
          await fs.move(pair.sessionPath, permPath, { overwrite: true });
          const sessionFileStat = await fs.stat(permPath);
          await trackingSessionInfoService.attachSessionFile(account.id, userId, {
            originalname: pair.originalSessionName || `${key}.session`,
            path: permPath,
            size: sessionFileStat.size,
            mimetype: 'application/octet-stream',
          });
          await trackingSessionInfoService.upsert(account.id, mapped.session);

          if (mapped.security.twoFaPassword !== undefined) {
            await trackingSecurityService.upsert(account.id, mapped.security);
          }
          await trackingTelegramMetaService.upsert(account.id, mapped.telegramMeta);

          if (isNew) results.created++; else results.updated++;
        } catch (err) {
          results.errors.push({ file: key, error: err.message || 'Unknown error' });
        }
      }
    } finally {
      await fs.remove(tempDir).catch(() => {});
      await fs.remove(zipFile.path).catch(() => {});
    }

    return results;
  },
};

module.exports = trackingSessionZipImportService;
