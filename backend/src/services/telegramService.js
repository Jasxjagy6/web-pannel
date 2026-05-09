/**
 * TelegramService - Core service wrapping all Telegram MTProto API operations
 * using the GramJS library.
 *
 * Provides session management, scraping, messaging, group operations,
 * 2FA management, and account operations through a unified interface.
 */

const { TelegramClient, utils } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { Api } = require('telegram/tl');
const { generateRandomBytes } = require('telegram/Helpers');
const {
  computeCheck: gramjsComputeCheck,
  computeDigest: gramjsComputeDigest,
} = require('telegram/Password');
const logger = require('../utils/logger');
const telegramConfig = require('../config/telegram');
const { encrypt, decrypt } = require('../utils/crypto');
const fingerprint = require('../utils/deviceFingerprint');

/**
 * Maximum number of retries for flood wait errors before giving up.
 */
const MAX_FLOOD_RETRIES = 5;

/**
 * Default flood wait backoff multiplier (used when seconds not specified).
 */
const DEFAULT_FLOOD_BACKOFF = 30;

/**
 * Maximum message length allowed by Telegram.
 */
const MAX_MESSAGE_LENGTH = 4096;
const NEW_PASSWORD_SALT_BYTES = 32;

/**
 * Delay utility for sleep between operations.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default per-attempt timeout for an MTProto connect / pre-flight call,
 * in milliseconds. With a dead SOCKS5 proxy gramJS will retry the
 * underlying socket internally for 15s+ a pop and never resolve, so we
 * race every connect / `getMe` we care about against this deadline and
 * fail fast.
 *
 * Tunable via env so operators can dial it down on a fast network or
 * up if they have unusually slow but legitimate proxies.
 */
const TG_CONNECT_TIMEOUT_MS = (() => {
  const v = parseInt(process.env.TG_CONNECT_TIMEOUT_MS, 10);
  if (Number.isFinite(v) && v >= 1000) return v;
  return 10_000;
})();

/**
 * Race `promise` against a hard timer. If the promise hasn't settled
 * by `ms`, the returned promise rejects with an error labelled
 * `TIMEOUT_<label>` so callers can distinguish between "Telegram said
 * no" and "Telegram never answered".
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} [label='OPERATION']
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label = 'OPERATION') {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Operation timed out after ${ms}ms (${label})`);
      err.code = `TIMEOUT_${label}`;
      err.isTimeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Extract the flood wait seconds from an error message.
 * @param {string} errorMessage - The Telegram error message
 * @returns {number} Seconds to wait
 */
function extractFloodSeconds(errorMessage) {
  const match = errorMessage.match(/A wait of (\d+) seconds/);
  if (match) return parseInt(match[1], 10);
  const simpleMatch = errorMessage.match(/(\d+) seconds/);
  if (simpleMatch) return parseInt(simpleMatch[1], 10);
  return DEFAULT_FLOOD_BACKOFF;
}

/**
 * Coerce a Telegram-style int64 value (BigInt / number / string) to a
 * lossless decimal string. **Critical** for `access_hash`: the raw
 * `Number(bigint)` coercion silently truncates anything >= 2^53, which
 * is most real access_hashes. Persisting a truncated value to the
 * BIGINT column then makes every later `InputUser({userId, accessHash})`
 * fail with "Could not find the input entity" because the hash on file
 * no longer matches what Telegram has on its side.
 *
 * @param {bigint|number|string|null|undefined} v
 * @returns {string|null}
 */
function bigintToString(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    return String(Math.trunc(v));
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    return /^-?\d+$/.test(s) ? s : null;
  }
  // GramJS sometimes wraps int64 values in `{ value, ... }` shapes;
  // fall back to `toString()` when it's available.
  if (v && typeof v.toString === 'function') {
    const s = v.toString();
    return /^-?\d+$/.test(s) ? s : null;
  }
  return null;
}

/**
 * Normalize a Telegram entity to a standard user/group object.
 * @param {object} entity - Raw GramJS entity
 * @returns {object|null} Normalized entity data
 */
function normalizeEntity(entity) {
  if (!entity) return null;

  // `accessHash` MUST go through `bigintToString` (not `Number`) — most
  // real Telegram access_hashes exceed 2^53 and `Number(bigint)` would
  // truncate them, breaking every later `InputUser` construction.
  const base = {
    id: entity.id ? Number(entity.id) : null,
    accessHash: bigintToString(entity.accessHash),
  };

  // User entity
  if (entity.className === 'User') {
    return {
      ...base,
      type: 'user',
      username: entity.username || null,
      firstName: entity.firstName || null,
      lastName: entity.lastName || null,
      phone: entity.phone || null,
      isBot: entity.bot || false,
      isPremium: entity.premium || false,
      isVerified: entity.verified || false,
      photo: entity.photo ? `https://t.me/${entity.username || entity.id}` : null,
      restrictionReason: entity.restrictionReason || null,
    };
  }

  // Chat (basic group) entity
  if (entity.className === 'Chat') {
    return {
      ...base,
      type: 'group',
      groupType: 'basic',
      title: entity.title || null,
      username: entity.username || null,
      participantsCount: entity.participantsCount || 0,
      isVerified: entity.verified || false,
      isRestricted: entity.restricted || false,
    };
  }

  // Channel entity (includes supergroups and channels)
  if (entity.className === 'Channel') {
    const isGroup = entity.megagroup === true;
    return {
      ...base,
      type: isGroup ? 'group' : 'channel',
      groupType: isGroup ? 'supergroup' : 'channel',
      title: entity.title || null,
      username: entity.username || null,
      participantsCount: entity.participantsCount || 0,
      isVerified: entity.verified || false,
      isRestricted: entity.restricted || false,
      isBroadcast: entity.broadcast || false,
    };
  }

  return base;
}

/**
 * Normalize a participant/user from group member list.
 * @param {object} participant - Raw participant object from getParticipants
 * @returns {object|null} Normalized user data
 */
function normalizeParticipant(participant) {
  if (!participant) return null;

  // GramJS may return either:
  // 1. A ChannelParticipant object with participant.user
  // 2. A User object directly (what we're seeing now)

  const user = participant.user || participant;

  // Check if it looks like a valid user (must have id)
  if (!user.id) return null;

  // Telegram's User object exposes a lot more than the bare id+name.
  // We surface every flag / scalar that is generally useful for
  // exports without any extra round-trips. Boolean flags that come
  // through as undefined are coerced to false so CSV exports don't
  // get half-empty cells for accounts that simply don't have the
  // flag set.
  const status = user.status ? user.status.className || null : null;
  let lastSeen = null;
  if (user.status) {
    if (user.status.wasOnline) {
      lastSeen = new Date(user.status.wasOnline * 1000).toISOString();
    } else if (user.status.expires) {
      lastSeen = new Date(user.status.expires * 1000).toISOString();
    }
  }
  const photoId = user.photo && user.photo.photoId
    ? String(user.photo.photoId.value !== undefined ? user.photo.photoId : user.photo.photoId)
    : null;

  return {
    id: user.id ? Number(user.id) : null,
    username: user.username || null,
    firstName: user.firstName || null,
    lastName: user.lastName || null,
    phone: user.phone || null,
    isBot: !!user.bot,
    isPremium: !!user.premium,
    isVerified: !!user.verified,
    isScam: !!user.scam,
    isFake: !!user.fake,
    isRestricted: !!user.restricted,
    isDeleted: !!user.deleted,
    isSupport: !!user.support,
    isContact: !!user.contact,
    isMutualContact: !!user.mutualContact,
    isCloseFriend: !!user.closeFriend,
    // Persist the FULL int64 access_hash as a decimal string. Using
    // `Number()` here truncates real access_hashes (which routinely
    // exceed 2^53) and silently corrupts `scraped_users.access_hash`,
    // which then makes every numeric-id invite later in the pipeline
    // fail with "Could not find the input entity".
    accessHash: bigintToString(user.accessHash),
    langCode: user.langCode || null,
    status,
    lastSeenAt: lastSeen,
    hasProfilePhoto: !!(user.photo && (user.photo.photoId || user.photo.photoSmall)),
    photoId,
    restrictionReason: Array.isArray(user.restrictionReason) && user.restrictionReason.length
      ? user.restrictionReason.map((r) => `${r.platform || 'all'}:${r.reason}:${r.text || ''}`).join('; ')
      : null,
    dcId: user.photo && typeof user.photo.dcId === 'number' ? user.photo.dcId : null,
    botInlinePlaceholder: user.botInlinePlaceholder || null,
    date: participant.date ? new Date(participant.date * 1000).toISOString() : null,
    inviterId: participant.inviterId ? Number(participant.inviterId) : null,
  };
}

/**
 * Extract an InputPeer from a resolved entity for API calls.
 * @param {object} entity - Resolved GramJS entity
 * @returns {object} InputPeer
 */
function getInputPeer(entity) {
  if (entity.className === 'User') {
    return new Api.InputPeerUser({
      userId: entity.id,
      accessHash: entity.accessHash,
    });
  }
  if (entity.className === 'Chat') {
    return new Api.InputPeerChat({ chatId: entity.id });
  }
  if (entity.className === 'Channel') {
    return new Api.InputPeerChannel({
      channelId: entity.id,
      accessHash: entity.accessHash,
    });
  }
  return entity;
}

/**
 * TelegramService - Core service for all Telegram MTProto operations.
 *
 * Manages client sessions, handles connection lifecycle, and provides
 * methods for scraping, messaging, group management, and account operations.
 */
class TelegramService {
  constructor() {
    /**
     * Active client instances keyed by sessionId.
     * @type {Map<string, { client: TelegramClient, connected: boolean, apiId: number, apiHash: string }>}
     */
    this.clients = new Map();

    /**
     * Encrypted session string data keyed by sessionId.
     * @type {Map<string, string>}
     */
    this.sessionStore = new Map();

    /**
     * In-flight flood wait promises keyed by sessionId for deduplication.
     * @type {Map<string, Promise<void>>}
     */
    this._floodWaits = new Map();

    logger.info('TelegramService initialized');
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Create a new Telegram client session from a session string.
   *
   * @param {string} sessionId - Unique identifier for this session
   * @param {string} sessionFile - Encrypted session string data
   * @param {number} apiId - Telegram API ID (optional, uses config default)
   * @param {string} apiHash - Telegram API Hash (optional, uses config default)
   * @param {object} [opts]
   * @param {object} [opts.proxy] - GramJS proxy interface (SOCKS / MTProxy)
   * @param {object} [opts.identity] - Persisted device identity (Anti-Detect).
   *   When omitted the static `telegramConfig` defaults are used (legacy).
   * @returns {Promise<{ sessionId: string, connected: boolean }>}
   */
  async createSession(sessionId, sessionFile, apiId, apiHash, opts = {}) {
    try {
      // Decrypt the session string
      const sessionString = decrypt(sessionFile);

      const finalApiId = apiId || telegramConfig.apiId;
      const finalApiHash = apiHash || telegramConfig.apiHash;

      if (!finalApiId || !finalApiHash) {
        throw new Error('API ID and API Hash are required');
      }

      const proxy = opts.proxy || null;
      const idOpts = fingerprint.toClientOptions(opts.identity);

      // Create a new TelegramClient with the string session
      const stringSession = new StringSession(sessionString);
      const client = new TelegramClient(stringSession, finalApiId, finalApiHash, {
        connectionRetries: telegramConfig.connectionRetries,
        timeout: telegramConfig.timeout,
        deviceModel: idOpts.deviceModel || telegramConfig.deviceModel,
        systemVersion: idOpts.systemVersion || telegramConfig.systemVersion,
        appVersion: idOpts.appVersion || telegramConfig.appVersion,
        langCode: idOpts.langCode || telegramConfig.langCode,
        systemLangCode: idOpts.systemLangCode || idOpts.langCode || telegramConfig.langCode,
        baseLogger: telegramConfig.baseLogger,
        // SOCKS / MTProxy connections must use raw TCP, not WSS.
        useWSS: proxy ? false : telegramConfig.useWSS,
        autoReconnect: true,
        proxy: proxy || undefined,
      });

      // Connect the client
      await client.connect();

      this.clients.set(sessionId, {
        client,
        connected: true,
        apiId: finalApiId,
        apiHash: finalApiHash,
        proxy: proxy || null,
        identity: opts.identity || null,
      });

      this.sessionStore.set(sessionId, sessionFile);

      logger.info(`Session created and connected: ${sessionId}`, {
        hasProxy: !!proxy,
        platform: opts.identity ? opts.identity.platform : 'default',
      });

      return {
        sessionId,
        connected: true,
      };
    } catch (error) {
      logger.error(`Failed to create session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Login with phone number and verification code.
   *
   * This method initiates a new session by sending a code to the phone number
   * and then signing in with that code. If 2FA is enabled on the account,
   * it will throw an error indicating handle2FA should be called.
   *
   * @param {string} phone - Phone number in international format (e.g. +1234567890)
   * @param {string} code - Verification code received via SMS/Telegram
   * @param {number} apiId - Telegram API ID
   * @param {string} apiHash - Telegram API Hash
   * @param {string} phoneCodeHash - Hash returned from sendCode request
   * @param {object} [opts]
   * @param {object} [opts.proxy] - Optional GramJS proxy (Anti-Detect).
   * @param {object} [opts.identity] - Optional persisted device identity.
   * @returns {Promise<{ sessionId: string, sessionData: string, me: object }>}
   */
  async loginWithPhone(phone, code, apiId, apiHash, phoneCodeHash, opts = {}) {
    try {
      const finalApiId = apiId || telegramConfig.apiId;
      const finalApiHash = apiHash || telegramConfig.apiHash;

      if (!finalApiId || !finalApiHash) {
        throw new Error('API ID and API Hash are required for login');
      }

      const sessionId = `login_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const stringSession = new StringSession('');

      const proxy = opts.proxy || null;
      const idOpts = fingerprint.toClientOptions(opts.identity);

      const client = new TelegramClient(stringSession, finalApiId, finalApiHash, {
        connectionRetries: telegramConfig.connectionRetries,
        timeout: telegramConfig.timeout,
        deviceModel: idOpts.deviceModel || telegramConfig.deviceModel,
        systemVersion: idOpts.systemVersion || telegramConfig.systemVersion,
        appVersion: idOpts.appVersion || telegramConfig.appVersion,
        langCode: idOpts.langCode || telegramConfig.langCode,
        systemLangCode: idOpts.systemLangCode || idOpts.langCode || telegramConfig.langCode,
        baseLogger: telegramConfig.baseLogger,
        useWSS: proxy ? false : telegramConfig.useWSS,
        proxy: proxy || undefined,
      });

      await client.connect();

      // If phoneCodeHash is provided, use it for signIn
      let sentCode;
      if (phoneCodeHash) {
        sentCode = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: phoneCodeHash,
            phoneCode: code,
          })
        );
      } else {
        sentCode = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCode: code,
          })
        );
      }

      // Get the user info
      const me = await client.getMe();

      // Save session string
      const sessionString = client.session.save();
      const encryptedSession = encrypt(sessionString);

      this.clients.set(sessionId, {
        client,
        connected: true,
        apiId: finalApiId,
        apiHash: finalApiHash,
        proxy: proxy || null,
        identity: opts.identity || null,
      });

      this.sessionStore.set(sessionId, encryptedSession);

      logger.info(`Phone login successful: ${phone}`, { sessionId });

      return {
        sessionId,
        sessionData: encryptedSession,
        me: normalizeEntity(me),
      };
    } catch (error) {
      logger.error(`Phone login failed for ${phone}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Handle 2FA (Two-Factor Authentication) password challenge.
   *
   * Called when login requires a password (Cloud Password / SRP).
   *
   * @param {string} sessionId - The session ID from the login attempt
   * @param {string} password - The 2FA password
   * @returns {Promise<{ sessionId: string, sessionData: string, me: object }>}
   */
  async handle2FA(sessionId, password) {
    try {
      const sessionEntry = this.clients.get(String(sessionId));
      if (!sessionEntry) {
        throw new Error(`Session ${sessionId} not found for 2FA handling`);
      }

      const { client } = sessionEntry;

      // Fetch the password configuration (SRP)
      const passwordRequest = await client.invoke(new Api.account.GetPassword());

      // Compute the password check using GramJS utilities
      const passwordSrp = await computeCheck(passwordRequest, password);

      // Submit the password check
      const auth = await client.invoke(
        new Api.auth.CheckPassword({ password: passwordSrp })
      );

      // Get user info
      const me = await client.getMe();

      // Save session
      const sessionString = client.session.save();
      const encryptedSession = encrypt(sessionString);

      this.sessionStore.set(sessionId, encryptedSession);

      logger.info(`2FA authentication successful for session ${sessionId}`);

      return {
        sessionId,
        sessionData: encryptedSession,
        me: normalizeEntity(me),
      };
    } catch (error) {
      logger.error(`2FA handling failed for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Save session data (encrypted) for later retrieval.
   *
   * In a production system, this would persist to a database. Here we store
   * in the session store Map and return the encrypted data.
   *
   * @param {number|string} userId - User ID who owns this session
   * @param {string} sessionId - Session identifier
   * @param {string} sessionData - Encrypted session string
   * @returns {Promise<{ userId: string|number, sessionId: string, savedAt: string }>}
   */
  async saveSession(userId, sessionId, sessionData) {
    try {
      // Update or store in the session store
      this.sessionStore.set(sessionId, sessionData);

      // Also update the client entry if it exists
      const entry = this.clients.get(String(sessionId));
      if (entry) {
        entry.connected = true;
        this.clients.set(sessionId, entry);
      }

      const savedAt = new Date().toISOString();

      logger.info(`Session saved for user ${userId}, session ${sessionId}`);

      return {
        userId: String(userId),
        sessionId,
        savedAt,
      };
    } catch (error) {
      logger.error(`Failed to save session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Disconnect and remove a session from the client pool.
   *
   * @param {string} sessionId - Session identifier to disconnect
   * @returns {Promise<{ sessionId: string, disconnected: boolean }>}
   */
  async disconnectSession(sessionId) {
    try {
      const entry = this.clients.get(String(sessionId));
      if (!entry) {
        logger.warn(`Session ${sessionId} not found for disconnect`);
        return { sessionId, disconnected: false };
      }

      const { client } = entry;

      try {
        await client.disconnect();
      } catch (disconnectError) {
        logger.warn(`Disconnect error for session ${sessionId}`, {
          error: disconnectError.message,
        });
      }

      // Try to destroy the client to free resources
      try {
        await client.destroy();
      } catch (destroyError) {
        logger.warn(`Destroy error for session ${sessionId}`, {
          error: destroyError.message,
        });
      }

      this.clients.delete(sessionId);
      this.sessionStore.delete(sessionId);
      this._floodWaits.delete(sessionId);

      logger.info(`Session disconnected: ${sessionId}`);

      return { sessionId, disconnected: true };
    } catch (error) {
      logger.error(`Failed to disconnect session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // Scraping
  // =========================================================================

  /**
   * Get members from a Telegram group or channel.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group/channel ID, username, or invite link
   * @param {object} options - Scraping options
   * @param {number} options.limit - Maximum number of members to fetch (default: 10000)
   * @param {boolean} options.filterBots - Whether to exclude bot accounts (default: true)
   * @returns {Promise<{ members: object[], total: number, groupId: string }>}
   */
  async getGroupMembers(sessionId, groupId, options = { limit: 10000, filterBots: true }) {
    await this._ensureConnected(sessionId);

    const { limit = 10000, filterBots = true } = options;

    try {
      const entity = await this._resolveEntity(sessionId, groupId);
      if (!entity) {
        throw new Error(`Could not resolve group/channel: ${groupId}`);
      }

      const members = [];
      let offset = 0;
      const batchSize = 200;

      while (members.length < limit) {
        const batchLimit = Math.min(batchSize, limit - members.length);

        const participants = await this._withFloodRetry(sessionId, async () => {
          return await this.clients.get(String(sessionId)).client.getParticipants(entity, {
            limit: batchLimit,
            offset: offset,
          });
        });

        if (!participants || participants.length === 0) {
          break;
        }

        for (const participant of participants) {
          const normalized = normalizeParticipant(participant);
          if (normalized) {
            if (filterBots && normalized.isBot) {
              continue;
            }
            members.push(normalized);
          }

          if (members.length >= limit) {
            break;
          }
        }

        offset += participants.length;

        if (participants.length < batchLimit) {
          break;
        }

        // Small delay between batches to avoid flood
        await sleep(1000);
      }

      logger.info(`Scraped ${members.length} members from ${groupId}`, { sessionId });

      return members;
    } catch (error) {
      logger.error(`Failed to get group members for ${groupId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Get information about a specific Telegram user.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} userId - User ID, username, or phone number
   * @returns {Promise<object>} Normalized user information
   */
  async getUserInfo(sessionId, userId) {
    await this._ensureConnected(sessionId);

    try {
      const entity = await this._resolveEntity(sessionId, userId);
      if (!entity) {
        throw new Error(`Could not resolve user: ${userId}`);
      }

      // Get full user data
      const fullUser = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.users.GetFullUser({
            id: getInputPeer(entity),
          })
        );
      });

      const normalized = normalizeEntity(entity);

      if (fullUser && fullUser.fullUser) {
        normalized.bio = fullUser.fullUser.bio || null;
        normalized.commonChatsCount = fullUser.fullUser.commonChatsCount || 0;
        normalized.phoneCallsPrivate = fullUser.fullUser.phoneCallsPrivate || false;
      }

      return normalized;
    } catch (error) {
      logger.error(`Failed to get user info for ${userId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Search for users by query string (username or name).
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} query - Search query string
   * @returns {Promise<{ users: object[], total: number }>}
   */
  async searchUsers(sessionId, query) {
    await this._ensureConnected(sessionId);

    try {
      const results = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.contacts.Search({
            q: query,
          })
        );
      });

      const users = [];
      if (results && results.users) {
        for (const user of results.users) {
          if (user.className === 'User') {
            users.push(normalizeEntity(user));
          }
        }
      }

      logger.info(`Searched users with query "${query}", found ${users.length}`, { sessionId });

      return {
        users,
        total: users.length,
      };
    } catch (error) {
      logger.error(`Failed to search users with query "${query}"`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Get all groups/channels the current user is a member of.
   *
   * @param {string} sessionId - Active session identifier
   * @returns {Promise<{ groups: object[], total: number }>}
   */
  async getGroups(sessionId) {
    await this._ensureConnected(sessionId);

    try {
      const dialogs = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.getDialogs({
          limit: 500,
        });
      });

      const groups = [];
      if (dialogs && dialogs.length > 0) {
        for (const dialog of dialogs) {
          const entity = dialog.entity;
          if (!entity) continue;

          // Include chats, supergroups, and channels
          if (entity.className === 'Chat' || entity.className === 'Channel') {
            const normalized = normalizeEntity(entity);
            if (normalized) {
              normalized.lastMessage = dialog.message ? dialog.message.message || null : null;
              normalized.unreadCount = dialog.unreadCount || 0;
              groups.push(normalized);
            }
          }
        }
      }

      logger.info(`Retrieved ${groups.length} groups/channels for session ${sessionId}`);

      return {
        groups,
        total: groups.length,
      };
    } catch (error) {
      logger.error(`Failed to get groups for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Get subscribers of a channel.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} channelId - Channel ID or username
   * @param {object} options - Options
   * @param {number} options.limit - Maximum subscribers to fetch (default: 10000)
   * @returns {Promise<{ subscribers: object[], total: number, channelId: string }>}
   */
  async getChannelSubscribers(sessionId, channelId, options = { limit: 10000 }) {
    await this._ensureConnected(sessionId);

    const { limit = 10000 } = options;

    try {
      const entity = await this._resolveEntity(sessionId, channelId);
      if (!entity) {
        throw new Error(`Could not resolve channel: ${channelId}`);
      }

      if (entity.className !== 'Channel' || !entity.broadcast) {
        throw new Error(`Entity ${channelId} is not a broadcast channel`);
      }

      const subscribers = [];
      let offset = 0;
      const batchSize = 200;

      while (subscribers.length < limit) {
        const batchLimit = Math.min(batchSize, limit - subscribers.length);

        const participants = await this._withFloodRetry(sessionId, async () => {
          return await this.clients.get(String(sessionId)).client.getParticipants(entity, {
            limit: batchLimit,
            offset: offset,
            filter: new Api.ChannelParticipantsRecent(),
          });
        });

        if (!participants || participants.length === 0) {
          break;
        }

        for (const participant of participants) {
          const normalized = normalizeParticipant(participant);
          if (normalized) {
            subscribers.push(normalized);
          }

          if (subscribers.length >= limit) {
            break;
          }
        }

        offset += participants.length;

        if (participants.length < batchLimit) {
          break;
        }

        await sleep(1000);
      }

      logger.info(`Scraped ${subscribers.length} subscribers from channel ${channelId}`, {
        sessionId,
      });

      return subscribers;
    } catch (error) {
      logger.error(`Failed to get channel subscribers for ${channelId}`, {
        error: error.message,
      });
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // Messaging
  // =========================================================================

  /**
   * Send a message to a user, group, or channel.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} targetId - Target user/group/channel identifier
   * @param {string} message - Message text to send
   * @param {object} options - Send options
   * @param {boolean} options.silent - Send without notification
   * @param {boolean} options.noWebpage - Disable webpage preview
   * @param {number} options.replyTo - Reply to a specific message ID
   * @param {string} options.scheduleDate - ISO date string to schedule message
   * @param {boolean} options.parseMarkdown - Parse markdown formatting
   * @returns {Promise<{ messageId: number, date: string, targetId: string }>}
   */
  async sendMessage(sessionId, targetId, message, options = {}) {
    await this._ensureConnected(sessionId);

    const {
      silent = false,
      noWebpage = false,
      replyTo = null,
      scheduleDate = null,
      parseMarkdown = false,
    } = options;

    try {
      const entity = await this._resolveEntity(sessionId, targetId);
      if (!entity) {
        throw new Error(`Could not resolve target: ${targetId}`);
      }

      // Handle markdown formatting if requested
      let parsedMessage = message;
      let parseModeOption = undefined;

      if (parseMarkdown) {
        parseModeOption = 'md';
      }

      const sendOptions = {
        message: parsedMessage,
        entity: entity,
        silent,
        noWebpage,
        replyTo,
        parseMode: parseModeOption,
      };

      if (scheduleDate) {
        sendOptions.scheduleDate = new Date(scheduleDate);
      }

      const result = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.sendMessage(entity, sendOptions);
      });

      const messageData = {
        messageId: result ? result.id : null,
        date: result && result.date
          ? new Date(result.date * 1000).toISOString()
          : new Date().toISOString(),
        targetId: String(targetId),
        silent,
      };

      logger.info(`Message sent to ${targetId}`, {
        sessionId,
        messageId: messageData.messageId,
      });

      return messageData;
    } catch (error) {
      logger.error(`Failed to send message to ${targetId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Send a message to a group (alias for sendMessage with group context).
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group identifier
   * @param {string} message - Message text
   * @returns {Promise<{ messageId: number, date: string, groupId: string }>}
   */
  async sendMessageToGroup(sessionId, groupId, message) {
    return this.sendMessage(sessionId, groupId, message, { noWebpage: false });
  }

  /**
   * Send a message to multiple users with configurable delay between each.
   *
   * @param {string} sessionId - Active session identifier
   * @param {Array<string|number>} userIds - Array of target user IDs
   * @param {string} message - Message text to send
   * @param {object} options - Bulk send options
   * @param {number} options.delay - Delay in ms between each message (default: 2000)
   * @param {boolean} options.silent - Send without notification
   * @param {number} options.retryFailed - Number of retries for failed messages (default: 2)
   * @returns {Promise<{ sent: number, failed: number, errors: object[], userIds: string[] }>}
   */
  async sendBulkMessage(sessionId, userIds, message, options = {}) {
    await this._ensureConnected(sessionId);

    const {
      delay = 2000,
      silent = false,
      retryFailed = 2,
    } = options;

    const results = {
      sent: 0,
      failed: 0,
      errors: [],
      userIds: [],
    };

    for (const userId of userIds) {
      try {
        let sent = false;
        let attempts = 0;

        while (!sent && attempts <= retryFailed) {
          try {
            await this.sendMessage(sessionId, userId, message, { silent });
            sent = true;
            results.sent++;
            results.userIds.push(String(userId));
          } catch (sendError) {
            attempts++;
            if (attempts > retryFailed) {
              results.failed++;
              results.errors.push({
                userId: String(userId),
                error: sendError.message,
                attempts,
              });
              logger.error(`Bulk message failed for user ${userId} after ${attempts} attempts`, {
                sessionId,
                error: sendError.message,
              });
            } else {
              await sleep(delay);
            }
          }
        }

        // Delay between messages to avoid flood
        if (delay > 0 && sent) {
          await sleep(delay);
        }
      } catch (error) {
        results.failed++;
        results.errors.push({
          userId: String(userId),
          error: error.message,
        });
      }
    }

    logger.info(
      `Bulk message complete: ${results.sent} sent, ${results.failed} failed out of ${userIds.length}`,
      { sessionId }
    );

    return results;
  }

  /**
   * Forward a message from one chat to another.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} targetId - Destination chat identifier
   * @param {number} messageId - Message ID to forward
   * @param {string|number} sourceId - Source chat identifier
   * @returns {Promise<{ messageId: number, date: string, sourceId: string, targetId: string }>}
   */
  async forwardMessage(sessionId, targetId, messageId, sourceId) {
    await this._ensureConnected(sessionId);

    try {
      const targetEntity = await this._resolveEntity(sessionId, targetId);
      const sourceEntity = await this._resolveEntity(sessionId, sourceId);

      if (!targetEntity || !sourceEntity) {
        throw new Error(`Could not resolve target or source entity`);
      }

      const result = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.messages.ForwardMessages({
            fromPeer: sourceEntity,
            id: [messageId],
            toPeer: targetEntity,
            silent: false,
            background: false,
            withMyScore: false,
            dropAuthor: false,
            dropMediaCaptions: false,
          })
        );
      });

      const forwardedId =
        result && result.updates && result.updates.length > 0
          ? result.updates[0].id
          : null;

      logger.info(`Message ${messageId} forwarded from ${sourceId} to ${targetId}`, { sessionId });

      return {
        messageId: forwardedId,
        date: new Date().toISOString(),
        sourceId: String(sourceId),
        targetId: String(targetId),
      };
    } catch (error) {
      logger.error(
        `Failed to forward message ${messageId} from ${sourceId} to ${targetId}`,
        { error: error.message }
      );
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // Group Operations
  // =========================================================================

  /**
   * Add a single member to a group.
   *
   * The optional `userOptions.accessHash` lets the caller skip entity
   * resolution when it already has a `(user_id, access_hash)` pair from
   * a previous scrape. Without it, calling this with a bare numeric id
   * for a stranger user almost always blows up with "Could not find the
   * input entity" — Telegram requires the access_hash to construct an
   * `InputUser`, and a stranger session has no way to look it up.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group identifier
   * @param {string|number} userId - User ID, @username, or +phone to add
   * @param {object} [userOptions]
   * @param {string} [userOptions.accessHash] - Decimal-string `access_hash`
   *   captured at scrape time. When present and `userId` is numeric, we
   *   skip resolution and build an `InputUser` directly.
   * @returns {Promise<{ success: boolean, groupId: string, userId: string }>}
   */
  async addMemberToGroup(sessionId, groupId, userId, userOptions = {}) {
    await this._ensureConnected(sessionId);

    try {
      const groupEntity = await this._resolveEntity(sessionId, groupId);
      if (!groupEntity) {
        throw new Error(`Could not resolve group: ${groupId}`);
      }

      // Resolve the user to get their InputUser. When the caller has an
      // access_hash hint and the identifier is purely numeric we can
      // skip resolution entirely — that's the *only* path that works
      // for an arbitrary scraped user the inviting session has never
      // seen before.
      const userEntity = await this._resolveEntity(sessionId, userId, {
        accessHash: userOptions && userOptions.accessHash,
      });
      if (!userEntity) {
        // Make the failure diagnosable from the Operation History UI.
        // The most common cause for a numeric-id row with no further
        // fallback is a missing or stale access_hash — say so plainly
        // instead of the generic "could not resolve" line, which has
        // historically led operators to think the panel was broken
        // when in fact Telegram simply doesn't have enough info to
        // route the invite.
        const idStr = String(userId);
        const looksNumeric = /^\d+$/.test(idStr);
        const hadHash = userOptions && userOptions.accessHash;
        let reason;
        if (looksNumeric && !hadHash) {
          reason =
            'Could not resolve user by numeric id alone — the row has no access_hash on file. ' +
            'Re-scrape the source group via the panel (the scrape captures access_hash automatically) ' +
            'or include access_hash in the imported CSV.';
        } else if (looksNumeric && hadHash) {
          reason =
            'Could not resolve user by numeric id even with the cached access_hash — Telegram ' +
            'returned UserEmpty (account is deactivated, deleted, or the hash is invalid for this session).';
        } else {
          reason = `Could not resolve user to add: ${userId}`;
        }
        throw new Error(reason);
      }

      const inputUser = new Api.InputUser({
        userId: userEntity.id,
        accessHash: userEntity.accessHash,
      });

      // Telegram has two completely different "add member" RPCs:
      //
      //   * `messages.AddChatUser`     → for **basic groups** (legacy
      //     "Chat" peer, no access_hash, capped at ~200 members).
      //   * `channels.InviteToChannel` → for **supergroups & channels**
      //     ("Channel" peer with access_hash). Calling this on a basic
      //     group fails with `400: CHAT_MEMBER_ADD_FAILED` because the
      //     RPC namespace is wrong — the group isn't a channel.
      //
      // GramJS exposes the entity's MTProto class as `className`, which
      // is `'Chat'` for basic groups and `'Channel'` for supergroups /
      // broadcast channels. Branch on that to pick the right RPC.
      const isBasicGroup = groupEntity.className === 'Chat';

      const inviteResult = await this._withFloodRetry(sessionId, async () => {
        const client = this.clients.get(String(sessionId)).client;
        if (isBasicGroup) {
          // `messages.AddChatUser` takes the legacy chat id directly
          // (no access_hash) and a `fwdLimit` for how many of the
          // recent messages the new user should see. Pick a small,
          // reasonable backfill — large values can be flagged as spam.
          return await client.invoke(
            new Api.messages.AddChatUser({
              chatId: groupEntity.id,
              userId: inputUser,
              fwdLimit: 50,
            })
          );
        }
        return await client.invoke(
          new Api.channels.InviteToChannel({
            channel: getInputPeer(groupEntity),
            users: [inputUser],
          })
        );
      });

      // Privacy-restricted detection differs between the two RPCs:
      //
      //   * `channels.InviteToChannel` — does NOT throw on privacy.
      //     It returns the user inside `missingInvitees` (Layer 198
      //     `messages.InvitedUsers` wrapper) and the call "succeeds".
      //     Since we only invite one user per call, any non-empty
      //     `missingInvitees` means our user was the one dropped.
      //
      //   * `messages.AddChatUser` — throws `USER_PRIVACY_RESTRICTED`
      //     directly, so it's already in the catch-block path.
      //
      // We also catch the legacy "empty updates && empty users" reply
      // (older deployments without the Layer 198 wrapper) as a silent
      // drop — same outcome as a privacy reject.
      if (!isBasicGroup) {
        const missing =
          (inviteResult && (inviteResult.missingInvitees || inviteResult.missing_invitees)) || [];
        const inviteUpdates = (inviteResult && inviteResult.updates) || null;
        const innerUpdates =
          inviteUpdates && Array.isArray(inviteUpdates.updates)
            ? inviteUpdates.updates
            : Array.isArray(inviteResult && inviteResult.updates)
              ? inviteResult.updates
              : [];
        const innerUsers =
          (inviteUpdates && Array.isArray(inviteUpdates.users) && inviteUpdates.users) ||
          (Array.isArray(inviteResult && inviteResult.users) && inviteResult.users) ||
          [];

        const silentlyDropped =
          (Array.isArray(missing) && missing.length > 0) ||
          (innerUpdates.length === 0 && innerUsers.length === 0);

        if (silentlyDropped) {
          const detail = (Array.isArray(missing) && missing[0]) || {};
          const wouldAllow = detail.premiumWouldAllowInvite || detail.premium_would_allow_invite;
          logger.warn(
            `Telegram dropped invite (privacy/restricted) for ${userId}` +
              (wouldAllow ? ' [premiumWouldAllowInvite=true]' : '') +
              ` (missing=${Array.isArray(missing) ? missing.length : 0}, updates=${innerUpdates.length}, users=${innerUsers.length})`,
            { sessionId, groupId }
          );
          throw new Error('USER_PRIVACY_RESTRICT');
        }
      }

      logger.info(
        `Added user ${userId} to ${isBasicGroup ? 'basic group' : 'channel/supergroup'} ${groupId}`,
        { sessionId }
      );

      return {
        success: true,
        groupId: String(groupId),
        userId: String(userId),
      };
    } catch (error) {
      logger.error(`Failed to add user ${userId} to group ${groupId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Add multiple members to a group with configurable delay.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group identifier
   * @param {Array<string|number>} userIdList - Array of user IDs to add
   * @param {object} options - Bulk add options
   * @param {number} options.delay - Delay in ms between each add (default: 3000)
   * @param {number} options.retryFailed - Number of retries per user (default: 2)
   * @returns {Promise<{ added: number, failed: number, errors: object[] }>}
   */
  async bulkAddMembers(sessionId, groupId, userIdList, options = {}) {
    await this._ensureConnected(sessionId);

    const {
      delay = 3000,
      retryFailed = 2,
    } = options;

    const results = {
      added: 0,
      failed: 0,
      errors: [],
    };

    // Resolve group entity once
    const groupEntity = await this._resolveEntity(sessionId, groupId);
    if (!groupEntity) {
      throw new Error(`Could not resolve group: ${groupId}`);
    }

    for (const userId of userIdList) {
      try {
        let added = false;
        let attempts = 0;

        while (!added && attempts <= retryFailed) {
          try {
            await this.addMemberToGroup(sessionId, groupId, userId);
            added = true;
            results.added++;
          } catch (addError) {
            attempts++;
            if (addError.message && addError.message.includes('FLOOD_WAIT')) {
              const seconds = extractFloodSeconds(addError.message);
              logger.warn(`Flood wait during bulk add: ${seconds}s for user ${userId}`, {
                sessionId,
              });
              await sleep(seconds * 1000);
              continue;
            }
            if (attempts > retryFailed) {
              results.failed++;
              results.errors.push({
                userId: String(userId),
                error: addError.message,
                attempts,
              });
            } else {
              await sleep(delay);
            }
          }
        }

        // Delay between adds
        await sleep(delay);
      } catch (error) {
        results.failed++;
        results.errors.push({
          userId: String(userId),
          error: error.message,
        });
      }
    }

    logger.info(
      `Bulk add complete: ${results.added} added, ${results.failed} failed out of ${userIdList.length}`,
      { sessionId, groupId }
    );

    return results;
  }

  /**
   * Remove a member from a group.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group identifier
   * @param {string|number} userId - User ID to remove
   * @returns {Promise<{ success: boolean, groupId: string, userId: string }>}
   */
  async removeMember(sessionId, groupId, userId) {
    await this._ensureConnected(sessionId);

    try {
      const groupEntity = await this._resolveEntity(sessionId, groupId);
      if (!groupEntity) {
        throw new Error(`Could not resolve group: ${groupId}`);
      }

      const userEntity = await this._resolveEntity(sessionId, userId);
      if (!userEntity) {
        throw new Error(`Could not resolve user to remove: ${userId}`);
      }

      const inputUser = new Api.InputUser({
        userId: userEntity.id,
        accessHash: userEntity.accessHash,
      });

      await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.channels.EditBanned({
            channel: getInputPeer(groupEntity),
            participant: inputUser,
            bannedRights: new Api.ChatBannedRights({
              untilDate: 0,
              viewMessages: true,
              sendMessages: true,
              sendMedia: true,
              sendStickers: true,
              sendGifs: true,
              sendGames: true,
              sendInline: true,
              embedLinks: true,
            }),
          })
        );
      });

      logger.info(`Removed user ${userId} from group ${groupId}`, { sessionId });

      return {
        success: true,
        groupId: String(groupId),
        userId: String(userId),
      };
    } catch (error) {
      logger.error(`Failed to remove user ${userId} from group ${groupId}`, {
        error: error.message,
      });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Get detailed information about a group or channel.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} groupId - Group/channel identifier
   * @returns {Promise<object>} Normalized group/channel info
   */
  async getGroupInfo(sessionId, groupId) {
    await this._ensureConnected(sessionId);

    try {
      const entity = await this._resolveEntity(sessionId, groupId);
      if (!entity) {
        throw new Error(`Could not resolve group/channel: ${groupId}`);
      }

      // Get full chat info
      const fullChat = await this._withFloodRetry(sessionId, async () => {
        if (entity.className === 'Channel') {
          return await this.clients.get(String(sessionId)).client.invoke(
            new Api.channels.GetFullChannel({
              channel: getInputPeer(entity),
            })
          );
        } else if (entity.className === 'Chat') {
          return await this.clients.get(String(sessionId)).client.invoke(
            new Api.messages.GetFullChat({
              chatId: entity.id,
            })
          );
        }
        return null;
      });

      const normalized = normalizeEntity(entity);

      if (fullChat) {
        const fullChatInfo = fullChat.fullChat;
        if (fullChatInfo) {
          normalized.about = fullChatInfo.about || null;
          normalized.participantsCount = fullChatInfo.participantsCount || 0;
          normalized.adminsCount = fullChatInfo.adminsCount || 0;
          normalized.kickedCount = fullChatInfo.kickedCount || 0;
          normalized.bannedCount = fullChatInfo.bannedCount || 0;
          normalized.canViewParticipants = fullChatInfo.canViewParticipants || false;
          normalized.canSetUsername = fullChatInfo.canSetUsername || false;
          normalized.slowmodeEnabled = fullChatInfo.slowmodeEnabled || false;
          normalized.slowmodeSeconds = fullChatInfo.slowmodeSeconds || 0;
          normalized.linkedChatId = fullChatInfo.linkedChatId
            ? Number(fullChatInfo.linkedChatId)
            : null;
          normalized.description = fullChatInfo.about || null;
        }

        // Export invite link if possible
        try {
          if (entity.className === 'Channel') {
            const exportResult = await this.clients.get(String(sessionId)).client.invoke(
              new Api.channels.ExportInviteLink({
                channel: getInputPeer(entity),
              })
            );
            normalized.inviteLink = exportResult.link || null;
          }
        } catch (linkError) {
          logger.debug(`Could not export invite link for ${groupId}`, {
            error: linkError.message,
          });
        }
      }

      return normalized;
    } catch (error) {
      logger.error(`Failed to get group info for ${groupId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Create a new supergroup.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} title - Group title
   * @param {Array<string|number>} members - Array of user IDs to add initially
   * @returns {Promise<object>} Created group information
   */
  async createGroup(sessionId, title, members = []) {
    await this._ensureConnected(sessionId);

    try {
      // Resolve member InputUsers
      const inputUsers = [];
      for (const userId of members) {
        const userEntity = await this._resolveEntity(sessionId, userId);
        if (userEntity) {
          inputUsers.push(
            new Api.InputUser({
              userId: userEntity.id,
              accessHash: userEntity.accessHash,
            })
          );
        }
      }

      // Create the supergroup
      const result = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.channels.CreateChannel({
            title: title,
            about: '',
            megagroup: true,
            users: inputUsers,
          })
        );
      });

      // Extract the created channel from updates
      let createdChannel = null;
      if (result && result.chats) {
        for (const chat of result.chats) {
          if (chat.className === 'Channel') {
            createdChannel = chat;
            break;
          }
        }
      }

      const normalized = normalizeEntity(createdChannel);

      logger.info(`Created group "${title}" with ${inputUsers.length} initial members`, {
        sessionId,
      });

      return {
        ...normalized,
        membersAdded: inputUsers.length,
        createdAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.error(`Failed to create group "${title}"`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // 2FA Management
  // =========================================================================

  /**
   * Enable Two-Factor Authentication (Cloud Password) on the account.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} password - New 2FA password
   * @param {string} hint - Password hint (optional)
   * @param {string} email - Recovery email (optional)
   * @returns {Promise<{ success: boolean, enabled: boolean }>}
   */
  async enable2FA(sessionId, password, hint = '', email = '') {
    await this._ensureConnected(sessionId);

    try {
      const client = this.clients.get(String(sessionId)).client;

      // Get current password settings
      const passwordRequest = await client.invoke(new Api.account.GetPassword());
      const newAlgo = prepareNewPasswordAlgo(passwordRequest);

      const passwordSrp = new Api.InputCheckPasswordEmpty();
      const newPasswordHash = await computeNewPasswordHash(newAlgo, password);

      // Update the password
      await this._withFloodRetry(sessionId, async () => {
        return await client.invoke(
          new Api.account.UpdatePasswordSettings({
            password: passwordSrp,
            newSettings: new Api.account.PasswordInputSettings({
              newAlgo,
              newPasswordHash,
              hint: hint,
              email: email ? new Api.InputTextEmailMessage({ email }) : undefined,
            }),
          })
        );
      });

      logger.info(`2FA enabled for session ${sessionId}`);

      return {
        success: true,
        enabled: true,
      };
    } catch (error) {
      logger.error(`Failed to enable 2FA for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Disable Two-Factor Authentication on the account.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} currentPassword - Current 2FA password
   * @returns {Promise<{ success: boolean, enabled: boolean }>}
   */
  async disable2FA(sessionId, currentPassword) {
    await this._ensureConnected(sessionId);

    try {
      const client = this.clients.get(String(sessionId)).client;

      // Get current password settings
      const passwordRequest = await client.invoke(new Api.account.GetPassword());
      const newAlgo = prepareNewPasswordAlgo(passwordRequest);

      // Compute the password check to verify identity
      const passwordSrp = await computeCheck(passwordRequest, currentPassword);

      // Disable by setting empty password
      await this._withFloodRetry(sessionId, async () => {
        return await client.invoke(
          new Api.account.UpdatePasswordSettings({
            password: passwordSrp,
            newSettings: new Api.account.PasswordInputSettings({
              newAlgo,
              newPasswordHash: Buffer.alloc(0),
              hint: '',
            }),
          })
        );
      });

      logger.info(`2FA disabled for session ${sessionId}`);

      return {
        success: true,
        enabled: false,
      };
    } catch (error) {
      logger.error(`Failed to disable 2FA for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Change the 2FA password.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} oldPass - Current 2FA password
   * @param {string} newPass - New 2FA password
   * @returns {Promise<{ success: boolean }>}
   */
  async change2FA(sessionId, oldPass, newPass) {
    await this._ensureConnected(sessionId);

    try {
      const client = this.clients.get(String(sessionId)).client;

      // Get current password settings
      const passwordRequest = await client.invoke(new Api.account.GetPassword());
      const newAlgo = prepareNewPasswordAlgo(passwordRequest);

      // Compute the current password check
      const currentPasswordSrp = await computeCheck(passwordRequest, oldPass);

      const newPasswordHash = await computeNewPasswordHash(newAlgo, newPass);

      // Update the password
      await this._withFloodRetry(sessionId, async () => {
        return await client.invoke(
          new Api.account.UpdatePasswordSettings({
            password: currentPasswordSrp,
            newSettings: new Api.account.PasswordInputSettings({
              newAlgo,
              newPasswordHash,
              hint: passwordRequest.hint || '',
            }),
          })
        );
      });

      logger.info(`2FA password changed for session ${sessionId}`);

      return {
        success: true,
      };
    } catch (error) {
      logger.error(`Failed to change 2FA password for session ${sessionId}`, {
        error: error.message,
      });
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // Account Operations
  // =========================================================================

  /**
   * Get the current authenticated user's information.
   *
   * @param {string} sessionId - Active session identifier
   * @returns {Promise<object>} Normalized user information for self
   */
  async getMe(sessionId) {
    await this._ensureConnected(sessionId);

    try {
      const me = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.getMe();
      });

      return normalizeEntity(me);
    } catch (error) {
      logger.error(`Failed to getMe for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Update the current user's profile (name and bio).
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} firstName - New first name
   * @param {string} lastName - New last name (optional)
   * @param {string} bio - New bio/about text (optional)
   * @returns {Promise<object>} Updated user information
   */
  async updateProfile(sessionId, firstName, lastName = '', bio = '') {
    await this._ensureConnected(sessionId);

    try {
      const updates = [];

      // Update name
      if (firstName || lastName !== '') {
        await this._withFloodRetry(sessionId, async () => {
          return await this.clients.get(String(sessionId)).client.invoke(
            new Api.account.UpdateProfile({
              firstName: firstName || '',
              lastName: lastName,
            })
          );
        });
        updates.push('name');
      }

      // Update bio
      if (bio !== '') {
        await this._withFloodRetry(sessionId, async () => {
          return await this.clients.get(String(sessionId)).client.invoke(
            new Api.account.UpdateProfile({
              about: bio,
            })
          );
        });
        updates.push('bio');
      }

      // Get updated profile
      const updated = await this.getMe(sessionId);

      logger.info(`Updated profile fields: ${updates.join(', ')}`, { sessionId });

      return {
        ...updated,
        updatedFields: updates,
      };
    } catch (error) {
      logger.error(`Failed to update profile for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Update username for a session.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} username - New username (without @)
   * @returns {Promise<{username: string}>}
   */
  async updateUsername(sessionId, username) {
    await this._ensureConnected(sessionId);

    try {
      // Remove @ if present
      const cleanUsername = username.startsWith('@') ? username.substring(1) : username;

      await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.account.UpdateUsername({
            username: cleanUsername,
          })
        );
      });

      // Get updated profile
      const updated = await this.getMe(sessionId);

      logger.info(`Updated username to ${cleanUsername}`, { sessionId });

      return {
        ...updated,
        updatedField: 'username',
      };
    } catch (error) {
      logger.error(`Failed to update username for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Update profile photo for a session.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} filePath - Path to the image file
   * @returns {Promise<{success: boolean}>}
   */
  async updateProfilePhoto(sessionId, filePath) {
    await this._ensureConnected(sessionId);

    try {
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        throw new Error(`Image file not found: ${filePath}`);
      }

      await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.photos.UploadProfilePhoto({
            file: await this.clients.get(String(sessionId)).client.uploadFile({
              file: filePath,
              workers: 1,
            }),
          })
        );
      });

      logger.info(`Updated profile photo`, { sessionId });

      return {
        success: true,
        updatedField: 'profile_photo',
      };
    } catch (error) {
      logger.error(`Failed to update profile photo for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Get the contact list of the current user.
   *
   * @param {string} sessionId - Active session identifier
   * @returns {Promise<{ contacts: object[], total: number }>}
   */
  async getContacts(sessionId) {
    await this._ensureConnected(sessionId);

    try {
      const contacts = await this._withFloodRetry(sessionId, async () => {
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.contacts.GetContacts({
            hash: BigInt(0),
          })
        );
      });

      const contactList = [];
      if (contacts && contacts.users) {
        for (const user of contacts.users) {
          if (user.className === 'User') {
            contactList.push(normalizeEntity(user));
          }
        }
      }

      logger.info(`Retrieved ${contactList.length} contacts for session ${sessionId}`);

      return {
        contacts: contactList,
        total: contactList.length,
      };
    } catch (error) {
      logger.error(`Failed to get contacts for session ${sessionId}`, { error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  /**
   * Get a client instance by session ID.
   *
   * @param {string} sessionId - Session identifier
   * @returns {{ client: TelegramClient, connected: boolean, apiId: number, apiHash: string }|null}
   * @private
   */
  _getClient(sessionId) {
    return this.clients.get(String(sessionId)) || null;
  }

  /**
   * Load a session from database and create a TelegramClient.
   * Used for auto-loading sessions that were previously logged in.
   */
  async _loadSessionFromDB(sessionId) {
    try {
      const { pool } = require('../config/database');
      const fs = require('fs').promises;
      const path = require('path');
      const { decrypt } = require('../utils/crypto');
      
      const result = await pool.query(
        `SELECT id, session_file_path, api_id, api_hash, is_logged_in, status,
                device_identity, bound_proxy_id, user_api_credential_id,
                dc_id, dc_ip, dc_port
         FROM sessions WHERE id = $1`,
        [sessionId]
      );
      
      const session = result.rows[0];
      if (!session) {
        logger.warn(`Session ${sessionId} not found in database`);
        return;
      }
      
      // Allow sessions that are either active or uploaded (for uploaded telethon sessions)
      const validStatuses = ['active', 'uploaded', 'logged_in'];
      if (!validStatuses.includes(session.status)) {
        logger.warn(`Session ${sessionId} has invalid status: ${session.status}`);
        return;
      }
      
      const uploadRoot = process.env.UPLOAD_DIR_ABS
        || (process.env.NODE_ENV === 'production' ? '/app/uploads' : path.resolve(__dirname, '../../uploads'));
      const sessionPath = path.join(uploadRoot, session.session_file_path);
      const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf8'));
      let sessionString = sessionData.session;
      
      if (!sessionString) {
        logger.warn(`Session ${sessionId} has no session string in file`);
        return;
      }
      
      // Decrypt the session string if it was encrypted (uploaded sessions are encrypted)
      try {
        sessionString = decrypt(sessionString);
        logger.debug(`Session ${sessionId} decrypted successfully`);
      } catch (decryptError) {
        // If decryption fails, the session might already be in plain format
        logger.debug(`Session ${sessionId} may not be encrypted, using as-is`);
      }
      
      // v8: prefer the live per-user credential vault — that way an
      // owner who rotates their api_hash in Settings has the new hash
      // picked up on the next reconnect. Fall back to the per-row
      // snapshot (legacy) and finally to the panel-wide env-vars.
      let apiId = session.api_id || telegramConfig.apiId;
      let apiHash = session.api_hash || telegramConfig.apiHash;
      if (session.user_api_credential_id) {
        try {
          const userApiCredentials = require('./userApiCredentialsService');
          const cred = await userApiCredentials.loadDecrypted(session.user_api_credential_id);
          if (cred && cred.isActive) {
            apiId = cred.apiId;
            apiHash = cred.apiHash;
          }
        } catch (credErr) {
          logger.debug(`credential load failed for session ${sessionId}: ${credErr.message}; falling back to snapshot`);
        }
      }

      // Anti-Detect: replay the persisted device identity so each
      // reconnect looks like the same physical device. If the row has
      // no identity yet (legacy session), generate + persist one now.
      const identityService = require('./identityService');
      let identity = null;
      try {
        identity = session.device_identity
          ? fingerprint.sanitizeIdentity(
              typeof session.device_identity === 'string'
                ? JSON.parse(session.device_identity)
                : session.device_identity
            )
          : null;
        if (!identity) {
          identity = await identityService.loadOrCreate(sessionId);
        }
      } catch (idErr) {
        logger.warn(`identity load failed during _loadSessionFromDB ${sessionId}: ${idErr.message}`);
      }
      const idOpts = fingerprint.toClientOptions(identity);

      // Anti-Detect: respect the bound proxy if one is configured.
      let proxyConf = null;
      try {
        const proxyService = require('./proxyService');
        const row = await proxyService.assignProxyForSession(sessionId);
        proxyConf = proxyService.buildGramJSProxy(row);
      } catch (proxyErr) {
        logger.debug(`proxy assign failed during _loadSessionFromDB ${sessionId}: ${proxyErr.message}`);
      }

      const stringSession = new StringSession(sessionString);
      // Anti-revoke Phase 1 (B1): if STRICT_FINGERPRINT is on and we
      // would otherwise leak the panel-default device row, refuse — the
      // operator must persist a real identity first.
      if (telegramConfig.STRICT_FINGERPRINT && telegramConfig.ANTI_REVOKE_PHASE_1_ENABLED) {
        if (!idOpts.deviceModel || !idOpts.systemVersion || !idOpts.appVersion) {
          throw new Error(
            `Refusing to connect session ${sessionId}: no device identity bound (STRICT_FINGERPRINT). ` +
              `Run identityService.loadOrCreate(${sessionId}) first.`
          );
        }
      }
      // Anti-revoke Phase 1 (B12): for Android / iOS / Desktop profiles,
      // override useWSS=false (real apps use TCP MTProto). Web profiles
      // keep WSS. The proxy override (TCP-only) still wins.
      const transportPlatform = (identity && identity.platform) || '';
      const wantsWss = ['web'].includes(transportPlatform)
        ? telegramConfig.useWSS
        : false;
      const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: telegramConfig.connectionRetries,
        timeout: telegramConfig.timeout,
        deviceModel: idOpts.deviceModel || telegramConfig.deviceModel,
        systemVersion: idOpts.systemVersion || telegramConfig.systemVersion,
        appVersion: idOpts.appVersion || telegramConfig.appVersion,
        langCode: idOpts.langCode || telegramConfig.langCode,
        systemLangCode: idOpts.systemLangCode || idOpts.langCode || telegramConfig.langCode,
        baseLogger: telegramConfig.baseLogger,
        useWSS: proxyConf ? false : wantsWss,
        autoReconnect: true,
        proxy: proxyConf || undefined,
      });

      // Anti-revoke Phase 1 (B4): if a DC pin is persisted, set it on
      // the session BEFORE connect so the auth_key lands on its
      // original DC and doesn't trigger an `auth.ImportAuthorization`
      // round-trip.
      try {
        if (session.dc_id && client.session && typeof client.session.setDc === 'function') {
          client.session.setDc(session.dc_id, session.dc_ip || '', session.dc_port || 443);
        }
      } catch (dcErr) {
        logger.debug(`DC pin set failed for ${sessionId}: ${dcErr.message}`);
      }

      await client.connect();

      const sessionIdStr = String(sessionId);
      this.clients.set(sessionIdStr, {
        client,
        connected: true,
        apiId,
        apiHash,
        proxy: proxyConf || null,
        identity: identity || null,
      });
      // Anti-revoke Phase 1 (B4): persist whichever DC the auth_key
      // ended up on (first connect on a fresh row, or roaming after a
      // forced migrate). Cheap; idempotent.
      try { await this.persistDcPinFromClient(sessionIdStr); } catch { /* noop */ }
//      // DEBUG console.log('[F] Session stored, Map size after:', this.clients.size, 'keys:', Array.from(this.clients.keys()));
      
      logger.info(`Session ${sessionId} loaded from database`);
    } catch (error) {
      logger.error(`_loadSessionFromDB failed for session ${sessionId}:`, error);
//      // DEBUG console.log('[ERROR] _loadSessionFromDB error:', error.message);
      throw error;
    }
  }

  /**
   * Ensure the client for a given session is connected.
   * Attempts reconnection if the client is disconnected.
   *
   * @param {string} sessionId - Session identifier
   * @throws {Error} If the session does not exist or cannot be reconnected
   * @private
   */
  async _ensureConnected(sessionId, opts = {}) {
    const sessionIdStr = String(sessionId);
    let entry = this.clients.get(sessionIdStr);

    logger.debug(`_ensureConnected called for sessionId: "${sessionIdStr}", found: ${!!entry}`);
    logger.debug(`Current clients keys: ${Array.from(this.clients.keys()).join(', ')}`);

    if (!entry) {
      // Session not in memory - try to load it from the database
      logger.info(`Session ${sessionId} not in memory, loading from database...`);
      await this._loadSessionFromDB(sessionId);
      entry = this.clients.get(sessionIdStr);

      if (!entry) {
        logger.error(`Session ${sessionId} still not found after loading from DB`);
        throw new Error(`Session ${sessionId} not found. Create or load the session first.`);
      }
    }

    const { client, apiId, apiHash } = entry;
    const proxyConf = entry.proxy || null;
    const idOpts = fingerprint.toClientOptions(entry.identity);
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : TG_CONNECT_TIMEOUT_MS;
    // When the caller asks for proxy fallback we'll retry once without
    // the configured proxy if the proxied connect times out. Default
    // off so legacy callers retain today's "stick to the bound proxy"
    // behaviour; the clear-chats job opts in.
    const allowProxyFallback = !!opts.allowProxyFallback;

    // Check if the client is still connected
    let isConnected = false;
    try {
      isConnected = client.connected;
    } catch {
      isConnected = false;
    }

    if (!isConnected) {
      logger.info(`Reconnecting session ${sessionId} (timeout=${timeoutMs}ms)`);
      let connectError = null;
      try {
        await withTimeout(
          client.connect(),
          timeoutMs,
          'TG_CONNECT',
        );
        entry.connected = true;
        this.clients.set(sessionId, entry);
      } catch (err) {
        connectError = err;
        // Best-effort: tell gramJS to stop the in-flight reconnect
        // loop so its retry-forever behaviour doesn't keep the
        // backend pinned on a dead proxy after we've already given
        // up on this attempt.
        try { await client.disconnect(); } catch (_) { /* ignore */ }
      }

      if (connectError) {
        // First fallback path: when the bound proxy times out and
        // the caller opted into a direct-IP retry, rebuild a fresh
        // client without the proxy and try once more on this VM's
        // egress IP. This is the "added proxies didn't respond in
        // 10s, use the present device IP" behaviour.
        const isProxyTimeout =
          allowProxyFallback
          && proxyConf
          && (connectError.isTimeout || /timed out|timeout/i.test(connectError.message || ''));
        if (isProxyTimeout) {
          const sessionData = this.sessionStore.get(sessionId);
          if (sessionData) {
            try {
              const sessionString = decrypt(sessionData);
              const stringSession = new StringSession(sessionString);
              const directClient = new TelegramClient(stringSession, apiId, apiHash, {
                connectionRetries: 1,
                timeout: telegramConfig.timeout,
                deviceModel: idOpts.deviceModel || telegramConfig.deviceModel,
                systemVersion: idOpts.systemVersion || telegramConfig.systemVersion,
                appVersion: idOpts.appVersion || telegramConfig.appVersion,
                langCode: idOpts.langCode || telegramConfig.langCode,
                systemLangCode: idOpts.systemLangCode || idOpts.langCode || telegramConfig.langCode,
                baseLogger: telegramConfig.baseLogger,
                useWSS: telegramConfig.useWSS,
                autoReconnect: true,
                // No proxy — use the panel's egress IP directly.
                proxy: undefined,
              });
              await withTimeout(
                directClient.connect(),
                timeoutMs,
                'TG_CONNECT_DIRECT',
              );
              entry.client = directClient;
              entry.connected = true;
              entry.proxyBypassed = true;
              this.clients.set(sessionId, entry);
              logger.warn(
                `Session ${sessionId} bound proxy unreachable in ${timeoutMs}ms; reconnected directly`,
              );
              return entry;
            } catch (directErr) {
              logger.error(
                `Session ${sessionId} direct-IP fallback also failed: ${directErr.message}`,
              );
              try { /* best-effort cleanup */ } catch (_) {}
              throw new Error(
                `Session ${sessionId} could not connect via proxy or direct IP: ${directErr.message}`,
              );
            }
          }
        }

        // Second fallback (legacy): if reconnect fails, try to
        // create a new client from stored session, still respecting
        // the bound proxy. Wrapped in a timeout so a dead proxy
        // doesn't stall here either.
        const sessionData = this.sessionStore.get(sessionId);
        if (sessionData) {
          try {
            const sessionString = decrypt(sessionData);
            const stringSession = new StringSession(sessionString);
            const newClient = new TelegramClient(stringSession, apiId, apiHash, {
              connectionRetries: telegramConfig.connectionRetries,
              timeout: telegramConfig.timeout,
              deviceModel: idOpts.deviceModel || telegramConfig.deviceModel,
              systemVersion: idOpts.systemVersion || telegramConfig.systemVersion,
              appVersion: idOpts.appVersion || telegramConfig.appVersion,
              langCode: idOpts.langCode || telegramConfig.langCode,
              systemLangCode: idOpts.systemLangCode || idOpts.langCode || telegramConfig.langCode,
              baseLogger: telegramConfig.baseLogger,
              useWSS: proxyConf ? false : telegramConfig.useWSS,
              autoReconnect: true,
              proxy: proxyConf || undefined,
            });

            await withTimeout(
              newClient.connect(),
              timeoutMs,
              'TG_RECONNECT',
            );

            entry.client = newClient;
            entry.connected = true;
            this.clients.set(sessionId, entry);

            logger.info(`Session ${sessionId} reconnected with new client`);
          } catch (recreateError) {
            logger.error(`Failed to recreate client for session ${sessionId}`, {
              error: recreateError.message,
            });
            throw new Error(
              `Session ${sessionId} is disconnected and could not be reconnected: ${recreateError.message}`
            );
          }
        } else {
          throw new Error(
            `Session ${sessionId} is disconnected and no stored session data is available: ${connectError.message}`
          );
        }
      }
    }

    return entry;
  }

  /**
   * Resolve a Telegram entity from various identifier formats.
   *
   * Supports:
   * - Usernames (with or without @ prefix)
   * - Phone numbers (with + prefix)
   * - Numeric IDs (direct entity ID)
   * - Invite links (t.me/joinchat/ or t.me/+...)
   * - Channel/group usernames (with or without @)
   *
   * @param {string} sessionId - Active session identifier
   * @param {string|number} identifier - The identifier to resolve
   * @returns {Promise<object|null>} Resolved entity or null
   * @private
   */
  async _resolveEntity(sessionId, identifier, options = {}) {
    await this._ensureConnected(sessionId);
    const client = this.clients.get(String(sessionId)).client;

    // Accept either `(sessionId, identifier, accessHash)` for ergonomic
    // callers and the canonical `(sessionId, identifier, { accessHash })`
    // shape used internally. We keep both because plumbing the hash
    // through every call site as a string is much less invasive than
    // converting them all to objects.
    let accessHashHint = null;
    if (options && typeof options === 'object') {
      accessHashHint = options.accessHash || null;
    } else if (typeof options === 'string' || typeof options === 'bigint') {
      accessHashHint = options;
    }
    const normalizedAccessHash = accessHashHint != null
      ? this._normalizeAccessHashHint(accessHashHint)
      : null;

    try {
      // If it's already a resolved entity, return it
      if (identifier && typeof identifier === 'object' && identifier.className) {
        return identifier;
      }

      const idStr = String(identifier).trim();

      // Fast path: numeric id + cached access_hash. This is the *only*
      // reliable way to invite a stranger user by id — without the
      // access_hash GramJS hits "Could not find the input entity" and
      // every fallback below is also doomed to fail because we have
      // never interacted with the user.
      if (normalizedAccessHash !== null && /^\d+$/.test(idStr)) {
        try {
          const entity = await this._withFloodRetry(sessionId, async () => {
            return await client.invoke(
              new Api.users.GetUsers({
                id: [
                  new Api.InputUser({
                    userId: BigInt(idStr),
                    accessHash: normalizedAccessHash,
                  }),
                ],
              })
            );
          });

          if (entity && entity.length > 0 && entity[0].className && entity[0].className !== 'UserEmpty') {
            return entity[0];
          }
        } catch (hintErr) {
          // Fall through to the legacy resolution chain so a stale or
          // garbled access_hash doesn't permanently block resolution
          // — many scraped hashes are still valid even when GetUsers
          // returns UserEmpty for the row (privacy / deactivated).
          logger.debug(`Numeric+accessHash resolution failed for ${idStr}`, {
            sessionId,
            error: hintErr && hintErr.message,
          });
        }
      }

      // Handle invite links
      if (idStr.startsWith('https://t.me/joinchat/') || idStr.startsWith('https://t.me/+')) {
        try {
          const result = await this._withFloodRetry(sessionId, async () => {
            return await client.invoke(
              new Api.messages.CheckChatInvite({
                hash: idStr.split('/').pop(),
              })
            );
          });

          if (result.className === 'ChatInvite') {
            // Import the invite to get the channel/chat
            const imported = await this._withFloodRetry(sessionId, async () => {
              return await client.invoke(
                new Api.messages.ImportChatInvite({
                  hash: idStr.split('/').pop(),
                })
              );
            });

            if (imported && imported.chats && imported.chats.length > 0) {
              return imported.chats[0];
            }
          }
        } catch (inviteError) {
          logger.debug(`Invite link resolution failed`, { error: inviteError.message });
          // Continue to try other resolution methods
        }
      }

      // Handle usernames (with or without @)
      if (idStr.startsWith('@') || (idStr.length > 4 && !idStr.includes('+'))) {
        const username = idStr.startsWith('@') ? idStr.slice(1) : idStr;

        // Skip if it looks like a numeric ID
        if (!/^\d+$/.test(username)) {
          try {
            const entity = await this._withFloodRetry(sessionId, async () => {
              return await client.getEntity(username);
            });
            if (entity) return entity;
          } catch {
            // Username not found, continue to other methods
          }
        }
      }

      // Handle phone numbers
      if (idStr.startsWith('+') && /^\+\d{5,15}$/.test(idStr)) {
        try {
          const result = await this._withFloodRetry(sessionId, async () => {
            return await client.invoke(
              new Api.contacts.ImportContacts({
                contacts: [
                  new Api.InputPhoneContact({
                    clientId: BigInt(0),
                    phone: idStr,
                    firstName: '',
                    lastName: '',
                  }),
                ],
              })
            );
          });

          if (result.users && result.users.length > 0) {
            return result.users[0];
          }
        } catch {
          // Phone number not found, continue
        }
      }

      // Handle numeric IDs (telegram peer IDs)
      if (/^\d+$/.test(idStr)) {
        const numericId = parseInt(idStr, 10);

        // Try to get entity directly
        try {
          const entity = await this._withFloodRetry(sessionId, async () => {
            return await client.getEntity(numericId);
          });
          if (entity) return entity;
        } catch {
          // Direct entity get failed
        }

        // Try as a user ID with InputUser
        try {
          const entity = await this._withFloodRetry(sessionId, async () => {
            return await client.invoke(
              new Api.users.GetUsers({
                id: [
                  new Api.InputUser({
                    userId: BigInt(numericId),
                    accessHash: BigInt(0),
                  }),
                ],
              })
            );
          });

          if (entity && entity.length > 0 && entity[0].className !== 'UserEmpty') {
            return entity[0];
          }
        } catch {
          // User lookup failed
        }
      }

      // Last resort: try to resolve as raw string
      try {
        const entity = await this._withFloodRetry(sessionId, async () => {
          return await client.getEntity(idStr);
        });
        if (entity) return entity;
      } catch {
        // Final attempt failed
      }

      return null;
    } catch (error) {
      logger.error(`Failed to resolve entity: ${identifier}`, { error: error.message });
      return null;
    }
  }

  /**
   * Coerce a caller-supplied access_hash into a `BigInt` suitable for
   * use as an `InputUser.accessHash`. Accepts strings (decimal),
   * numbers, BigInts, and the canonical-zero "no hash" sentinel. Returns
   * null when the value is missing or unparseable so the resolver can
   * fall back to the legacy resolution chain instead of crashing.
   *
   * @param {*} hint
   * @returns {bigint|null}
   * @private
   */
  _normalizeAccessHashHint(hint) {
    try {
      if (hint === null || hint === undefined) return null;
      if (typeof hint === 'bigint') return hint === BigInt(0) ? null : hint;
      if (typeof hint === 'number') {
        if (!Number.isFinite(hint) || hint === 0) return null;
        return BigInt(Math.trunc(hint));
      }
      const s = String(hint).trim();
      if (!s || s === '0') return null;
      if (!/^-?\d+$/.test(s)) return null;
      return BigInt(s);
    } catch {
      return null;
    }
  }

  /**
   * Handle and classify Telegram API errors into a structured format.
   *
   * @param {Error} error - The error object from GramJS
   * @returns {Error} An enriched error with structured information
   * @private
   */
  _handleTelegramError(error) {
    if (!error) {
      return new Error('Unknown error occurred');
    }

    const errorMessage = error.message || String(error);

    // Map of known Telegram error codes to human-readable messages
    const errorMap = {
      FLOOD_WAIT: {
        pattern: /FLOOD_WAIT_(\d+)/i,
        message: (seconds) =>
          `Rate limited by Telegram. You must wait ${seconds} seconds before trying again.`,
        code: 'FLOOD_WAIT',
        retryable: true,
        statusCode: 429,
      },
      SESSION_REVOKED: {
        pattern: /SESSION_REVOKED/i,
        message: 'The session has been revoked and is no longer valid.',
        code: 'SESSION_REVOKED',
        retryable: false,
        statusCode: 401,
      },
      SESSION_EXPIRED: {
        pattern: /SESSION_EXPIRED/i,
        message: 'The session has expired. Please re-authenticate.',
        code: 'SESSION_EXPIRED',
        retryable: false,
        statusCode: 401,
      },
      AUTH_KEY_UNREGISTERED: {
        pattern: /AUTH_KEY_UNREGISTERED/i,
        message: 'The session authorization key is not registered.',
        code: 'AUTH_KEY_UNREGISTERED',
        retryable: false,
        statusCode: 401,
      },
      AUTH_KEY_DUPLICATED: {
        pattern: /AUTH_KEY_DUPLICATED/i,
        message:
          'The session authorization key is in use by another connection ' +
          'and has been revoked by Telegram. Please re-upload or re-login the session.',
        code: 'AUTH_KEY_DUPLICATED',
        retryable: false,
        statusCode: 401,
      },
      USER_DEACTIVATED: {
        pattern: /USER_DEACTIVATED(_BAN)?/i,
        message: 'The Telegram account associated with this session is deactivated.',
        code: 'USER_DEACTIVATED',
        retryable: false,
        statusCode: 401,
      },
      USER_BANNED_IN_CHANNEL: {
        pattern: /USER_BANNED_IN_CHANNEL/i,
        message: 'You are banned from this channel or group.',
        code: 'USER_BANNED_IN_CHANNEL',
        retryable: false,
        statusCode: 403,
      },
      PRIVACY_RESTRICTED: {
        pattern: /PrivacyRestricted/i,
        message: "The user's privacy settings prevent this action.",
        code: 'PRIVACY_RESTRICTED',
        retryable: false,
        statusCode: 403,
      },
      PHONE_NUMBER_INVALID: {
        pattern: /PHONE_NUMBER_INVALID/i,
        message: 'The phone number provided is invalid.',
        code: 'PHONE_NUMBER_INVALID',
        retryable: true,
        statusCode: 400,
      },
      PHONE_CODE_INVALID: {
        pattern: /PHONE_CODE_INVALID/i,
        message: 'The verification code is invalid.',
        code: 'PHONE_CODE_INVALID',
        retryable: true,
        statusCode: 400,
      },
      PHONE_CODE_EXPIRED: {
        pattern: /PHONE_CODE_EXPIRED/i,
        message: 'The verification code has expired. Please request a new one.',
        code: 'PHONE_CODE_EXPIRED',
        retryable: true,
        statusCode: 400,
      },
      API_ID_INVALID: {
        pattern: /API_ID_INVALID/i,
        message: 'The API ID is invalid.',
        code: 'API_ID_INVALID',
        retryable: false,
        statusCode: 400,
      },
      API_HASH_INVALID: {
        pattern: /API_HASH_INVALID/i,
        message: 'The API Hash is invalid.',
        code: 'API_HASH_INVALID',
        retryable: false,
        statusCode: 400,
      },
      USER_NOT_MUTUAL_CONTACT: {
        pattern: /USER_NOT_MUTUAL_CONTACT/i,
        message: 'The user is not a mutual contact.',
        code: 'USER_NOT_MUTUAL_CONTACT',
        retryable: false,
        statusCode: 403,
      },
      CHAT_ADMIN_REQUIRED: {
        pattern: /CHAT_ADMIN_REQUIRED/i,
        message: 'You must be an admin of this chat to perform this action.',
        code: 'CHAT_ADMIN_REQUIRED',
        retryable: false,
        statusCode: 403,
      },
      CHAT_WRITE_FORBIDDEN: {
        pattern: /CHAT_WRITE_FORBIDDEN/i,
        message: 'You cannot send messages in this chat.',
        code: 'CHAT_WRITE_FORBIDDEN',
        retryable: false,
        statusCode: 403,
      },
      MESSAGE_TOO_LONG: {
        pattern: /MESSAGE_TOO_LONG/i,
        message: `The message exceeds Telegram's maximum length of ${MAX_MESSAGE_LENGTH} characters.`,
        code: 'MESSAGE_TOO_LONG',
        retryable: true,
        statusCode: 400,
      },
      MEDIA_INVALID: {
        pattern: /MEDIA_INVALID/i,
        message: 'The media file is invalid or corrupted.',
        code: 'MEDIA_INVALID',
        retryable: true,
        statusCode: 400,
      },
      INPUT_USER_DEACTIVATED: {
        pattern: /INPUT_USER_DEACTIVATED/i,
        message: 'The target user account has been deactivated.',
        code: 'INPUT_USER_DEACTIVATED',
        retryable: false,
        statusCode: 400,
      },
      PEER_FLOOD: {
        pattern: /PEER_FLOOD/i,
        message: 'Too many actions performed. Please wait before trying again.',
        code: 'PEER_FLOOD',
        retryable: true,
        statusCode: 429,
      },
      CHAT_ID_INVALID: {
        pattern: /CHAT_ID_INVALID/i,
        message: 'The chat ID is invalid or the chat does not exist.',
        code: 'CHAT_ID_INVALID',
        retryable: true,
        statusCode: 400,
      },
      USER_ID_INVALID: {
        pattern: /USER_ID_INVALID/i,
        message: 'The user ID is invalid or the user does not exist.',
        code: 'USER_ID_INVALID',
        retryable: true,
        statusCode: 400,
      },
      USERNAME_INVALID: {
        pattern: /USERNAME_INVALID/i,
        message: 'The username is invalid.',
        code: 'USERNAME_INVALID',
        retryable: true,
        statusCode: 400,
      },
      USERNAME_OCCUPIED: {
        pattern: /USERNAME_OCCUPIED/i,
        message: 'The username is already taken.',
        code: 'USERNAME_OCCUPIED',
        retryable: false,
        statusCode: 400,
      },
      CHAT_FORBIDDEN: {
        pattern: /CHAT_FORBIDDEN/i,
        message: 'You are forbidden from accessing this chat.',
        code: 'CHAT_FORBIDDEN',
        retryable: false,
        statusCode: 403,
      },
      SLOWMODE_WAIT: {
        pattern: /SLOWMODE_WAIT_(\d+)/i,
        message: (seconds) => `Slowmode is enabled. Please wait ${seconds} seconds.`,
        code: 'SLOWMODE_WAIT',
        retryable: true,
        statusCode: 429,
      },
      PASSWORD_HASH_INVALID: {
        pattern: /PASSWORD_HASH_INVALID/i,
        message: 'The 2FA password is incorrect.',
        code: 'PASSWORD_HASH_INVALID',
        retryable: true,
        statusCode: 400,
      },
      PASSWORD_RECOVERY_NA: {
        pattern: /PASSWORD_RECOVERY_NA/i,
        message: 'No recovery email is set for password recovery.',
        code: 'PASSWORD_RECOVERY_NA',
        retryable: false,
        statusCode: 400,
      },
      EMAIL_UNCONFIRMED: {
        pattern: /EMAIL_UNCONFIRMED_\d+/i,
        message: 'The recovery email has not been confirmed.',
        code: 'EMAIL_UNCONFIRMED',
        retryable: true,
        statusCode: 400,
      },
      CONNECTION_NOT_INITED: {
        pattern: /ConnectionNotInitedError/i,
        message: 'Connection was not properly initialized.',
        code: 'CONNECTION_NOT_INITED',
        retryable: true,
        statusCode: 503,
      },
      // Telegram returns CHAT_MEMBER_ADD_FAILED in two situations:
      //   1. Wrong RPC namespace — calling channels.InviteToChannel on a
      //      basic group (Chat) instead of messages.AddChatUser. With the
      //      basic-group dispatch fixed in `addMemberToGroup` this branch
      //      should be rare, but keep the mapping so the operator sees
      //      a clear message instead of a raw "400: CHAT_MEMBER_ADD_FAILED".
      //   2. Telegram refused the add for opaque "trust" reasons (the
      //      session has been quietly flagged after recent invites, or
      //      the target's privacy setting is "Allow Premium users only").
      //      Either way it's user-input adjacent — surface it clearly.
      CHAT_MEMBER_ADD_FAILED: {
        pattern: /CHAT_MEMBER_ADD_FAILED/i,
        message:
          "Telegram refused to add this user (CHAT_MEMBER_ADD_FAILED). " +
          "Most common causes: target's privacy is 'Premium users only', " +
          "the inviting account has been silently flagged after recent " +
          "adds, or the group is full / archived. Try a warmer session " +
          "or skip the user.",
        code: 'CHAT_MEMBER_ADD_FAILED',
        retryable: false,
        statusCode: 403,
      },
    };

    // Check the error message against known patterns
    for (const [key, config] of Object.entries(errorMap)) {
      const match = errorMessage.match(config.pattern);
      if (match) {
        const message =
          typeof config.message === 'function'
            ? config.message(parseInt(match[1], 10) || 30)
            : config.message;

        const enrichedError = new Error(message);
        enrichedError.code = config.code;
        enrichedError.retryable = config.retryable;
        enrichedError.statusCode = config.statusCode;
        enrichedError.originalError = error;
        enrichedError.floodSeconds = key === 'FLOOD_WAIT' ? parseInt(match[1], 10) : null;

        logger.warn(`Telegram API error: ${config.code}`, {
          message: enrichedError.message,
          original: errorMessage,
          retryable: config.retryable,
        });

        return enrichedError;
      }
    }

    // Unknown error - wrap with generic info
    const unknownError = new Error(`Telegram API error: ${errorMessage}`);
    unknownError.code = 'TELEGRAM_API_ERROR';
    unknownError.retryable = false;
    unknownError.statusCode = 500;
    unknownError.originalError = error;

    logger.error('Unknown Telegram API error', {
      message: errorMessage,
    });

    return unknownError;
  }

  /**
   * Execute an API call with automatic flood wait retry logic.
   *
   * Retries the operation if a FLOOD_WAIT error is received,
   * waiting for the specified duration before each retry.
   *
   * @param {string} sessionId - Session identifier
   * @param {Function} operation - Async function to execute
   * @param {number} maxRetries - Maximum number of flood retries (default: MAX_FLOOD_RETRIES)
   * @returns {Promise<*>} Result of the operation
   * @private
   */
  async _withFloodRetry(sessionId, operation, maxRetries = MAX_FLOOD_RETRIES) {
    let retries = 0;

    while (true) {
      try {
        return await operation();
      } catch (error) {
        const errorMessage = error.message || String(error);

        // Check for FLOOD_WAIT
        const floodMatch = errorMessage.match(/FLOOD_WAIT_(\d+)/i);
        if (floodMatch && retries < maxRetries) {
          const waitSeconds = parseInt(floodMatch[1], 10);
          retries++;

          logger.warn(
            `Flood wait detected for session ${sessionId}: ${waitSeconds}s (retry ${retries}/${maxRetries})`
          );

          // Long flood waits (≥30s) get pushed to two stores:
          //   - tg_session_health (legacy anti-revoke risk model)
          //   - sessions.cooldown_until (new job-eligibility gate)
          if (waitSeconds >= 30) {
            try {
              const cfg = require('../config/telegram');
              if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
                const detectionEvents = require('../providers/telegram/detectionEvents');
                await detectionEvents.recordFromError(error, {
                  session_id: sessionId,
                  fingerprint: { source: 'flood_retry', flood_wait_seconds: waitSeconds, retries },
                });
                const { pool } = require('../config/database');
                await pool.query(
                  `INSERT INTO tg_session_health (session_id, last_flood_seconds, last_flood_at, consecutive_flood_waits, updated_at)
                   VALUES ($1, $2, NOW(), 1, NOW())
                   ON CONFLICT (session_id) DO UPDATE SET
                     last_flood_seconds = EXCLUDED.last_flood_seconds,
                     last_flood_at = NOW(),
                     consecutive_flood_waits = tg_session_health.consecutive_flood_waits + 1,
                     updated_at = NOW()`,
                  [sessionId, waitSeconds]
                ).catch(() => {});
              }
            } catch { /* best-effort */ }
            try {
              const sessionCooldown = require('./sessionCooldown');
              await sessionCooldown.markFloodCooldown(
                sessionId,
                waitSeconds,
                `FLOOD_WAIT_${waitSeconds}`
              );
            } catch { /* best-effort */ }
          }

          await sleep(waitSeconds * 1000);
          continue;
        }

        // PEER_FLOOD is account-level: Telegram has flagged this
        // session as spam, and the cooldown is hours / days — not 30s.
        // Retrying every 30s for 5 attempts just burns 2.5 minutes per
        // call (and per call site there can be hundreds), without any
        // chance of recovery in that window. Fail fast AND mark the
        // session on cooldown so the worker session-pickers stop
        // handing it more work for a while (privacy/2fa/login pages
        // don't read the cooldown field, so the operator can still
        // recover the session manually).
        if (errorMessage.includes('PEER_FLOOD')) {
          logger.warn(
            `Peer flood detected for session ${sessionId}: not retrying (account-level cooldown is hours, not seconds)`
          );
          try {
            const cfg = require('../config/telegram');
            if (cfg.ANTI_REVOKE_PHASE_3_ENABLED) {
              const detectionEvents = require('../providers/telegram/detectionEvents');
              await detectionEvents.recordFromError(error, {
                session_id: sessionId,
                fingerprint: { source: 'peer_flood', retries },
              });
            }
          } catch { /* best-effort */ }
          try {
            const sessionCooldown = require('./sessionCooldown');
            await sessionCooldown.markPeerFlood(sessionId, 'PEER_FLOOD');
          } catch { /* best-effort */ }
          throw this._handleTelegramError(error);
        }

        // Check for SLOWMODE_WAIT
        const slowmodeMatch = errorMessage.match(/SLOWMODE_WAIT_(\d+)/i);
        if (slowmodeMatch && retries < maxRetries) {
          const waitSeconds = parseInt(slowmodeMatch[1], 10);
          retries++;

          logger.warn(
            `Slowmode wait for session ${sessionId}: ${waitSeconds}s (retry ${retries}/${maxRetries})`
          );

          await sleep(waitSeconds * 1000);
          continue;
        }

        // Not a flood or max retries exceeded - re-throw
        throw this._handleTelegramError(error);
      }
    }
  }

  /**
   * Join a group or channel using a session.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} targetId - Group/channel username or ID
   * @returns {Promise<{ success: boolean, targetId: string, targetName?: string }>}
   */
  async joinChannel(sessionId, targetId) {
    await this._ensureConnected(sessionId);

    try {
      const entity = await this._resolveEntity(sessionId, targetId);
      if (!entity) {
        throw new Error(`Could not resolve target: ${targetId}`);
      }

      const inputPeer = getInputPeer(entity);

      await this._withFloodRetry(sessionId, async () => {
        const { Api } = require('telegram/tl');
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.channels.JoinChannel({
            channel: inputPeer,
          })
        );
      });

      logger.info(`Session ${sessionId} joined ${targetId}`, { sessionId, targetId });

      return {
        success: true,
        targetId: String(targetId),
        targetName: entity.title || entity.username || targetId,
      };
    } catch (error) {
      logger.error(`Failed to join ${targetId}`, { sessionId, error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Leave a group or channel using a session.
   *
   * @param {string} sessionId - Active session identifier
   * @param {string} targetId - Group/channel username or ID
   * @returns {Promise<{ success: boolean, targetId: string }>}
   */
  async leaveChannel(sessionId, targetId) {
    await this._ensureConnected(sessionId);

    try {
      const entity = await this._resolveEntity(sessionId, targetId);
      if (!entity) {
        // If session is not a member, that's OK - just skip
        logger.info(`Session ${sessionId} is not a member of ${targetId}, skipping`);
        return {
          success: true,
          targetId: String(targetId),
          skipped: true,
          reason: 'Session is not a member',
        };
      }

      const inputPeer = getInputPeer(entity);

      await this._withFloodRetry(sessionId, async () => {
        const { Api } = require('telegram/tl');
        return await this.clients.get(String(sessionId)).client.invoke(
          new Api.channels.LeaveChannel({
            channel: inputPeer,
          })
        );
      });

      logger.info(`Session ${sessionId} left ${targetId}`, { sessionId, targetId });

      return {
        success: true,
        targetId: String(targetId),
      };
    } catch (error) {
      // If session is not a participant, treat as success (skip)
      const errMsg = error.message || '';
      if (errMsg.includes('CHANNEL_PRIVATE') || 
          errMsg.includes('CHANNEL_PUBLIC_REQUIRED') ||
          errMsg.includes('USER_NOT_PARTICIPANT') ||
          errMsg.includes('CHAT_NOT_MODIFIED')) {
        logger.info(`Session ${sessionId} not in ${targetId}, skipping leave`);
        return {
          success: true,
          targetId: String(targetId),
          skipped: true,
          reason: 'Session is not a member',
        };
      }

      logger.error(`Failed to leave ${targetId}`, { sessionId, error: error.message });
      throw this._handleTelegramError(error);
    }
  }

  /**
   * Gracefully disconnect all active sessions and clean up resources.
   * Call this before shutting down the application.
   *
   * @returns {Promise<void>}
   */
  async disconnectAll() {
    const sessionIds = Array.from(this.clients.keys());

    logger.info(`Disconnecting all ${sessionIds.length} active sessions`);

    const results = await Promise.allSettled(
      sessionIds.map((sessionId) => this.disconnectSession(sessionId))
    );

    const succeeded = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logger.info(`Disconnected ${succeeded} sessions, ${failed} failed`);
  }

  /**
   * Get the number of currently active sessions.
   *
   * @returns {number}
   */
  get activeSessionCount() {
    return this.clients.size;
  }

  /**
   * Detect whether an error from a Telegram call indicates that the
   * session's auth key has been permanently invalidated and re-trying is
   * pointless. Used by the heartbeat / restore loops to stop hammering
   * Telegram with a dead auth key.
   *
   * @param {Error|object} error - Error thrown by a Telegram call.
   * @returns {boolean}
   */
  isPermanentAuthError(error) {
    if (!error) return false;
    // GramJS RPC errors carry the symbolic code in `errorMessage`, the
    // numeric HTTP-style code in `code`, and the human message in
    // `message`. Concatenate and uppercase whatever we have so the
    // detection works no matter where the symbol shows up.
    const parts = [
      error.errorMessage,
      error.message,
      typeof error.code === 'string' ? error.code : null,
    ].filter(Boolean);
    if (parts.length === 0) parts.push(String(error));
    const haystack = parts.join(' ').toUpperCase();
    return (
      haystack.includes('AUTH_KEY_DUPLICATED') ||
      haystack.includes('AUTH_KEY_UNREGISTERED') ||
      haystack.includes('AUTH_KEY_INVALID') ||
      haystack.includes('SESSION_REVOKED') ||
      haystack.includes('SESSION_EXPIRED') ||
      haystack.includes('USER_DEACTIVATED')
    );
  }

  /**
   * Check if a session exists and is connected.
   *
   * @param {string} sessionId - Session identifier
   * @returns {boolean}
   */
  isSessionActive(sessionId) {
    const entry = this.clients.get(String(sessionId));
    return entry !== undefined && entry.connected;
  }

  /**
   * Iterate over all active session IDs (string keys).
   * @returns {string[]}
   */
  getActiveSessionIds() {
    return Array.from(this.clients.keys());
  }

  /**
   * Register a new-message handler for a connected session. Used by the OTP
   * scanner and the period-bounded scrape monitor to listen for messages
   * coming through a session.
   *
   * @param {string} sessionId - Active session identifier
   * @param {(event: object) => void|Promise<void>} handler - Receives the raw
   *   GramJS event so callers can read `event.message`, `event.chatId`,
   *   `event.senderId`, and call `event.getSender()` / `event.getChat()`.
   * @param {object} [options]
   * @param {Array<string|number>} [options.chats] - Restrict the handler to
   *   this list of chat IDs / usernames (passed straight through to GramJS
   *   NewMessage event filter).
   * @returns {Promise<() => void>} unsubscribe function
   */
  async addNewMessageHandler(sessionId, handler, options = {}) {
    await this._ensureConnected(sessionId);
    const entry = this.clients.get(String(sessionId));
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    const { NewMessage } = require('telegram/events');
    const eventOptions = {};
    // NOTE: We deliberately AVOID passing GramJS's `chats` filter here.
    // GramJS resolves the filter lazily on the first matching event by
    // calling `getInputEntity()` on every entry; for items that aren't
    // already in the session's peer cache (URL forms, freshly-resolved
    // usernames, transient FloodWaits) it makes a network call, and a
    // single failure rejects the whole `_resolve()` — leaving
    // `builder.resolved=false` so EVERY subsequent NewMessage event is
    // dropped at the dispatcher. This was the dominant cause of the
    // "5-minute job, 10 active users, only 2-3 captured" symptom.
    //
    // Callers who need to restrict which chats they listen to should
    // filter inside their handler instead (see `_eventMatchesTarget`
    // in scrapeMonitorService).
    if (options.chats && options.chats.length > 0) {
      eventOptions.chats = options.chats;
    }
    const event = new NewMessage(eventOptions);
    const wrapper = async (ev) => {
      try {
        await handler(ev);
      } catch (err) {
        logger.warn(`message handler error for session ${sessionId}: ${err.message}`);
      }
    };
    entry.client.addEventHandler(wrapper, event);
    return () => {
      try {
        entry.client.removeEventHandler(wrapper, event);
      } catch (err) {
        logger.debug(`Failed to remove event handler: ${err.message}`);
      }
    };
  }

  /**
   * Register a Raw update handler for a connected session.
   *
   * Unlike `addNewMessageHandler`, this delivers the raw GramJS update
   * objects (`Api.UpdateChannelUserTyping`, `Api.UpdateMessageReactions`,
   * `Api.UpdateChannelParticipant`, etc) so callers can capture user
   * activity that doesn't surface as a NewMessage — typing, reactions,
   * joins/leaves, MessageService events, and so on.
   *
   * GramJS's `Raw` builder has no chat filter and resolves to true on
   * boot, so it is safe from the lazy-filter failure mode that
   * `NewMessage`'s `chats` filter has.
   *
   * @param {string} sessionId
   * @param {(update: object) => void|Promise<void>} handler
   * @param {object} [options]
   * @param {Array<Function>} [options.types] - Optional list of GramJS
   *   `Api.*` constructors to filter to. When omitted every update is
   *   delivered.
   * @returns {Promise<() => void>} unsubscribe function
   */
  async addRawUpdateHandler(sessionId, handler, options = {}) {
    await this._ensureConnected(sessionId);
    const entry = this.clients.get(String(sessionId));
    if (!entry) throw new Error(`Session ${sessionId} not found`);
    const { Raw } = require('telegram/events');
    const builderParams = {};
    if (Array.isArray(options.types) && options.types.length > 0) {
      builderParams.types = options.types;
    }
    const event = new Raw(builderParams);
    const wrapper = async (update) => {
      try {
        await handler(update);
      } catch (err) {
        logger.warn(`raw update handler error for session ${sessionId}: ${err.message}`);
      }
    };
    entry.client.addEventHandler(wrapper, event);
    return () => {
      try {
        entry.client.removeEventHandler(wrapper, event);
      } catch (err) {
        logger.debug(`Failed to remove raw event handler: ${err.message}`);
      }
    };
  }

  /**
   * Probe whether a chat allows the panel session to enumerate participants.
   *
   * Returns `{ canScrape, isAdminOnly, info, reason }`. Used by the new
   * scrape preview endpoint so the UI can offer the user the option to
   * monitor the chat for a period instead of failing the job.
   *
   * @param {string} sessionId
   * @param {string|number} target  - group/channel id, @username, or invite link
   * @returns {Promise<{ canScrape: boolean, isAdminOnly: boolean, info: object, reason?: string }>}
   */
  async probeScrapeAccess(sessionId, target) {
    await this._ensureConnected(sessionId);
    let info = { id: null, title: null, type: null, participantsCount: null };
    let entity;
    try {
      entity = await this._resolveEntity(sessionId, target);
    } catch (err) {
      return { canScrape: false, isAdminOnly: false, info, reason: `resolve_failed: ${err.message}` };
    }
    if (!entity) {
      return { canScrape: false, isAdminOnly: false, info, reason: 'entity_not_found' };
    }

    const normalized = normalizeEntity(entity) || {};
    info = {
      id: normalized.id ? String(normalized.id) : null,
      title: normalized.title || null,
      username: normalized.username || null,
      type: normalized.type || null,
      groupType: normalized.groupType || null,
      isBroadcast: normalized.isBroadcast || false,
      participantsCount: normalized.participantsCount || 0,
    };

    // Channel-only broadcasts: members are inherently admin-only.
    if (entity.className === 'Channel' && entity.broadcast) {
      try {
        // Try to peek at one participant; if Telegram allows it we can scrape.
        const probe = await this.clients.get(String(sessionId)).client.getParticipants(entity, {
          limit: 1,
        });
        if (probe && probe.length >= 0) {
          return { canScrape: true, isAdminOnly: false, info };
        }
      } catch (err) {
        if (/CHAT_ADMIN_REQUIRED|PARTICIPANTS_HIDDEN|ADMIN_RANK_INVALID/i.test(err.message || '')) {
          return { canScrape: false, isAdminOnly: true, info, reason: 'admin_only_channel' };
        }
        return { canScrape: false, isAdminOnly: true, info, reason: err.message };
      }
    }

    // Group / supergroup: try a single-participant probe.
    try {
      const probe = await this.clients.get(String(sessionId)).client.getParticipants(entity, {
        limit: 1,
      });
      if (probe && probe.length >= 0) {
        return { canScrape: true, isAdminOnly: false, info };
      }
      return { canScrape: false, isAdminOnly: true, info, reason: 'empty_or_hidden_roster' };
    } catch (err) {
      const msg = err.message || '';
      if (/CHAT_ADMIN_REQUIRED|PARTICIPANTS_HIDDEN|CHANNEL_PRIVATE/i.test(msg)) {
        return { canScrape: false, isAdminOnly: true, info, reason: 'chat_admin_required' };
      }
      return { canScrape: false, isAdminOnly: true, info, reason: msg };
    }
  }

  // ====================================================================
  //  Anti-revoke: pinging, presence, DC pinning, GetAuthorizations probe
  // ====================================================================

  /**
   * Send a transport-level MTProto Ping (with disconnect timer) — what
   * real Telegram clients use as keepalive. Falls back to a lightweight
   * `users.GetUsers([Self])` if the GramJS internals expose neither
   * `_sender` nor `Api.PingDelayDisconnect`.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{ok:boolean, latencyMs:number, fallback:boolean}>}
   */
  async pingSession(sessionId) {
    const sid = String(sessionId);
    await this._ensureConnected(sid);
    const entry = this.clients.get(sid);
    if (!entry) throw new Error(`Session ${sid} not found`);
    const t0 = Date.now();
    let fallback = false;
    try {
      const PingDelayDisconnect = Api && Api.PingDelayDisconnect ? Api.PingDelayDisconnect : null;
      if (PingDelayDisconnect && entry.client._sender && typeof entry.client._sender.send === 'function') {
        const pingId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
        await entry.client._sender.send(
          new PingDelayDisconnect({ pingId, disconnectDelay: 75 })
        );
      } else if (entry.client.invoke && Api && Api.users && Api.users.GetUsers && Api.InputUserSelf) {
        // Fallback: smallest possible RPC that exercises the auth_key.
        await entry.client.invoke(new Api.users.GetUsers({ id: [new Api.InputUserSelf()] }));
        fallback = true;
      } else {
        // Last resort: getMe (which the legacy heartbeat used).
        await this.getMe(sid);
        fallback = true;
      }
      try {
        const { pool } = require('../config/database');
        await pool.query(`UPDATE sessions SET last_ping_at = NOW() WHERE id = $1`, [sid]).catch(() => {});
      } catch { /* ignore */ }
      return { ok: true, latencyMs: Date.now() - t0, fallback };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Broadcast online presence (`account.UpdateStatus(offline=false)`).
   * Real clients call this on every (re)connect — its absence is one of
   * the strongest "this is a script, not a phone" signals.
   *
   * @param {string|number} sessionId
   * @returns {Promise<boolean>} true if the call was actually made
   */
  async setOnline(sessionId) {
    const sid = String(sessionId);
    const entry = this.clients.get(sid);
    if (!entry || !entry.client) return false;
    try {
      if (Api && Api.account && Api.account.UpdateStatus) {
        await entry.client.invoke(new Api.account.UpdateStatus({ offline: false }));
        try {
          const { pool } = require('../config/database');
          await pool.query(`UPDATE sessions SET last_online_status_at = NOW() WHERE id = $1`, [sid]).catch(() => {});
        } catch { /* ignore */ }
        return true;
      }
    } catch (err) {
      logger.debug(`setOnline failed for ${sid}: ${err.message}`);
    }
    return false;
  }

  /**
   * Broadcast offline presence. Idempotent — safe to call repeatedly.
   * Used after `OFFLINE_AFTER_IDLE_MS` of inactivity.
   *
   * @param {string|number} sessionId
   * @returns {Promise<boolean>}
   */
  async setOffline(sessionId) {
    const sid = String(sessionId);
    const entry = this.clients.get(sid);
    if (!entry || !entry.client) return false;
    try {
      if (Api && Api.account && Api.account.UpdateStatus) {
        await entry.client.invoke(new Api.account.UpdateStatus({ offline: true }));
        return true;
      }
    } catch (err) {
      logger.debug(`setOffline failed for ${sid}: ${err.message}`);
    }
    return false;
  }

  /**
   * Re-broadcast online presence only when the previous call is older
   * than `OFFLINE_AFTER_IDLE_MS / 2` (roughly every 2.5 min by default).
   * Cheap; used by the heartbeat loop.
   */
  async announceOnlineIfDue(sessionId) {
    const sid = String(sessionId);
    try {
      const { pool } = require('../config/database');
      const cfg = require('../config/telegram');
      const cadence = Math.max(60_000, Math.floor((cfg.OFFLINE_AFTER_IDLE_MS || 300000) / 2));
      const r = await pool.query(
        `SELECT last_online_status_at FROM sessions WHERE id = $1`,
        [sid]
      );
      const last = r.rows[0] && r.rows[0].last_online_status_at;
      const ageMs = last ? Date.now() - new Date(last).getTime() : Number.POSITIVE_INFINITY;
      if (ageMs < cadence) return false;
      return await this.setOnline(sid);
    } catch (err) {
      logger.debug(`announceOnlineIfDue failed for ${sid}: ${err.message}`);
      return false;
    }
  }

  /**
   * Persist the DC the auth key is currently bound to so subsequent
   * reconnects pin to the same DC. GramJS's session object exposes
   * `dcId`, `serverAddress`, and `port` once the connection is up.
   * @param {string|number} sessionId
   */
  async persistDcPinFromClient(sessionId) {
    const sid = String(sessionId);
    const entry = this.clients.get(sid);
    if (!entry || !entry.client) return null;
    const sess = entry.client.session;
    if (!sess) return null;
    const dcId = typeof sess.dcId === 'number' ? sess.dcId : (sess._dcId || null);
    const dcIp = sess.serverAddress || sess._serverAddress || null;
    const dcPort = typeof sess.port === 'number' ? sess.port : (sess._port || null);
    if (!dcId) return null;
    try {
      const { pool } = require('../config/database');
      await pool.query(
        `UPDATE sessions
            SET dc_id = $1,
                dc_ip = COALESCE($2, dc_ip),
                dc_port = COALESCE($3, dc_port),
                auth_key_first_seen_at = COALESCE(auth_key_first_seen_at, NOW())
          WHERE id = $4`,
        [dcId, dcIp, dcPort, sid]
      );
      return { dcId, dcIp, dcPort };
    } catch (err) {
      logger.debug(`persistDcPinFromClient failed for ${sid}: ${err.message}`);
      return null;
    }
  }

  /**
   * Periodic GetAuthorizations probe — early-warning that an external
   * "Terminate session" click in another Telegram client has marked our
   * auth key for revocation. The auth_key keeps working for a brief
   * grace window; surfacing the disappearance lets us avoid burning
   * future API calls.
   *
   * Returns `{ checked: bool, revokedExternally: bool, count: int }` so
   * the heartbeat caller can decide whether to mark the session revoked.
   *
   * Cadence is `AUTHORIZATIONS_PROBE_MS ± AUTHORIZATIONS_PROBE_JITTER_MS`
   * per session; the function is idempotent and skips when not yet due.
   */
  async checkAuthorizationsIfDue(sessionId) {
    const sid = String(sessionId);
    try {
      const { pool } = require('../config/database');
      const cfg = require('../config/telegram');
      const baseMs = Math.max(60_000, cfg.AUTHORIZATIONS_PROBE_MS || 14_400_000);
      const jitterMs = Math.max(0, cfg.AUTHORIZATIONS_PROBE_JITTER_MS || 0);
      const dueMs = baseMs + Math.floor((Math.random() * 2 - 1) * jitterMs);
      const r = await pool.query(
        `SELECT last_authorizations_check_at FROM sessions WHERE id = $1`,
        [sid]
      );
      const last = r.rows[0] && r.rows[0].last_authorizations_check_at;
      const ageMs = last ? Date.now() - new Date(last).getTime() : Number.POSITIVE_INFINITY;
      if (ageMs < dueMs) return { checked: false };

      const entry = this.clients.get(sid);
      if (!entry || !entry.client) return { checked: false };
      if (!Api || !Api.account || !Api.account.GetAuthorizations) return { checked: false };

      const out = await entry.client.invoke(new Api.account.GetAuthorizations());
      const authorizations = (out && out.authorizations) || [];
      const current = authorizations.find((a) => a.current);
      const revokedExternally = !current && authorizations.length > 0;

      await pool.query(
        `UPDATE sessions
            SET last_authorizations_check_at = NOW()
          WHERE id = $1`,
        [sid]
      );
      try {
        await pool.query(
          `INSERT INTO tg_session_health (session_id, active_authorizations, last_authorizations_check_at, updated_at)
           VALUES ($1, $2::jsonb, NOW(), NOW())
           ON CONFLICT (session_id) DO UPDATE SET
             active_authorizations = EXCLUDED.active_authorizations,
             last_authorizations_check_at = NOW(),
             updated_at = NOW()`,
          [
            sid,
            JSON.stringify(
              authorizations.map((a) => ({
                hash: String(a.hash || ''),
                current: !!a.current,
                deviceModel: a.deviceModel || null,
                platform: a.platform || null,
                systemVersion: a.systemVersion || null,
                appName: a.appName || null,
                appVersion: a.appVersion || null,
                country: a.country || null,
                ip: a.ip || null,
                dateActive: a.dateActive || null,
                dateCreated: a.dateCreated || null,
              })).slice(0, 20)
            ),
          ]
        );
      } catch { /* tg_session_health may not exist on dev DBs */ }
      return { checked: true, count: authorizations.length, revokedExternally };
    } catch (err) {
      // If the auth_key is already dead this throws AUTH_KEY_UNREGISTERED;
      // let the caller handle it via isPermanentAuthError().
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`checkAuthorizationsIfDue failed for ${sid}: ${err.message}`);
      return { checked: false };
    }
  }

  // ====================================================================
  //  Anti-revoke Phase 4 — confirmed-authorization + accountTTL helpers
  // ====================================================================

  /**
   * Mark the current authorization as "confirmed" so it survives the
   * 24h unconfirmed-session window. Real Telegram clients implicitly do
   * this via the official "Yes, this is me" UI; userbots and string
   * sessions never get the prompt and stay in the unconfirmed bucket
   * forever — which is what makes them vulnerable to "Terminate other
   * sessions" wipes from the user's phone.
   *
   * `account.ChangeAuthorizationSettings({ hash: 0, confirmed: true })`
   * has been a no-op-on-already-confirmed since MTProto layer 162. Safe
   * to call repeatedly. Telegram returns BoolTrue / BoolFalse — we
   * treat anything non-throwing as success.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{confirmed:boolean, error?:string}>}
   */
  async confirmCurrentAuthorization(sessionId) {
    const sid = String(sessionId);
    const entry = this.clients.get(sid);
    if (!entry || !entry.client) {
      return { confirmed: false, error: 'no client' };
    }
    if (!Api || !Api.account || !Api.account.ChangeAuthorizationSettings) {
      // Older GramJS: skip silently. The whole feature is best-effort
      // anti-revoke insurance, not load-bearing.
      return { confirmed: false, error: 'method missing' };
    }
    try {
      // hash=0 selects the current authorization (the one we're calling
      // through). encryptedRequestsDisabled=true also blocks
      // PEER-to-PEER call invitations from random users (a known nuisance
      // vector for userbot accounts). callRequestsDisabled=true blocks
      // VOIP call requests for the same reason — neither flag affects
      // outbound RPCs we initiate ourselves.
      await entry.client.invoke(
        new Api.account.ChangeAuthorizationSettings({
          hash: 0n,
          confirmed: true,
          encryptedRequestsDisabled: true,
          callRequestsDisabled: true,
        })
      );
      try {
        const { pool } = require('../config/database');
        await pool.query(
          `INSERT INTO tg_session_health (session_id, confirmed_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (session_id) DO UPDATE SET
             confirmed_at = NOW(),
             updated_at = NOW()`,
          [sid]
        ).catch(() => {});
      } catch { /* tg_session_health may be missing in dev */ }
      return { confirmed: true };
    } catch (err) {
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`confirmCurrentAuthorization failed for ${sid}: ${err.message}`);
      return { confirmed: false, error: err.message };
    }
  }

  /**
   * Idempotently push the account's auto-delete TTL out to its maximum
   * (730 days). Without this, a Telegram account that goes idle for the
   * default 6 months gets nuked along with all its sessions — including
   * the panel's. Real clients call this via the Privacy & Security UI.
   *
   * Uses tg_session_health.account_ttl_set_at to skip the call if it's
   * already been made within ANTI_REVOKE_PHASE_4_RESET_ACCOUNT_TTL_INTERVAL_MS.
   *
   * @param {string|number} sessionId
   * @param {object}        [opts]
   * @param {boolean}       [opts.force=false] - bypass the cadence check
   * @returns {Promise<{set:boolean, days:number, error?:string}>}
   */
  async maximizeAccountTTL(sessionId, opts = {}) {
    const sid = String(sessionId);
    const cfg = require('../config/telegram');
    const days = Math.max(30, Math.min(730, cfg.ANTI_REVOKE_PHASE_4_ACCOUNT_TTL_DAYS || 730));
    const entry = this.clients.get(sid);
    if (!entry || !entry.client) {
      return { set: false, days, error: 'no client' };
    }
    if (!Api || !Api.account || !Api.account.SetAccountTTL || !Api.AccountDaysTTL) {
      return { set: false, days, error: 'method missing' };
    }
    if (!opts.force) {
      try {
        const { pool } = require('../config/database');
        const r = await pool.query(
          `SELECT account_ttl_set_at FROM tg_session_health WHERE session_id = $1`,
          [sid]
        );
        const last = r.rows[0] && r.rows[0].account_ttl_set_at;
        const cadence = cfg.ANTI_REVOKE_PHASE_4_RESET_ACCOUNT_TTL_INTERVAL_MS;
        if (last && Date.now() - new Date(last).getTime() < cadence) {
          return { set: false, days, error: 'not due' };
        }
      } catch { /* tg_session_health may be missing in dev */ }
    }
    try {
      await entry.client.invoke(
        new Api.account.SetAccountTTL({
          ttl: new Api.AccountDaysTTL({ days }),
        })
      );
      try {
        const { pool } = require('../config/database');
        await pool.query(
          `INSERT INTO tg_session_health (session_id, account_ttl_set_at, updated_at)
           VALUES ($1, NOW(), NOW())
           ON CONFLICT (session_id) DO UPDATE SET
             account_ttl_set_at = NOW(),
             updated_at = NOW()`,
          [sid]
        ).catch(() => {});
      } catch { /* tg_session_health may be missing in dev */ }
      return { set: true, days };
    } catch (err) {
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`maximizeAccountTTL failed for ${sid}: ${err.message}`);
      return { set: false, days, error: err.message };
    }
  }

  /**
   * Drive both Phase-4 hardenings on a freshly-connected client so
   * loginSession / verify / password don't have to know the protocol
   * details. Best-effort: any failure is logged but never thrown to the
   * caller — we don't want a single Telegram-side flake to block a
   * successful login from being persisted.
   *
   * @param {string|number} sessionId
   * @returns {Promise<{confirmed:boolean, ttlDays:number}>}
   */
  async hardenSessionAgainstRevocation(sessionId) {
    const sid = String(sessionId);
    const cfg = require('../config/telegram');
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) {
      return { confirmed: false, ttlDays: 0 };
    }
    let confirmed = false;
    let ttlDays = 0;
    try {
      const r = await this.confirmCurrentAuthorization(sid);
      confirmed = !!r.confirmed;
    } catch (err) {
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`hardenSessionAgainstRevocation: confirm failed for ${sid}: ${err.message}`);
    }
    try {
      const r = await this.maximizeAccountTTL(sid, { force: true });
      if (r.set) ttlDays = r.days;
    } catch (err) {
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`hardenSessionAgainstRevocation: ttl failed for ${sid}: ${err.message}`);
    }
    return { confirmed, ttlDays };
  }

  /**
   * Heartbeat-side variant of hardenSessionAgainstRevocation: only
   * issues the protocol calls when their tg_session_health bookkeeping
   * timestamps have aged past the configured intervals. Cheap, safe to
   * call on every heartbeat tick.
   *
   * @param {string|number} sessionId
   */
  async reaffirmHardeningIfDue(sessionId) {
    const sid = String(sessionId);
    const cfg = require('../config/telegram');
    if (!cfg.ANTI_REVOKE_PHASE_4_ENABLED) return { reaffirmed: false };
    let reaffirmed = false;
    try {
      const { pool } = require('../config/database');
      const r = await pool.query(
        `SELECT confirmed_at, account_ttl_set_at FROM tg_session_health WHERE session_id = $1`,
        [sid]
      );
      const row = r.rows[0] || {};
      const now = Date.now();
      const confirmAge = row.confirmed_at
        ? now - new Date(row.confirmed_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (confirmAge >= cfg.ANTI_REVOKE_PHASE_4_RECONFIRM_INTERVAL_MS) {
        const c = await this.confirmCurrentAuthorization(sid).catch(() => ({ confirmed: false }));
        if (c.confirmed) reaffirmed = true;
      }
      const ttlAge = row.account_ttl_set_at
        ? now - new Date(row.account_ttl_set_at).getTime()
        : Number.POSITIVE_INFINITY;
      if (ttlAge >= cfg.ANTI_REVOKE_PHASE_4_RESET_ACCOUNT_TTL_INTERVAL_MS) {
        const t = await this.maximizeAccountTTL(sid, { force: true }).catch(() => ({ set: false }));
        if (t.set) reaffirmed = true;
      }
    } catch (err) {
      if (this.isPermanentAuthError(err)) throw err;
      logger.debug(`reaffirmHardeningIfDue failed for ${sid}: ${err.message}`);
    }
    return { reaffirmed };
  }
}

/**
 * Compute the SRP password check for 2FA authentication.
 * This is a helper that uses GramJS's internal password utilities.
 *
 * @param {object} currentPassword - Password settings from account.getPassword
 * @param {string} password - The plain text password
 * @param {string} hint - Optional password hint
 * @returns {Promise<object>} Password check object for API calls
 */
async function computeCheck(currentPassword, password, hint = '') {
  try {
    const { computeCheck: gramjsComputeCheck } = require('telegram/Password');

    if (
      currentPassword.currentAlgo &&
      currentPassword.currentAlgo.className === 'PasswordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow'
    ) {
      return await gramjsComputeCheck(currentPassword, password);
    }

    // If no current password algorithm, create a new one
    if (!currentPassword.currentAlgo) {
      const { Password: PasswordAlgo } = require('telegram/Password');
      return await PasswordAlgo.computeCheck(currentPassword, password);
    }

    // Fallback: attempt with the generic computeCheck
    return await gramjsComputeCheck(currentPassword, password);
  } catch (error) {
    logger.error('Failed to compute password check', { error: error.message });
    throw new Error(`2FA password computation failed: ${error.message}`);
  }
}

async function computeNewPasswordHash(newAlgo, password) {
  try {
    return await gramjsComputeDigest(newAlgo, password);
  } catch (error) {
    logger.error('Failed to compute new password hash', { error: error.message });
    throw new Error(`2FA new password computation failed: ${error.message}`);
  }
}

function prepareNewPasswordAlgo(passwordRequest) {
  if (!passwordRequest.newAlgo) {
    throw new Error('2FA password settings are missing a new password algorithm');
  }
  passwordRequest.newAlgo.salt1 = Buffer.concat([
    passwordRequest.newAlgo.salt1,
    generateRandomBytes(NEW_PASSWORD_SALT_BYTES),
  ]);
  return passwordRequest.newAlgo;
}

// Export as a SINGLETON instance so all services share the same client Map
// This is critical: when sessionService logs in, the client must be available to scrapeService, messageService, etc.
const telegramServiceInstance = new TelegramService();
module.exports = telegramServiceInstance;
