/**
 * Instagram provider — Phase 2 entry point.
 *
 * This file lazily loads each Instagram subsystem on first use so that
 * pulling in `instagram-private-api` doesn't pay a cold-start cost when
 * the panel is running with only Telegram traffic. Each subsystem exports
 * the same noun.verb shape as the Telegram provider so controllers can
 * delegate via `getProvider(req.platform).<noun>.<verb>(...)` without
 * caring which platform they're talking to.
 *
 * The capabilities map mirrors §3.4 of INSTAGRAM_PANEL_ARCHITECTURE.md:
 * any feature the Telegram panel exposes that Instagram cannot implement
 * (forwarding, channel-member scrape, group invites, …) returns false so
 * the frontend renders a "Not supported on Instagram" tooltip instead of
 * a broken button.
 */

const capabilities = {
  // Sessions
  sessions_upload:        true,
  sessions_create:        true,
  sessions_download:      true,
  sessions_logout:        true,
  sessions_status:        true,
  sessions_heartbeat:     true,

  // Scrape — IG-specific scrape verbs
  scrape_followers:       true,
  scrape_following:       true,
  scrape_likers:          true,
  scrape_members:         false, // TG-only
  scrape_recent_msgs:     false, // TG-only
  scrape_active_users:    true,  // IG monitor analog
  scrape_export:          true,

  // Messaging
  messaging_bulk_dm:      true,
  messaging_bulk_to_group:false, // IG: bulk-to-thread is the closest analog
  messaging_forward:      false, // IG forwarding is not supported via private API
  messaging_threads:      true,  // IG DM threads
  messaging_warmup:       true,  // IG accounts need conservative warmup

  // Groups (TG) / Threads (IG)
  groups_invite:          false,
  groups_kick:            false,

  // Lists / Reports
  lists_crud:             true,
  lists_import:           true,
  reports_generate:       true,

  // OTP
  otp_passive_listen:     false, // IG does not push OTPs into the in-app inbox
  otp_active_request:     true,  // SMS / email challenge during login

  // 2FA — TOTP enable/disable/change via accountSecurity
  twofa_enable:           true,
  twofa_disable:          true,
  twofa_change:           true,

  // Privacy
  privacy_set_phone:      false,
  privacy_set_account:    true,  // public/private toggle
  privacy_story_controls: true,

  // Account settings
  account_set_username:   true,
  account_set_name:       true,
  account_set_bio:        true,
  account_set_photo:      true,

  // Proxies — IG-specific validator (TLS handshake against i.instagram.com)
  proxies_validate:       true,
  proxies_assign:         true,

  // Identity / fingerprint — Instagram device fingerprint generator
  identity_device_model:  false, // TG concept
  identity_android_uuid:  true,  // IG concept

  // Behavior simulation
  behavior_simulate:      true,

  // ---------------------------------------------------------------------
  // Coarse rollups consumed by the sidebar / nav (mirror of
  // telegram/index.js). Same key on both providers so the React
  // Sidebar gate can stay simple.
  // ---------------------------------------------------------------------
  sessions_list:          true,
  scrape_any:             true,   // followers || following || likers
  messaging_bulk:         true,   // bulk_dm only on IG
  lists:                  true,   // shared list service
  reports:                true,   // shared report service
  proxies:                true,
  identity_device:        true,   // android uuid fingerprint
  account_settings:       true,
  privacy_set:            true,   // public/private toggle
  twofa_change:           true,
  otp_passive:            false,  // IG has no passive OTP inbox
  otp_relay:              false,  // Saved-Messages relay is Telegram-only

  // In-panel Telegram client — Telegram-only capability. Always false
  // here so the IG sidebar never renders the "Login" entry.
  telegram_client:        false,

  // Phase 2 in-panel Telegram client features — all Telegram-only.
  tgc_send_media:         false,
  tgc_view_media:         false,
  tgc_message_actions:    false,
  tgc_self_profile:       false,
  tgc_peer_profile:       false,
  tgc_chat_admin:         false,
};

// Lazy module loaders — keeps the IG runtime out of the cold-start path.
let _loaded = {};
function _lazy(name) {
  if (_loaded[name]) return _loaded[name];
  // eslint-disable-next-line global-require
  _loaded[name] = require(`./${name}`);
  return _loaded[name];
}

// Each subsystem exposes a single object whose methods accept and return the
// same shapes as the Telegram provider equivalents. They are wrapped in
// getter functions so we don't pay the require() cost for unused subsystems.
const sessions = new Proxy({}, {
  get(_t, prop) { return _lazy('sessions')[prop]; },
});
const create = new Proxy({}, {
  get(_t, prop) { return _lazy('create')[prop]; },
});
const scrape = new Proxy({}, {
  get(_t, prop) { return _lazy('scrape')[prop]; },
});
const messaging = new Proxy({}, {
  get(_t, prop) { return _lazy('messaging')[prop]; },
});
const threads = new Proxy({}, {
  get(_t, prop) { return _lazy('threads')[prop]; },
});
const groups = new Proxy({}, {
  get(_t, prop) {
    // Telegram-style groups are not supported on Instagram — return a
    // stub that throws a recognisable error so controllers can degrade.
    return () => {
      const e = new Error('Telegram-style groups are not available on Instagram. Use threads instead.');
      e.code = 'NOT_SUPPORTED_ON_INSTAGRAM';
      throw e;
    };
  },
});
const lists = new Proxy({}, {
  get(_t, prop) { return _lazy('lists')[prop]; },
});
const reports = new Proxy({}, {
  get(_t, prop) { return _lazy('reports')[prop]; },
});
const otp = new Proxy({}, {
  get(_t, prop) { return _lazy('otp')[prop]; },
});
const twoFA = new Proxy({}, {
  get(_t, prop) { return _lazy('twoFA')[prop]; },
});
const privacy = new Proxy({}, {
  get(_t, prop) { return _lazy('privacy')[prop]; },
});
const accountSettings = new Proxy({}, {
  get(_t, prop) { return _lazy('accountSettings')[prop]; },
});
const proxies = new Proxy({}, {
  get(_t, prop) { return _lazy('proxies')[prop]; },
});
const identity = new Proxy({}, {
  get(_t, prop) { return _lazy('identity')[prop]; },
});
const behavior = new Proxy({}, {
  get(_t, prop) { return _lazy('behavior')[prop]; },
});

// IG doesn't use per-user app credentials (the user authenticates with the
// Instagram username + password during session create), so the credentials
// gate always passes.
const userCredentials = {
  list:      async () => [],
  create:    async () => { throw new Error('Instagram does not use per-user API credentials'); },
  update:    async () => { throw new Error('Instagram does not use per-user API credentials'); },
  delete:    async () => { throw new Error('Instagram does not use per-user API credentials'); },
  hasUsable: async () => true,
  raw:       null,
};

module.exports = {
  platform: 'instagram',
  capabilities,
  native: new Proxy({}, {
    get(_t, prop) { return _lazy('client')[prop]; },
  }),

  sessions,
  create,
  scrape,
  messaging,
  threads,
  groups,
  lists,
  reports,
  otp,
  twoFA,
  privacy,
  accountSettings,
  proxies,
  identity,
  behavior,
  userCredentials,
};
