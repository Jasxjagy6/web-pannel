/**
 * CupidBotService — HTTP client for the CupidBot downstream chat API.
 *
 * Endpoint: POST https://chat-api.cupidbotofm.ai/api/generateChatResponse
 * Docs:     https://cupidbot.apidog.io/api-7537406
 *
 * The access token is read from process.env.CUPIDBOT_ACCESS_TOKEN and is
 * never exposed to the frontend.
 *
 * Uses Node's built-in https module so the feature works even when the
 * node_modules tree is not yet populated.
 */

const https = require('https');
const { URL } = require('url');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_ENDPOINT = 'https://chat-api.cupidbotofm.ai/api/generateChatResponse';
const ADMIN_ACCESS_TOKEN = process.env.CUPIDBOT_ACCESS_TOKEN || '';
const ENDPOINT_URL = process.env.CUPIDBOT_ENDPOINT_URL || DEFAULT_ENDPOINT;
const MAX_RETRIES = 3;

// Short-lived in-memory cache for env-token validation so we don't hit
// CupidBot on every message. Keyed on process lifetime only.
const ENV_KEY_CACHE_TTL_MS = 5 * 60 * 1000;
const _envKeyCache = { value: null, expiresAt: 0 };

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function _requestJson(url, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: 60000,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          if (data.trim()) json = JSON.parse(data);
        } catch (err) {
          return reject(new Error(`Invalid JSON from CupidBot: ${err.message}`));
        }
        resolve({ statusCode: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CupidBot request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

class CupidBotService {
  /**
   * Resolve the env-supplied CupidBot token with a short-lived validation
   * cache. Validation runs lazily on first use and is reused for
   * ENV_KEY_CACHE_TTL_MS across subsequent calls.
   */
  async _resolveEnvKey() {
    if (!ADMIN_ACCESS_TOKEN) {
      throw new Error('CUPIDBOT_ACCESS_TOKEN is not configured');
    }
    const now = Date.now();
    if (_envKeyCache.value && _envKeyCache.expiresAt > now) {
      return _envKeyCache.value;
    }
    const isValid = await this.validateApiKey(ADMIN_ACCESS_TOKEN);
    _envKeyCache.value = { token: ADMIN_ACCESS_TOKEN, isValid };
    _envKeyCache.expiresAt = now + ENV_KEY_CACHE_TTL_MS;
    return _envKeyCache.value;
  }

  /**
   * Resolve the CupidBot access token for a user.
   *
   * Resolution order:
   *   1. Per-user key from `user_cupidbot_keys` (always wins).
   *   2. For users with `role IN ('admin','superadmin')`, fall back to
   *      `process.env.CUPIDBOT_ACCESS_TOKEN` (validated lazily, cached).
   *   3. Otherwise throw so the UI can prompt for a key.
   */
  async getAccessToken(userId) {
    const uid = Number(userId);
    if (!uid) {
      throw new Error('User ID is required to resolve CupidBot API key');
    }

    const { rows } = await pool.query(
      `SELECT api_key, is_valid FROM user_cupidbot_keys WHERE user_id = $1`,
      [uid]
    );
    if (rows.length && rows[0].api_key) {
      return { token: rows[0].api_key, source: 'user', isValid: rows[0].is_valid };
    }

    const userRes = await pool.query(
      `SELECT role FROM users WHERE id = $1`,
      [uid]
    );
    const role = userRes.rows[0] && userRes.rows[0].role;
    if (role === 'admin' || role === 'superadmin') {
      const envKey = await this._resolveEnvKey();
      return { token: envKey.token, source: 'admin', isValid: envKey.isValid };
    }

    throw new Error('CupidBot API key is not configured. Please add your API key in the AI menu.');
  }

  /**
   * Store or update a user's CupidBot API key.
   */
  async setUserApiKey(userId, apiKey) {
    const uid = Number(userId);
    if (!uid) throw new Error('User ID is required');
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('API key is required');
    }
    const key = apiKey.trim();

    // Validate by calling CupidBot with a tiny payload.
    const isValid = await this.validateApiKey(key);

    await pool.query(
      `INSERT INTO user_cupidbot_keys (user_id, api_key, is_valid, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET api_key = EXCLUDED.api_key,
           is_valid = EXCLUDED.is_valid,
           updated_at = NOW()`,
      [uid, key, isValid]
    );

    return { userId: uid, isValid };
  }

  /**
   * Validate an API key with a lightweight CupidBot call.
   *
   * We send a minimal but realistic payload. The only definitive "bad key"
   * signal from CupidBot is HTTP 401/403. Other status codes (200, 400 for
   * malformed params, 429 for rate-limit, 5xx for server issues) are treated
   * as the key being accepted by CupidBot's auth layer, so we don't block
   * users because of API-side validation quirks.
   */
  async validateApiKey(apiKey) {
    const body = {
      accessToken: apiKey,
      version: '0.19.0',
      manifestVersion: '0.19.0',
      isAPI: true,
      app: 'telegram',
      brand: 'cupidbotofm',
      product: 'ofm-tg',
      isOF: true,
      isFemale: true,
      accountID: 'validation',
      platformSource: 'telegram',
      responseLanguageCode: 'en',
      isFollowUp: false,
      settingDayInfo: 'Just lounging around, waiting for a reply',
      settingNightInfo: 'Just winding down, waiting for a reply',
      name: 'Test Model',
      age: 25,
      userInfo: 'You are a friendly test model',
      city: 'New York',
      ctaInfo: 'Page subscription details will be provided later',
      chooseRandomCTA: false,
      useDefaultSettings: true,
      showAdvancedSettings: false,
      ctaData: [{ platform: 'onlyfans', cta: 'check my link' }],
      chatStyle: 'youth',
      responseLanguage: 'english',
      recipient: { id: '0', name: 'John Smith', username: 'john_smith2', bio: 'Hiking and my two cats', location: 'New York' },
      messages: [
        {
          id: '1',
          timestamp: Math.floor(Date.now() / 1000),
          msg: 'hi',
          isIncoming: true,
          medias: [],
        },
      ],
    };

    try {
      const res = await _requestJson(ENDPOINT_URL, body);
      logger.debug(
        `CupidBot key validation status=${res.statusCode} body=${
          res.data ? JSON.stringify(res.data).slice(0, 200) : 'empty'
        }`
      );
      if (res.statusCode === 401 || res.statusCode === 403) return false;
      return true;
    } catch (err) {
      logger.warn(`CupidBot key validation request failed: ${err.message}`);
      // Network / timeout failures should not permanently lock a user out of
      // the feature; accept the key and let the real generateReply calls show
      // whether it actually works.
      return true;
    }
  }

  /**
   * Delete a user's stored CupidBot API key.
   */
  async deleteUserApiKey(userId) {
    const uid = Number(userId);
    if (!uid) throw new Error('User ID is required');
    await pool.query(`DELETE FROM user_cupidbot_keys WHERE user_id = $1`, [uid]);
    return { userId: uid, deleted: true };
  }

  /**
   * Generate an AI reply for a conversation.
   *
   * CRITICAL: Per CupidBot API docs, we must send the LAST EXCHANGE of messages
   * to confirm delivery of previous AI messages. The API maintains its own
   * conversation state keyed by (accountID, recipient.id).
   *
   * @param {object} params
   * @param {string|number} params.userId - Panel user id for API-key lookup.
   * @param {string|number} params.accountID - Panel session id used as the AI account identifier.
   * @param {object} params.recipient - { id, name, username, bio, location }
   * @param {Array<object>} params.messages - Full conversation memory (max 100), each item:
   *   { id, timestamp, msg, isIncoming, medias, confirmed? }
   * @param {object} [params.overrides] - Optional CupidBot payload overrides.
   * @param {boolean} [params.isFollowUp] - Whether this is a follow-up (no new user message).
   * @param {Array<string>} [params.confirmedMessageIds] - IDs of AI messages confirmed delivered.
   * @returns {Promise<{ text: string|null, media: object|null, didConvert: boolean, category: string|null, rateLimit: object|null, statusCode: number }>}
   */
  async generateReply({
    userId,
    accountID,
    recipient,
    messages,
    overrides = {},
    isFollowUp = false,
    confirmedMessageIds = [],
    botProfile = {},
  }) {
    const { token: accessToken } = await this.getAccessToken(userId);

    // Per CupidBot docs: only send the LAST EXCHANGE to confirm previous AI messages
    // and include any new incoming messages.
    // The API will use this to align with its internal database.
    const messagesToSend = this._buildMessagePayload(messages, confirmedMessageIds, isFollowUp);

    // Use bot's actual Telegram profile name, fallback to overrides or default
    const botName = botProfile?.name || overrides.name || 'Test Model';
    const botFirstName = botProfile?.firstName || '';
    const botLastName = botProfile?.lastName || '';

    // Build dynamic userInfo based on bot's actual profile
    const dynamicUserInfo = botName && botName !== 'Test Model'
      ? `Your name is ${botName}. ${overrides.userInfo || 'You are a friendly and engaging model.'}`
      : (overrides.userInfo || 'You are a friendly test model');

    const body = {
      accessToken,
      version: overrides.version || '0.19.0',
      manifestVersion: overrides.manifestVersion || '0.19.0',
      isAPI: true,
      app: 'telegram',
      brand: overrides.brand || 'cupidbotofm',
      product: overrides.product || 'ofm-tg',
      isOF: overrides.isOF !== false,
      isFemale: true,
      accountID: String(accountID),
      platformSource: 'telegram',
      responseLanguageCode: 'en',
      responseLanguage: 'english',
      isFollowUp,
      name: botName,
      age: overrides.age || 25,
      userInfo: dynamicUserInfo,
      city: overrides.city || recipient.location || 'New York',
      ctaInfo: overrides.ctaInfo || 'Page subscription details will be provided later',
      chooseRandomCTA: false,
      useDefaultSettings: true,
      showAdvancedSettings: false,
      ctaData: overrides.ctaData || [{ platform: 'onlyfans', cta: 'check my link' }],
      settingDayInfo: overrides.settingDayInfo || 'Just lounging around, waiting for a reply',
      settingNightInfo: overrides.settingNightInfo || 'Just winding down, waiting for a reply',
      recipient: {
        id: String(recipient.id || ''),
        name: recipient.name || '',
        username: recipient.username || '',
        bio: recipient.bio || '',
        location: recipient.location || '',
      },
      messages: messagesToSend,
      ...overrides,
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await _requestJson(ENDPOINT_URL, body);

        if (res.statusCode === 200 && res.data) {
          const option = res.data.options?.[0]?.[0];
          return {
            statusCode: res.statusCode,
            text: option?.msg || null,
            media: option?.media || null,
            didConvert: !!res.data.didConvert,
            category: res.data.category || null,
            rateLimit: res.data.rateLimit || null,
            rawResponse: res.data,
          };
        }

        lastErr = new Error(
          `CupidBot ${res.statusCode}: ${res.data ? JSON.stringify(res.data) : 'empty body'}`
        );
        lastErr.statusCode = res.statusCode;
        lastErr.responseData = res.data;

        // Retry on rate limit or server errors
        if (res.statusCode === 429 || res.statusCode >= 500) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }

        throw lastErr;
      } catch (err) {
        lastErr = err;
        logger.warn(`CupidBot request failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
        if (attempt < MAX_RETRIES - 1) {
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }

    throw lastErr;
  }

  /**
   * Build the messages payload for CupidBot API.
   *
   * Per docs: We should only send the last exchange (last AI messages + new user messages).
   * The API uses this to confirm delivery of previous AI messages and get new user messages.
   * We also need to track which of our AI messages have been confirmed delivered.
   */
  _buildMessagePayload(messages, confirmedMessageIds, isFollowUp) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return [];
    }

    // Filter to get messages that need to be sent to CupidBot:
    // 1. Unconfirmed outgoing (AI) messages
    // 2. New incoming messages since last call
    // 3. For follow-up, we send empty array but with isFollowUp=true

    if (isFollowUp) {
      return [];
    }

    // Find the last confirmed outgoing message index
    const confirmedSet = new Set(confirmedMessageIds.map(String));

    // We need to send:
    // - Any outgoing AI messages that haven't been confirmed yet
    // - All incoming messages after the last confirmed outgoing message
    const result = [];
    let lastConfirmedIndex = -1;

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const msgId = String(m.id);
      if (!m.isIncoming && confirmedSet.has(msgId)) {
        lastConfirmedIndex = i;
      }
    }

    // Send unconfirmed outgoing messages + all incoming messages after last confirmed
    for (let i = lastConfirmedIndex + 1; i < messages.length; i++) {
      const m = messages[i];
      result.push({
        id: String(m.id),
        timestamp: Math.floor((m.timestamp || Date.now()) / 1000),
        msg: m.msg || '',
        isIncoming: !!m.isIncoming,
        medias: (m.medias || []).map((md) => ({
          url: md.url || '',
          fileType: md.fileType || 'photo',
          caption: md.caption || '',
          duration: md.duration || 0,
        })),
      });
    }

    return result;
  }

  /**
   * Parse CupidBot response category and handle special cases.
   */
  parseResponseCategory(category) {
    const interventionReasons = {
      isTmpGhosted: 'The guy did not subscribe after all phase loops, the bot is now ghosting forever.',
      stopMessaging: 'This conversation has been deemed highly unlikely to convert, the bot is now ghosting forever.',
      wordSpam: 'The guy is spamming us with too many words, likely because he has realized he is talking to an AI bot and wants to waste compute.',
      promptSpam: 'The guy is trying to hijack our prompt, likely because he has realized he is talking to an AI bot and wants to waste compute.',
      charSpam: 'The guy is spamming us with too many characters, likely because he has realized he is talking to an AI bot and wants to waste compute.',
      glitchedText: 'The guy is spamming us with glitched symbols, likely because he has realized he is talking to an AI bot and wants to waste compute.',
      tooLong: 'The guy\'s response was too long, likely because he has realized he is talking to an AI bot and wants to waste compute.',
      notOurTurn: 'It\'s not our turn to generate a response because the last message is not from the guy.',
      messagingFromAnotherAccount: 'You are messaging this guy already from another account with the same model, you can adjust this setting in Miscellaneous settings.',
      underage: 'The recipient is underage, the bot is now ghosting forever.',
      ghostAfterMassMessage: 'A mass message CTA has been sent to this conversation, the bot is now ghosting forever.',
      filteredGender: 'The recipient is not of the preferred gender, the bot is now ghosting forever.',
      filteredTier: 'The recipient is not of the preferred country tier, the bot is now ghosting forever.',
      botRecipient: 'The recipient is another bot, we are now ghosting forever.',
    };

    return {
      category,
      isGhosting: category && Object.keys(interventionReasons).includes(category),
      isNotOurTurn: category === 'notOurTurn',
      reason: category ? interventionReasons[category] : null,
    };
  }
}

module.exports = new CupidBotService();