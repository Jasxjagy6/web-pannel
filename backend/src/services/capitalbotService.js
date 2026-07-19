const https = require('https');
const { URL } = require('url');
const { pool } = require('../config/database');
const logger = require('../utils/logger');

const DEFAULT_ENDPOINT = 'https://api.capitalbot.ai/generateResponse';
const DEFAULT_MODELS_ENDPOINT = 'https://api.capitalbot.ai/getModelsAndPresets';
const ADMIN_ACCESS_TOKEN = process.env.CAPITALBOT_ACCESS_TOKEN || '';
const ENDPOINT_URL = process.env.CAPITALBOT_ENDPOINT_URL || DEFAULT_ENDPOINT;
const DEFAULT_MODEL_ID = parseInt(process.env.CAPITALBOT_MODEL_ID || '43', 10);
const DEFAULT_PRESET_ID = parseInt(process.env.CAPITALBOT_PRESET_ID || '88', 10);
const MAX_RETRIES = 3;

// CapitalBot hard-rejects any request whose `chatHistory` array is longer
// than 60 with HTTP 413 ("chatHistory exceeds limit. Maximum accepted is
// 60."). Before this cap, ANY chat that accumulated >60 stored messages
// failed on every retry FOREVER — so the AI silently stopped replying to
// exactly the busiest conversations while short chats kept working. We
// send only the most recent N (default 55, a little headroom under 60)
// messages; older context is dropped from the API call but kept in our
// own per-chat memory. Configurable via CAPITALBOT_MAX_CHAT_HISTORY.
const MAX_CHAT_HISTORY = Math.max(
  1,
  Math.min(60, parseInt(process.env.CAPITALBOT_MAX_CHAT_HISTORY || '55', 10))
);

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
          return reject(new Error(`Invalid JSON from CapitalBot: ${err.message}`));
        }
        resolve({ statusCode: res.statusCode, data: json });
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CapitalBot request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

class CapitalBotService {
  async _resolveEnvKey() {
    if (!ADMIN_ACCESS_TOKEN) {
      throw new Error('CAPITALBOT_ACCESS_TOKEN is not configured');
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

  async getAccessToken(userId) {
    const uid = Number(userId);
    if (!uid) {
      throw new Error('User ID is required to resolve CapitalBot license key');
    }

    const { rows } = await pool.query(
      `SELECT api_key, is_valid, model_id, preset_id FROM user_capitalbot_keys WHERE user_id = $1`,
      [uid]
    );
    if (rows.length && rows[0].api_key) {
      return {
        token: rows[0].api_key,
        source: 'user',
        isValid: rows[0].is_valid,
        modelId: rows[0].model_id ? Number(rows[0].model_id) : null,
        presetId: rows[0].preset_id ? Number(rows[0].preset_id) : null,
      };
    }

    throw new Error('CapitalBot API key is not configured. Please add your license key in the AI menu.');
  }

  async setUserApiKey(userId, apiKey, modelId = null, presetId = null) {
    const uid = Number(userId);
    if (!uid) throw new Error('User ID is required');
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      throw new Error('License key is required');
    }
    const key = apiKey.trim();

    const { isValid, models, presets } = await this.validateApiKeyWithModels(key);

    const mId = modelId ? Number(modelId) : null;
    const pId = presetId ? Number(presetId) : null;

    const firstModelId = models?.length ? models[0].modelId : null;
    const firstPresetId = presets?.length ? presets[0].id : null;

    await pool.query(
      `INSERT INTO user_capitalbot_keys (user_id, api_key, is_valid, model_id, preset_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (user_id) DO UPDATE
       SET api_key = EXCLUDED.api_key,
           is_valid = EXCLUDED.is_valid,
           model_id = COALESCE(EXCLUDED.model_id, user_capitalbot_keys.model_id),
           preset_id = COALESCE(EXCLUDED.preset_id, user_capitalbot_keys.preset_id),
           updated_at = NOW()`,
      [uid, key, isValid, mId || firstModelId, pId || firstPresetId]
    );

    return { userId: uid, isValid, modelId: mId || firstModelId, presetId: pId || firstPresetId, models, presets };
  }

  async updateModelPreset(userId, modelId, presetId) {
    const uid = Number(userId);
    if (!uid) throw new Error('User ID is required');

    const mId = modelId ? Number(modelId) : null;
    const pId = presetId ? Number(presetId) : null;

    await pool.query(
      `UPDATE user_capitalbot_keys SET model_id = $1, preset_id = $2, updated_at = NOW() WHERE user_id = $3`,
      [mId, pId, uid]
    );

    return { userId: uid, modelId: mId, presetId: pId };
  }

  async validateApiKey(apiKey) {
    try {
      const res = await _requestJson(DEFAULT_MODELS_ENDPOINT, { licensekey: apiKey });
      logger.debug(`CapitalBot key validation status=${res.statusCode}`);
      if (res.statusCode === 401 || res.statusCode === 403) return false;
      if (res.statusCode === 200 && res.data && res.data.success) return true;
      return true;
    } catch (err) {
      logger.warn(`CapitalBot key validation request failed: ${err.message}`);
      return true;
    }
  }

  async validateApiKeyWithModels(apiKey) {
    try {
      const res = await _requestJson(DEFAULT_MODELS_ENDPOINT, { licensekey: apiKey });
      if (res.statusCode === 200 && res.data && res.data.success) {
        return {
          isValid: true,
          models: res.data.data?.models || [],
          presets: res.data.data?.presets || [],
        };
      }
      return { isValid: false, models: [], presets: [] };
    } catch (err) {
      logger.warn(`CapitalBot key validation request failed: ${err.message}`);
      return { isValid: false, models: [], presets: [] };
    }
  }

  async getAvailableModels(apiKey) {
    try {
      const res = await _requestJson(DEFAULT_MODELS_ENDPOINT, { licensekey: apiKey });
      if (res.statusCode === 200 && res.data) {
        return { success: true, data: res.data };
      }
      return { success: false, error: res.data || 'Failed to fetch models' };
    } catch (err) {
      logger.warn(`CapitalBot getAvailableModels failed: ${err.message}`);
      throw err;
    }
  }

  async deleteUserApiKey(userId) {
    const uid = Number(userId);
    if (!uid) throw new Error('User ID is required');
    await pool.query(`DELETE FROM user_capitalbot_keys WHERE user_id = $1`, [uid]);
    return { userId: uid, deleted: true };
  }

  _buildChatHistory(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return [];

    // Keep only the most recent MAX_CHAT_HISTORY messages. `messages` is
    // ordered oldest -> newest, so slice(-N) keeps the freshest context and
    // stays under CapitalBot's hard 60-message ceiling (HTTP 413 otherwise).
    const bounded =
      messages.length > MAX_CHAT_HISTORY
        ? messages.slice(-MAX_CHAT_HISTORY)
        : messages;

    return bounded.map((m) => ({
      role: m.isIncoming ? 'user' : 'assistant',
      content: m.msg || '',
      timestamp: Math.floor((m.timestamp || Date.now()) / 1000),
    }));
  }

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
    const accessToken = await this.getAccessToken(userId);
    const licenseKey = accessToken.token;

    const chatHistory = this._buildChatHistory(messages);

    const userModelId = accessToken.modelId;
    const userPresetId = accessToken.presetId;

    // Per-conversation identity. CapitalBot keys its engagement/lead
    // state by `useridentifier` and dedups leads ACROSS every account on
    // the same license: if we send the bare Telegram peer id, then the
    // moment ONE session replies to a user CapitalBot marks that user as
    // `messagedAlready` (engagedBy: <that account>), and every OTHER
    // session that talks to the same user gets `messaged_already` →
    // not_our_turn → silence. In this panel the same lead legitimately
    // DMs many of our sessions and each session must answer independently,
    // so we namespace the identifier with the account/session id. That
    // makes (session 211 ↔ user X) and (session 213 ↔ user X) two
    // distinct CapitalBot leads instead of one shared, first-come-locked
    // lead. It MUST also be non-empty — an empty identifier would collapse
    // every chat on an account into one context and leak history between
    // users.
    const rawPeerId = String(
      recipient.id || recipient.useridentifier || recipient.peerId || ''
    ).trim();
    const peerPart = rawPeerId || 'unknown';
    const useridentifier = `acct${accountID}_${peerPart}`;

    const body = {
      licensekey: licenseKey,
      modelId: userModelId ?? overrides.modelId ?? DEFAULT_MODEL_ID,
      presetId: userPresetId ?? overrides.presetId ?? DEFAULT_PRESET_ID,
      accountId: String(accountID),
      platform: overrides.platform || 'Telegram',
      conversationSource: overrides.conversationSource || 'Telegram',
      userInfos: {
        useridentifier,
      },
      chatHistory,
    };

    if (recipient.name) body.userInfos.name = recipient.name;
    if (recipient.username) body.userInfos.username = recipient.username;
    if (recipient.age) body.userInfos.age = recipient.age;
    if (recipient.location) body.userInfos.location = recipient.location;

    if (botProfile?.name && !overrides.modelName) {
      body.modelName = botProfile.name;
    }

    const optionalFields = {
      city: overrides.city || recipient.location,
      modelName: overrides.modelName,
      modelAge: overrides.modelAge,
      chattingStyle: overrides.chattingStyle,
      appearance: overrides.appearance,
      hobbies: overrides.hobbies,
      ctaInfo: overrides.ctaInfo,
      dayTimeActivity: overrides.dayTimeActivity,
      nightTimeActivity: overrides.nightTimeActivity,
      language: overrides.language,
      photoRate: overrides.photoRate,
      interestLevel: overrides.interestLevel,
      phaseGoal: overrides.phaseGoal,
      matchLocation: overrides.matchLocation,
      timezone: overrides.timezone,
      outfit: overrides.outfit,
      livePhotoSource: overrides.livePhotoSource,
      detectLanguage: overrides.detectLanguage,
      audio: overrides.audio,
      video: overrides.video,
      image: overrides.image,
      affiliate: overrides.affiliate,
    };

    for (const [key, val] of Object.entries(optionalFields)) {
      if (val != null) {
        body[key] = val;
      }
    }

    let lastErr;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await _requestJson(ENDPOINT_URL, body);

        if (res.statusCode === 200 && res.data) {
          const contentArray = res.data.content || [];
          const textParts = contentArray
            .filter((item) => item.type === 'text')
            .map((item) => item.content);
          const responseText = textParts.length > 0 ? textParts.join('\n') : null;

          const mediaEntry = contentArray.find((item) => item.type !== 'text');
          const media = mediaEntry
            ? { url: mediaEntry.content, type: mediaEntry.type, mediaPool: mediaEntry.mediaPool || null }
            : null;

          let category = null;
          if (res.data.underage) category = 'underage';
          else if (res.data.aiCreditOver) category = 'ai_credit_over';
          else if (res.data.timewaste) category = 'timewaste';
          else if (res.data.tierFiltered) category = 'tier_filtered';
          else if (res.data.genderFiltered) category = 'gender_filtered';
          else if (res.data.messagedAlready) category = 'messaged_already';
          else if (res.data.internalAccount) category = 'internal_account';
          else if (res.data.ignored) category = 'ignored';
          else if (res.data.ppvExhausted) category = 'ppv_exhausted';
          else if (res.data.chatCooldown) category = 'chat_cooldown';

          return {
            statusCode: res.statusCode,
            text: responseText,
            media,
            didConvert: !!res.data.converted,
            category,
            rateLimit: null,
            rawResponse: res.data,
          };
        }

        lastErr = new Error(
          `CapitalBot ${res.statusCode}: ${res.data ? JSON.stringify(res.data) : 'empty body'}`
        );
        lastErr.statusCode = res.statusCode;
        lastErr.responseData = res.data;

        if (res.statusCode === 429 || res.statusCode >= 500) {
          await sleep(1000 * Math.pow(2, attempt));
          continue;
        }

        throw lastErr;
      } catch (err) {
        lastErr = err;
        logger.warn(`CapitalBot request failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message}`);
        // Client errors (4xx other than 429) are deterministic — retrying
        // the identical payload just wastes time and hammers the API, so
        // fail fast. Only 429 / 5xx / network errors are worth a retry.
        if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 429) {
          break;
        }
        if (attempt < MAX_RETRIES - 1) {
          await sleep(1000 * Math.pow(2, attempt));
        }
      }
    }

    throw lastErr;
  }

  parseResponseCategory(category) {
    const interventionReasons = {
      underage: 'Underage content detected. Conversation terminated.',
      ai_credit_over: 'AI credits depleted.',
      timewaste: 'Conversation reached AI messages limit and was ended.',
      tier_filtered: 'User filtered by country tier filter.',
      gender_filtered: 'User filtered by female gender filter.',
      messaged_already: 'User already engaged by another account.',
      internal_account: 'User is a CapitalAI account (self-engagement blocked).',
      ignored: 'Request matched an enabled ignore condition.',
      ppv_exhausted: 'All PPV items have been sold to this user.',
      chat_cooldown: 'Chat is on cooldown during outfit day transition.',
    };

    return {
      category,
      isGhosting: category && ['underage', 'timewaste', 'tier_filtered', 'gender_filtered', 'ppv_exhausted'].includes(category),
      // `messaged_already` used to fire constantly because every session
      // shared one CapitalBot lead per Telegram user (see the
      // useridentifier note in generateReply). Now that the identifier is
      // namespaced per account/session, each session owns its own lead and
      // this category should effectively never appear for our normal
      // multi-session fan-in. It's kept here so that if CapitalBot ever
      // does legitimately return it, we still stop rather than spam.
      isNotOurTurn: category && ['messaged_already', 'internal_account', 'ignored', 'chat_cooldown', 'ai_credit_over'].includes(category),
      reason: category ? interventionReasons[category] || null : null,
    };
  }
}

module.exports = new CapitalBotService();
