require('dotenv').config();

/**
 * Telegram protocol config.
 *
 * IMPORTANT — anti-revoke (Phase 1):
 *
 * `deviceModel` / `systemVersion` / `appVersion` / `langCode` defaults below
 * are kept ONLY as a last-resort safety net so a brand-new dev environment
 * doesn't crash the backend on first boot. They MUST NOT reach Telegram in
 * production: every TelegramClient instantiated by this codebase pulls a
 * persisted device identity from `identityService.loadOrCreate(sessionId)`
 * (or from `fingerprint.buildIdentity(...)` in the create-session flow,
 * before a session row exists).
 *
 * `ANTI_REVOKE_STRICT_FINGERPRINT=true` (default in production) makes the
 * service throw if any code path is about to send these defaults to Telegram.
 * Set to `false` only when running ad-hoc unit tests that don't talk to
 * Telegram at all (the smoke suites set this themselves).
 */

const STRICT_FINGERPRINT =
  String(process.env.ANTI_REVOKE_STRICT_FINGERPRINT ?? 'true').toLowerCase() === 'true';

const STRICT_PROXY_ISOLATION =
  String(process.env.STRICT_PROXY_ISOLATION ?? 'true').toLowerCase() === 'true';

const ANTI_REVOKE_PHASE_1_ENABLED =
  String(process.env.ANTI_REVOKE_PHASE_1_ENABLED ?? 'true').toLowerCase() === 'true';
const ANTI_REVOKE_PHASE_2_ENABLED =
  String(process.env.ANTI_REVOKE_PHASE_2_ENABLED ?? 'true').toLowerCase() === 'true';
const ANTI_REVOKE_PHASE_3_ENABLED =
  String(process.env.ANTI_REVOKE_PHASE_3_ENABLED ?? 'true').toLowerCase() === 'true';
const ANTI_REVOKE_PHASE_4_ENABLED =
  String(process.env.ANTI_REVOKE_PHASE_4_ENABLED ?? 'true').toLowerCase() === 'true';

const telegramConfig = {
  apiId: parseInt(process.env.TELEGRAM_API_ID || '0'),
  apiHash: process.env.TELEGRAM_API_HASH || '',
  connectionRetries: 5,
  timeout: 30000,
  baseLogger: null, // Disable GramJS internal logging - we use our own logger
  useWSS: true,

  // ---- Burned-in safety-net defaults (NEVER ship to production traffic) ----
  // Kept identical to historical values so any test that reads them by name
  // still type-checks; they are guarded by `STRICT_FINGERPRINT` below.
  deviceModel: 'Mozilla/5.0 (X11; Linux x86_64)',
  systemVersion: 'Node.js',
  appVersion: '1.0.0',
  langCode: 'en',

  // ---- Anti-revoke flags ----
  STRICT_FINGERPRINT,
  STRICT_PROXY_ISOLATION,
  ANTI_REVOKE_PHASE_1_ENABLED,
  ANTI_REVOKE_PHASE_2_ENABLED,
  ANTI_REVOKE_PHASE_3_ENABLED,
  ANTI_REVOKE_PHASE_4_ENABLED,

  // Phase 1 — restore-on-boot jitter window. Default 5 min so 50 sessions
  // reconnect over 5 min instead of all at once → no "data-centre sweep"
  // pattern from the panel host IP.
  RESTORE_WINDOW_MS: parseInt(process.env.SESSION_RESTORE_WINDOW_MS || `${5 * 60 * 1000}`, 10),
  RESTORE_PER_IP_PER_MIN: parseInt(process.env.SESSION_RESTORE_PER_IP_PER_MIN || '4', 10),

  // Phase 2 — heartbeat is MTProto Ping, not getMe.
  HEARTBEAT_INTERVAL_MS: parseInt(process.env.SESSION_HEARTBEAT_INTERVAL_MS || `${120 * 1000}`, 10),
  HEARTBEAT_JITTER_MS:   parseInt(process.env.SESSION_HEARTBEAT_JITTER_MS   || `${25 * 1000}`,  10),

  // Phase 2 — presence semantics.
  ONLINE_AFTER_RECONNECT: true,
  OFFLINE_AFTER_IDLE_MS:  parseInt(process.env.SESSION_OFFLINE_AFTER_IDLE_MS || `${5 * 60 * 1000}`, 10),

  // Phase 2 — early-warning probe interval.
  AUTHORIZATIONS_PROBE_MS:        parseInt(process.env.AUTHORIZATIONS_PROBE_MS        || `${4 * 60 * 60 * 1000}`, 10),
  AUTHORIZATIONS_PROBE_JITTER_MS: parseInt(process.env.AUTHORIZATIONS_PROBE_JITTER_MS || `${2 * 60 * 60 * 1000}`, 10),

  // Phase 2 — circadian curfew window for behavior actions (local hours).
  BEHAVIOR_CURFEW_HOUR_START: parseInt(process.env.BEHAVIOR_CURFEW_HOUR_START || '23', 10),
  BEHAVIOR_CURFEW_HOUR_END:   parseInt(process.env.BEHAVIOR_CURFEW_HOUR_END   || '6',  10),

  // Phase 3 — risk gate threshold for heavy operations.
  RISK_GATE_THRESHOLD: parseFloat(process.env.TG_RISK_GATE_THRESHOLD || '0.65'),

  // Phase 4 — bulletproof panel sessions.
  //
  // Number of consecutive permanent-auth errors required before the
  // heartbeat marks a session status='revoked'. Default 2 so single
  // false-positives (transient proxy / DC migrate / GramJS internals)
  // don't kill an otherwise healthy session.
  ANTI_REVOKE_PHASE_4_CONSECUTIVE_REVOKE_THRESHOLD: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_CONSECUTIVE_REVOKE_THRESHOLD || '2', 10
  ),
  // Minimum elapsed time between the first strike and the threshold-
  // crossing strike. Default 30 minutes — gives Telegram's own DC
  // migration storms time to subside before we conclude the auth_key
  // is really dead.
  ANTI_REVOKE_PHASE_4_REVOKE_CONFIRM_WINDOW_MS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_REVOKE_CONFIRM_WINDOW_MS || `${30 * 60 * 1000}`, 10
  ),
  // Number of consecutive "session disappeared from
  // account.GetAuthorizations" probes required before we mark the row
  // revoked-externally. Same rationale as the heartbeat counter.
  ANTI_REVOKE_PHASE_4_CONSECUTIVE_EXTERNAL_REVOKE_THRESHOLD: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_CONSECUTIVE_EXTERNAL_REVOKE_THRESHOLD || '2', 10
  ),
  // Re-call account.ChangeAuthorizationSettings(confirmed=true) every
  // N hours so we keep the panel session in the "trusted" bucket even
  // if Telegram ever rotates the flag silently. Default 7 days.
  ANTI_REVOKE_PHASE_4_RECONFIRM_INTERVAL_MS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_RECONFIRM_INTERVAL_MS || `${7 * 24 * 60 * 60 * 1000}`, 10
  ),
  // Re-call account.SetAccountTTL on the same cadence so an idle
  // account never auto-expires. Default 30 days (effectively the same
  // 730-day TTL stays at 730 days forever).
  ANTI_REVOKE_PHASE_4_RESET_ACCOUNT_TTL_INTERVAL_MS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_RESET_ACCOUNT_TTL_INTERVAL_MS || `${30 * 24 * 60 * 60 * 1000}`, 10
  ),
  // Account-TTL we ask Telegram to enforce. Max accepted by the
  // protocol is 730 days; we use the max so an idle account is never
  // pruned. Operators can lower this for compliance reasons.
  ANTI_REVOKE_PHASE_4_ACCOUNT_TTL_DAYS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_ACCOUNT_TTL_DAYS || '730', 10
  ),
  // How long encrypted off-DB session backups are retained before the
  // pruner deletes them. 90 days is the working compromise between
  // "long enough to recover from operator error" and disk usage.
  ANTI_REVOKE_PHASE_4_BACKUP_RETENTION_DAYS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_BACKUP_RETENTION_DAYS || '90', 10
  ),
  // Minimum interval between two outbound bot alerts for the same
  // session — prevents the user from getting hammered when the
  // heartbeat sees the same problem on every tick.
  ANTI_REVOKE_PHASE_4_ALERT_COOLDOWN_MS: parseInt(
    process.env.ANTI_REVOKE_PHASE_4_ALERT_COOLDOWN_MS || `${10 * 60 * 1000}`, 10
  ),
};

if (!telegramConfig.apiId || !telegramConfig.apiHash) {
  console.warn('WARNING: TELEGRAM_API_ID and TELEGRAM_API_HASH are not set');
}

module.exports = telegramConfig;
