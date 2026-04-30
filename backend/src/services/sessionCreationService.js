/**
 * SessionCreationService — Upgrade 5
 *
 * Implements an interactive "Create Session" flow:
 *
 *   1. start({ phone, apiId?, apiHash? })
 *        Opens a fresh GramJS TelegramClient against an empty StringSession,
 *        connects, calls auth.SendCode, and remembers
 *          { tempId, client, phoneCodeHash, phone, apiId, apiHash }
 *        in an in-memory map keyed by `tempId`. The map auto-evicts entries
 *        older than CREATION_TTL_MS (default 5 minutes) so that a user who
 *        abandons the flow doesn't leak Telegram clients.
 *
 *   2. verify({ tempId, code })
 *        Calls auth.SignIn with the stored phoneCodeHash. If Telegram replies
 *        with SESSION_PASSWORD_NEEDED the entry stays in the map and the
 *        caller is told `{ status: 'awaiting_password' }`. Otherwise the
 *        session is persisted (encrypted JSON file + DB row) and the entry
 *        is dropped.
 *
 *   3. password({ tempId, password })
 *        Calls client.checkPassword via Api.auth.CheckPassword and persists
 *        the session on success.
 *
 *   4. resend({ tempId })
 *        Calls auth.ResendCode and refreshes the stored phoneCodeHash.
 *
 *   5. cancel({ tempId })
 *        Tears down the temporary client and removes the map entry.
 *
 * Persisted sessions are written to the same on-disk format used by
 * sessionService for uploaded GramJS string sessions, namely
 *   `<uploadDir>/<userId>/sessions/<uuid>.json`
 * with body
 *   { session: <encrypted gramjs string>, createdAt, originalName }
 *
 * The DB row is inserted with status='active', is_logged_in=true, and
 * keep_alive=true so that the heartbeat loop (Upgrade 1) immediately
 * adopts it. The freshly-built TelegramClient is also reused via
 * telegramService.adoptClient so we don't reconnect twice in a row.
 */

const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { TelegramClient, Api } = require('telegram');
const { StringSession } = require('telegram/sessions');

const { pool } = require('../config/database');
const telegramConfig = require('../config/telegram');
const { uploadDir } = require('../middleware/upload');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const telegramService = require('./telegramService');

const SESSION_SUBDIR = 'sessions';
const CREATION_TTL_MS = parseInt(process.env.SESSION_CREATION_TTL_MS || `${5 * 60 * 1000}`, 10);

class SessionCreationService {
  constructor() {
    /** @type {Map<string, {
     *    client: any,
     *    phoneCodeHash: string,
     *    phone: string,
     *    apiId: number,
     *    apiHash: string,
     *    userId: number,
     *    createdAt: number,
     *    awaitingPassword: boolean,
     *  }>} */
    this.pending = new Map();
    this._reaper = setInterval(() => this._reapStale(), 60 * 1000);
    if (this._reaper.unref) this._reaper.unref();
  }

  /** Reap stale entries to avoid leaking Telegram clients. */
  async _reapStale() {
    const now = Date.now();
    for (const [tempId, entry] of this.pending.entries()) {
      if (now - entry.createdAt > CREATION_TTL_MS) {
        try {
          await entry.client.disconnect();
        } catch (err) {
          // ignore
        }
        this.pending.delete(tempId);
        logger.info(`Session creation flow ${tempId} expired`);
      }
    }
  }

  _newTempId() {
    return crypto.randomBytes(16).toString('hex');
  }

  _normalizePhone(phone) {
    const trimmed = String(phone || '').trim();
    if (!trimmed) {
      throw new AppError('Phone number is required', 400, 'PHONE_REQUIRED');
    }
    // Allow leading + and digits, strip everything else.
    const cleaned = trimmed.replace(/[^\d+]/g, '');
    if (!/^\+?\d{6,15}$/.test(cleaned)) {
      throw new AppError(
        'Phone number must be in international format (e.g. +14155551234)',
        400,
        'PHONE_INVALID'
      );
    }
    return cleaned.startsWith('+') ? cleaned : `+${cleaned}`;
  }

  _resolveApi(apiId, apiHash) {
    const id = Number(apiId) || telegramConfig.apiId;
    const hash = String(apiHash || telegramConfig.apiHash || '');
    if (!id || !hash) {
      throw new AppError(
        'Telegram API ID/Hash not configured',
        500,
        'TELEGRAM_API_NOT_CONFIGURED'
      );
    }
    return { apiId: id, apiHash: hash };
  }

  _userSessionDir(userId) {
    return path.join(uploadDir, String(userId), SESSION_SUBDIR);
  }

  // ---------------------------------------------------------------------------
  // Step 1: start — sendCode
  // ---------------------------------------------------------------------------
  async start({ userId, phone, apiId, apiHash }) {
    const normalizedPhone = this._normalizePhone(phone);
    const { apiId: id, apiHash: hash } = this._resolveApi(apiId, apiHash);

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, id, hash, {
      connectionRetries: telegramConfig.connectionRetries,
      timeout: telegramConfig.timeout,
      deviceModel: telegramConfig.deviceModel,
      systemVersion: telegramConfig.systemVersion,
      appVersion: telegramConfig.appVersion,
      langCode: telegramConfig.langCode,
      baseLogger: telegramConfig.baseLogger,
      useWSS: telegramConfig.useWSS,
    });

    try {
      await client.connect();
      const sent = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber: normalizedPhone,
          apiId: id,
          apiHash: hash,
          settings: new Api.CodeSettings({}),
        })
      );

      const tempId = this._newTempId();
      this.pending.set(tempId, {
        client,
        phoneCodeHash: sent.phoneCodeHash,
        phone: normalizedPhone,
        apiId: id,
        apiHash: hash,
        userId,
        createdAt: Date.now(),
        awaitingPassword: false,
      });

      logger.info(`Session creation start: tempId=${tempId} phone=${normalizedPhone}`);
      return {
        tempId,
        status: 'awaiting_code',
        phone: normalizedPhone,
        codeType: sent.type ? sent.type.className : 'unknown',
        nextType: sent.nextType ? sent.nextType.className : null,
        timeout: sent.timeout || null,
      };
    } catch (err) {
      try { await client.disconnect(); } catch (_) {}
      logger.error('Session creation start failed', { phone: normalizedPhone, err: err.message });
      throw new AppError(
        `Failed to send code: ${err.errorMessage || err.message}`,
        400,
        'SEND_CODE_FAILED'
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2: verify — signIn with code
  // ---------------------------------------------------------------------------
  async verify({ userId, tempId, code }) {
    const entry = this._mustGet(userId, tempId);
    if (!code || String(code).trim().length === 0) {
      throw new AppError('OTP code is required', 400, 'CODE_REQUIRED');
    }
    const trimmedCode = String(code).replace(/\s+/g, '');
    try {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: trimmedCode,
        })
      );
      // Success — no 2FA required.
      return await this._persistAndFinish(userId, tempId, false);
    } catch (err) {
      const msg = err && (err.errorMessage || err.message) || '';
      if (/SESSION_PASSWORD_NEEDED/i.test(msg)) {
        entry.awaitingPassword = true;
        logger.info(`Session creation ${tempId} requires 2FA password`);
        return { tempId, status: 'awaiting_password' };
      }
      logger.warn(`Session creation verify failed for ${tempId}: ${msg}`);
      throw new AppError(`Verification failed: ${msg || 'unknown'}`, 400, 'VERIFY_FAILED');
    }
  }

  // ---------------------------------------------------------------------------
  // Step 2b: password — checkPassword for 2FA
  // ---------------------------------------------------------------------------
  async password({ userId, tempId, password }) {
    const entry = this._mustGet(userId, tempId);
    if (!entry.awaitingPassword) {
      throw new AppError(
        'This session is not awaiting a 2FA password',
        409,
        'NOT_AWAITING_PASSWORD'
      );
    }
    if (!password || String(password).length === 0) {
      throw new AppError('2FA password is required', 400, 'PASSWORD_REQUIRED');
    }
    try {
      await entry.client.checkPassword(String(password));
      return await this._persistAndFinish(userId, tempId, true);
    } catch (err) {
      const msg = err && (err.errorMessage || err.message) || '';
      logger.warn(`Session creation password failed for ${tempId}: ${msg}`);
      throw new AppError(`2FA failed: ${msg || 'unknown'}`, 400, 'PASSWORD_FAILED');
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3a: resend — auth.ResendCode
  // ---------------------------------------------------------------------------
  async resend({ userId, tempId }) {
    const entry = this._mustGet(userId, tempId);
    try {
      const sent = await entry.client.invoke(
        new Api.auth.ResendCode({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
        })
      );
      entry.phoneCodeHash = sent.phoneCodeHash;
      entry.createdAt = Date.now();
      return {
        tempId,
        status: 'awaiting_code',
        codeType: sent.type ? sent.type.className : 'unknown',
        timeout: sent.timeout || null,
      };
    } catch (err) {
      const msg = err && (err.errorMessage || err.message) || '';
      throw new AppError(`Resend failed: ${msg}`, 400, 'RESEND_FAILED');
    }
  }

  // ---------------------------------------------------------------------------
  // Step 3b: cancel — tear down the temp client
  // ---------------------------------------------------------------------------
  async cancel({ userId, tempId }) {
    const entry = this.pending.get(tempId);
    if (!entry || entry.userId !== userId) {
      // 404 silently is friendlier here.
      return { cancelled: false };
    }
    try { await entry.client.disconnect(); } catch (_) {}
    this.pending.delete(tempId);
    return { cancelled: true };
  }

  _mustGet(userId, tempId) {
    const entry = this.pending.get(tempId);
    if (!entry) {
      throw new AppError(
        'Session creation flow not found or expired',
        404,
        'FLOW_NOT_FOUND'
      );
    }
    if (entry.userId !== userId) {
      throw new AppError('Forbidden', 403, 'FLOW_FORBIDDEN');
    }
    return entry;
  }

  // ---------------------------------------------------------------------------
  // Persist a successfully-authenticated client.
  // ---------------------------------------------------------------------------
  async _persistAndFinish(userId, tempId, hadTwoFA) {
    const entry = this._mustGet(userId, tempId);
    const { client, phone, apiId, apiHash } = entry;

    // Pull user info + session string before we hand the client off.
    let me = null;
    try {
      me = await client.getMe();
    } catch (err) {
      logger.warn(`getMe after creation failed for ${tempId}: ${err.message}`);
    }
    const sessionString = client.session.save();
    if (!sessionString || sessionString.length < 10) {
      throw new AppError('Failed to extract session string from client', 500, 'NO_SESSION');
    }
    const encryptedSession = encrypt(sessionString);

    // Write the session file to disk, then insert the DB row.
    const sessionDir = this._userSessionDir(userId);
    await fs.ensureDir(sessionDir);
    const fileUuid = uuidv4();
    const filePath = path.join(sessionDir, `${fileUuid}.json`);
    const relativePath = path.relative(uploadDir, filePath);
    await fs.writeFile(
      filePath,
      JSON.stringify({
        session: encryptedSession,
        createdAt: new Date().toISOString(),
        originalName: `${phone}.json`,
        createdVia: 'panel',
      }),
      'utf8'
    );

    const accountInfo = me
      ? {
          telegramId: typeof me.id === 'object' && me.id !== null && 'value' in me.id ? Number(me.id.value) : Number(me.id),
          username: me.username || null,
          firstName: me.firstName || null,
          lastName: me.lastName || null,
          phone: me.phone || phone.replace(/^\+/, ''),
          isPremium: !!me.premium,
          isVerified: !!me.verified,
        }
      : { phone: phone.replace(/^\+/, '') };

    const insert = await pool.query(
      `INSERT INTO sessions (
         user_id, phone, session_file_path, api_id, api_hash,
         status, is_2fa_enabled, is_logged_in, keep_alive, account_info,
         last_heartbeat, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, 'active', $6, TRUE, TRUE, $7, NOW(), NOW(), NOW())
       RETURNING id`,
      [
        userId,
        phone,
        relativePath,
        apiId,
        apiHash,
        hadTwoFA,
        JSON.stringify({
          ...accountInfo,
          sessionType: 'string',
          createdVia: 'panel',
          createdAt: new Date().toISOString(),
        }),
      ]
    );
    const sessionId = insert.rows[0].id;

    // Adopt the live, already-connected client into telegramService so we
    // don't immediately reconnect. If adoption fails we just disconnect and
    // let the next heartbeat / login restore it from disk.
    try {
      telegramService.clients.set(String(sessionId), {
        client,
        connected: true,
        apiId,
        apiHash,
      });
      telegramService.sessionStore.set(String(sessionId), encryptedSession);
    } catch (err) {
      logger.warn(`adoptClient failed for new session ${sessionId}: ${err.message}`);
      try { await client.disconnect(); } catch (_) {}
    }

    // Also assign a proxy slot so future reconnects route through the same
    // pool as login flows do. This call lives outside the original
    // transaction so it won't deadlock.
    try {
      const proxyService = require('./proxyService');
      await proxyService.assignProxyForSession(sessionId);
    } catch (err) {
      logger.debug(`proxy assign post-creation skipped: ${err.message}`);
    }

    this.pending.delete(tempId);
    logger.info(`Session creation finished: sessionId=${sessionId} phone=${phone}`);

    return {
      sessionId,
      status: 'active',
      phone,
      accountInfo,
    };
  }
}

const instance = new SessionCreationService();
module.exports = instance;
