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
 *        Runs the MTProto SRP flow (GetPassword -> computeCheck ->
 *        CheckPassword) against the stored client and persists the session
 *        on success.
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
const { computeCheck: gramjsComputeCheck } = require('telegram/Password');

const { pool } = require('../config/database');
const telegramConfig = require('../config/telegram');
const { uploadDir } = require('../middleware/upload');
const { encrypt } = require('../utils/crypto');
const logger = require('../utils/logger');
const { AppError } = require('../utils/errorHandler');
const telegramService = require('./telegramService');
const fingerprint = require('../utils/deviceFingerprint');

const SESSION_SUBDIR = 'sessions';
const CREATION_TTL_MS = parseInt(process.env.SESSION_CREATION_TTL_MS || `${5 * 60 * 1000}`, 10);
const STRICT_PROXY_ISOLATION = String(
  process.env.STRICT_PROXY_ISOLATION ?? 'false'
).toLowerCase() === 'true';

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
        if (entry.reservedProxyId) {
          try {
            const proxyService = require('./proxyService');
            await proxyService.releaseAdHoc(`creation:${tempId}`);
          } catch (_) {}
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

  /**
   * Pick the Telegram API credential the new session should be minted
   * under. v8 changed this from "use the panel-wide TELEGRAM_API_ID
   * env-var" to "pick one of the user's per-user credentials, rotating
   * by max_sessions". The caller may still pass an explicit
   * `apiId/apiHash` override (used when re-trying a flow under a
   * specific credential) but in the common case we just call
   * `userApiCredentialsService.pickForNewSession(userId)`.
   *
   * Returns `{ apiId, apiHash, credentialId }`. `credentialId` is null
   * when falling back to env-vars (legacy / admin path).
   */
  async _resolveApi(userId, apiId, apiHash) {
    if (apiId && apiHash) {
      return {
        apiId: Number(apiId),
        apiHash: String(apiHash),
        credentialId: null,
      };
    }
    if (userId) {
      try {
        const userApiCredentials = require('./userApiCredentialsService');
        const pick = await userApiCredentials.pickForNewSession(userId);
        return {
          apiId: pick.apiId,
          apiHash: pick.apiHash,
          credentialId: pick.id,
        };
      } catch (err) {
        // pickForNewSession throws either API_CREDENTIALS_REQUIRED or
        // NO_CREDENTIAL_CAPACITY — surface those verbatim. Anything
        // else falls through to the env-var legacy path so admins can
        // still bootstrap without per-user credentials.
        if (err && (err.code === 'API_CREDENTIALS_REQUIRED' || err.code === 'NO_CREDENTIAL_CAPACITY')) {
          throw err;
        }
        logger.warn(`pickForNewSession failed for user ${userId}: ${err.message}; falling back to env`);
      }
    }
    const id = Number(apiId) || telegramConfig.apiId;
    const hash = String(apiHash || telegramConfig.apiHash || '');
    if (!id || !hash) {
      throw new AppError(
        'Telegram API ID/Hash not configured. Add credentials in Settings.',
        412,
        'API_CREDENTIALS_REQUIRED'
      );
    }
    return { apiId: id, apiHash: hash, credentialId: null };
  }

  _userSessionDir(userId) {
    return path.join(uploadDir, String(userId), SESSION_SUBDIR);
  }

  // ---------------------------------------------------------------------------
  // Step 1: start — sendCode
  // ---------------------------------------------------------------------------
  async start({ userId, phone, apiId, apiHash, country, platform, proxyId, userRole }) {
    const normalizedPhone = this._normalizePhone(phone);
    const { apiId: id, apiHash: hash, credentialId } =
      await this._resolveApi(userId, apiId, apiHash);

    // Anti-Detect: build the device identity that this account will use
    // for the rest of its life. The seed includes the phone so a re-tried
    // creation flow for the same phone keeps the same identity.
    //
    // Anti-revoke (Phase 1 §B2): the `country` field from the create
    // form is forwarded so langCode + timezone match the proxy region.
    // The `platform` filter (e.g. 'android'|'ios'|'desktop') lets the
    // user opt for a specific device profile pool.
    const tempId = this._newTempId();
    const allProfiles = fingerprint.PROFILES || [];
    let chosenProfile = null;
    if (platform && allProfiles.length) {
      const matches = allProfiles.filter(
        (p) => String(p.platform).toLowerCase() === String(platform).toLowerCase()
      );
      if (matches.length) {
        // Deterministic pick from the filtered pool (seed = phone).
        const seed = `creation:${normalizedPhone}:${tempId}`;
        chosenProfile = fingerprint.pickProfileForSeed
          ? matches[Math.abs(seed.length) % matches.length]
          : matches[0];
      }
    }
    const identity = fingerprint.buildIdentity(chosenProfile, {
      seed: `creation:${normalizedPhone}:${tempId}`,
      country: country ? String(country).toLowerCase() : null,
    });

    // Anti-Detect: try to allocate a proxy slot up-front so the SendCode
    // request itself doesn't leak the VPS direct IP. We don't have a DB
    // session row yet, so we reserve a "virtual" slot keyed by tempId.
    let proxyConf = null;
    let reservedProxyId = null;
    let proxyError = null;
    try {
      const proxyService = require('./proxyService');
      const reserved = await proxyService.reserveAdHoc(
        `creation:${tempId}`,
        { userId, role: userRole || null, proxyId: proxyId || null }
      );
      if (reserved) {
        reservedProxyId = reserved.id;
        proxyConf = proxyService.buildGramJSProxy(reserved);
      }
    } catch (err) {
      // BYO Proxy (Phase 2): bubble up NO_USER_PROXY / PROXY_PIN_UNAVAILABLE
      // so the controller returns 412 to the UI instead of leaking the
      // direct VPS IP in a 200 response.
      if (err && (err.code === 'NO_USER_PROXY' || err.code === 'PROXY_PIN_UNAVAILABLE')) {
        proxyError = err;
      } else {
        logger.debug(`pre-create proxy reserve skipped: ${err.message}`);
      }
    }

    if (proxyError) throw proxyError;

    if (!proxyConf && STRICT_PROXY_ISOLATION) {
      throw new AppError(
        'No proxy available for new session (STRICT_PROXY_ISOLATION=true). ' +
          'Add a working proxy in the Proxies page first.',
        503,
        'NO_PROXY_AVAILABLE'
      );
    }

    const stringSession = new StringSession('');
    const client = new TelegramClient(stringSession, id, hash, {
      connectionRetries: telegramConfig.connectionRetries,
      timeout: telegramConfig.timeout,
      deviceModel: identity.deviceModel,
      systemVersion: identity.systemVersion,
      appVersion: identity.appVersion,
      langCode: identity.langCode,
      systemLangCode: identity.systemLangCode || identity.langCode,
      baseLogger: telegramConfig.baseLogger,
      useWSS: proxyConf ? false : telegramConfig.useWSS,
      proxy: proxyConf || undefined,
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

      this.pending.set(tempId, {
        client,
        phoneCodeHash: sent.phoneCodeHash,
        phone: normalizedPhone,
        apiId: id,
        apiHash: hash,
        credentialId,
        userId,
        createdAt: Date.now(),
        awaitingPassword: false,
        identity,
        proxyConf,
        reservedProxyId,
      });

      logger.info(`Session creation start: tempId=${tempId} phone=${normalizedPhone} platform=${identity.platform}`);
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
      // Release the reserved proxy slot if SendCode failed.
      if (reservedProxyId) {
        try {
          const proxyService = require('./proxyService');
          await proxyService.releaseAdHoc(`creation:${tempId}`);
        } catch (_) {}
      }
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

    // Idempotency: if the client is already authorized (i.e. a previous
    // verify call succeeded the SignIn step but failed during persistence,
    // e.g. because of a transient DB error), don't call SignIn again — that
    // would either fail with PHONE_CODE_EXPIRED or charge the user for a
    // re-send. Just retry the persistence step.
    let alreadyAuthorized = false;
    try {
      alreadyAuthorized = await entry.client.isUserAuthorized();
    } catch (_) {
      alreadyAuthorized = false;
    }
    if (alreadyAuthorized) {
      logger.info(`Session creation ${tempId}: client already authorized, retrying persist`);
      return await this._persistAndFinish(userId, tempId, entry.awaitingPassword);
    }

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
      // GramJS 2.26.x does NOT expose `client.checkPassword` directly. Use the
      // documented MTProto SRP flow: GetPassword -> computeCheck -> CheckPassword.
      const passwordRequest = await entry.client.invoke(
        new Api.account.GetPassword()
      );
      const passwordSrp = await gramjsComputeCheck(
        passwordRequest,
        String(password)
      );
      await entry.client.invoke(
        new Api.auth.CheckPassword({ password: passwordSrp })
      );
      return await this._persistAndFinish(userId, tempId, true);
    } catch (err) {
      const code = (err && (err.errorMessage || err.code)) || '';
      const msg = (err && (err.errorMessage || err.message)) || '';
      logger.warn(`Session creation password failed for ${tempId}: ${msg}`);
      // Surface the most common failure (wrong password) with a 401 so the
      // frontend doesn't conflate it with a server-side bug.
      if (/PASSWORD_HASH_INVALID/i.test(code) || /PASSWORD_HASH_INVALID/i.test(msg)) {
        throw new AppError(
          'The 2FA cloud password is incorrect.',
          401,
          'PASSWORD_HASH_INVALID'
        );
      }
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
    if (entry.reservedProxyId) {
      try {
        const proxyService = require('./proxyService');
        await proxyService.releaseAdHoc(`creation:${tempId}`);
      } catch (_) {}
    }
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
    const { client, phone, apiId, apiHash, credentialId, identity, reservedProxyId, proxyConf } = entry;

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
         user_api_credential_id,
         status, is_2fa_enabled, is_logged_in, keep_alive, account_info,
         device_identity, bound_proxy_id,
         last_heartbeat, last_active, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, TRUE, TRUE, $8, $9::jsonb, $10, NOW(), NOW(), NOW())
       RETURNING id`,
      [
        userId,
        phone,
        relativePath,
        apiId,
        apiHash,
        credentialId || null,
        hadTwoFA,
        JSON.stringify({
          ...accountInfo,
          sessionType: 'string',
          createdVia: 'panel',
          createdAt: new Date().toISOString(),
        }),
        identity ? JSON.stringify(identity) : null,
        reservedProxyId || null,
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
        proxy: proxyConf || null,
        identity: identity || null,
      });
      telegramService.sessionStore.set(String(sessionId), encryptedSession);
    } catch (err) {
      logger.warn(`adoptClient failed for new session ${sessionId}: ${err.message}`);
      try { await client.disconnect(); } catch (_) {}
    }

    // Bind the proxy slot to the new session ID so future reconnects
    // resolve through the same pool. If the start() flow already
    // reserved one we just transfer that reservation; otherwise we let
    // proxyService pick.
    try {
      const proxyService = require('./proxyService');
      if (reservedProxyId) {
        await proxyService.transferAdHocToSession(`creation:${tempId}`, sessionId);
      } else {
        await proxyService.assignProxyForSession(sessionId);
      }
      // BYO Proxy (Phase 2): now that the session is connected through
      // this proxy, mark it as TG-validated so the user UI can render
      // the green "validated for Telegram" chip immediately.
      try {
        const userIdForBind = entry && entry.userId;
        if (userIdForBind && reservedProxyId) {
          const owned = await proxyService.getMyProxy(userIdForBind, reservedProxyId);
          if (owned) {
            await proxyService.validateMyProxyForPlatform(
              userIdForBind, reservedProxyId, 'telegram'
            );
          }
        }
      } catch (validateErr) {
        logger.debug(`validateMyProxyForPlatform skipped: ${validateErr.message}`);
      }
    } catch (err) {
      logger.debug(`proxy assign post-creation skipped: ${err.message}`);
    }

    this.pending.delete(tempId);
    logger.info(`Session creation finished: sessionId=${sessionId} phone=${phone}`);

    // Anti-revoke Phase 4: a brand-new session is by definition in the
    // 24h "unconfirmed" window, so this is the most important call of
    // the whole flow — without it the very next login from the user's
    // phone can wipe the panel session via Telegram's
    // "Terminate other sessions" prompt. We also push the account
    // TTL out so an idle account doesn't auto-prune. Both are
    // best-effort: any non-permanent error is logged and swallowed.
    try {
      await telegramService.hardenSessionAgainstRevocation(String(sessionId));
    } catch (hardenErr) {
      logger.debug(
        `Phase-4 harden failed for new session ${sessionId}: ${hardenErr.message}`
      );
    }

    // Anti-revoke Phase 4: snapshot the encrypted session string to
    // the off-DB backups directory so deleting the row never wipes
    // the only copy of the auth_key. Best-effort.
    try {
      const sessionService = require('./sessionService');
      if (typeof sessionService._writeSessionBackup === 'function') {
        await sessionService._writeSessionBackup(sessionId, 'created').catch(() => {});
      }
    } catch { /* ignore */ }

    // OTP Relay: a brand-new session may already be referenced as a
    // watch source on an attachment that was created before the
    // session existed (rare but possible if the operator pre-creates
    // the row by ID). Pick those up here.
    try {
      const otpRelayService = require('./otpRelayService');
      await otpRelayService.onSessionConnected(String(sessionId)).catch(() => {});
    } catch { /* best-effort */ }

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
