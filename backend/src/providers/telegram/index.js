/**
 * Telegram provider — facade over the existing per-feature service singletons.
 *
 * No code is moved out of `backend/src/services/` for this commit; this is a
 * thin re-export layer that gives controllers a unified noun.verb API
 * (`provider.sessions.upload(...)`, `provider.scrape.start(...)`, etc.) so
 * the controller layer stays platform-agnostic and the Instagram provider
 * (Phase 2) can implement the same shape.
 *
 * The objects exposed here are NOT new singletons; they are just live
 * references to the existing service singletons. Anything previously called
 * via `require('../services/sessionService').<method>(...)` resolves through
 * `provider.sessions.<method>(...)` to the same instance, with the same
 * mutable state, locks, in-memory client pools, etc.
 */

const sessionService = require('../../services/sessionService');
const sessionCreationService = require('../../services/sessionCreationService');
const telegramService = require('../../services/telegramService');
const scrapeService = require('../../services/scrapeService');
const scrapeMonitorService = require('../../services/scrapeMonitorService');
const messageService = require('../../services/messageService');
const groupService = require('../../services/groupService');
const listService = require('../../services/listService');
const reportService = require('../../services/reportService');
const otpService = require('../../services/otpService');
const twoFAService = require('../../services/twoFAService');
const twoFAJobService = require('../../services/twoFAJobService');
const privacyService = require('../../services/privacyService');
const privacyJobWorker = require('../../services/privacyJobWorker');
const accountSettingsService = require('../../services/accountSettingsService');
const proxyService = require('../../services/proxyService');
const identityService = require('../../services/identityService');
const behaviorService = require('../../services/behaviorService');
const userApiCredentialsService = require('../../services/userApiCredentialsService');

// ---------------------------------------------------------------------------
// Capability flags (§3.4 — feature parity with degradation).
// ---------------------------------------------------------------------------
//
// The frontend reads this map from `/api/<platform>/capabilities` to know
// which features to render and which to hide / show as "Not supported on
// $platform". Telegram is the legacy reference implementation so it gets
// every flag.
const capabilities = {
  // Sessions
  sessions_upload:        true,   // multi-file .session/.json/.bin/.txt upload
  sessions_create:        true,   // interactive create with phone code + 2FA
  sessions_download:      true,   // re-export plaintext session string
  sessions_logout:        true,
  sessions_status:        true,
  sessions_heartbeat:     true,

  // Scrape
  scrape_followers:       false,  // IG-only
  scrape_following:       false,  // IG-only
  scrape_likers:          false,  // IG-only
  scrape_members:         true,   // TG-only — channel/supergroup members
  scrape_recent_msgs:     true,   // TG-only — recent messages of a channel
  scrape_active_users:    true,   // TG monitor — active users window
  scrape_export:          true,

  // Messaging
  messaging_bulk_dm:      true,
  messaging_bulk_to_group:true,   // TG-only
  messaging_forward:      true,   // TG-only
  messaging_threads:      false,  // IG-only
  messaging_warmup:       false,  // IG-only daily/hourly warmup caps

  // Groups (TG semantics) / Threads (IG)
  groups_invite:          true,   // TG-only
  groups_kick:            true,   // TG-only

  // Lists / Reports
  lists_crud:             true,
  lists_import:           true,
  reports_generate:       true,

  // OTP
  otp_passive_listen:     true,   // TG: NewMessage from "777000"
  otp_active_request:     false,  // IG: SMS/email challenge during login

  // 2FA
  twofa_enable:           true,
  twofa_disable:          true,
  twofa_change:           true,

  // Privacy
  privacy_set_phone:      true,   // TG concept
  privacy_set_account:    false,  // IG concept (private/public)
  privacy_story_controls: false,  // IG-only

  // Account settings
  account_set_username:   true,
  account_set_name:       true,
  account_set_bio:        true,
  account_set_photo:      true,

  // Proxies
  proxies_validate:       true,
  proxies_assign:         true,

  // Identity / fingerprint
  identity_device_model:  true,   // TG fingerprint
  identity_android_uuid:  false,  // IG fingerprint

  // Behavior simulation
  behavior_simulate:      true,

  // ---------------------------------------------------------------------
  // Coarse rollups consumed by the sidebar / nav. Same key on both
  // providers so the React Sidebar gate can stay simple. They're just
  // ORs of the fine-grained flags above.
  // ---------------------------------------------------------------------
  sessions_list:          true,
  scrape_any:             true,   // scrape_members || scrape_recent_msgs || scrape_active_users
  messaging_bulk:         true,   // messaging_bulk_dm || messaging_bulk_to_group
  lists:                  true,   // lists_crud || lists_import
  reports:                true,   // reports_generate
  proxies:                true,   // proxies_validate || proxies_assign
  identity_device:        true,   // identity_device_model || identity_android_uuid
  account_settings:       true,   // any account_set_*
  privacy_set:            true,   // privacy_set_phone || privacy_set_account
  twofa_change:           true,
  otp_passive:            true,   // alias of otp_passive_listen
  otp_relay:              true,   // Saved-Messages OTP relay (TG only)

  // ---------------------------------------------------------------------
  // In-panel Telegram client (per-session login → real chat UI).
  // Telegram-only; the Instagram provider must NOT expose this flag.
  // Backed by /api/telegram/client/* and a custom React Telegram-style
  // chat surface that opens in its own window per session.
  // ---------------------------------------------------------------------
  telegram_client:        true,

  // ---------------------------------------------------------------------
  // Phase 2 — in-panel Telegram client feature surface (Telegram-only).
  // Each flag gates one Phase 2 deliverable on the frontend; the Instagram
  // provider must mirror them as `false`.
  // ---------------------------------------------------------------------
  // D1 — send media (photo/video/file/voice/sticker).
  tgc_send_media:         true,
  // D2 — view media inline (image/video/audio rendering + Range streaming).
  tgc_view_media:         true,
  // D3 — message actions: reply / forward / edit / delete.
  tgc_message_actions:    true,
  // D5 — self profile (view + edit name / bio / username / photo).
  tgc_self_profile:       true,
};

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
const sessions = {
  upload:        (...a) => sessionService.uploadSessions(...a),
  list:          (...a) => sessionService.listSessions(...a),
  get:           (...a) => sessionService.getSession(...a),
  login:         (...a) => sessionService.loginSession(...a),
  logout:        (...a) => sessionService.logoutSession(...a),
  // Anti-revoke Phase 4 — bring a 'revoked' row back to life if the
  // on-disk encrypted session string (or its newest backup) is still
  // accepted by Telegram. Telegram-only.
  recover:       (...a) => sessionService.recoverSession(...a),
  status:        (...a) => sessionService.checkSessionStatus(...a),
  download:      (...a) => sessionService.downloadSession(...a),
  delete:        (...a) => sessionService.deleteSession(...a),
  bulkDelete:    (...a) => sessionService.bulkDeleteSessions(...a),
  stats:         (...a) => sessionService.getSessionStats(...a),
  heartbeat:     (...a) => sessionService.heartbeatLoggedInSessions(...a),
  restoreAll:    (...a) => sessionService.restoreAllLoggedInSessions(...a),
  raw:           sessionService,
};

// ---------------------------------------------------------------------------
// Interactive create-session flow
// ---------------------------------------------------------------------------
const create = {
  start:    (...a) => sessionCreationService.start(...a),
  verify:   (...a) => sessionCreationService.verify(...a),
  // TG: 2FA cloud password. IG: 2FA TOTP code. Same API surface, different
  // semantics inside.
  password: (...a) => sessionCreationService.password(...a),
  resend:   (...a) => sessionCreationService.resend(...a),
  cancel:   (...a) => sessionCreationService.cancel(...a),
  raw:      sessionCreationService,
};

// ---------------------------------------------------------------------------
// Scrape
// ---------------------------------------------------------------------------
const scrape = {
  startMembers:    (...a) => scrapeService.startMembersScrape(...a),
  startMessages:   (...a) => scrapeService.startMessagesScrape(...a),
  startActive:     (...a) => scrapeMonitorService.startMonitor(...a),
  list:            (...a) => scrapeService.listJobs(...a),
  get:             (...a) => scrapeService.getJob(...a),
  cancel:          (...a) => scrapeService.cancelJob(...a),
  exportCsv:       (...a) => scrapeService.exportCsv(...a),
  exportXlsx:      (...a) => scrapeService.exportXlsx(...a),
  raw:             scrapeService,
  monitor:         scrapeMonitorService,
};

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------
const messaging = {
  sendBulk:        (...a) => messageService.sendBulk(...a),
  sendToGroup:     (...a) => messageService.sendToGroup?.(...a),
  forward:         (...a) => messageService.forwardMessage?.(...a),
  list:            (...a) => messageService.listJobs?.(...a),
  cancel:          (...a) => messageService.cancelJob?.(...a),
  raw:             messageService,
};

// ---------------------------------------------------------------------------
// Threads (IG-only — Telegram returns 'not supported')
// ---------------------------------------------------------------------------
const threads = {
  list: () => { throw new Error('Telegram does not support threads — use groups instead'); },
  get:  () => { throw new Error('Telegram does not support threads — use groups instead'); },
  send: () => { throw new Error('Telegram does not support threads — use groups instead'); },
};

// ---------------------------------------------------------------------------
// Groups (TG-only)
// ---------------------------------------------------------------------------
const groups = {
  invite: (...a) => groupService.invite?.(...a),
  kick:   (...a) => groupService.kick?.(...a),
  list:   (...a) => groupService.listGroups?.(...a),
  raw:    groupService,
};

// ---------------------------------------------------------------------------
// Lists / Reports — already platform-aware via the platform column on the
// underlying tables. The provider just delegates.
// ---------------------------------------------------------------------------
const lists = {
  create: (...a) => listService.createList(...a),
  list:   (...a) => listService.listLists(...a),
  get:    (...a) => listService.getList(...a),
  update: (...a) => listService.updateList(...a),
  delete: (...a) => listService.deleteList(...a),
  items:  (...a) => listService.listItems(...a),
  raw:    listService,
};

const reports = {
  generate: (...a) => reportService.generateReport(...a),
  list:     (...a) => reportService.listReports?.(...a),
  raw:      reportService,
};

// ---------------------------------------------------------------------------
// OTP — TG passively listens for the "Telegram Login Code" message.
// ---------------------------------------------------------------------------
const otp = {
  startScan: (...a) => otpService.startScan(...a),
  list:      (...a) => otpService.listScans?.(...a),
  poll:      (...a) => otpService.pollScan?.(...a),
  cancel:    (...a) => otpService.cancelScan?.(...a),
  raw:       otpService,
};

// ---------------------------------------------------------------------------
// 2FA
// ---------------------------------------------------------------------------
const twoFA = {
  enable:   (...a) => twoFAService.enable(...a),
  disable:  (...a) => twoFAService.disable(...a),
  change:   (...a) => twoFAService.change(...a),
  listJobs: (...a) => twoFAJobService.listJobs(...a),
  startJob: (...a) => twoFAJobService.startJob(...a),
  cancelJob:(...a) => twoFAJobService.cancelJob?.(...a),
  raw:      twoFAService,
  jobs:     twoFAJobService,
};

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------
const privacy = {
  set: (...a) => privacyService.setPrivacy(...a),
  get: (...a) => privacyService.getPrivacy?.(...a),
  raw: privacyService,
  worker: privacyJobWorker,
};

// ---------------------------------------------------------------------------
// Account settings
// ---------------------------------------------------------------------------
const accountSettings = {
  update: (...a) => accountSettingsService.update?.(...a),
  get:    (...a) => accountSettingsService.get?.(...a),
  raw:    accountSettingsService,
};

// ---------------------------------------------------------------------------
// Proxies — validation runs against Telegram's DC4 endpoint.
// ---------------------------------------------------------------------------
const proxies = {
  list:     (...a) => proxyService.listProxies(...a),
  create:   (...a) => proxyService.createProxy(...a),
  validate: (...a) => proxyService.validateProxy(...a),
  delete:   (...a) => proxyService.deleteProxy(...a),
  assign:   (...a) => proxyService.assignProxy?.(...a),
  raw:      proxyService,
};

// ---------------------------------------------------------------------------
// Identity (device fingerprint generator)
// ---------------------------------------------------------------------------
const identity = {
  generate: (...a) => identityService.generateIdentity(...a),
  list:     (...a) => identityService.listIdentities(...a),
  assign:   (...a) => identityService.assignIdentity?.(...a),
  raw:      identityService,
};

// ---------------------------------------------------------------------------
// Behavior simulation (anti-detect)
// ---------------------------------------------------------------------------
const behavior = {
  start:  (...a) => behaviorService.start(...a),
  stop:   (...a) => behaviorService.stop?.(...a),
  status: (...a) => behaviorService.getStatus?.(...a),
  raw:    behaviorService,
};

// ---------------------------------------------------------------------------
// Per-user app credentials (TG: API ID + API Hash). IG doesn't use this so
// the IG provider returns a stub that always reports "yes credentials".
// ---------------------------------------------------------------------------
const userCredentials = {
  list:       (...a) => userApiCredentialsService.list(...a),
  create:     (...a) => userApiCredentialsService.create(...a),
  update:     (...a) => userApiCredentialsService.update(...a),
  delete:     (...a) => userApiCredentialsService.delete(...a),
  hasUsable:  (...a) => userApiCredentialsService.userHasUsable(...a),
  raw:        userApiCredentialsService,
};

module.exports = {
  platform: 'telegram',
  capabilities,
  // Native client pool (kept for any caller that still needs the raw
  // GramJS client map — e.g. the heartbeat sweep at boot time).
  native:   telegramService,

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
