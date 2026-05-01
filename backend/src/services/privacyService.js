/**
 * PrivacyService
 * --------------------------------------------------------------------
 * Wraps Telegram's `account.SetPrivacy` MTProto request behind a
 * panel-friendly contract. All 11 privacy keys exposed by the official
 * Telegram apps are supported:
 *
 *   phone_number      InputPrivacyKeyPhoneNumber
 *   added_by_phone    InputPrivacyKeyAddedByPhone
 *   last_seen         InputPrivacyKeyStatusTimestamp
 *   profile_photo     InputPrivacyKeyProfilePhoto
 *   bio               InputPrivacyKeyAbout
 *   gifts             InputPrivacyKeyStarGiftsAutoSave
 *   birthday          InputPrivacyKeyBirthday
 *   forwards          InputPrivacyKeyForwards
 *   calls             InputPrivacyKeyPhoneCall
 *   messages          InputPrivacyKeyVoiceMessages  (premium feature; we
 *                     reuse the same key for the panel's "messages"
 *                     control because Telegram's per-message visibility
 *                     uses the voice-messages privacy key)
 *   invites           InputPrivacyKeyChatInvite
 *
 * Rule values:
 *   everybody  -> InputPrivacyValueAllowAll
 *   nobody     -> InputPrivacyValueDisallowAll
 *   contacts   -> InputPrivacyValueAllowContacts
 *   premium    -> InputPrivacyValueAllowPremium    (messages key only)
 *
 * Public API:
 *   PRIVACY_KEYS                    (frozen list of supported keys)
 *   PRIVACY_RULES                   (frozen list of supported rules)
 *   buildKey(name)                  -> Api.InputPrivacyKey*
 *   buildRules(name, ruleValue)     -> [Api.InputPrivacyValue*]
 *   applyToSession(sessionId, settings)  -> per-key result map
 */

'use strict';

const { Api } = require('telegram');
const tgService = require('./telegramService');
const logger = require('../utils/logger');

const PRIVACY_KEYS = Object.freeze([
  'phone_number',
  'added_by_phone',
  'last_seen',
  'profile_photo',
  'bio',
  'gifts',
  'birthday',
  'forwards',
  'calls',
  'messages',
  'invites',
]);

const PRIVACY_RULES = Object.freeze(['everybody', 'nobody', 'contacts', 'premium']);

const KEY_FACTORY = {
  phone_number:   () => new Api.InputPrivacyKeyPhoneNumber(),
  added_by_phone: () => new Api.InputPrivacyKeyAddedByPhone(),
  last_seen:      () => new Api.InputPrivacyKeyStatusTimestamp(),
  profile_photo:  () => new Api.InputPrivacyKeyProfilePhoto(),
  bio:            () => new Api.InputPrivacyKeyAbout(),
  gifts:          () => new Api.InputPrivacyKeyStarGiftsAutoSave(),
  birthday:       () => new Api.InputPrivacyKeyBirthday(),
  forwards:       () => new Api.InputPrivacyKeyForwards(),
  calls:          () => new Api.InputPrivacyKeyPhoneCall(),
  messages:       () => new Api.InputPrivacyKeyVoiceMessages(),
  invites:        () => new Api.InputPrivacyKeyChatInvite(),
};

// Premium is only meaningful for the messages key; everywhere else we
// downgrade it to "contacts" defensively.
const PREMIUM_ELIGIBLE_KEYS = new Set(['messages']);

function buildKey(keyName) {
  const f = KEY_FACTORY[keyName];
  if (!f) {
    const err = new Error(`Unknown privacy key: ${keyName}`);
    err.code = 'BAD_KEY';
    throw err;
  }
  return f();
}

/**
 * Build the array of `InputPrivacyValue*` rules that match a single
 * panel rule. Telegram's API is "list of rules in priority order" but
 * the panel only exposes a single bucket so we always emit one rule.
 */
function buildRules(keyName, ruleValue) {
  if (!PRIVACY_RULES.includes(ruleValue)) {
    const err = new Error(`Unknown privacy rule: ${ruleValue}`);
    err.code = 'BAD_RULE';
    throw err;
  }
  if (ruleValue === 'premium' && !PREMIUM_ELIGIBLE_KEYS.has(keyName)) {
    // Defensive — fall back to contacts for non-message keys.
    return [new Api.InputPrivacyValueAllowContacts()];
  }
  switch (ruleValue) {
    case 'everybody': return [new Api.InputPrivacyValueAllowAll()];
    case 'nobody':    return [new Api.InputPrivacyValueDisallowAll()];
    case 'contacts':  return [new Api.InputPrivacyValueAllowContacts()];
    case 'premium':   return [new Api.InputPrivacyValueAllowPremium()];
    default:          return [new Api.InputPrivacyValueDisallowAll()];
  }
}

/**
 * Apply a {key -> rule} map to one Telegram session. Each key is
 * applied independently with a small randomized sleep between calls so
 * we don't trip Telegram's per-account throttling.
 *
 * @param {number|string} sessionId
 * @param {object} settings  e.g. { phone_number: 'contacts', last_seen: 'everybody' }
 * @param {object} [opts]
 * @param {number} [opts.minSleepMs=400]
 * @param {number} [opts.maxSleepMs=1200]
 * @returns {Promise<{results: object, succeeded: number, failed: number}>}
 *   results is { phone_number: 'ok' | 'FLOOD_WAIT_42' | 'PRIVACY_KEY_INVALID' | ... }
 */
async function applyToSession(sessionId, settings, opts = {}) {
  const minSleep = Math.max(0, opts.minSleepMs ?? 400);
  const maxSleep = Math.max(minSleep, opts.maxSleepMs ?? 1200);

  await tgService._ensureConnected(sessionId);
  const entry = tgService.clients.get(String(sessionId));
  if (!entry || !entry.client) {
    throw new Error(`Session ${sessionId} has no live client`);
  }
  const client = entry.client;

  const keys = Object.keys(settings || {}).filter((k) => PRIVACY_KEYS.includes(k));
  if (keys.length === 0) {
    return { results: {}, succeeded: 0, failed: 0 };
  }

  const results = {};
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < keys.length; i++) {
    const keyName = keys[i];
    const ruleValue = settings[keyName];
    if (!PRIVACY_RULES.includes(ruleValue)) {
      results[keyName] = `BAD_RULE:${ruleValue}`;
      failed++;
      continue;
    }

    let key, rules;
    try {
      key = buildKey(keyName);
      rules = buildRules(keyName, ruleValue);
    } catch (err) {
      results[keyName] = err.code || 'BAD_KEY';
      failed++;
      continue;
    }

    try {
      await client.invoke(new Api.account.SetPrivacy({ key, rules }));
      results[keyName] = 'ok';
      succeeded++;
    } catch (err) {
      // GramJS errors expose .errorMessage (Telegram code) and .seconds
      const code = (err && (err.errorMessage || err.message)) || 'ERROR';
      results[keyName] = code.length > 60 ? code.slice(0, 60) : code;
      failed++;
      logger.warn(
        `account.SetPrivacy(${keyName}=${ruleValue}) failed for session ${sessionId}: ${code}`
      );
    }

    if (i < keys.length - 1) {
      const sleep = Math.floor(Math.random() * (maxSleep - minSleep + 1)) + minSleep;
      await new Promise((r) => setTimeout(r, sleep));
    }
  }

  return { results, succeeded, failed };
}

module.exports = {
  PRIVACY_KEYS,
  PRIVACY_RULES,
  buildKey,
  buildRules,
  applyToSession,
};
