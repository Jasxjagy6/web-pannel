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
   * Resolve the CupidBot access token for a user.
   * Admin (user id 1) falls back to the global env token; all other
   * users must have stored their own key in user_cupidbot_keys.
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

    if (uid === 1) {
      if (!ADMIN_ACCESS_TOKEN) {
        throw new Error('CUPIDBOT_ACCESS_TOKEN is not configured');
      }
      return { token: ADMIN_ACCESS_TOKEN, source: 'admin', isValid: true };
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
   */
  async validateApiKey(apiKey) {
    const body = {
      accessToken: apiKey,
      isAPI: true,
      app: 'telegram',
      brand: 'cupidbotofm',
      isOF: true,
      accountID: 'validation',
      recipient: { id: '0', name: '', username: '', bio: '', location: '' },
      messages: [],
    };

    try {
      const res = await _requestJson(ENDPOINT_URL, body);
      if (res.statusCode === 401 || res.statusCode === 403) return false;
      if (res.statusCode >= 200 && res.statusCode < 300) return true;
      return false;
    } catch (err) {
      logger.debug(`CupidBot key validation request failed: ${err.message}`);
      return false;
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
   * @param {object} params
   * @param {string|number} params.userId - Panel user id for API-key lookup.
   * @param {string|number} params.accountID - Panel session id used as the AI account identifier.
   * @param {object} params.recipient - { id, name, username, bio, location }
   * @param {Array<object>} params.messages - Conversation memory, each item:
   *   { id, timestamp, msg, isIncoming, medias }
   * @param {object} [params.overrides] - Optional CupidBot payload overrides
   *   (app, brand, isOF, chatStyle, responseLanguage, etc.).
   * @returns {Promise<{ text: string|null, media: object|null, didConvert: boolean, category: string|null, rateLimit: object|null }>}
   */
  async generateReply({ userId, accountID, recipient, messages, overrides = {} }) {
    const { token: accessToken } = await this.getAccessToken(userId);

    const body = {
      accessToken,
      isAPI: true,
      app: overrides.app || 'telegram',
      brand: overrides.brand || 'cupidbotofm',
      isOF: overrides.isOF !== false,
      accountID: String(accountID),
      recipient: {
        id: String(recipient.id || ''),
        name: recipient.name || '',
        username: recipient.username || '',
        bio: recipient.bio || '',
        location: recipient.location || '',
      },
      messages: messages.map((m) => ({
        id: String(m.id),
        timestamp: Math.floor(m.timestamp / 1000),
        msg: m.msg || '',
        isIncoming: !!m.isIncoming,
        medias: (m.medias || []).map((md) => ({
          url: md.url || '',
          fileType: md.fileType || 'photo',
          caption: md.caption || '',
          duration: md.duration || 0,
        })),
      })),
      ...overrides,
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await _requestJson(ENDPOINT_URL, body);

        if (res.statusCode === 200 && res.data) {
          const option = res.data.options?.[0]?.[0];
          return {
            text: option?.msg || null,
            media: option?.media || null,
            didConvert: !!res.data.didConvert,
            category: res.data.category || null,
            rateLimit: res.data.rateLimit || null,
          };
        }

        lastErr = new Error(
          `CupidBot ${res.statusCode}: ${res.data ? JSON.stringify(res.data) : 'empty body'}`
        );

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
}

module.exports = new CupidBotService();
