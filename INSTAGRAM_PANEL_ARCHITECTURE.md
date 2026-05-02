# Instagram Panel — Full Architecture Plan
**Repo:** `Jasxjagy6/web-pannel`
**Goal:** Add a complete Instagram panel alongside the existing Telegram panel, with feature parity, a top-level Telegram ↔ Instagram toggle, per-platform subscriptions, Instagram-themed UI, and the ability to comfortably handle **1000+ concurrent users on both panels simultaneously**.
**Document scope:** Architecture only. No code changes. Every step is laid out so a follow-up PR series can execute against this plan without re-discovery.

---

## 0. How to read this document

The repo is large, so this plan starts from a deep ground-truth audit of the current panel and proposes a multi-platform design that re-uses every piece of infrastructure that is platform-agnostic (auth, billing, queues, Redis, Postgres, websockets, proxy framing, anti-detect framing, reports) while introducing a clean **provider abstraction** for everything that is Telegram-specific (MTProto, GramJS, phone-number/OTP/2FA flow, session-string format).

Sections are roughly in dependency order:

1. Audit of the current Telegram panel.
2. Goals, non-goals, and product surface.
3. The new platform abstraction (data model + service interfaces).
4. Backend changes per subsystem (auth, billing, sessions, scrape, messaging, groups, lists, reports, OTP, 2FA, proxies, anti-detect, privacy, websockets, queues).
5. Instagram-specific design (library choice, login flow, challenge/2FA, session storage, fingerprint, feature mapping).
6. Frontend changes (PlatformContext, header toggle, theme system, routing, billing redirect).
7. Capacity plan for 1000+ concurrent users.
8. Security, observability, ops.
9. Phased rollout plan and risk register.
10. Acceptance criteria.
11. Appendices (file layout, env vars, API surface, test matrix).

---

## 1. Current state — deep audit

### 1.1 Top-level layout

```
web-pannel/
├── backend/       Node.js (Express + Socket.IO + GramJS + BullMQ)
│   └── src/
│       ├── index.js                    HTTP + WS bootstrap, queue init, startup hooks
│       ├── config/
│       │   ├── database.js             Postgres pool + migration runner
│       │   ├── redis.js                Redis client (also used by BullMQ via ioredis-style cfg)
│       │   ├── telegram.js             Legacy Telegram defaults (api_id, api_hash fallbacks)
│       │   └── schema.sql + migration_v2..v8.sql + scraping/group/privacy migrations
│       ├── middleware/
│       │   ├── auth.js                 JWT decode, requireApproved gate, requireAdmin
│       │   ├── rateLimiter.js
│       │   ├── upload.js / fileUpload.js
│       │   └── validator.js
│       ├── routes/                     auth, sessions, scrape, messages, groups,
│       │                               lists, reports, dashboard, accountSettings,
│       │                               twoFAJobs, otp, proxies, antiDetect, privacy,
│       │                               admin, billing, userCredentials
│       ├── controllers/                Thin layer wrapping services
│       ├── services/                   ~22 services, all Telegram-specific or platform-agnostic
│       │   ├── telegramService.js          GramJS wrapper (2807 lines) — THE Telegram core
│       │   ├── sessionService.js           Bulk upload / lifecycle / heartbeat (2276 lines)
│       │   ├── sessionCreationService.js   Interactive create-session flow (570 lines)
│       │   ├── scrapeService.js            Scrape orchestration (931 lines)
│       │   ├── scrapeMonitorService.js     Period-bounded passive monitors (618 lines)
│       │   ├── messageService.js           Distribution/bulk send (2288 lines)
│       │   ├── groupService.js             Group ops (957 lines)
│       │   ├── listService.js              List CRUD (1719 lines)
│       │   ├── reportService.js            Reports + exports (1797 lines)
│       │   ├── twoFAService.js / twoFAJobService.js   Change-2FA jobs (~1170 lines)
│       │   ├── otpService.js               OTP-scan jobs (326 lines)
│       │   ├── privacyService.js / privacyJobWorker.js   Privacy bulk-apply (504 lines)
│       │   ├── proxyService.js             Free + manual proxy pool, validation, assignment
│       │   ├── identityService.js          Per-session device fingerprint
│       │   ├── behaviorService.js          Anti-detect "looks-human" simulator
│       │   ├── accountSettingsService.js   Profile/photo/bio updates
│       │   ├── userApiCredentialsService.js Per-user Telegram API ID/Hash vault (v8)
│       │   ├── subscriptionService.js      OxaPay-driven subscriptions + trial
│       │   ├── oxapayService.js            HTTPS client + HMAC IPN verification
│       │   └── systemSettingsService.js    Admin-tunable singletons
│       ├── queues/                     scrapeQueue, messageQueue, groupQueue, twoFAQueue
│       │                               (BullMQ on Redis)
│       └── utils/                      crypto (AES-256-GCM), errorHandler, logger,
│                                        deviceFingerprint, telethonConverter, pagination,
│                                        botDetector
├── frontend/      React 18 + Vite + Tailwind + Zustand + Socket.IO client
│   └── src/
│       ├── App.jsx                 Routes + ProtectedRoute (entitlement gate)
│       ├── context/AuthContext.jsx
│       ├── hooks/                  useAuth, useWebSocket, usePolling
│       ├── api/                    axios client + per-feature modules
│       ├── components/
│       │   ├── layout/             Layout, Header (Bell + avatar), Sidebar
│       │   └── common/             Modal, Toast, DataTable, FileUpload, etc.
│       └── pages/                  Login, Register, Pending, Admin, Dashboard,
│                                    Sessions, CreateSession, Scrape, Messaging,
│                                    Groups, Lists, Reports, Settings, AccountSettings,
│                                    Change2FA, GetOTP, Proxies, AntiDetect, Privacy,
│                                    Billing
├── scripts/                        Operational scripts
├── sessions/                       (gitignored) on-disk session uploads
├── docker-compose.yml              postgres + redis + backend + frontend
└── OPS.md                          Runbook for the 500-700 concurrent-user target
```

Backend totals: ~18,800 LOC of services, ~2200 LOC of controllers, ~550 LOC of routes, ~150 LOC of middleware, schema + 9 migrations.
Frontend totals: ~15,300 LOC across 21 pages + 8 layout/common components + 17 API modules.

### 1.2 Auth & subscription pipeline

- **JWT** issued on `POST /api/auth/login` (`backend/src/middleware/auth.js`).
- `authenticate` middleware decodes the JWT, then **re-reads the live `users` row** every request so a banned / un-approved user can't keep a stale token. The user row is hydrated onto `req.user` with `subscription*`, `trial_*`, etc.
- `requireApproved(feature?)` is the global feature gate:
  1. admin → bypass.
  2. banned → `403 ACCOUNT_BANNED`.
  3. not-approved → `403 NOT_APPROVED` (legacy; v8 makes this auto-approve).
  4. **No usable per-user Telegram API credential** → `412 API_CREDENTIALS_REQUIRED`. The frontend listens for this code globally and pops `MissingApiCredsModal`.
  5. **No active subscription and no live trial** (or feature not in the trial whitelist) → `402 SUBSCRIPTION_REQUIRED` / `402 TRIAL_FEATURE_NOT_ALLOWED`. The frontend redirects to `/billing`.
- Subscriptions are stored on the `users` row (`subscription_plan`, `subscription_status`, `subscription_expires_at`, `subscription_features`, plus `trial_started_at`, `trial_expires_at`, `trial_used`). Audit goes to `subscription_events`. Invoices go to `payment_invoices` (OxaPay). `system_settings` holds admin-tunable price/period/trial config.
- Sweep loop `subscriptionService.sweepExpired()` runs every 60 s in `backend/src/index.js` to roll active → expired.

### 1.3 Sessions & telegram clients

- A "session" in this codebase = one logged-in Telegram account, identified by `sessions.id` (Postgres serial). The on-disk JSON file holds the GramJS string session (encrypted at rest with `JWT_SECRET`-derived AES-GCM); after PR #14 the download endpoint decrypts on the fly so users get a plaintext session.
- `telegramService.js` keeps an in-process `clients` Map: `sessionId → { client, connected, apiId, apiHash, proxy, identity }`. The heartbeat loop (`sessionService.heartbeatLoggedInSessions`, every `SESSION_HEARTBEAT_INTERVAL_MS`) keeps idle clients alive; `restoreAllLoggedInSessions` rebuilds the map at boot.
- Per-user Telegram API credentials live in `user_api_credentials` (encrypted hash). `userApiCredentialsService.pickForNewSession(userId)` rotates by `live_session_count ASC, id ASC`. Every session row is bound to a credential id.
- Proxies are bound to sessions via `sessions.bound_proxy_id` (set by `proxyService.assignProxyForSession`). The proxy pool is a mix of free public lists and admin-added paid proxies; revalidated every 10 minutes against Telegram DC4.
- Device fingerprints (`identityService`) per session: device_model, system_version, app_version, lang_code. Persisted in `sessions.device_identity::jsonb`.
- Anti-detect (`behaviorService`) runs a randomised batch of read-only actions (mark-as-read, set-typing, occasional reactions) every `BEHAVIOR_TICK_INTERVAL_MS` so dormant sessions don't look like a bot farm.

### 1.4 Feature surfaces (Telegram)

Each surface is a triple `route → controller → service`:

| Surface | Description | Key service entry-points | Queue? |
|---|---|---|---|
| **Sessions** | Bulk upload `.json/.session/.bin`, list, login, logout, status, download, delete | `sessionService.uploadSessions`, `restoreAllLoggedInSessions`, `loginSession`, `logoutSession`, `getSessionById`, `listSessions` | no |
| **Create Session** | Interactive `/start` → `/verify` → `/password` → `/resend` → `/cancel` | `sessionCreationService.{start,verify,password,resend,cancel}` | no (in-memory `pending` map) |
| **Scrape** | Scrape group members / channel subscribers; period-bounded monitors for hidden-member groups | `scrapeService.execute`, `scrapeMonitorService.{startJob,resumeActiveJobs,pauseJob}` | yes (`scrapeQueue`) |
| **Messaging** | DM blast / group blast with target lists; rate-limited per-session | `messageService.{distributeTargets,sendBulkMessage,sendBulkToGroups,sendBulkToUsers}` | yes (`messageQueue`) |
| **Groups** | Add/remove members, create groups, group info | `groupService.*` | yes (`groupQueue`) |
| **Lists** | CRUD on lists of users; import from scrape jobs / CSV | `listService.*` | no |
| **Reports** | Aggregations + CSV/XLSX/PDF exports | `reportService.*` | no (sync) |
| **Get OTP** | 5-minute OTP scan window — captures incoming login codes | `otpService.{startScan,resumeActiveScans}` | no (live MTProto handler) |
| **Change 2FA** | Bulk update password for owned sessions | `twoFAJobService.*` + `twoFAQueue` | yes |
| **Proxies** | Pool view, manual add, refresh, assignment | `proxyService.*` | no (background validator) |
| **Anti-Detect** | Per-session identity overrides + behavior toggles | `identityService`, `behaviorService` | no |
| **Privacy** | Bulk apply privacy settings across owned sessions | `privacyService`, `privacyJobWorker` | no (worker) |
| **Account Settings** | Profile photo, bio, name, username | `accountSettingsService.*` | no |
| **Admin** | User CRUD, billing overrides, audit log | `adminController` directly hits `users/payment_invoices/subscription_events` | no |
| **Billing** | Trial activation, subscribe, OxaPay invoice + IPN | `billingController`, `subscriptionService`, `oxapayService` | no |

### 1.5 Frontend pages & routes

- `App.jsx` declares 19 routes; `Login`, `Register`, `Pending` are eager, everything else is lazy.
- `ProtectedRoute` wraps each authenticated page: it checks `isAuthenticated`, `status === banned/approved`, `isAdmin`, and whether the user has an entitlement (`subscription.status === active && expiresAt > now`, OR `trial.expiresAt > now`). No entitlement → redirect to `/billing`.
- `/billing` and `/settings` are explicitly `allowWithoutSubscription` so a freshly-registered user can configure API credentials and pay before being allowed into feature pages.
- The sidebar (`Sidebar.jsx`) is a flat list of feature links (Dashboard, Sessions, Create Session, Scrape, Messaging, Groups, Lists, Change 2FA, Get OTP, Proxies, Anti-Detect, Reports, Account Settings, Privacy, Billing, Settings). Admin gets `/admin` on top.
- The header (`Header.jsx`) currently has: menu toggle (left), page title, and on the right a **Bell** icon + avatar with email. There is no platform switcher today.
- Theme: Tailwind config defines `primary` as Telegram-style blues (`#3b82f6`/`#2563eb`/`#1d4ed8`) and `dark` slates. Every page hard-codes `bg-dark-*` / `text-primary-*`. There is no per-platform theme indirection yet.
- Real-time: `useWebSocket` connects to Socket.IO with the JWT, joins `user:<userId>` room on the server (`backend/src/index.js` line 170), and listens for `scrape:*`, `messaging:*`, `monitor:tick`, `notification`. The client stores progress in component state.

### 1.6 Capacity posture today

`OPS.md` documents the 500-700 concurrent-user target, with a clear dial-up procedure (DB pool → log sampling → second panel pod → pgbouncer → workers split → monitor pod). Tunables live in env vars (`DB_POOL_MAX`, `WS_PING_*`, `MAX_RUNNING_MONITORS_PER_USER`, `REQ_LOG_SAMPLE`, `SHUTDOWN_GRACE_MS`). docker-compose runs everything single-node today, but the codebase is already pod-friendly (graceful shutdown, lifetime-bounded DB connections, BullMQ workers can be split off).

---

## 2. Goals, non-goals, product surface

### 2.1 Goals

1. **Feature parity.** Every feature the Telegram panel offers must have an Instagram analog where Instagram supports it. Where Instagram does not support a primitive at all, the page must still render and degrade gracefully (e.g., explicitly mark "Not supported on Instagram" with a tooltip).
2. **Single account, two panels.** A user has **one** account (one `users` row, one JWT). The Telegram panel and Instagram panel are different *views* over that account, with **independent subscriptions** (you can buy Telegram only, Instagram only, or both).
3. **Top-bar toggle**, next to the bell icon, that flips the entire app between Telegram and Instagram. Smooth animation, persisted across reloads, deep-linkable.
4. **Subscription redirect.** Toggling to a panel for which the user has no active subscription/trial sends them to that panel's billing page (`/ig/billing` or `/tg/billing`) with the platform pre-selected.
5. **Theme parity with the platform.** Telegram panel keeps its current bluish dark theme. Instagram panel adopts an Instagram-like palette: gradient brand color (the `#feda75 → #d62976 → #4f5bd5` Instagram gradient), softer card surfaces, the same dark base.
6. **Operational target: 1000+ concurrent users on each panel simultaneously**, i.e. a 2000-user steady state with bursty peaks. Includes WS, scrape jobs, messaging jobs, and live OTP scans.
7. **No regression for existing Telegram users.** Migration must be backwards-compatible; deployed users must keep working through the cutover.

### 2.2 Non-goals

1. **Public Instagram Graph API integration** for end-user features. The Graph API only covers Business/Creator accounts and is heavily rate-limited; we cannot drive scraping/DM blasting through it. Graph stays optional for the Insights subset only.
2. **Bypassing Instagram detection / login challenges by automation.** We surface checkpoints to the user; we don't auto-solve them.
3. **Re-architecting Telegram features.** This plan only refactors Telegram code where the abstraction requires it. We don't take on unrelated Telegram clean-ups.
4. **Switching languages.** The plan keeps Node.js as the primary backend; an optional Python sidecar for `instagrapi` is documented but not the default.

### 2.3 Product surface (what the user sees)

```
                                                 ┌─────────────────────────────┐
                                                 │ Header                      │
   Sidebar (per-platform colors)                 │  ☰  Page title              │
   ┌────────────────────────┐                    │           [TG ⇄ IG] 🔔  👤  │
   │  ✦ Telegram Panel      │  ←  brand swap     ├─────────────────────────────┤
   │  Dashboard             │                    │                             │
   │  Sessions              │                    │   Page content              │
   │  Create Session        │                    │   (changes when toggling)   │
   │  Scrape                │                    │                             │
   │  Messaging             │                    │                             │
   │  ...                   │                    │                             │
   │  Billing               │                    │                             │
   │  Settings              │                    │                             │
   └────────────────────────┘                    └─────────────────────────────┘
```

Toggle flow:

- **Has both subscriptions** → instantly swap `platform` in the URL (`/tg/...` ↔ `/ig/...`), theme, sidebar items.
- **Toggle to a platform with no entitlement** → smooth animated transition then route to `/<platform>/billing` with a banner ("You don't have an active Instagram subscription yet").
- **Already on `/<platform>/billing`** → toggle just flips the platform parameter so the user doesn't get bounced back.

---

## 3. Platform abstraction (the core idea)

### 3.1 The "platform" enum

Introduce a first-class `platform` discriminator everywhere there is a per-account concept. Two values today: `telegram`, `instagram`. The data model is forward-compatible with future platforms (e.g., `tiktok`).

- Postgres: `CREATE TYPE platform_type AS ENUM ('telegram','instagram');` and add `platform platform_type NOT NULL` columns.
- Application: a `Platform` enum (`'telegram' | 'instagram'`) is derived from URL prefix or the JWT-issued default and threaded through every service call.

### 3.2 Provider interface

Almost every Telegram service has a clean noun-verb shape (sessions, scrape, messaging, groups, lists, reports, otp, twoFA, accountSettings, privacy). We extract those shapes into a **provider interface** that both `telegramProvider` (existing code repackaged) and `instagramProvider` (new) implement.

```text
SocialProvider
├── platform: 'telegram' | 'instagram'
├── createClient({ session, credential, proxy, identity }) → Client
├── sessions
│   ├── upload(files, userId, opts) → { results, ... }
│   ├── createInteractive.start({ userId, identifier, credentialId? })
│   ├── createInteractive.verify({ userId, tempId, code })
│   ├── createInteractive.password({ userId, tempId, password })   // 2FA / Instagram password
│   ├── createInteractive.solveChallenge({ userId, tempId, code, choice }) // IG only no-op for TG
│   ├── createInteractive.resend({ userId, tempId })
│   ├── createInteractive.cancel({ userId, tempId })
│   ├── login(sessionId, userId)
│   ├── logout(sessionId, userId)
│   ├── status(sessionId, userId)
│   ├── download(sessionId, userId) → buffer + filename + mime
│   └── heartbeat(sessionId)
├── identity
│   ├── randomize(sessionId)
│   └── apply(sessionId, identity)
├── proxies
│   ├── assign(sessionId)
│   └── release(sessionId)
├── scrape
│   ├── execute({ jobId, sessionIds, target, options })   // members / followers
│   └── monitor.start({ jobId, sessionIds, target, durationMs })
├── messaging
│   ├── sendBulk({ jobId, sessions, targets, message, options })
│   ├── sendToGroup / sendToThread
│   └── forward
├── groups            // Telegram channels/supergroups; Instagram has only DM threads
│   ├── add / remove / info / create
│   └── list
├── threads           // Instagram DM threads; on Telegram this maps to chats
│   ├── list / get / send / fetchInbox
├── accountSettings
│   ├── updateProfile / updatePhoto / updateUsername / updateBio
├── otp
│   ├── startScan({ sessionId, durationMs })
│   └── resume(sessionId)
├── twoFA
│   ├── enable / disable / change
└── privacy
    └── apply({ sessionIds, settings })
```

Not every method exists on every platform. The interface declares **capability flags** the provider returns at startup so the UI can grey out unsupported sub-features:

```text
provider.capabilities = {
  scrapeMembers: true,
  scrapeChannelSubscribers: true,        // tg-specific
  scrapeFollowersFollowing: true,        // ig-specific
  messagingDirect: true,
  messagingGroup: true,                  // tg-only
  messagingForward: true,
  groupCreate: true,                     // tg-only
  groupAddRemove: true,                  // tg-only
  twoFA: true,
  otpScan: true,
  privacy: true,
  changePassword: true,                  // ig-specific
  liveStream: false,                     // future
}
```

Telegram's existing services implement this interface natively. Instagram's implementation is a thin wrapper around `instagram-private-api` (preferred — Node, same process) or an `instagrapi`-Python sidecar (fallback, see §5.1).

### 3.3 Service registry

A single registry resolves the provider by platform:

```text
backend/src/providers/index.js
  exports getProvider(platform) → SocialProvider
  loaders register('telegram', telegramProvider)
            register('instagram', instagramProvider)
```

Controllers always call `getProvider(platform).<noun>.<verb>(...)` instead of importing `telegramService` directly. Existing controllers that hard-import `telegramService` are refactored to take `platform` from `req` (see §4.3) and resolve through the registry.

### 3.4 What stays platform-agnostic

These subsystems do **not** need platform branching — they just gain a `platform` column and possibly a per-platform query filter:

- **users / auth / JWT** (one user, both panels).
- **subscriptions / billing** (per-platform rows, see §4.2 — but the OxaPay client and the IPN handler are unchanged).
- **system_settings** (per-platform keys, e.g. `billing.telegram.subscription_price_usd`, `billing.instagram.subscription_price_usd`).
- **Postgres / Redis / BullMQ infra** (queues become `<platform>:<feature>`, see §4.7).
- **Socket.IO** (rooms become `user:<userId>:<platform>`, see §4.8).
- **Activity logs / reports / lists** (already JSONB-payload-driven; gain a `platform` column).
- **Proxy pool framing** (host:port:protocol is the same, validation target is platform-specific — see §4.9).
- **Anti-detect framing** (device fingerprint shape changes, the scheduler does not — see §4.10).

### 3.5 What is platform-specific

These get separate implementations that conform to the interface above:

- Session creation and live-client lifecycle.
- Scrape (members vs followers/following).
- Messaging (chat semantics differ).
- Groups vs DM threads.
- 2FA / challenge / OTP flow.
- Privacy / account-settings field set.

---

## 4. Backend architecture

### 4.1 Database schema changes

The migration is `migration_v9_multiplatform.sql`. All `IF NOT EXISTS` / `IF EXISTS` to keep it idempotent and re-runnable.

#### 4.1.1 `platform` column on per-account tables

Every table that today scopes a row to "an account" gets a `platform` column with a default of `'telegram'` (so Telegram backfills automatically) and a `NOT NULL` after backfill:

```text
sessions                  + platform platform_type NOT NULL DEFAULT 'telegram'
scraping_jobs             + platform
scraped_users             + platform     -- not strictly needed (joined to job) but cheap
messaging_jobs            + platform
message_logs              + platform
group_operations          + platform
groups (table)            + platform     -- the Telegram groups cache
lists                     + platform
list_items                + platform
reports                   + platform
activity_logs             + platform
scrape_monitor_jobs       + platform
twofa_jobs                + platform
otp_scans                 + platform
privacy_jobs              + platform
proxies                   + platform     -- proxies are validated per platform target,
                                          -- so a working IG proxy may not be a working TG proxy
user_api_credentials      + platform     -- IG doesn't have api_id/api_hash — see §5.5
```

Indexes are renamed to be platform-aware where it matters:

```text
CREATE INDEX idx_sessions_user_platform_logged_in
  ON sessions(user_id, platform, is_logged_in);
CREATE INDEX idx_scraping_jobs_user_platform_status
  ON scraping_jobs(user_id, platform, status);
CREATE INDEX idx_messaging_jobs_user_platform_status
  ON messaging_jobs(user_id, platform, status);
CREATE INDEX idx_lists_user_platform ON lists(user_id, platform);
CREATE INDEX idx_reports_user_platform ON reports(user_id, platform);
```

#### 4.1.2 Subscriptions: per-platform rows

The existing `users.subscription_*` columns are de-normalised into a new table:

```text
CREATE TABLE user_subscriptions (
  id                       SERIAL PRIMARY KEY,
  user_id                  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform                 platform_type NOT NULL,
  plan                     VARCHAR(50),
  status                   VARCHAR(20) NOT NULL DEFAULT 'inactive'
                              CHECK (status IN ('inactive','active','expired','cancelled')),
  expires_at               TIMESTAMP,
  features                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  trial_started_at         TIMESTAMP,
  trial_expires_at         TIMESTAMP,
  trial_used               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, platform)
);

CREATE INDEX idx_user_subscriptions_user_platform
  ON user_subscriptions(user_id, platform);
CREATE INDEX idx_user_subscriptions_active_expiring
  ON user_subscriptions(status, expires_at)
  WHERE status = 'active' AND expires_at IS NOT NULL;
```

Backfill step:

```sql
INSERT INTO user_subscriptions (user_id, platform, plan, status, expires_at, features,
                                trial_started_at, trial_expires_at, trial_used)
SELECT id, 'telegram', subscription_plan, subscription_status, subscription_expires_at,
       subscription_features, trial_started_at, trial_expires_at, trial_used
FROM users
ON CONFLICT (user_id, platform) DO NOTHING;
```

The legacy `users.subscription_*` columns are kept for one release cycle as **read-only mirrors** so any tooling that hasn't been updated still sees data; a follow-up migration removes them.

`payment_invoices` and `subscription_events` gain `platform platform_type NOT NULL` so the audit trail and invoice history are scoped per-panel.

#### 4.1.3 Instagram-specific tables

Instagram doesn't have api_id/api_hash, but it does have **device-state** that must persist across reconnects (`instagram-private-api`'s state JSON: device info, cookies, csrftoken, etc.). The `sessions.session_file_path` already handles this (it's an opaque blob path) — no schema change required, just a new on-disk format.

Instagram also has **DM threads**, which map naturally to the existing `groups` cache table. We add an `external_type` column to disambiguate:

```text
ALTER TABLE groups
  ADD COLUMN IF NOT EXISTS external_type VARCHAR(20);  -- 'channel'|'supergroup'|'thread'|'group'
```

Instagram **followers/following** scrape results land in `scraped_users` with `target_type='followers'|'following'` (already a JSONB-friendly column). No schema change — we just standardize the values.

Instagram's **per-account device fingerprint** is richer than Telegram's: it includes `android_version`, `device_id`, `phone_id`, `uuid`, `advertising_id`, `family_device_id`. Stored in `sessions.device_identity::jsonb`. No schema change.

#### 4.1.4 Decommission `user_api_credentials` for Instagram

Instagram has no per-user developer credentials. The `user_api_credentials` table stays Telegram-scoped (we add a `platform` column with a CHECK constraint that for now only allows `'telegram'`). The credential gate (`requireApproved` → `412 API_CREDENTIALS_REQUIRED`) becomes platform-aware: only enforce when `platform === 'telegram'`.

#### 4.1.5 New billing settings

`system_settings` gains per-platform price/period keys. The migration seeds:

```text
billing.telegram.subscription_price_usd   = 9.99
billing.telegram.subscription_period_days = 30
billing.telegram.trial_enabled            = true
billing.telegram.trial_duration_minutes   = 5
billing.telegram.trial_allowed_features   = [<existing TG list>]
billing.instagram.subscription_price_usd  = 9.99
billing.instagram.subscription_period_days = 30
billing.instagram.trial_enabled           = true
billing.instagram.trial_duration_minutes  = 5
billing.instagram.trial_allowed_features  = ['dashboard','sessions','scrape','messaging','threads','lists','reports']
```

Bundle pricing is optional but recommended:

```text
billing.bundle.tg_plus_ig.price_usd = 14.99
billing.bundle.tg_plus_ig.period_days = 30
```

A bundle purchase grants both `user_subscriptions` rows in a single OxaPay invoice.

### 4.2 Subscription / billing changes

The subscription pipeline is the part of the codebase most affected by the multi-platform split, but the changes are mechanical.

#### 4.2.1 `subscriptionService` becomes platform-aware

Every public method gets a `platform` parameter. The existing helpers are renamed and re-keyed against `user_subscriptions`:

```text
entitlementFor(userRow, platform, feature?) → { allowed, reason, mode }
startTrial(userId, platform)                 → snapshot
grantSubscription(userId, platform, opts)    → { snapshot, expiresAt }
expireSubscription(userId, platform, reason) → snapshot
sweepExpired()                                — sweeps all (user_id, platform) tuples
userPublicSnapshot(userRow, subscriptionsByPlatform) →
  { id, email, role, status,
    subscriptions: { telegram: {...}, instagram: {...} } }
```

The frontend always reads `user.subscriptions[platform]` and never `user.subscription`.

#### 4.2.2 OxaPay invoice creation

`oxapayService.createInvoice` is unchanged. `subscriptionService.createInvoiceForUser(userId, { platform, plan?, amount? })` adds a `platform` to the description and stamps the new `payment_invoices.platform`. The OxaPay `order_id` we already send (the local invoice id) implicitly carries the platform via the DB row, so the IPN doesn't need to know.

#### 4.2.3 IPN handler

`billingController.oxapayIpn` looks up the invoice, then calls `grantSubscription(userId, invoice.platform, ...)`. For bundle purchases (`invoice.platform === 'bundle'`), it calls `grantSubscription` twice — once for each platform — inside a single transaction, with the same `granted_until` so both expire together.

#### 4.2.4 Middleware

`requireApproved(feature)` becomes `requireApproved(platform, feature?)`. The `feature` argument is preserved so the trial whitelist still works per-platform. The platform is read from `req.platform` (set by a `parsePlatform` middleware that runs first — see §4.3).

The `412 API_CREDENTIALS_REQUIRED` check stays gated on `platform === 'telegram'`. Instagram has no equivalent credential gate.

The `402 SUBSCRIPTION_REQUIRED` check stays, but error payload includes `platform`:

```json
{
  "success": false,
  "error": {
    "message": "An active Instagram subscription is required to use this feature.",
    "code": "SUBSCRIPTION_REQUIRED",
    "platform": "instagram"
  }
}
```

The frontend uses `error.platform` to redirect to the correct billing page.

### 4.3 URL prefix + platform parsing

All feature routes are mounted twice:

```text
const apiPrefix = process.env.API_PREFIX || '/api';
['telegram', 'instagram'].forEach((platform) => {
  const router = express.Router();
  router.use(parsePlatform(platform));      // sets req.platform
  router.use(authenticate);
  router.use('/sessions', sessionRoutes);
  router.use('/scrape', scrapeRoutes);
  // ... every feature ...
  app.use(`${apiPrefix}/${platform}`, router);
});
// Platform-agnostic endpoints stay at the old paths
app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}/billing`, billingRoutes);   // billing knows the platform from body/query
app.use(`${apiPrefix}/admin`, adminRoutes);
```

Concretely:

```
OLD:  GET  /api/sessions          (implicit telegram)
NEW:  GET  /api/telegram/sessions
      GET  /api/instagram/sessions
      GET  /api/sessions          (kept for one release: redirects to /api/telegram/sessions
                                   with X-Devin-Platform-Deprecated: telegram header)
```

`parsePlatform` is a one-liner middleware:

```text
function parsePlatform(forced) {
  return (req, _res, next) => {
    req.platform = forced || req.headers['x-platform'] || 'telegram';
    if (!['telegram','instagram'].includes(req.platform)) {
      throw new AppError('Unknown platform', 400, 'UNKNOWN_PLATFORM');
    }
    next();
  };
}
```

Controllers/services read `req.platform` and resolve `getProvider(req.platform)`.

### 4.4 Routes & controllers

The shape of every controller stays identical; only the platform plumbing is added. Concrete examples:

#### 4.4.1 sessionController

```diff
- const result = await sessionService.uploadSessions(req.files, userId, options);
+ const result = await getProvider(req.platform)
+   .sessions.upload(req.files, userId, options);
```

```diff
- const r = await pool.query(
-   `SELECT id, phone, session_file_path, account_info
-      FROM sessions
-     WHERE id = $1 AND user_id = $2`,
-   [sessionId, userId]
- );
+ const r = await pool.query(
+   `SELECT id, phone, username, session_file_path, account_info, platform
+      FROM sessions
+     WHERE id = $1 AND user_id = $2 AND platform = $3`,
+   [sessionId, userId, req.platform]
+ );
```

The existing `downloadSession` decryption logic from PR #14 is preserved verbatim; the file format on disk for Instagram is **already JSON** (it's `instagram-private-api`'s `state` blob), so the same decrypt/serialize-on-the-fly path applies.

#### 4.4.2 scrapeController, messageController, groupController, listController

Same shape: thread `req.platform` into every service call.

#### 4.4.3 billingController

Add `platform` to:

- `getStatus` — return both subscriptions: `data.subscriptions = { telegram: {...}, instagram: {...} }`.
- `subscribe` — accept `body.platform` (`'telegram' | 'instagram' | 'bundle'`).
- `startTrial` — accept `body.platform`.
- `oxapayIpn` — read `platform` from the local invoice row.
- `getInvoices` — filter by `?platform=`.

#### 4.4.4 adminController

Add filters: `GET /api/admin/users?platform=instagram&hasActiveSubscription=true`. Admin grant/revoke takes `platform`.

### 4.5 Telegram provider (existing code, repackaged)

`backend/src/providers/telegram/` collects the **existing** services into one package and exposes them through the provider interface. No behavior change; only re-exports.

```text
backend/src/providers/telegram/
├── index.js            registers SocialProvider with capabilities map
├── sessions.js         re-exports sessionService methods through the interface
├── interactive.js      re-exports sessionCreationService methods
├── scrape.js           re-exports scrapeService + scrapeMonitorService
├── messaging.js        re-exports messageService
├── groups.js           re-exports groupService
├── lists.js            re-exports listService
├── reports.js          re-exports reportService
├── otp.js              re-exports otpService
├── twoFA.js            re-exports twoFAService + twoFAJobService
├── privacy.js          re-exports privacyService + privacyJobWorker hooks
├── proxies.js          re-exports proxyService scoped to telegram
├── identity.js         re-exports identityService
└── behavior.js         re-exports behaviorService
```

The implementations themselves don't move; only thin adapter modules are added. This keeps the diff tiny and lets the Instagram provider be developed against a frozen interface.

### 4.6 Instagram provider (new code)

See §5 for the full design. Layout:

```text
backend/src/providers/instagram/
├── index.js            registers SocialProvider with capabilities map (no groups/forward)
├── client.js           IgApiClient pool + state save/restore + reconnect
├── sessions.js         upload/list/login/logout/status/download
├── interactive.js      start/verify/2fa/challenge/resend/cancel
├── scrape.js           followers / following / hashtag / location
├── messaging.js        DM thread list / send / send media / reaction
├── threads.js          thread-level helpers (read, mute, archive, pin)
├── lists.js            (re-uses platform-agnostic listService through the registry)
├── reports.js          (re-uses platform-agnostic reportService)
├── otp.js              SMS/email OTP capture during login challenge
├── twoFA.js            enable/disable/change app-2FA
├── privacy.js          private/public, story controls, tag-control
├── accountSettings.js  bio, name, username, profile photo
├── proxies.js          IG-specific proxy validator (target = i.instagram.com:443)
├── identity.js         IG device fingerprint generator + state persistence
└── behavior.js         IG-specific mark-as-seen / story-view simulator
```

### 4.7 Queues (BullMQ shards)

Today: 4 queues (`scrape-jobs`, `message-jobs`, `group-jobs`, `twofa-jobs`) on a shared Redis. With two platforms and a 1000-user-per-platform target this needs to be split. The plan:

- **Per-platform queue names**: `scrape:telegram`, `scrape:instagram`, etc. Each has its own Worker with its own `concurrency` knob.
- **Shared Redis instance** is fine for headcount; isolate via key prefix (BullMQ already namespaces by queue name). Move to a 2-shard Redis Cluster only if memory or pubsub throughput becomes a bottleneck (see §7.4).
- **Dedicated worker pods** at >2k cumulative concurrent users. The codebase already supports this — `backend/src/index.js` has a clean queue-init hook (`initializeQueues()`) and `closeQueues()` for graceful shutdown.
- **Job options** stay the same: `attempts: 3`, `exponential` backoff, `removeOnComplete: { age: 3600, count: 100 }`. Tweak per-queue if Instagram jobs run longer (they do — see §5.7 rate limits).

#### Concurrency budgets (initial guess, tune later)

| Queue | Workers/pod | concurrency/worker | Total parallel jobs | Rationale |
|---|---:|---:|---:|---|
| `scrape:telegram` | 2 | 5 | 10 | Same as today. |
| `scrape:instagram` | 2 | 3 | 6 | IG hits soft limits earlier. |
| `messaging:telegram` | 2 | 5 | 10 | Existing. |
| `messaging:instagram` | 2 | 2 | 4 | Each DM is rate-limited. |
| `groups:telegram` | 2 | 3 | 6 | Existing. |
| `twofa:telegram` | 2 | 2 | 4 | Existing. |
| `twofa:instagram` | 2 | 2 | 4 | Mirror. |

`scrape:instagram` and `messaging:instagram` are the bottlenecks; we keep concurrency low and let the per-session sleep loops do the actual rate limiting.

### 4.8 Websockets

Today every authenticated socket joins `user:<userId>`. With two panels, a user keeps **one** socket but listens to **two** rooms:

```text
socket.join(`user:${userId}`);                 // platform-agnostic notifications
socket.join(`user:${userId}:telegram`);
socket.join(`user:${userId}:instagram`);
```

Server emits go to the platform-scoped room when the event is platform-specific:

```text
io.to(`user:${userId}:${platform}`).emit('scrape:progress', {...});
io.to(`user:${userId}`).emit('subscription:updated', {...});  // platform-agnostic
```

Client subscribes per-platform (`hooks/useWebSocket.js` filters by current platform; events for the other platform still arrive but are queued in a tiny in-memory buffer keyed by platform so when the user toggles they see the latest state without an extra fetch).

### 4.9 Proxies (per-platform pools)

`proxyService` already supports manual + free pools, validation against a target endpoint, and binding to sessions. Two extensions:

1. **Validation target is platform-specific**:
   - Telegram: `149.154.167.51:443` (DC4) — current behavior.
   - Instagram: `i.instagram.com:443` (HTTPS CONNECT through the proxy with TLS handshake).
   The `proxies` table gains `validated_for_telegram BOOLEAN` and `validated_for_instagram BOOLEAN` so a proxy that works for Telegram but not Instagram (or vice versa) is correctly classified.

2. **Per-platform free-proxy lists**:
   - Telegram: existing list (`TheSpeedX/PROXY-List`, `hookzof/socks5_list`, `hideip.me`).
   - Instagram: same lists are fine (proxies are platform-agnostic at the network layer), but ensure the Instagram validator runs against them so the pool tagged `validated_for_instagram=true` is non-empty.

Per-platform `assignProxyForSession(sessionId, platform)` filters to the right validator flag.

### 4.10 Anti-detect (per-platform fingerprints + behavior)

`identityService` becomes a tiny dispatcher:

```text
identityService.randomize(platform, sessionId)
  → telegramIdentity.randomize(sessionId)   { device_model, system_version, app_version, lang_code }
  → instagramIdentity.randomize(sessionId)  { android_version, device_id, phone_id, uuid,
                                              advertising_id, family_device_id, user_agent }
```

`behaviorService` likewise:

- **Telegram simulator** unchanged.
- **Instagram simulator**: a periodic batch that does `feed_timeline()`, `news_inbox()`, occasional `media_seen` for stories. Rate: 1 batch per session per ~30 minutes with full jitter.

### 4.11 Rate limiting

Today: `express-rate-limit` for HTTP endpoints, plus per-session token-bucket for messaging. Two adjustments:

1. Per-platform HTTP buckets: `RATE_LIMIT_MAX` becomes `RATE_LIMIT_TG_MAX` and `RATE_LIMIT_IG_MAX` so an Instagram burst can't starve Telegram.
2. Per-account messaging token buckets are platform-aware. Instagram's effective send rate is ~30/hour to non-mutuals, ~60/hour to mutuals — much lower than Telegram. The bucket config is read from `system_settings` so an admin can tune it without redeploy.

### 4.12 Migration runner

`database.js::migrations[]` already orders migrations and skips applied ones. New entries:

```text
{ name: 'v9_multiplatform',           file: 'migration_v9_multiplatform.sql' },
{ name: 'v9_2_instagram_extras',      file: 'migration_v9_2_instagram_extras.sql' },
{ name: 'v9_3_subscription_split',    file: 'migration_v9_3_subscription_split.sql' },
```

Each is wrapped in a single transaction. `v9_3_subscription_split` runs the data backfill in the same TX as the schema change so a partial failure rolls back.

---

## 5. Instagram-specific design

### 5.1 Library choice

Two viable paths; the plan picks (1) and keeps (2) as a fallback for a future "advanced" tier.

**(1) Primary: `instagram-private-api` (npm — `dilame/instagram-private-api`)** — Node/TypeScript. Active in 2024 (last major release v1.46.1, March 2024). Same process model as the existing backend, no IPC, no Python runtime. Capabilities cover login (with 2FA + checkpoint), DM, follow/unfollow, scrape, media, stories, real-time via FBNS. State is a single JSON object you can persist verbatim — maps cleanly onto the existing `sessions.session_file_path` blob storage. About 36k weekly downloads, 6.4k stars, MIT.

**(2) Fallback: `instagrapi` (PyPI — `subzeroid/instagrapi`)** — Python. Larger feature surface (Reels Insights, story builders with text/animations, fbsearch v2 SERPs, account discovery flows). MIT. We'd run a tiny Python sidecar exposing a gRPC or HTTP-JSON API and have the Node provider proxy to it. Only worth doing if we hit a feature gap we can't reasonably fill in Node.

Decision: ship Instagram provider on `instagram-private-api` first. Add a Python sidecar later if/when a customer-paid feature requires it.

### 5.2 Login flow (interactive create-session)

Instagram's login is materially different from Telegram's:

```
[User: username + password]
        │
        ▼
ig.account.login(username, password)
        │
        ├── success → state JSON ready, persist + DB row
        ├── 2FA challenge (TOTP / SMS / WhatsApp)
        │       → user enters 6-digit code → ig.account.twoFactorLogin(...)
        ├── checkpoint challenge (suspicious-activity)
        │       → ig.challenge.auto(true) sends OTP to email/SMS
        │       → user enters code → ig.challenge.sendSecurityCode(code)
        └── feedback_required (consent / phone / etc.) → surfaced as error to user
```

Mapped onto the existing interactive shape:

```text
POST /api/instagram/sessions/create/start
     body: { username, password, credentialId? (n/a for IG) }
     → { tempId, status: 'awaiting_password' | 'awaiting_2fa' | 'awaiting_challenge' | 'active' }

POST /api/instagram/sessions/create/verify
     body: { tempId, code }                  // 2FA code
     → { status: 'awaiting_challenge' | 'active' }

POST /api/instagram/sessions/create/challenge
     body: { tempId, code }                  // checkpoint code from email/SMS
     → { status: 'active' }

POST /api/instagram/sessions/create/resend   // resend 2FA / challenge code
POST /api/instagram/sessions/create/cancel
```

In-memory `pending` map (mirrors `sessionCreationService.pending`) keyed by `tempId`, TTL 5 min, reaper interval 60 s, identical lifecycle.

### 5.3 Session storage

`instagram-private-api` exposes `ig.state.serialize() → JSON` and `ig.state.deserialize(json)`. We persist this JSON in `sessions.session_file_path` exactly the way Telegram session strings are persisted (encrypted at rest, decrypted on download per PR #14).

JSON shape on disk:

```json
{
  "platform": "instagram",
  "version": 1,
  "state": "<full ig.state JSON>",
  "createdAt": "...",
  "originalName": "<username>.json",
  "createdVia": "panel"
}
```

Re-upload accepts either the panel format or a raw `ig.state.serialize()` blob (we sniff for `cookies` / `deviceString` keys).

### 5.4 In-process client pool

Mirror of `telegramService.clients`:

```text
instagramService.clients : Map<sessionId, {
  ig: IgApiClient,
  connected: boolean,
  username: string,
  proxy: ProxyConf | null,
  identity: InstagramIdentity,
  lastFeedRefreshAt: number,
}>
```

Heartbeat: every `INSTAGRAM_HEARTBEAT_INTERVAL_MS` (default 60 s) we run a cheap `ig.account.currentUser()` on each logged-in client. On `LoginRequiredError` we mark the session inactive and emit `session:disconnected` to the user's room.

Crash recovery: at boot, `instagramService.restoreAllLoggedInSessions()` enumerates `sessions WHERE platform='instagram' AND is_logged_in=TRUE`, deserialises state, sets `ig.state.proxyUrl` from the bound proxy, and pings `currentUser()` to validate.

### 5.5 Per-user "API credentials" — the open question

Telegram requires each user to register their own `api_id`/`api_hash`. Instagram has no such concept — every Instagram client identifies as the official Android app. Two options:

- **Option A (recommended): drop the credentials gate for Instagram.** Skip the `412 API_CREDENTIALS_REQUIRED` middleware path when `platform === 'instagram'`. The user lands directly on `/ig/dashboard` after subscribing.
- **Option B**: model "Instagram API credentials" as a per-user **device fingerprint set** that the user can manage in Settings. Useful for power users who want to attach a particular device profile to a particular subset of accounts. Not required for v1; can be added later.

We ship Option A.

### 5.6 Feature mapping — Telegram ↔ Instagram

Side-by-side, with the interface method, the underlying library call, and any caveats:

| Telegram surface | Instagram analog | provider method | `instagram-private-api` call | Caveats |
|---|---|---|---|---|
| Sessions: bulk upload | Upload `state.json` files (one account per file) | `sessions.upload` | `ig.state.deserialize` | We accept either panel format or raw state. |
| Sessions: list / status / login / logout | Same | `sessions.{list,status,login,logout}` | `ig.account.currentUser`, `ig.account.logout` | "Login" for IG = deserialize state + ping. |
| Create Session interactive | Same shape (start/verify/2fa/challenge) | `sessions.createInteractive.*` | `ig.account.login`, `twoFactorLogin`, `ig.challenge.*` | See §5.2. |
| Scrape group members | Scrape **followers / following** of a target user | `scrape.execute({ target: { type:'followers'|'following', username } })` | `ig.feed.accountFollowers(userId)` / `accountFollowing(userId)` | Pagination via `feed.items()`. Cap at IG's reachable depth (~10k visible). |
| Scrape channel subscribers | Not 1:1; closest is "users who liked recent posts" | `scrape.execute({ target: { type:'likers', mediaId } })` | `ig.media.likers(mediaId)` | Optional advanced feature. |
| Messaging: DM blast | DM blast | `messaging.sendBulk` | `ig.entity.directThread([userId]).broadcastText(text)` | Strict rate-limit: ~30/hour to non-mutuals. |
| Messaging: send to group/channel | Send to existing DM thread | `messaging.sendToGroup` | `ig.entity.directThread(threadId).broadcastText(text)` | IG group threads are DM threads with >2 participants. |
| Messaging: forward | Share post / reel into thread | `messaging.forward` | `ig.entity.directThread(threadId).broadcastPost(mediaId)` | Different primitive but fills the same UI slot. |
| Groups: create / add / remove | DM thread create / add / remove | `groups.{create,addMember,removeMember,info}` | `ig.entity.directThread(...).addUser([userId])` etc. | Up to 32 members per IG group thread. |
| Lists | Same | `lists.*` | n/a (DB only) | Just plumb `platform`. |
| Reports | Same | `reports.*` | n/a (DB only) | Plumb `platform`; add IG-specific aggregations (followers gained/lost). |
| Get OTP | Capture login OTP from email/SMS during challenge | `otp.startScan` | passive listener on the live `ig` client during challenge | Only meaningful for accounts where the user controls the email — see §5.7. |
| Change 2FA | Enable / disable / rotate TOTP secret | `twoFA.{enable,disable,change}` | `ig.account.enableTwoFactor`, `disableTwoFactor`, `rotate2FA` | Same UI flow; under the hood it's TOTP not Telegram-SRP. |
| Proxies | Same | `proxies.*` | `ig.state.proxyUrl = ...` | Per-platform validator. |
| Anti-Detect | Per-session device fingerprint | `identity.{randomize,apply}` | `ig.state.generateDevice(seed)` | Richer fingerprint set (§4.10). |
| Privacy | Account privacy + story / tag controls | `privacy.apply` | `ig.account.setPrivate`, `ig.account.setPublic`, story-privacy endpoints | UI is similar; field set differs. |
| Account Settings | Profile photo / bio / name / username | `accountSettings.*` | `ig.account.editProfile`, `ig.account.changeProfilePicture` | Same shape. |

Anything in the Telegram UI that has no Instagram analog (e.g., **Create channel/supergroup**) is not exposed in the Instagram sidebar. The capability flags map (§3.2) drives this so the frontend doesn't have to hard-code.

### 5.7 Rate limits, fingerprint, and detection posture

Instagram is materially more aggressive than Telegram about flagging suspicious activity. The plan bakes the following in from day one:

- **One device fingerprint per session, generated deterministically from a per-account seed** so a session "looks the same" across reconnects. (`ig.state.generateDevice(username)`.)
- **Sticky proxies**: `proxyService` already binds a session to a proxy; for Instagram the binding is hard — the same session never connects from two different proxies.
- **Login from country-aware proxy**: optional but recommended. Admin can configure `instagram.proxy_country_match` to require the proxy and the account's country to match (we infer country from a provided phone or the proxy's geo-IP).
- **Behavior simulator** (§4.10) runs every ~30 min per session: `feed_timeline`, `news_inbox`, occasional story view. Keeps the account "warm".
- **Per-session messaging caps** (defaults, admin-tunable):
  - First 24h after login: DM blast disabled (only manual single-target).
  - Day 2-7: 30 DMs/day, 1/min minimum spacing, 10/hour to non-mutuals.
  - Day 8+: 60 DMs/day.
  - All caps doubled for accounts older than 90 days (heuristic from `me.signup_date`).
- **Job pacing**: jobs are split into "rounds" with a configurable `delayBetweenRoundsMs` (default 60-180 s, jittered).
- **Soft-fail handling**: on `feedback_required` or `checkpoint_required`, the session is rolled to status `'challenge_pending'` and the user is notified via WS + email. The job continues with the remaining sessions.

### 5.8 Capabilities the IG provider does **not** expose

- Creating broadcast channels (Instagram has them but creation is gated by partner program).
- Live Streaming (out of scope for v1; library supports it via `LiveModule`).
- Insights (Graph API; out of scope for v1).

These come back as `provider.capabilities.<feature> = false` so the frontend hides them.

---

## 5A. Per-feature deep design (Instagram parity)

This is the section the previous draft was thin on. Each Telegram surface in the existing panel is reproduced here with a full backend + frontend design for Instagram, including the underlying `instagram-private-api` calls, the data shape, the REST endpoints, the rate-limit posture, and the edge-case handling. The Telegram column at the start of each subsection is a recap of what the panel does today (so this document is self-contained).

A consistent template is used per feature:

- **Today on Telegram**: which file/service implements it, what the user can do.
- **Instagram analog**: what the user can do on the IG panel.
- **Library calls**: exact `instagram-private-api` calls behind each operation. Where multiple calls participate in one user action, listed in order.
- **Data model**: which Postgres tables/columns are touched (in addition to the `platform` column added by §4.1.1).
- **REST surface**: every new endpoint under `/api/instagram/*`.
- **Provider service shape**: methods exposed by `providers/instagram/<feature>.js`.
- **Frontend page shape**: what the page looks like, what it shows, what it lets the user do, where it differs from the Telegram page.
- **Rate-limit posture**: per-account daily/hourly caps, jitter, warm-up curve, automatic back-off.
- **Edge cases**: enumerated failure modes (`feedback_required`, `checkpoint_required`, `IgLoginRequiredError`, `IgPrivateAccountError`, `IgUserHasLoggedOutError`, etc.) and how the provider responds.
- **WS events**: which Socket.IO events are emitted, their payload shape.

A small number of capabilities (e.g., creating broadcast channels, Reels Insights, Live Streaming) are explicitly out of scope for v1; they are listed in §5.8 and surfaced via `provider.capabilities.<feature> = false`.

---

### 5A.1 Sessions (bulk lifecycle)

**Today on Telegram.** `backend/src/services/sessionService.js` (2,276 LOC) handles bulk upload of `.json`/`.session`/`.bin` session files, lists owned sessions, drives `login`/`logout`/`status`, downloads (plaintext, per PR #14), deletes, and runs the boot-time `restoreAllLoggedInSessions()` and the per-minute `heartbeatLoggedInSessions()` keep-alive loop. The on-disk format is `{ session: <encrypted gramjs string>, createdAt, originalName }`. Session strings are bound to `user_api_credentials.id` and to a proxy from the pool.

**Instagram analog.** Same UX. The user can:

- Bulk-upload one or more `.json` files. Each is one Instagram account's serialized state.
- See a sortable, filterable table of owned IG sessions with status (`uploaded`, `active`, `challenge_pending`, `logged_out`, `error`), username, full name, follower count, last-active, bound proxy, identity hash.
- Per-row actions: **Login** (deserialize + ping), **Logout**, **Status** (live re-check), **Download** (plaintext `state.json`), **Delete** (DELETE row + on-disk file + scraped/messaging history if `cascade=true`).
- Bulk actions: bulk login, bulk logout, bulk delete, bulk reassign to a different proxy, bulk randomize identity.

**Library calls.**

```
upload          fs.readFile + ig.state.deserialize(state) (validation only — we don't connect)
login           ig.state.deserialize(state) → ig.account.currentUser()
                  on LoginRequiredError → status='logged_out'
                  on IgCheckpointError  → status='challenge_pending', emit ws event
logout          ig.account.logout()  (ignore network errors; just mark row)
status          ig.account.currentUser()  →  { username, fullName, followers, following,
                                                isPrivate, isVerified, mediaCount }
download        decrypt on the fly + serialize to user as `<username>.json`
heartbeat       same as status, every INSTAGRAM_HEARTBEAT_INTERVAL_MS, with jitter ±20%
restoreAll      enumerate sessions WHERE platform='instagram' AND is_logged_in=TRUE,
                deserialize, ig.state.proxyUrl = <bound proxy>, ping, mark connected
```

**Data model.**

```
sessions
  + platform                   = 'instagram'
  + session_file_path          → encrypted IG state JSON
  + account_info::jsonb        { username, fullName, isPrivate, isVerified,
                                 followerCount, followingCount, mediaCount, signupDateMs }
  + device_identity::jsonb     { android_version, device_id, phone_id, uuid,
                                 advertising_id, family_device_id, user_agent }
  + bound_proxy_id             → proxies.id (validated_for_instagram=true)
  + status                     'uploaded' | 'active' | 'challenge_pending'
                               | 'logged_out' | 'error'
  + is_logged_in               BOOLEAN
  + last_active                TIMESTAMP
```

**REST surface.**

```
POST   /api/instagram/sessions/upload         multipart, accepts state.json
GET    /api/instagram/sessions                ?status=&search=&page=&limit=&sort=
GET    /api/instagram/sessions/:id            details + capabilities-derived flags
GET    /api/instagram/sessions/:id/status     live re-check
POST   /api/instagram/sessions/:id/login      attempt connect
POST   /api/instagram/sessions/:id/logout
GET    /api/instagram/sessions/:id/download   plaintext state.json (per PR #14 contract)
DELETE /api/instagram/sessions/:id?cascade=true
POST   /api/instagram/sessions/bulk/login     body: { sessionIds }
POST   /api/instagram/sessions/bulk/logout
POST   /api/instagram/sessions/bulk/delete
POST   /api/instagram/sessions/bulk/reassign-proxy
POST   /api/instagram/sessions/bulk/randomize-identity
```

**Provider service shape.**

```
providers/instagram/sessions.js
  upload(files, userId, opts) → { results: [{ originalName, sessionId, status, error? }] }
  list(userId, query)         → { rows, total }
  byId(sessionId, userId)     → row | null
  status(sessionId, userId)   → snapshot
  login(sessionId, userId)    → snapshot
  logout(sessionId, userId)   → snapshot
  download(sessionId, userId) → { buffer, filename, mime: 'application/json' }
  remove(sessionId, userId, { cascade }) → { ok, removed }
  bulk*(...)
  restoreAllLoggedInSessions()
  heartbeatLoggedInSessions()
```

**Frontend page shape.** `pages/Sessions.jsx` is reused. The column set switches per platform: TG renders **Phone**; IG renders **Username + Full name**. The status pill colors map to the same semantics. The "Download" button posts to the platform-prefixed URL and saves the returned blob with the filename hint from the `Content-Disposition` header (the server already sets it for TG; we mirror for IG). The bulk-action toolbar is platform-agnostic.

**Rate-limit posture.** `login` is throttled to 1 request per 30 s per session to avoid waking up Instagram's anti-bot heuristics; the heartbeat loop adds 20% jitter. Bulk operations are sequenced (not parallel) at most 5 concurrent across the user's whole inventory.

**Edge cases.**

- `IgLoginRequiredError` → row goes to `logged_out`, the bound `ig` client is removed from the in-process pool, WS `session:logged_out` emitted.
- `IgCheckpointError` → row goes to `challenge_pending`. The user must re-run the create-session interactive flow with a `resumeFromSessionId` parameter (see §5A.2) to resolve the checkpoint.
- `IgUserHasLoggedOutError` → same as `IgLoginRequiredError`.
- Network/proxy failure → status stays `active` for up to 3 consecutive failures, then flips to `error` with the last error message exposed in the row.
- File upload format unknown → 400 with `{ code: 'UNKNOWN_SESSION_FORMAT' }`. Front-end shows which file failed.

**WS events.**

```
session:status            { sessionId, status, accountInfo }
session:logged_out        { sessionId, reason }
session:challenge         { sessionId, challengeType: 'email'|'sms'|'totp' }
session:identity_changed  { sessionId, deviceIdentity }
```

---

### 5A.2 Create Session (interactive)

**Today on Telegram.** `backend/src/services/sessionCreationService.js` runs an in-memory `pending` map keyed by `tempId` (16 hex bytes). `start({ phone, apiId?, apiHash? })` opens a fresh `TelegramClient`, calls `auth.SendCode`, stores `{ client, phoneCodeHash, phone, apiId, apiHash, userId, createdAt, awaitingPassword }`. `verify({ tempId, code })` runs `auth.SignIn`; on `SESSION_PASSWORD_NEEDED` it flips `awaitingPassword=true` and returns `{ status: 'awaiting_password' }`. `password({ tempId, password })` runs the SRP flow. `resend` calls `auth.ResendCode`. `cancel` tears down. A 60-second reaper deletes entries older than `CREATION_TTL_MS` (5 min default). Successful sessions are persisted via `sessionService.saveSession(...)` and the live `TelegramClient` is adopted into the live pool (`telegramService.adoptClient`). Strict proxy isolation is supported via `STRICT_PROXY_ISOLATION=true`.

**Instagram analog.** Same `tempId`+`pending`+reaper machinery; the **state machine has more states** because Instagram has both 2FA and checkpoint flows that can fire independently:

```
 ┌──────────┐  username+password    ┌─────────────────────┐
 │  start   │ ────────────────────▶ │  awaiting_2fa       │ if two_factor_required
 └──────────┘                        └────────┬────────────┘
      │                                       │ totp/sms/whatsapp code
      │                                       ▼
      │                              ┌─────────────────────┐
      │                              │ awaiting_challenge  │ if checkpoint_required
      │                              └────────┬────────────┘
      │                                       │ email/sms code
      │                                       ▼
      │                              ┌─────────────────────┐
      └────────────────────────────▶ │       active        │
                                     └─────────────────────┘
```

A second entry-point is `resumeFromSessionId` for sessions that flipped to `challenge_pending` after a successful login — the user can re-open the same flow, type the new email/SMS code, and the session is re-armed.

**Library calls.**

```
start          ig = new IgApiClient()
               ig.state.generateDevice(username)            // deterministic per username
               ig.state.proxyUrl = <selected proxy URL>     // bound to the future session
               try {
                 await ig.account.login(username, password)
                 → success → persist, adopt
               } catch (err) {
                 if err is IgLoginTwoFactorRequiredError → store ig.state, ask for code, status='awaiting_2fa'
                 if err is IgCheckpointError            → ig.challenge.auto(true), status='awaiting_challenge'
                 if err is IgChallengeWrongCodeError    → tell user "wrong code, retry"
                 if err is IgLoginBadPasswordError      → 401, do NOT keep state
                 if err is IgLoginInvalidUserError      → 404, do NOT keep state
                 else                                    → 500, drop state
               }

verify         await ig.account.twoFactorLogin({
                 username, verificationCode, twoFactorIdentifier,
                 verificationMethod: '0'|'1'|'2'|'3'    // totp / sms / backup / WA
               })
               on success → if subsequent IgCheckpointError → status='awaiting_challenge'
               on failure → IgLoginTwoFactorRequiredError loop: increment attempts (max 5)

challenge      await ig.challenge.sendSecurityCode(code)
               on success → run ig.account.currentUser() to settle, persist
               on IgChallengeWrongCodeError → keep entry, ask user to re-enter

resend         for 2FA code: ig.account.sendTwoFactorLoginSMS(...)
               for challenge code: ig.challenge.selectVerifyMethod(0|1)  // email|sms

cancel         drop the entry, release the ad-hoc proxy reservation
```

**Data model.** No new tables. The persisted row goes into `sessions` exactly like an uploaded session. The `device_identity::jsonb` stores the deterministic device generated from the username so re-logins on different days produce the same fingerprint.

**REST surface.**

```
POST /api/instagram/sessions/create/start
     body: { username, password, proxyHint? }
     → { tempId, status, attemptsRemaining? }

POST /api/instagram/sessions/create/verify
     body: { tempId, code, method: 'totp'|'sms'|'backup'|'whatsapp' }
     → { status, attemptsRemaining? }

POST /api/instagram/sessions/create/challenge
     body: { tempId, code }
     → { status }

POST /api/instagram/sessions/create/resend
     body: { tempId, kind: '2fa'|'challenge', method: 'email'|'sms' }
     → { ok, nextAvailableAt }

POST /api/instagram/sessions/create/cancel
     body: { tempId }

POST /api/instagram/sessions/create/resume
     body: { sessionId }   // for sessions stuck in 'challenge_pending'
     → { tempId, status: 'awaiting_challenge' }
```

**Provider service shape.**

```
providers/instagram/interactive.js
  pending: Map<tempId, IgPendingEntry>
  start({ userId, username, password, proxyHint? })       → { tempId, status }
  verify({ userId, tempId, code, method })                → { status }
  challenge({ userId, tempId, code })                     → { status }
  resend({ userId, tempId, kind, method })                → { ok, nextAvailableAt }
  cancel({ userId, tempId })                              → { ok }
  resume({ userId, sessionId })                           → { tempId, status }
  _reapStale()                                            // 60s interval, drops > CREATION_TTL_MS
```

**Frontend page shape.** `pages/CreateSession.jsx` becomes a **stepped wizard**:

```
[Step 1] Username + Password   → POST /create/start
[Step 2] (if awaiting_2fa)     → 6-digit code field + method dropdown (TOTP/SMS/WhatsApp/Backup)
                                  + Resend (cooldown timer) + Switch method link
[Step 3] (if awaiting_challenge) → 6-digit code field + Email/SMS picker + Resend
[Step 4] active                → success card with the new session row + link to /ig/sessions
```

A persistent banner shows attempts remaining (`5 / 5 → 4 / 5 → ...`) so users don't get locked out silently. A "Cancel" button is always visible and posts to `/cancel`. The wizard state lives in URL query params (`?temp=<tempId>&step=verify`) so a refresh resumes correctly.

**Rate-limit posture.**

- `start`: 5 per user per hour. Sixth call returns `429 LOGIN_RATE_LIMIT` with the next-available timestamp.
- `verify`: 5 attempts per `tempId`. Then 15-minute cooldown.
- `challenge`: 5 attempts per `tempId`. Then 15-minute cooldown.
- `resend` 2FA SMS: 1 per 60 s per `tempId`.
- `resend` challenge: 1 per 60 s per `tempId` per method.

**Edge cases.**

- `IgLoginBadPasswordError` and `IgLoginInvalidUserError` both wipe the entry immediately and return a generic `INVALID_CREDENTIALS` (we do **not** distinguish between "wrong password" and "user doesn't exist" to avoid being a username enumeration oracle).
- `feedback_required` (Instagram saying "we don't trust this device, try again later") returns `429 FEEDBACK_REQUIRED` and the entry is dropped. The frontend tells the user to wait ≥1 hour and try a different proxy.
- `consent_required` (account needs to accept new terms) cannot be solved from an automated flow; the user is told to open the official app once.
- `IgPasswordResetRequiredError` (Instagram forces a password reset) → `409 PASSWORD_RESET_REQUIRED`.
- App version drift (Instagram rejects an old `App-Version` header): we pin the IG mobile version to the value `instagram-private-api` ships and bump it during dependency upgrades.

**WS events.**

```
session:created           { sessionId, username, status }
session:create:state      { tempId, status, attemptsRemaining }
session:create:challenge  { tempId, method }   // emitted when start/verify flips to challenge
```

---

### 5A.3 Scrape

**Today on Telegram.** `scrapeService.js` (931 LOC) plus `scrapeMonitorService.js` (618 LOC) plus `scrape:jobs` BullMQ queue. The user picks one or more sessions, one or more targets (group/channel link or `@username` or numeric ID), a target type (`group_members` or `channel_subscribers`), a `limit`, and options (`filterBots`, `floodProtection`, `saveToList`, etc.). The job is queued; a worker pulls it, normalizes targets via `_resolveEntity`, and runs `_scrapeTarget(sessionId, targetId, targetType, options, jobId)` which paginates members (`channels.GetParticipants` with offsets of 200) and inserts unique `(jobId, telegram_id)` rows into `scraped_users`. Progress is held in Redis (`scrape:progress:<jobId>`) and broadcast over WS. `scrapeMonitorService` provides a **period-bounded passive monitor** for groups whose member list is hidden — it attaches a `NewMessage` handler and harvests author IDs for `durationMs` (default ≤ 24h).

**Instagram analog.** A close mapping with two structural differences:

1. There are **no broadcast channels with member lists** on IG. The closest things are: followers/following of a user, likers of a post, commenters of a post, viewers of a story, hashtag posts, location posts.
2. The "passive monitor" idea translates to **story-view monitor** (capture viewers of a story owned by one of the user's sessions over a period) and **DM-inbox monitor** (capture incoming DMs containing IDs).

**Target types** the user can choose:

```
followers           target = username           // public account → always works
                                                 // private + not following → ERR_PRIVATE_TARGET
following           target = username           // same constraints
likers              target = post URL/shortcode // likers of a media item
commenters          target = post URL/shortcode // commenters of a media item
hashtag_top         target = #hashtag           // top posts under a hashtag → authors
hashtag_recent      target = #hashtag           // recent posts under a hashtag → authors
location            target = location URL/id    // posts at a place → authors
story_viewers       target = sessionId+storyId  // viewers of OWN session's story
search              target = query              // user search results
```

**Library calls.**

```
followers            ig.feed.accountFollowers(userId).items()    // paginated cursor
following            ig.feed.accountFollowing(userId).items()
likers               ig.media.likers(mediaId)                    // returns up to 1000
commenters           ig.feed.mediaComments(mediaId).items()      // paginated
hashtag_top          ig.feed.tags(tag, 'top').items() → for each post: poster
hashtag_recent       ig.feed.tags(tag, 'recent').items() → for each post: poster
location             ig.feed.location(locationId, 'top'|'recent').items() → poster
story_viewers        ig.feed.reelsMedia({ userIds: [sessionUserId] }) → media[].viewers (paginated via ig.feed.reelsViewers(mediaId))
search               ig.search.users(query)                      // returns ~50 users
```

Each pagination loop respects `_isCancelled(jobId)` and obeys the same `MAX_TARGETS_PER_JOB` / `MAX_SESSIONS_PER_JOB` caps the TG service uses. Per-page sleeps are jittered between `INSTAGRAM_SCRAPE_DELAY_MIN_MS` (default 2,000) and `INSTAGRAM_SCRAPE_DELAY_MAX_MS` (default 5,000). Worker concurrency is 3 per pod (vs 5 for TG).

**Data model.** Re-uses `scraping_jobs` and `scraped_users` (already JSONB-friendly). We add a `platform` column to both (per §4.1.1) and standardize `target_type` values: `followers`, `following`, `likers`, `commenters`, `hashtag_top`, `hashtag_recent`, `location`, `story_viewers`, `search`. `scraped_users` stores `instagram_id BIGINT` (re-uses `telegram_id` column — the column gets renamed to `external_id` in `v9_2_instagram_extras`) plus `username`, `full_name`, `is_private`, `is_verified` in JSONB columns we already have.

**REST surface.**

```
POST   /api/instagram/scrape/jobs
       body: { sessionIds, targets, targetType, limit, options }
       → { jobId, status: 'pending' }

GET    /api/instagram/scrape/jobs                ?page=&limit=&filter=
GET    /api/instagram/scrape/jobs/:id
GET    /api/instagram/scrape/jobs/:id/progress   live (also pushed via WS)
POST   /api/instagram/scrape/jobs/:id/cancel
POST   /api/instagram/scrape/jobs/:id/save-to-list   body: { listName }
GET    /api/instagram/scrape/jobs/:id/export?format=csv|xlsx

POST   /api/instagram/scrape/monitor              // story-view monitor
       body: { sessionId, storyId, durationMinutes }
       → { jobId }
GET    /api/instagram/scrape/monitor/:id
POST   /api/instagram/scrape/monitor/:id/pause
POST   /api/instagram/scrape/monitor/:id/resume
POST   /api/instagram/scrape/monitor/:id/cancel
```

**Provider service shape.**

```
providers/instagram/scrape.js
  createJob({ sessionIds, targets, targetType, limit, options, userId }) → { jobId }
  startJob(jobId, async=true)
  cancel(jobId, userId)
  byId(jobId, userId)
  list(userId, query)
  saveToList(jobId, listName, userId)
  exportCsv(jobId, userId), exportXlsx(jobId, userId)
  getStats(userId)

providers/instagram/scrapeMonitor.js
  startStoryMonitor({ sessionId, storyId, durationMs, userId }) → { jobId }
  resumeActiveJobs()    // boot-time hydrate
  pause(jobId), resume(jobId), cancel(jobId)
```

**Frontend page shape.** `pages/Scrape.jsx` already supports multiple targets, multiple sessions, a target-type radio, and a results table. For IG we change:

- **Target picker**: a dropdown for target type, then a smart text input that accepts `@username`, full URL, hashtag (`#xyz`), or location URL.
- **Per-target preview** (optional, behind a "Preview" button): we call `ig.user.searchExact(username)` or `ig.media.info(shortcode)` to confirm the target exists, the account is public/reachable, and surface the size estimate.
- **Options panel** gains IG-specific toggles: `Skip private accounts`, `Skip business accounts`, `Skip accounts with no profile picture` (cheap heuristic), `Stop on flood-wait`.
- **Story-view monitor** is its own tab inside the Scrape page (mirroring the TG passive-monitor tab today).

**Rate-limit posture.** Followers/following pagination is the hottest path. We pin to:

- 1 page (≤ 200 items) every 2-5 s with jitter.
- Hard cap of 10,000 items per scrape per session per day.
- After 3 `feedback_required` errors on the same session within 10 minutes, the session is **paused** for the remainder of the job (a different session takes over) and a WS `session:cooling_down` is emitted.
- After 5 paused sessions in a job, the whole job is rolled to `failed` with `reason='ig_rate_limited'`.

**Edge cases.**

- Private account, not following: returns `IgPrivateAccountError` immediately. The frontend tells the user "Private account, no followers visible — only do this from a session that follows the target".
- `IgUserNotFoundError`: target row is marked failed; job continues.
- `IgChallengeRequiredError` mid-scrape: session is rolled to `challenge_pending` (resolution flow §5A.2) and the job continues with the remaining sessions.
- `IgFollowersFollowingTooFastError`: we increase the per-page sleep by 1.5× and continue. After 3 occurrences in a row, pause the session for the day.
- Hashtag rate limit: cap at 33 pages per session per hour (≈ 1500 posts).

**WS events.**

```
scrape:progress           { jobId, sessionId, found, total, percent }
scrape:target:done        { jobId, sessionId, targetId, count }
scrape:completed          { jobId, summary }
scrape:failed             { jobId, reason }
scrape:session:cooling    { jobId, sessionId, retryAt }
monitor:tick              { monitorJobId, found, latestViewer }
```

---

### 5A.4 Messaging (with all the options)

**Today on Telegram.** `messageService.js` (2,288 LOC) is the biggest service file. It exposes **single send**, **bulk DM blast**, **bulk-to-groups blast**, **bulk-to-users blast**, **forward**, **preview**, **history**, **stats**. Key features:

- Smart distribution across N sessions (`distributeTargets` round-robin with options `messagesPerSession`, `delayMin`, `delayMax`, `retryFailed`).
- Per-session token-bucket rate limiter (`rateLimiter(sessionId, delayMin, delayMax)`).
- Real-time progress in Redis (`message:progress:<jobId>`) + WS broadcast.
- Per-message logging in `message_logs` (200-row batched insert).
- Cancel mid-flight via `cancelJob`.
- Schedule (sends `scheduleDate` to GramJS).
- Spintax / template variables / media attachments / forward instead of compose.

**Instagram analog — same UX surface, larger options panel.** The send primitives differ but the orchestration layer (distribution, rate-limiting, retry, logging, progress, cancel) is reused verbatim.

#### 5A.4.1 Send primitives

```
text                       ig.entity.directThread([userId|threadId]).broadcastText(text)
photo                      .broadcastPhoto({ file, allowFullAspectRatio: true })
video                      .broadcastVideo({ video, coverImage })
voice                      .broadcastVoice({ file, duration })
post / reel share          .broadcastPost(mediaId)
profile share              .broadcastProfile(userId)
story share                .broadcastStorySticker(...)
link preview               .broadcastLink(text, urls)
reaction                   .broadcastReaction({ itemId, emoji })
typing indicator           .updateTyping(true) / wait / .updateTyping(false)
mark seen                  ig.directThread.markItemSeen(threadId, itemId)
```

The provider exposes these as a unified `messaging.send({ kind, ... })`:

```
providers/instagram/messaging.js
  send({ session, target, kind, payload, options }) → { itemId, sentAt }
    kind: 'text' | 'photo' | 'video' | 'voice' | 'post_share' | 'profile_share'
        | 'story_share' | 'link' | 'reaction'
    target: { type: 'user', userId } | { type: 'thread', threadId }
    payload: kind-specific blob (text, mediaPath, mediaId, urls, emoji)
    options: { simulateTypingMs?, markSeenBeforeMs?, parseLinksAsPreviews? }
```

#### 5A.4.2 Bulk DM blast

The user picks:

- **Sessions** (one or many).
- **Target list** — explicit `[username|userId]`, an existing scraped list, a CSV upload, or "all my followers".
- **Message** — text + optional media. Spintax (`{hi|hey|hello}`) and template vars (`{{first_name}}`, `{{username}}`, `{{custom1}}`) are supported and resolved per target.
- **Pacing** — `delayMin` / `delayMax` (default 30-90s for IG vs 1-3s for TG), `messagesPerSession` cap, `roundsPerDay` cap.
- **Targeting filters** — `mutuals only`, `non-mutuals only`, `verified only`, `≥ N followers`, `≤ M following`, `accounts ≥ X days old`.
- **Pre-message warm-up** — optional `markSeenBeforeMs`, optional `simulateTypingMs` (1.5-3.5s typing indicator before sending so the message looks human).
- **Schedule** — start now, or queue for a specific UTC datetime.
- **Retry policy** — `retryFailed` (0-3) with exponential backoff per target.
- **Stop conditions** — auto-stop a session on N consecutive `feedback_required`, auto-stop the whole job after K paused sessions.

**Library calls.** Each target → for each session it's been routed to:

```
1. (optional) ig.entity.directThread([userId]).updateTyping(true)
2. (optional) wait simulateTypingMs (jittered)
3. ig.entity.directThread([userId]).broadcastText(text) | broadcastPhoto({ file }) | ...
4. await rateLimiter(sessionId, delayMin, delayMax)
5. log to message_logs (batched)
```

#### 5A.4.3 Bulk-to-existing-thread blast

Same as bulk DM blast but `target.type='thread'` and the list is `threadId[]`. Useful for sending the same message into 50 group threads the account is already in. Library: `ig.entity.directThread(threadId).broadcastText(...)`.

#### 5A.4.4 Forward / share

Instagram doesn't have message forwarding the way Telegram does. The closest primitives are:

- `broadcastPost(mediaId)` — share a public post into a thread.
- `broadcastProfile(userId)` — share a profile into a thread.
- `directThread.shareItem(threadIdSource, itemId, threadIdDest)` — re-share a DM media item to another thread.

These map to the same "Forward" UI button.

#### 5A.4.5 Per-account warm-up curve

Hard-baked defaults the operator can tune in `system_settings`:

| Account age | Daily DMs to non-mutuals | Daily DMs to mutuals | Min spacing |
|---|---:|---:|---:|
| < 24h | 0 (manual single-target only) | 5 | 5 min |
| 1-7 days | 10 | 30 | 90 s |
| 8-30 days | 20 | 60 | 60 s |
| 31-90 days | 30 | 90 | 45 s |
| > 90 days | 50 | 150 | 30 s |

These caps are computed per session at job start; if the cap is hit mid-job the session is paused for that day and other sessions absorb the remaining targets. The user is told via WS + a banner.

**Data model.** Re-uses `messaging_jobs` and `message_logs`. New JSONB fields under `messaging_jobs.options`:

```
{
  kind: 'text' | 'photo' | ...,
  spintax: true,
  templateVars: ['first_name', 'username', 'custom1'],
  filters: { mutualsOnly, verifiedOnly, minFollowers, maxFollowing, minAgeDays },
  warmup: { simulateTypingMs: [1500, 3500], markSeenBeforeMs: [500, 1500] },
  schedule: { startAt, roundsPerDay },
  stopOnFeedbackRequired: 3,
  stopJobAfterPausedSessions: 5
}
```

**REST surface.**

```
POST   /api/instagram/messages/single            single send (the primitive)
POST   /api/instagram/messages/bulk              create + start bulk DM blast
POST   /api/instagram/messages/bulk-threads      create + start bulk-thread blast
POST   /api/instagram/messages/forward           share a media/profile into one or more threads
POST   /api/instagram/messages/preview           render template + spintax for one target
GET    /api/instagram/messages/jobs              list with filters
GET    /api/instagram/messages/jobs/:id          details
GET    /api/instagram/messages/jobs/:id/progress live
POST   /api/instagram/messages/jobs/:id/cancel
GET    /api/instagram/messages/history           ?status=&sessionId=&dateFrom=&dateTo=
GET    /api/instagram/messages/history/export?format=csv|xlsx
GET    /api/instagram/messages/stats             aggregates per-session per-day
```

**Provider service shape.**

```
providers/instagram/messaging.js
  send(...)
  sendBulk(params, userId)
  sendBulkToThreads(params, userId)
  forward(params, userId)
  preview(...)
  cancelJob(...)
  history(...), exportHistory(...), stats(...)
```

**Frontend page shape.** `pages/Messaging.jsx` is restructured into 3 tabs:

- **Compose** — message editor (text + media + spintax + template vars), live preview, target picker (list import + filters), session picker, options panel (pacing, warm-up, schedule).
- **Jobs** — table of jobs with status, progress bar, owning session(s), counts (sent/failed/skipped), cancel button.
- **History** — searchable per-target log; CSV/XLSX export.

The compose tab surfaces the **per-session daily cap** as a live banner: `"Today: 12 / 30 DMs used on @account_a · 24 / 30 on @account_b"`. The user cannot start a job that would exceed any participating session's cap.

**Rate-limit posture.**

- Per-session token bucket (Redis): tokens regenerate at `1 / spacingSeconds`.
- Global per-user cap (across all sessions): default 1,000 sent DMs / day. Tunable.
- Global IP cap (across all users on the same proxy): handled by the proxy assignment logic (proxies are sticky per session, so this is implicit).

**Edge cases.**

- `IgActionSpamError` ("we've blocked you from doing this for now"): session paused 24h.
- `IgPrivateUserError`: target marked skipped, job continues.
- `IgUserNotFoundError`: same.
- `IgInvalidParamsError` (often happens with malformed media): target marked failed; job continues.
- `IgCheckpointError` mid-job: session goes to `challenge_pending`, removed from rotation.

**WS events.**

```
message:progress              { jobId, sentCount, failedCount, skippedCount, percent }
message:sent                  { jobId, sessionId, target, itemId }
message:failed                { jobId, sessionId, target, reason }
message:job:done              { jobId, summary }
message:session:cooling       { jobId, sessionId, retryAt }
message:cap:hit               { sessionId, dailyCap, sentToday }
```

---

### 5A.5 Privacy

**Today on Telegram.** `privacyService.js` wraps `account.SetPrivacy` and exposes 11 privacy keys (`phone_number`, `added_by_phone`, `last_seen`, `profile_photo`, `bio`, `gifts`, `birthday`, `forwards`, `calls`, `messages`, `invites`) with 4 rule values (`everybody`, `nobody`, `contacts`, `premium`). Bulk apply across owned sessions with bounded-concurrency batches and jittered cooldown is in `privacyJobWorker.js`. The `privacy_jobs` queue in Postgres holds per-job state.

**Instagram analog.** Different field set, same shape (admin-tunable enum-of-keys × enum-of-rules). The 12 privacy controls Instagram exposes through the private API:

```
account_visibility           private | public                       (ig.account.setPrivate / setPublic)
allow_story_resharing        true | false                            (ig.story.setStorySharingEnabled)
hide_story_from              userIds[] (block-from-story list)       (ig.feed.story-share-controls)
close_friends                userIds[] (whitelist)                   (ig.feed.closeFriends)
allow_tagging                everyone | people_i_follow | nobody     (ig.account.setReelsTaggingPermission, similar for posts)
allow_remix                  everyone | people_i_follow | nobody     (ig.media.setRemixPermissions)
allow_message_from           everyone | people_i_follow | nobody     (ig.direct.allowMessages...)
allow_message_request_from   everyone | following | nobody           (separate setting on IG)
hide_active_status           true | false                            (ig.account.setActivityStatus)
mention_settings             everyone | people_i_follow | nobody     (ig.account.setMentionSettings)
comment_filter_keywords      string[]                                (ig.account.setCommentFilterKeywords)
restricted_users             userIds[]                               (ig.account.setRestrictedUsers — replaces)
```

The provider declares this as a frozen list and validates before issuing the call:

```
providers/instagram/privacy.js
  PRIVACY_KEYS = [12 strings above]
  PRIVACY_RULES per key (different enum per key)
  buildPayload(key, value) → IG-specific payload
  applyToSession(sessionId, settings)  → per-key result map
```

**Bulk apply.** Re-uses the same orchestrator shape as the Telegram `privacyJobWorker`:

```
privacy_jobs (table)
  id, user_id, platform='instagram', session_ids JSONB, settings JSONB,
  status, total, applied, failed, started_at, completed_at, error JSONB
```

A worker drains the queue, applies each `(session_id, key, value)` triple with jittered spacing (default 8-15 s between operations on the same session), retries once on `feedback_required`, and logs per-key results.

**REST surface.**

```
GET    /api/instagram/privacy/keys                   list of supported (key, allowedRules)
GET    /api/instagram/privacy/sessions/:id           current settings on a session
POST   /api/instagram/privacy/jobs                   body: { sessionIds, settings }
GET    /api/instagram/privacy/jobs                   list user's privacy jobs
GET    /api/instagram/privacy/jobs/:id               details
POST   /api/instagram/privacy/jobs/:id/cancel
```

**Frontend page shape.** `pages/Privacy.jsx` switches its key set per platform. The UI is a card per key with a value picker (radio for enums, multi-select for user lists, text-list for keywords). Two modes: **Apply to one session** (instant) and **Bulk apply to N sessions** (creates a job, progress in WS).

**Rate-limit posture.** Privacy ops are cheap from Instagram's perspective but visible to anti-bot signals if many fire in a short window. We hard-cap at 30 ops per session per hour and pace bulk operations accordingly.

**Edge cases.**

- Some keys (close friends, restricted users) take user IDs that must be resolved from usernames first via `ig.user.searchExact(username)`. The provider does the resolution and skips unknowns with a warning.
- A session that was paused for `feedback_required` skips privacy ops with `status='deferred'` until it recovers.

**WS events.**

```
privacy:job:progress  { jobId, applied, failed, percent }
privacy:job:done      { jobId, summary }
```

---

### 5A.6 Groups (Telegram) and DM Threads (Instagram)

**Today on Telegram.** `groupService.js` (957 LOC) exposes `addMembersToGroups`, `removeMember`, `createGroup`, `listGroups`, `getGroupInfo`, `configureGroupSpam`, `autoManageGroup`, plus a per-job audit in `group_operations`. Bulk add-members supports add-mode (invite/inviteByPhone) options, retry policy, jittered pacing, per-session cap. Powered by `groupQueue`.

**Instagram analog — DM threads.** Instagram has no public groups or channels; the closest peer concept is **DM threads with up to 32 participants**. Operations the IG panel exposes:

```
list                       ig.feed.directInbox().items()           pagination via cursor
get(threadId)              ig.feed.directThread(threadId).items()
create(userIds, name?)     ig.entity.directThread(userIds)         (auto-named if name omitted)
addMembers(threadId, ids)  ig.entity.directThread(threadId).addUser(ids)   (max 32 total)
removeMember(threadId,id)  ig.entity.directThread(threadId).removeUser(id) (only if you're admin)
rename(threadId, name)     ig.entity.directThread(threadId).updateTitle(name)
mute(threadId)             ig.entity.directThread(threadId).muteThread(...)
archive(threadId)          ig.entity.directThread(threadId).hide()
pin(threadId)              ig.entity.directThread(threadId).pinThread(...)
markSeen(threadId, itemId) ig.directThread.markItemSeen(threadId, itemId)
leave(threadId)            ig.entity.directThread(threadId).leave()
sendApprovalsForRequests() ig.feed.directPending().approveAll()
```

**Sidebar.** Instagram sidebar shows **DM Threads** instead of **Groups** (capability flag `groupAddRemove=false`, `threads=true`).

**Provider service shape.**

```
providers/instagram/threads.js
  list(sessionId, userId, query)
  get(sessionId, threadId, userId)
  create(sessionId, { userIds, name }, userId)
  addMembers(sessionId, threadId, userIds, userId)        → bulk-able (job)
  removeMember(sessionId, threadId, userIdTarget, userId)
  rename(sessionId, threadId, name, userId)
  mute(sessionId, threadId, userId)
  archive(sessionId, threadId, userId)
  pin(sessionId, threadId, userId)
  markSeen(sessionId, threadId, itemId, userId)
  leave(sessionId, threadId, userId)
  approvePending(sessionId, userId)
```

**REST surface.**

```
GET    /api/instagram/threads
GET    /api/instagram/threads/:id
POST   /api/instagram/threads                       create thread
POST   /api/instagram/threads/:id/add               body: { userIds }
POST   /api/instagram/threads/:id/remove            body: { userId }
PATCH  /api/instagram/threads/:id                   { name?, mute?, archive?, pin? }
POST   /api/instagram/threads/:id/seen              { itemId }
POST   /api/instagram/threads/:id/leave
POST   /api/instagram/threads/pending/approve-all
POST   /api/instagram/threads/operations            bulk add: body { sessionIds, threadIds, userIds, options }
GET    /api/instagram/threads/operations            list
GET    /api/instagram/threads/operations/:id        details
POST   /api/instagram/threads/operations/:id/cancel
```

**Frontend page shape.** A new `pages/Threads.jsx` page mirrors the structure of `pages/Groups.jsx`:

- Top toolbar: session picker + "New thread" button + bulk-action dropdown.
- Left list: paginated DM threads for the chosen session, with badges (unread, group, pinned, archived, request).
- Right pane: thread details + member list + actions (rename, mute, leave, ...).
- Tabs: **Threads** | **Operations** (audit of bulk ops) | **Pending requests**.

**Rate-limit posture.** Bulk add-member jobs are paced 30-90 s per add; per-session cap of 50 adds/day on accounts under 30 days old, 150/day after. Failures roll into the same `group_operations` audit pattern.

**Edge cases.**

- IG enforces a 32-person hard cap per thread → 4xx `THREAD_CAPACITY_EXCEEDED`.
- Adding someone who has blocked the session → 403 `BLOCKED_BY_TARGET`.
- Adding from a session not in the thread → 403 `NOT_THREAD_MEMBER`.
- Approving a pending DM request requires the user to have it in their Requests inbox.

**WS events.**

```
thread:op:progress    { opId, applied, failed }
thread:op:done        { opId, summary }
thread:new            { sessionId, threadId, snippet }
thread:request:new    { sessionId, fromUserId }
```

---

### 5A.7 Lists

**Today on Telegram.** `listService.js` (1,719 LOC) is platform-agnostic CRUD over `lists` and `list_items`. Sources: `scrape:job:<id>`, `manual`, `csv`, `import_from_session`. Operations: create, update, delete, list, item add/remove/dedupe, search, copy, export (CSV / XLSX / TSV), tag/category.

**Instagram analog.** Same service, plumbed with `platform` so a TG list and an IG list never accidentally cross-pollinate. New source values: `scrape:ig:job:<id>`, `csv:ig`, `import_from_session_followers:<sessionId>`, `import_from_session_following:<sessionId>`, `import_from_thread:<threadId>`.

The data model on `list_items` already supports both via the existing `telegram_id` column (renamed to `external_id` in `v9_2_instagram_extras`) and the username/full_name fields. We add a `platform` column and a unique constraint `UNIQUE(list_id, platform, external_id)`.

A list is **single-platform** by construction (selected when created). A user can clone a list "from TG → IG" only by username matching, which is opt-in and surfaces unmatched rows.

**REST surface.** Re-uses `/api/lists/*` (the listService is platform-agnostic). The `platform` is read from the URL prefix:

```
GET    /api/instagram/lists                          ?source=&search=&page=&limit=
POST   /api/instagram/lists                          { name, source, items? }
GET    /api/instagram/lists/:id
PATCH  /api/instagram/lists/:id                      { name?, tags? }
DELETE /api/instagram/lists/:id
GET    /api/instagram/lists/:id/items                ?search=&page=&limit=
POST   /api/instagram/lists/:id/items                bulk add  body: { items }
DELETE /api/instagram/lists/:id/items                bulk del  body: { itemIds }
POST   /api/instagram/lists/:id/dedupe
GET    /api/instagram/lists/:id/export?format=csv|xlsx|tsv
POST   /api/instagram/lists/:id/copy                 { newName, withItems }
POST   /api/instagram/lists/:id/cross-platform-clone target=telegram   (best-effort)
```

**Frontend page shape.** `pages/Lists.jsx` is unchanged; it already filters by source + tags. It now reads `platform` from URL.

---

### 5A.8 Change 2FA

**Today on Telegram.** `twoFAService.js` (858 LOC) + `twoFAJobService.js` (314 LOC) + `twoFAQueue`. Per-session `check2FAStatus`, `set2FA`, `verify2FA`, `disable2FA`, `change2FA`, `bulkCheck2FA`, `bulkEnable2FA`. SRP-flow under the hood. Hint, recovery email, custom password.

**Instagram analog.** Instagram supports **TOTP-based two-factor**, **SMS two-factor**, and **WhatsApp two-factor**. The private API exposes:

```
status                 ig.account.currentUser() returns has2fa flag (lightweight) +
                       ig.account.twoFactorInfo() returns active method (TOTP|SMS|WA)
enable_totp            ig.account.enableTwoFactor()
                          → { secret, qrCode, backupCodes[] }
disable                ig.account.disableTwoFactor()
                          → ok
rotate                 disable + enable (atomic in our service)
backup_codes_regen     ig.account.regenerateBackupCodes()
                          → backupCodes[]
```

Note: SMS-based 2FA enable requires confirming a code on the user's phone, which is a UX speed-bump; we expose enable in the panel but disable-only is the common path for restoring an account that was set up in the official app.

**Bulk apply.** Re-uses the orchestrator from `twoFAJobService` with a job table:

```
twofa_jobs
  id, user_id, platform='instagram', session_ids JSONB,
  operation 'enable_totp' | 'disable' | 'rotate' | 'regen_backup_codes',
  status, total, applied, failed,
  results JSONB[] (per session: { sessionId, ok, secret?, backupCodes? })
```

The result blob stores the new TOTP secret + backup codes encrypted at rest (AES-GCM via the same crypto helper). Returned to the user **once** in the response; subsequent reads return `secret_revealed_at` only and the user must re-enable to see it again.

**REST surface.**

```
GET    /api/instagram/2fa/sessions/:id/status
POST   /api/instagram/2fa/sessions/:id/enable          { method: 'totp' }
POST   /api/instagram/2fa/sessions/:id/disable
POST   /api/instagram/2fa/sessions/:id/rotate          disable + enable
POST   /api/instagram/2fa/sessions/:id/backup-codes/regenerate

POST   /api/instagram/2fa-jobs                          { sessionIds, operation }
GET    /api/instagram/2fa-jobs                          list
GET    /api/instagram/2fa-jobs/:id                      details
POST   /api/instagram/2fa-jobs/:id/cancel
```

**Frontend page shape.** `pages/Change2FA.jsx`:

- **Per-session card view** with a status pill (Off / TOTP / SMS / WA) and one-click "Enable TOTP" / "Disable" / "Rotate" / "Regen Backup Codes".
- After enable/rotate, a modal shows the QR code + secret + backup codes with **Copy** and **Download .txt** buttons. We tell the user that's their only chance to grab the secret.
- **Bulk panel** at the top: pick N sessions, pick operation, run.
- Banner: "Bulk enable does not require a code on Instagram (TOTP setup is interactive on the panel side)". For SMS, the user must do that one-by-one.

**Rate-limit posture.** Per-session: at most 1 2FA op per 5 minutes. Bulk paces accordingly.

**Edge cases.**

- `IgChallengeRequiredError` mid-op: session goes to `challenge_pending`.
- Trying to disable on a session that doesn't have 2FA on: returns `400 NOT_ENABLED`.
- TOTP secret regeneration invalidates the previous one — we tell the user explicitly.

**WS events.**

```
twofa:status:changed   { sessionId, has2fa, method }
twofa:job:progress     { jobId, applied, failed, percent }
twofa:job:done         { jobId }
```

---

### 5A.9 Get OTP

**Today on Telegram.** `otpService.js` (326 LOC) lets the user pick N sessions, hits "Confirm", and we register a `NewMessage` MTProto handler on each session that watches for messages from `777000` ("Telegram"). Robust regex extracts a 4-8 digit code (`/\blogin code:?\s*([A-Z0-9]{4,8})\b/i`, etc.). Codes are persisted into `otp_jobs`/`otp_job_items` and broadcast via `otp:detected`. The job auto-closes after `durationSeconds` (default 300 = 5 min). On boot `resumeActiveScans()` re-arms still-open scans.

**Instagram analog — different mechanism, same UX.** Instagram does not push login OTPs over the in-app DM stream; it sends them via SMS, email, or to the user's WhatsApp. The panel cannot read those. There are however three legitimate scan sources on the IG side:

1. **DM-stream scan** for messages whose sender is `instagram` or `instagramofficial` and whose body contains "code" / "login" / 6-digit pattern. (Rare but it does happen for campaign codes / 2FA reminders.)
2. **Notification-feed scan** via `ig.news.inbox()` for security-related notifications ("New login from <city>"). Useful as an audit, not as an OTP source.
3. **Last-issued OTP from the panel's own challenge flow** (§5A.2) — when the user logs in via the panel and Instagram emails/SMSes a code, the user types it into the panel; we keep that 6-digit code in a per-session "last received" buffer (5 min TTL) so the user can re-display it without re-checking their email if a re-verification fires within that window.

We expose all three. Source (1) is the closest to the TG primitive; (2) and (3) are bonus IG-specific surfaces.

**Library calls.**

```
DM-stream scan         realtime listener on the session's FBNS subscription
                       (ig.realtime.on('message', ...))
                       OR poll ig.feed.directInbox().items() every 15-30s and
                       diff against last seen item (we use this fallback when
                       FBNS is not authenticated).
news scan              ig.news.inbox()  every 30s diffed against last seen story_id
last-otp-buffer        in-memory Map<sessionId, { code, receivedAt, expiresAt }>
                       written by the create-session flow; read by the panel
```

**Data model.** `otp_jobs` and `otp_job_items` already exist. We add `platform` and a `source` column on items (`dm_stream`, `news`, `panel_buffer`).

**REST surface.**

```
POST   /api/instagram/otp/jobs              { sessionIds, durationSeconds, sources? }
GET    /api/instagram/otp/jobs              list
GET    /api/instagram/otp/jobs/:id          details (with detected codes)
POST   /api/instagram/otp/jobs/:id/cancel
GET    /api/instagram/otp/sessions/:id/last-buffer    panel_buffer entry if any
```

**Provider service shape.**

```
providers/instagram/otp.js
  createJob({ userId, sessionIds, durationSeconds, sources }) → { jobId }
  resumeActiveScans()
  list/get/cancel
  rememberFromChallenge(sessionId, code)   // called by interactive.challenge
```

**Frontend page shape.** `pages/GetOTP.jsx`:

- Picker: sessions + duration + scan sources (checkbox group).
- Live list of detected codes with timestamp, source, sender, and a "Copy" button.
- Per-session "Last received from panel" widget (always visible, lights up if a code is in the buffer).

**Rate-limit posture.** The poll fallback for DM-stream is at most every 15 s per session and only while a job is open. News inbox is 1 poll per 30 s per session. Negligible at 1000 concurrent users.

**Edge cases.**

- Session falls into `challenge_pending` mid-scan: it's removed from the scan and the user is told.
- Instagram DM was actually a real DM that contains a 6-digit number unrelated to login: we surface it but tag confidence as `low` (no "code" / "login" keyword nearby).

**WS events.**

```
otp:detected     { jobId, sessionId, code, source, confidence, sender }
otp:job:done     { jobId, summary }
```

---

### 5A.10 Proxies

**Today on Telegram.** `proxyService.js` (708 LOC) maintains a free + manual proxy pool, validates against Telegram DC4 (`149.154.167.51:443`), revalidates every `PROXY_RECHECK_INTERVAL_MS` (10 min default), enforces `MAX_SESSIONS_PER_PROXY` (4), supports SOCKS5/SOCKS4/HTTP/HTTPS, ad-hoc reservations for in-flight session creation, and per-session sticky binding. Free pool is sourced from `TheSpeedX/PROXY-List`, `hookzof/socks5_list`, `hideip.me`.

**Instagram extensions.** Two structural changes (§4.9):

1. **Per-platform validators.** Instagram validation = TLS handshake against `i.instagram.com:443` through the proxy with HTTP/1.1 `CONNECT`. A successful handshake within `PROXY_VALIDATION_TIMEOUT_MS` (default 8s) means the proxy is `validated_for_instagram=true`. Telegram validator is unchanged (TCP probe to DC4).
2. **Per-platform availability flags** on `proxies` rows: `validated_for_telegram`, `validated_for_instagram`, plus the existing `validated_at`, `latency_ms`, `failure_count`.

The free pool is fed into both validators in parallel; same proxy may end up valid for one platform and invalid for the other. The 10-min sweeper validates each proxy against both platforms in alternating sweeps to avoid doubling the validation traffic.

**REST surface.** Reuses `/api/<platform>/proxies/*`. Filters and selectors are platform-aware:

```
GET    /api/instagram/proxies                       only validated_for_instagram=true
GET    /api/instagram/proxies?show=all              admin debug view
POST   /api/instagram/proxies                       manual add (validated against IG only by default; ?both=true validates both)
DELETE /api/instagram/proxies/:id                   (admin)
POST   /api/instagram/proxies/refresh-free          re-scrape and re-validate free pool
POST   /api/instagram/proxies/sessions/:id/assign   bind a proxy to a session
POST   /api/instagram/proxies/sessions/:id/release
GET    /api/instagram/proxies/stats                 pool size, healthy count, failure rate
```

**Frontend page shape.** `pages/Proxies.jsx`:

- Pool table with platform-validity columns (`✓ TG / ✓ IG` badges).
- Filter: validated for / source / latency / failure-count.
- "Add manual proxy" modal with a checkbox "Validate for both platforms".
- Per-session assignment grid (matrix of session × proxy with assignment state).

**Rate-limit posture.** Proxy validation is cheap; the 10-min sweeper handles ~800 proxies × 2 platforms = ~1600 checks every 10 min ≈ 2.7 / s. Well within budget.

**Edge cases.**

- A proxy that was IG-valid yesterday is dead today → flagged unhealthy, sessions bound to it auto-rebind to the next-healthy proxy on next reconnect.
- Geo-blocked proxies (some EU IPs blocked by IG) → flagged with `geo_blocked_for_instagram=true` and excluded from the IG pool.

---

### 5A.11 Anti-Detect

**Today on Telegram.** `identityService.js` per-session device fingerprint (4 fields: `device_model`, `system_version`, `app_version`, `lang_code`) persisted in `sessions.device_identity::jsonb`. `behaviorService.js` (520 LOC) runs a randomized read-only batch (`mark-as-read`, `set-typing`, `occasional reactions`) every `BEHAVIOR_TICK_INTERVAL_MS` per session.

**Instagram analog.** Two parts:

#### 5A.11.1 Device fingerprint

Richer than Telegram. A full IG fingerprint is **7+ fields**:

```
android_version          e.g. "33/13"
android_release          e.g. "13"
manufacturer             e.g. "Samsung"
model                    e.g. "SM-S908U"  (Galaxy S22 Ultra)
device                   e.g. "b0q"
cpu                      e.g. "exynos2200"
device_id                deterministic from username
phone_id                 UUIDv4
uuid                     UUIDv4
advertising_id           UUIDv4 (Google Ad ID format)
family_device_id         UUIDv4
user_agent               full IG-Android UA string built from the above
locale                   e.g. "en_US"
country                  e.g. "US"
timezone                 e.g. "America/Los_Angeles"
```

The provider exposes:

```
providers/instagram/identity.js
  randomize(sessionId)      generate a fresh device + persist
  apply(sessionId, partial) override specific fields + persist + reconnect
  current(sessionId)        return the persisted identity
  presets                   list of preset device profiles (Pixel 7, S23, etc.)
```

Generation is deterministic per username so re-logins on different days produce the same fingerprint (anti-detection: changing the device every login is a red flag). The deterministic seed uses `username + INSTAGRAM_DEVICE_SALT` so the operator can rotate the salt cluster-wide if the format ever leaks.

#### 5A.11.2 Behavior simulator

A periodic batch per session that does cheap, read-only IG actions to keep the account "warm":

```
every INSTAGRAM_BEHAVIOR_TICK_INTERVAL_MS (default 5 min, full jitter ±20%):
  with probability 0.9: ig.feed.timeline().items()           // refresh feed
  with probability 0.6: ig.news.inbox()                       // check notifications
  with probability 0.4: ig.feed.directInbox().items()         // peek DM inbox
  with probability 0.2: pick a story from feed → ig.media.seenStory(...)
  with probability 0.05: like a random post from the timeline (only if liked_count > 100)
  with probability 0.02: brief "active now" by hitting ig.account.currentUser()
```

All probabilities and intervals are tunable in `system_settings`. The simulator runs only on sessions with `is_logged_in=TRUE` and not in `challenge_pending`. It's gated by `INSTAGRAM_BEHAVIOR_ENABLED` (default `true`).

**REST surface.**

```
GET    /api/instagram/anti-detect/identity/:sessionId
POST   /api/instagram/anti-detect/identity/:sessionId/randomize
PATCH  /api/instagram/anti-detect/identity/:sessionId            { ...overrides }
GET    /api/instagram/anti-detect/identity/presets

GET    /api/instagram/anti-detect/behavior/:sessionId
POST   /api/instagram/anti-detect/behavior/:sessionId            { enabled, profile? }
GET    /api/instagram/anti-detect/behavior/profiles              ['off','low','medium','high']
```

**Frontend page shape.** `pages/AntiDetect.jsx`:

- Two tabs: **Device fingerprint** (per-session) and **Behavior simulator** (per-session toggle + intensity preset).
- Device fingerprint editor: shows the 14 fields with "Randomize", "Apply preset (Pixel 7 / S23 / iPhone-emulating-Android profile / ...)", and a per-field override input.
- Behavior simulator: per-session enable toggle + intensity preset (Off / Low / Medium / High) + last tick timestamp.

**Rate-limit posture.** The simulator itself is paced. The `randomize` operation triggers a reconnect, which re-counts toward the proxy's per-session-per-day reconnect cap (3). Excessive randomization is rate-limited by the panel.

**Edge cases.**

- Changing the fingerprint of a logged-in session implicitly re-logs-in (Instagram treats it as a new device → may trigger checkpoint). We warn the user before applying.
- Behavior simulator that hits a paused session is a no-op.

---

### 5A.12 Account Settings

**Today on Telegram.** `accountSettingsService.js` (226 LOC) exposes `updateMultipleSessions` (bulk profile updates: `firstName`, `lastName`, `bio`), `saveProfilePhoto` (single session), and `getAccountSettings`.

**Instagram analog.** Larger field set:

```
fullName                 1-30 chars                       ig.account.editProfile({ first_name })
username                 1-30 chars, lowercase, unique     ig.account.editUsername(...)
bio                      0-150 chars                       ig.account.editProfile({ biography })
profile_photo            jpeg/png, square recommended      ig.account.changeProfilePicture(buffer)
website                  URL                               ig.account.editProfile({ external_url })
gender                   male/female/custom/prefer_not     ig.account.editProfile({ gender })
contact_email            email                             ig.account.editProfile({ email })
contact_phone            E.164                             ig.account.editProfile({ phone_number })
category                 only for business/creator         ig.account.setProfessionalAccount({ category, professional })
account_type             personal | creator | business     ig.account.setProfessionalAccount(...)
```

**Bulk apply.** Re-uses the same orchestrator pattern with per-session jittered spacing (default 10-25 s between updates). Per-session per-day cap of 5 profile updates by default to avoid suspicious-activity flags.

**REST surface.**

```
GET    /api/instagram/account-settings/:sessionId
POST   /api/instagram/account-settings/:sessionId/profile-photo    multipart
PATCH  /api/instagram/account-settings/:sessionId                  { fullName?, bio?, website?, gender?, contactEmail?, contactPhone? }
PATCH  /api/instagram/account-settings/:sessionId/username         { username }
POST   /api/instagram/account-settings/:sessionId/account-type     { type, category }
POST   /api/instagram/account-settings/bulk                        { sessionIds, fields }
```

**Frontend page shape.** `pages/AccountSettings.jsx`:

- Single-session editor: form with every field, image dropper for profile photo, save/cancel.
- Bulk editor: pick N sessions, fill in the fields you want to update across all of them, "Apply to all" → creates a job with progress.
- A "Switch to Professional" wizard for converting personal → creator/business with category selection.

**Rate-limit posture.** Profile updates are sensitive — IG flags rapid sequential changes. We hard-cap at 1 profile update per session per 10 minutes.

**Edge cases.**

- Username already taken → 409 with the suggested alternatives IG returns.
- Email change requires confirming a code emailed to the new address — out of scope (we surface the request and tell the user to confirm via the official app).
- Profile photo upload that's not square → we offer client-side center-crop before submit.

**WS events.**

```
account:updated     { sessionId, fields }
account:job:done    { jobId, summary }
```

---

### 5A.13 Capability matrix (final, machine-readable)

The provider returns this at startup. The frontend reads it once per session via `GET /api/<platform>/capabilities`:

```json
{
  "telegram": {
    "sessions.upload": true,
    "sessions.create": true,
    "scrape.groupMembers": true,
    "scrape.channelSubscribers": true,
    "scrape.followers": false,
    "scrape.hashtag": false,
    "scrape.likers": false,
    "scrape.storyViewers": false,
    "messaging.text": true,
    "messaging.media": true,
    "messaging.voice": true,
    "messaging.forward": true,
    "messaging.scheduled": true,
    "groups.create": true,
    "groups.addRemove": true,
    "threads.list": false,
    "twoFA.enable": true,
    "twoFA.disable": true,
    "twoFA.changePassword": true,
    "twoFA.regenerateBackupCodes": false,
    "otp.dmStream": true,
    "otp.newsInbox": false,
    "otp.panelBuffer": false,
    "privacy.keys": ["phone_number","added_by_phone","last_seen","profile_photo","bio","gifts","birthday","forwards","calls","messages","invites"],
    "antiDetect.fingerprintFields": 4,
    "antiDetect.behaviorSimulator": true,
    "accountSettings.fields": ["firstName","lastName","bio","profilePhoto","username"]
  },
  "instagram": {
    "sessions.upload": true,
    "sessions.create": true,
    "scrape.groupMembers": false,
    "scrape.channelSubscribers": false,
    "scrape.followers": true,
    "scrape.following": true,
    "scrape.hashtag": true,
    "scrape.location": true,
    "scrape.likers": true,
    "scrape.commenters": true,
    "scrape.storyViewers": true,
    "messaging.text": true,
    "messaging.media": true,
    "messaging.voice": true,
    "messaging.forward": true,
    "messaging.scheduled": true,
    "messaging.reactions": true,
    "messaging.threadShare": true,
    "groups.create": false,
    "groups.addRemove": false,
    "threads.list": true,
    "threads.create": true,
    "threads.addMembers": true,
    "threads.removeMembers": true,
    "twoFA.enable": true,
    "twoFA.disable": true,
    "twoFA.changePassword": false,
    "twoFA.regenerateBackupCodes": true,
    "otp.dmStream": true,
    "otp.newsInbox": true,
    "otp.panelBuffer": true,
    "privacy.keys": ["account_visibility","allow_story_resharing","hide_story_from","close_friends","allow_tagging","allow_remix","allow_message_from","allow_message_request_from","hide_active_status","mention_settings","comment_filter_keywords","restricted_users"],
    "antiDetect.fingerprintFields": 14,
    "antiDetect.behaviorSimulator": true,
    "accountSettings.fields": ["fullName","username","bio","profilePhoto","website","gender","contactEmail","contactPhone","accountType","category"]
  }
}
```

The frontend consumes this map to gate sidebar items, tab visibility, and form fields.

---

### 5A.14 Cross-feature concerns

**Per-session daily-cap registry.** A small in-Postgres table aggregates per-session per-day counters that several features read:

```
session_daily_counters (
  session_id INTEGER REFERENCES sessions(id) ON DELETE CASCADE,
  platform   platform_type NOT NULL,
  date       DATE NOT NULL,
  dms_sent   INTEGER NOT NULL DEFAULT 0,
  scrape_items INTEGER NOT NULL DEFAULT 0,
  privacy_ops  INTEGER NOT NULL DEFAULT 0,
  twofa_ops    INTEGER NOT NULL DEFAULT 0,
  account_ops  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, date)
);
```

Updated on every successful op (single `UPDATE ... SET counter = counter + 1`). Read by the messaging UI to render the live cap banner, by the account-settings UI to gate the form, and by the anti-detect dashboard for per-account warm-up status.

**Per-job audit trail.** All bulk jobs (scrape, messaging, threads, twofa, privacy, account-settings) write an `activity_log` row keyed to a stable `entity_type=ig_<feature>_job` and `entity_id=<jobId>`. The Admin page reads these to surface per-user activity timelines.

**Job concurrency caps.** Default per-user simultaneous in-flight jobs (across platforms):

```
scrape:               5
messaging:            3
threads/groups:       3
twofa:                2
privacy:              2
account-settings:     2
```

These are checked at job-create time (`getRunningJobCount(userId, kind)`) and enforced by the controllers, not the queue (so a user gets a clear `429 TOO_MANY_RUNNING_JOBS` instead of a silently-queued job).

**Per-session "in-use" lock.** When a session is participating in a write-job (messaging, twofa, account-settings) a Redis key `session:lock:<sessionId>` is set with a TTL covering the expected job duration. A second job that wants to write to the same session waits, or fails fast with `409 SESSION_BUSY` based on `?wait=`. This prevents the same `IgApiClient` from being driven by two workers concurrently and tripping IG's anti-bot heuristics.

---

## 6. Frontend architecture

### 6.1 Mental model

`platform: 'telegram' | 'instagram'` is a top-level concern. We thread it through:

1. **URL** (`/tg/...` and `/ig/...`).
2. **PlatformContext** (React context, persisted to `localStorage`).
3. **Theme** (Tailwind class root + CSS custom properties for the brand gradient).
4. **API client** (axios baseURL switches per request, or sets `X-Platform` header).
5. **Socket.IO** (joins the right per-platform room, filters events).

### 6.2 Routing

Switch from `BrowserRouter` to **two nested routes** under a `:platform` param:

```text
<BrowserRouter>
  <AuthProvider>
    <PlatformProvider>     // reads :platform, persists, exposes setPlatform
      <ToastContainer />
      <MissingApiCredsModal />
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route path="/login"     element={<Login />} />
          <Route path="/register"  element={<Register />} />
          <Route path="/pending"   element={<PendingGate />} />
          <Route path="/admin"     element={<AdminRoute />} />
          <Route path="/:platform/*" element={<PlatformShell />} />
          <Route path="/" element={<HomeRedirect />} />
          <Route path="*" element={<HomeRedirect />} />
        </Routes>
      </Suspense>
    </PlatformProvider>
  </AuthProvider>
</BrowserRouter>
```

`PlatformShell` re-declares the inner routes, all wrapped in `ProtectedRoute(platform)`:

```text
function PlatformShell() {
  const { platform } = useParams();
  if (!['telegram', 'instagram'].includes(platform))
    return <Navigate to="/tg" replace />;
  return (
    <Routes>
      <Route path="billing"          element={<ProtectedRoute platform={platform} title="Billing" allowWithoutSubscription><Billing /></ProtectedRoute>} />
      <Route path="settings"         element={<ProtectedRoute platform={platform} title="Settings" allowWithoutSubscription><Settings /></ProtectedRoute>} />
      <Route path="dashboard"        element={<ProtectedRoute platform={platform} title="Dashboard"><Dashboard /></ProtectedRoute>} />
      <Route path="sessions"         element={<ProtectedRoute platform={platform} title="Sessions"><Sessions /></ProtectedRoute>} />
      <Route path="create-session"   element={<ProtectedRoute platform={platform} title="Create Session"><CreateSession /></ProtectedRoute>} />
      <Route path="scrape"           element={<ProtectedRoute platform={platform} title="Scrape"><Scrape /></ProtectedRoute>} />
      <Route path="messaging"        element={<ProtectedRoute platform={platform} title="Messaging"><Messaging /></ProtectedRoute>} />
      <Route path="groups"           element={<ProtectedRoute platform={platform} title="Groups"><Groups /></ProtectedRoute>} />
      <Route path="threads"          element={<ProtectedRoute platform={platform} title="DM Threads"><Threads /></ProtectedRoute>} />
      <Route path="lists"            element={<ProtectedRoute platform={platform} title="Lists"><Lists /></ProtectedRoute>} />
      <Route path="reports"          element={<ProtectedRoute platform={platform} title="Reports"><Reports /></ProtectedRoute>} />
      <Route path="account-settings" element={<ProtectedRoute platform={platform} title="Account Settings"><AccountSettings /></ProtectedRoute>} />
      <Route path="change-2fa"       element={<ProtectedRoute platform={platform} title="Change 2FA"><Change2FA /></ProtectedRoute>} />
      <Route path="get-otp"          element={<ProtectedRoute platform={platform} title="Get OTP"><GetOTP /></ProtectedRoute>} />
      <Route path="proxies"          element={<ProtectedRoute platform={platform} title="Proxies"><Proxies /></ProtectedRoute>} />
      <Route path="anti-detect"      element={<ProtectedRoute platform={platform} title="Anti-Detect"><AntiDetect /></ProtectedRoute>} />
      <Route path="privacy"          element={<ProtectedRoute platform={platform} title="Privacy"><Privacy /></ProtectedRoute>} />
      <Route index                   element={<Navigate to="dashboard" replace />} />
      <Route path="*"                element={<Navigate to="dashboard" replace />} />
    </Routes>
  );
}
```

`ProtectedRoute(platform)` checks the **platform-scoped** entitlement:

```text
function hasEntitlement(user, platform) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const sub = user.subscriptions?.[platform] || {};
  if (sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date())
    return true;
  if (sub.trial?.expiresAt && new Date(sub.trial.expiresAt) > new Date()) return true;
  return false;
}
```

If `hasEntitlement(user, platform) === false` and the route is not `allowWithoutSubscription`, redirect to `/<platform>/billing`. This is the mechanism behind the "toggle to a panel you don't own → bounce to that panel's billing page" requirement.

### 6.3 PlatformContext

```text
PlatformContext value = {
  platform: 'telegram' | 'instagram',
  setPlatform(next, opts?: { preserveTab?: boolean }),
  isTelegram, isInstagram,
  capabilities,             // from /api/<platform>/capabilities
  brand: {                  // theme tokens
    name, gradient, primary, primaryHover, primaryActive, accent, accentSoft,
    logo: ReactComponent
  },
}
```

`setPlatform(next)`:

1. Compute the target URL: replace the leading `/<currentPlatform>/` with `/<next>/` so the same logical page is shown if the page is shared between platforms (e.g., `/tg/scrape` ↔ `/ig/scrape`).
2. If the target page does not exist on the new platform (capability false), redirect to `/<next>/dashboard`.
3. Persist `localStorage.platform = next`.
4. `navigate(targetUrl)`. The `ProtectedRoute` guard handles the billing redirect if needed.

The toggle component lives in `Header.jsx`, immediately to the **left of the Bell icon**, as required:

```
[ Telegram ⇄ Instagram ]   |   🔔   |   👤
```

Visual: a 64×32 px segmented switch with the two platform glyphs (Telegram airplane and Instagram camera). Active half has the platform brand gradient, inactive half has `bg-white/5`. Smooth 200 ms transform-based animation. Hover/keyboard accessible (Tab, Enter/Space, ArrowLeft/Right).

### 6.4 Theme system

The current theme is hard-coded `primary-*` (Telegram blue) and `dark-*` slates. To support a second theme without diverging two sets of pages, we introduce **CSS custom properties** as the source of truth, and let Tailwind classes consume them:

```text
:root[data-platform="telegram"] {
  --brand-from: #3b82f6;
  --brand-via:  #2563eb;
  --brand-to:   #1d4ed8;
  --brand-soft: rgba(59, 130, 246, 0.15);
  --brand-ring: rgba(37, 99, 235, 0.35);
}
:root[data-platform="instagram"] {
  --brand-from: #feda75;
  --brand-via:  #d62976;
  --brand-to:   #4f5bd5;
  --brand-soft: rgba(214, 41, 118, 0.15);
  --brand-ring: rgba(214, 41, 118, 0.35);
}
```

`tailwind.config.js` exposes these via the `colors` config:

```text
colors: {
  brand: {
    from: 'var(--brand-from)',
    via:  'var(--brand-via)',
    to:   'var(--brand-to)',
    soft: 'var(--brand-soft)',
    ring: 'var(--brand-ring)',
  },
  // primary stays as the legacy Telegram blue palette so
  // existing calls keep working during the transition.
}
```

A migration codemod replaces every `bg-primary-600`, `text-primary-500`, `ring-primary-*` etc. inside `frontend/src/**` with the equivalent `bg-brand-*` / `text-brand-*`. We keep the old `primary-*` palette in Tailwind for one release so unrelated components don't break.

The dark base (`bg-dark-950` / `text-dark-300`) stays on both platforms — both panels are dark-mode by default.

`PlatformProvider` writes `<html data-platform="...">` on mount and on every `setPlatform`. CSS handles the rest; React doesn't re-render anything theme-related.

Sidebar gets one extra brand surface treatment per platform (Instagram sidebar brand block uses the gradient as its background; Telegram keeps the solid blue).

### 6.5 Sidebar items

`Sidebar.jsx` reads the active platform and the provider's `capabilities` map:

```text
const items = useMemo(() => {
  const base = [
    { path: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { path: 'sessions', label: 'Sessions', icon: Users },
    { path: 'create-session', label: 'Create Session', icon: UserPlus },
    { path: 'scrape', label: 'Scrape', icon: Search, capability: 'scrape' },
    { path: 'messaging', label: 'Messaging', icon: MessageSquare, capability: 'messagingDirect' },
    platform === 'telegram'
      ? { path: 'groups', label: 'Groups', icon: UsersRound, capability: 'groupAddRemove' }
      : { path: 'threads', label: 'DM Threads', icon: UsersRound },
    { path: 'lists', label: 'Lists', icon: List },
    { path: 'change-2fa', label: 'Change 2FA', icon: ShieldCheck, capability: 'twoFA' },
    { path: 'get-otp', label: 'Get OTP', icon: KeyRound, capability: 'otpScan' },
    { path: 'proxies', label: 'Proxies', icon: Network },
    { path: 'anti-detect', label: 'Anti-Detect', icon: Fingerprint },
    { path: 'reports', label: 'Reports', icon: BarChart3 },
    { path: 'account-settings', label: 'Account Settings', icon: UserCog },
    { path: 'privacy', label: 'Privacy', icon: Shield, capability: 'privacy' },
    { path: 'billing', label: 'Billing', icon: CreditCard },
    { path: 'settings', label: 'Settings', icon: Settings },
  ];
  return base.filter((it) => !it.capability || capabilities[it.capability]);
}, [platform, capabilities]);
```

Links are now relative (`to={item.path}`) so the parent `:platform` route resolves them correctly.

### 6.6 API client

`frontend/src/api/client.js` adds platform-awareness:

```diff
+ import { currentPlatform } from '@/state/platform';
  api.interceptors.request.use((config) => {
    const token = localStorage.getItem('token');
    if (token) config.headers.Authorization = `Bearer ${token}`;
+   const platform = currentPlatform();
+   if (config._platform !== false && platform) {
+     // If the path is not platform-prefixed, prefix it.
+     if (!/^\/(telegram|instagram)\//.test(config.url)) {
+       config.url = `/${platform}${config.url.startsWith('/') ? '' : '/'}${config.url}`;
+     }
+     config.headers['X-Platform'] = platform;
+   }
    return config;
  });
```

`config._platform = false` is opt-out for platform-agnostic endpoints (`/auth/*`, `/billing/*`, `/admin/*`). Per-feature API modules (`api/sessions.js`, `api/scrape.js`, etc.) need no changes — the interceptor handles it transparently.

The 401-handling logic, the 412 modal trigger, and the (new) **402 + platform** redirect:

```diff
  if (error?.response?.status === 402) {
    const code = error.response?.data?.error?.code;
+   const platform = error.response?.data?.error?.platform || currentPlatform() || 'telegram';
    if (code === 'SUBSCRIPTION_REQUIRED' || code === 'TRIAL_FEATURE_NOT_ALLOWED') {
+     window.location.href = `/${platform}/billing`;
    }
  }
```

### 6.7 Socket.IO

`useWebSocket` rebinds rooms when `platform` changes. The hook keeps a single `socket` instance for the lifetime of the AuthProvider; only the listener filters change.

```text
function useWebSocket() {
  const socket = useSocketRaw();
  const { platform } = usePlatform();
  useEffect(() => {
    function onProgress(payload) { /* dispatch to platform-specific store */ }
    socket.on(`scrape:progress`, onProgress);
    socket.on(`scrape:completed`, ...);
    return () => { socket.off(...); };
  }, [platform]);
}
```

Server emits include `{ platform: '...' }` in the payload so a single listener can route to two stores if we ever want to surface cross-platform notifications (e.g., "your IG scrape just finished, check the IG panel" toast in the TG panel).

### 6.8 Billing page

`pages/Billing.jsx` becomes platform-aware. Top of the page:

```
You are viewing: [Telegram ▼]      // dropdown — switching here also flips the toggle
```

Two cards side-by-side:

- **Telegram subscription** — status, expiry, monthly price, [Subscribe] / [Renew] / [Manage].
- **Instagram subscription** — same.

A third card pitches the bundle:

- **Telegram + Instagram bundle** — price (e.g., `$14.99/mo`), savings vs. buying separately, [Buy bundle].

Trial buttons are platform-scoped: the Telegram trial activates only `subscriptions.telegram`, and likewise Instagram. A user can activate both trials independently.

The OxaPay checkout flow is unchanged from the user's perspective — they get redirected to OxaPay's hosted checkout, return to `/<platform>/billing?paid=true`, and on next page load the IPN has already extended the right `user_subscriptions` row.

### 6.9 Page-level changes (per page)

For each page below: what changes and what stays.

#### `Dashboard.jsx`
- Reads `platform` from URL.
- Calls `GET /api/<platform>/dashboard`.
- Renders a per-platform header strip (logo + active session count + recent activity).
- For Instagram: replace the "Active sessions / Total channels / DMs sent today" widget with "Active accounts / DMs sent today / Followers gained today".

#### `Sessions.jsx`
- Same UI. The download button → plaintext session JSON (per PR #14 for TG, ditto for IG `state.json`).
- Phone number column becomes Username column for IG (we already store `phone` for TG; add `username` to `account_info::jsonb` for IG and render whichever exists).
- Uploads accept `.json` for both platforms; the frontend does not need to know which library will parse it.

#### `CreateSession.jsx`
- TG path is unchanged.
- IG path replaces "Phone number" with "Username + Password" form. After `start`, the page transitions through `awaiting_2fa` / `awaiting_challenge` states. The same `tempId` machinery drives the UI.

#### `Scrape.jsx`
- TG: members + channel subscribers + period-bounded monitor (existing).
- IG: target picker accepts `username` (a public profile). Type radio: `Followers / Following / Likers of recent post`. The "hidden members" toggle becomes "Use story-view monitor" for IG (a similar passive listener idea but for story view rather than new chat messages).

#### `Messaging.jsx`
- Per-platform target picker (chat/userId for TG, username/threadId for IG).
- Per-platform daily caps surfaced as a banner ("You can send up to 30 DMs to non-mutuals today on this account").

#### `Groups.jsx` (TG-only) / `Threads.jsx` (IG-only)
- Sidebar shows whichever applies. Both pages live, sidebar capability flag toggles which one is reachable.

#### `Lists.jsx`, `Reports.jsx`
- Plumb `platform` through. The data-table is generic.

#### `Change2FA.jsx`, `GetOTP.jsx`
- TG flows unchanged. IG flows surface TOTP enable/disable and SMS OTP capture during login challenge.

#### `Proxies.jsx`
- Per-platform tab filter ("Show: Telegram-validated / Instagram-validated / All"). Manual proxy add validates against both targets.

#### `AntiDetect.jsx`
- Two tabs: device fingerprint, behavior toggles. Field set differs (TG: 4 fields; IG: 7 fields). Same UX shell.

#### `Privacy.jsx`
- Field set differs. Same UX shell.

#### `Settings.jsx`
- Telegram section: API ID/Hash credentials manager (unchanged).
- Instagram section: device fingerprint defaults, default proxy country.
- Account section: email, password, notifications.

#### `Admin.jsx`
- New filter: platform (All / Telegram / Instagram).
- Per-user view shows both subscriptions and their independent histories.

### 6.10 Smooth toggle animation

The toggle is a controlled segmented switch. On `setPlatform`:

1. Animate the switch knob (200 ms `transform: translateX(0 → 100%)` with easing `cubic-bezier(0.4, 0, 0.2, 1)`).
2. CSS variables flip on `<html data-platform>` (instant) — Tailwind classes that consume `var(--brand-*)` re-render through the browser's normal style recalc.
3. React Router `navigate(target)` runs in parallel. The page fades out (200 ms `opacity 1→0`) then the new page fades in (200 ms). Use `<Suspense>` boundaries already in `App.jsx`.

Net perceived cost: ~250 ms toggle. No layout shift, no full reload.

---

## 7. Capacity plan — 1000 concurrent users per panel

### 7.1 Steady-state targets

The numbers below assume **1000 active users on Telegram + 1000 active users on Instagram** at the same time, each running the panel in a browser tab and a low percentage running active jobs.

Per-user load model (peak hour):

- 1 long-lived WS connection.
- 1 page load every ~3 minutes (poll-style refresh).
- ~10 REST calls/minute when actively using a feature page.
- 1 in-flight job in 10% of users (scrape OR messaging OR monitor).

Aggregate:

- **2000 concurrent WS** sockets.
- **~600 RPS** sustained REST (2000 users × 10 rpm × 2 platforms × 0.9 idle ratio).
- **~200 concurrent jobs** (10% × 2000 users), of which ~100 are messaging (slow-paced) and ~100 are scrape (CPU/network heavy).
- **~3000 active sessions** (logged-in Telegram clients + Instagram IgApiClient) — each holds a TCP connection through a proxy.

This is roughly 3-4× the 500-700 user target documented in `OPS.md`.

### 7.2 Process layout (recommended)

```
                ┌────────────────────────────────────────┐
                │   nginx (TLS, sticky)                  │
                └──────┬───────────────────┬─────────────┘
                       │                   │
                       ▼                   ▼
        ┌─────────────────────┐  ┌─────────────────────┐
        │ panel-pod 1..N      │  │ admin-pod 1         │
        │  Express + Socket.IO│  │  Express (admin)    │
        │  (HTTP + WS only)   │  │                     │
        └─────────────────────┘  └─────────────────────┘
                       │                   │
                       ▼                   ▼
        ┌─────────────────────────────────────────────┐
        │ Postgres (master + replica) via pgbouncer   │
        │ Redis (single node v1, cluster v2)          │
        └─────────────────────────────────────────────┘
                       ▲                   ▲
                       │                   │
        ┌─────────────────────┐  ┌─────────────────────┐
        │ tg-worker pod 1..M  │  │ ig-worker pod 1..M  │
        │  scrape + messaging │  │  scrape + messaging │
        │  + 2fa + privacy    │  │  + 2fa + privacy    │
        │  + heartbeat        │  │  + heartbeat        │
        │  + OTP scan         │  │  + OTP scan         │
        │  + behavior         │  │  + behavior         │
        │  + monitor sweep    │  │  + monitor sweep    │
        └─────────────────────┘  └─────────────────────┘
                       │                   │
                       ▼                   ▼
                ┌────────────────────────────────┐
                │ Outbound proxy pool (per-pf)   │
                └────────────────────────────────┘
```

- **panel-pod**: stateless, runs only HTTP + WS. Scale by N (start at 2, add when CPU > 60% or WS connections > 1500/pod).
- **tg-worker / ig-worker**: stateful **only** in the in-process client maps. We pin a session to a worker pod (consistent hashing on `sessionId`) so the live `ig`/`gramjs` client is always reachable to the worker handling a given job. BullMQ doesn't natively pin; we implement it as a **router queue** (see §7.3).
- **admin-pod**: optional separation for admin endpoints to avoid a runaway query starving customer traffic. Single instance is fine.

panel-pod count is a function of WS connections; worker pod count is a function of in-flight job concurrency.

### 7.3 Worker affinity ("session pinning")

Telegram's `telegramService.clients` and Instagram's `instagramService.clients` are in-memory. If the worker pool is more than one pod, we can't have a job for `sessionId=42` arrive on a pod that doesn't hold the live client. Two ways to handle this:

- **(a) Re-hydrate on demand.** Each worker pod hydrates the client when the job arrives (deserialize state from disk + connect). Costs ~1-2 s per first-touch and 1 connection per active session per pod. At 3000 sessions × N pods this is wasteful but works.
- **(b) Affinity routing.** A pod-routing layer maps `sessionId mod N → pod`. We implement this with a per-pod queue (`scrape:instagram:pod-1`, `scrape:instagram:pod-2`, …). The producer (HTTP request handler in panel-pod) picks the right queue by hashing `sessionId`. New worker pods take a slice of the keyspace. `bull-board` or a custom dashboard shows fairness.

The plan picks **(b)**. Reason: at 3000 sessions × 4 pods × ~1 KB MTProto state and ~5 KB IG state, holding all sessions on every pod is feasible-but-wasteful, and the per-pod connection count to Telegram DCs / Instagram edges multiplies without need. Option (a) is the fallback if (b) becomes operationally annoying.

Migration step: the existing single-pod setup keeps `concurrency` set high; the pod-routing layer is gated behind `WORKER_POD_COUNT >= 2`. So today we ship with `WORKER_POD_COUNT=1` and the routing is a no-op.

### 7.4 Postgres

- `DB_POOL_MAX`: keep 50 per panel-pod, 80 per worker-pod (workers issue more SQL per second).
- Aggregate connections at peak: `2 panel × 50 + 4 workers × 80 + admin × 50 + bouncer-overhead`. ≈ 470 connections.
- Postgres `max_connections` ≥ 600 with **pgbouncer (transaction pooling)** in front. Sample config in `OPS.md` §6 already.
- **Read replica** for the Reports page and the Admin user list (the only read-heavy non-realtime queries). All other reads stay on master.
- **Indexes** to add explicitly (see §4.1.1). The hot index is `idx_sessions_user_platform_logged_in` for the heartbeat loop and the dashboard.
- **Partitioning**: not yet. `scraped_users` is the largest table and grows linearly with scrape jobs; we partition by `scraped_at` monthly only when the table crosses ~50M rows.

### 7.5 Redis

- Single 4 GB Redis is fine for v1. BullMQ keeps job lists per queue; the dominant memory cost is in-flight messaging jobs.
- Move to **Redis Cluster (3 masters + 3 replicas)** when:
  - We see `> 200k jobs/day` in any single queue (BullMQ keeps `removeOnComplete: { age: 3600, count: 100 }` so this is mostly bounded).
  - Pubsub fanout (Socket.IO Redis adapter — see §7.6) exceeds ~50k msgs/sec.
- Per-queue `RedisOptions` already shard by queue name; we just add a `keyPrefix` per queue if we ever go multi-tenant.

### 7.6 Socket.IO horizontal scaling

With multiple panel-pods, WS rooms must be replicated across pods. Use the official `@socket.io/redis-adapter`:

```
io.adapter(createAdapter(pubClient, subClient));
```

This adds:

- Cross-pod broadcast (a worker emitting `scrape:progress` from `tg-worker-1` reaches the user even if the user's WS landed on `panel-pod-2`).
- One Redis pubsub channel per "room broadcast" (lightweight at our scale).

Memory cost on Redis: sub-100 MB at 2k concurrent connections.

### 7.7 Frontend delivery

- Vite build is statics + a manifest. Push to a CDN (Cloudflare / S3+CloudFront).
- HTML entry served from panel-pod with `Cache-Control: no-store` so we get cache-busted asset URLs.
- Lazy-loaded routes are already in place (`App.jsx` uses `lazy()` for everything except Login/Register/Pending).

### 7.8 Outbound proxies

Sizing: at ~3000 sessions and `MAX_SESSIONS_PER_PROXY = 4`, we need ~750 working proxies in the pool. The `FREE_PROXY_POOL_SIZE = 20` cap today is a v0 setting — the plan raises it to ~800 with platform splits (~400 TG-validated + ~400 IG-validated, with overlap).

For paid customers we recommend a managed provider (Bright Data, IPRoyal). The plan is provider-agnostic: `addManualProxy` already supports SOCKS5/HTTP and any host:port:credentials.

### 7.9 Behaviour simulator overhead

`behaviorService` already runs at ~one tick per session per `BEHAVIOR_TICK_INTERVAL_MS`. With 3000 sessions and the default 5-min tick, that's ~10 ticks/sec across both platforms. Negligible.

### 7.10 OPS.md amendments

The runbook gets a new section **§8 Multi-platform**:

- New env knobs (`WORKER_POD_COUNT`, `INSTAGRAM_HEARTBEAT_INTERVAL_MS`, `RATE_LIMIT_TG_MAX`, `RATE_LIMIT_IG_MAX`).
- Dial-up procedure: **Symptom — Instagram messaging queue depth > 5000** → increase `messaging:instagram` worker concurrency, or scale `ig-worker` pod count.
- Sample pgbouncer config is unchanged (already in `OPS.md`).

---

## 8. Security & compliance

### 8.1 Credential storage

- Telegram: `api_hash_enc`, session strings, proxy creds — all AES-256-GCM with `JWT_SECRET`-derived key (existing).
- Instagram: `password` is **never persisted** beyond the in-memory pending entry. After a successful login we have an `ig.state` blob that is the equivalent of a session token. Encrypted at rest the same way.
- `payment_invoices.raw_create` and `raw_callback` are kept for audit but contain no full PAN data (OxaPay-side concern).

### 8.2 Threat model additions

- **Stolen panel JWT** → identical risk on both platforms. Mitigation unchanged: short JWT TTL, per-request DB rehydration of `users` row.
- **Instagram-account takeover** via the panel: limited blast radius — sessions are encrypted at rest, session blobs by themselves give an attacker a logged-in Instagram client. Same risk as Telegram session strings today. Mitigation: keep sessions strictly tied to the user_id that uploaded them; never share across users.
- **Cross-platform admin escalation** (admin from one panel modifies the other): admin actions stay platform-aware and audited.

### 8.3 Compliance

- Instagram TOS: `instagram-private-api` is unofficial. The panel must surface this to operators in the Settings page (legal banner).
- GDPR: the data we hold is identical in shape to today (email + session blobs + scraped contacts). Scraped contact deletion endpoints already exist via `listService.deleteList`. We add `DELETE /api/<platform>/sessions/:id?cascade=true` that also purges scraped/messaging data tied to it.
- Data retention: per `OPS.md`, jobs auto-expire after 1 hour (completed) or 24 hours (failed). No change.

### 8.4 Rate-limit fairness

Per-IP `express-rate-limit` is already on. We add a per-user-per-platform limit (Redis-backed sliding window) so a single user opening 100 tabs can't DoS other Instagram users' scrape jobs. Limits live in `system_settings` and are tuned by an admin.

---

## 9. Observability

### 9.1 Logging

- `req_log_sample` (existing) — keep.
- Add `platform` to every structured log line so dashboards can filter.
- Worker logs include `pod_id`, `queue`, `platform`.

### 9.2 Metrics

Prometheus-style counters/gauges (StatsD via `node-statsd` or Prom client). Core metrics:

```
panel.requests.count{platform,route,status}
panel.requests.duration{platform,route} (histogram)
panel.ws.connected{platform} (gauge)
panel.sessions.active{platform} (gauge)
panel.jobs.enqueued{platform,kind} (counter)
panel.jobs.duration{platform,kind} (histogram)
panel.jobs.failed{platform,kind,reason} (counter)
panel.proxies.healthy{platform} (gauge)
panel.subscriptions.active{platform} (gauge)
panel.subscriptions.expired_today{platform} (counter)
```

### 9.3 Tracing

OpenTelemetry middleware on Express + auto-instrument BullMQ. Tag spans with `platform`. Export to Jaeger / Honeycomb / Datadog.

### 9.4 Alerts (recommended set)

- `WS connected_count` drops > 30% in < 5 min → likely panel-pod restart loop.
- `jobs.failed{kind=scrape,platform=instagram} / total > 0.30 over 30 min` → Instagram detection wave; pause new scrapes.
- `proxies.healthy{platform=instagram} < 50` → refill the pool.
- `subscriptions.active{platform=instagram} - subscriptions.expired_today{platform=instagram} < 0` → revenue churn signal.

---

## 10. Phased rollout plan

### Phase 0 — Pre-work (no user impact)

- Add `platform_type` enum + `platform` columns + indexes (migration `v9_multiplatform`).
- Add `user_subscriptions` table + backfill.
- Refactor `subscriptionService` to read/write `user_subscriptions` (still hard-coded `platform='telegram'`).
- Refactor `requireApproved` to take `(platform, feature)` (still defaults `platform='telegram'`).
- Wire URL prefix `/api/telegram/*` and keep `/api/*` as a backwards-compat alias.
- All existing functionality unchanged. Ship to prod.

### Phase 1 — Provider abstraction (no user impact)

- Extract Telegram services into `backend/src/providers/telegram/`. No behavior change.
- Add `backend/src/providers/index.js` registry.
- Refactor controllers to call `getProvider(req.platform).<noun>.<verb>(...)`.
- Frontend: extract `PlatformProvider` skeleton (locked to `telegram`), API client interceptor adds `X-Platform: telegram`. No UI change.
- Ship to prod.

### Phase 2 — Instagram backend (alpha, internal)

- Add `backend/src/providers/instagram/` — sessions, login, scrape, messaging, threads, accountSettings, identity, proxies, twoFA, otp, privacy.
- Add Instagram migrations (`v9_2_instagram_extras`).
- Add `messaging:instagram`, `scrape:instagram`, etc. queues.
- New routes mounted at `/api/instagram/*`.
- No frontend yet. Tested via curl + admin tools.

### Phase 3 — Frontend platform routing (alpha, behind feature flag)

- Switch React Router to `:platform` param.
- Add `PlatformProvider`, theme tokens, `data-platform` root attribute.
- Add header toggle (next to Bell).
- Migrate existing pages to relative routes.
- Add `Threads.jsx` (Instagram DM threads page).
- Per-page changes from §6.9.
- Feature flag: `localStorage.feature_instagram_panel === '1'` gates the toggle. Internal users only.

### Phase 4 — Instagram billing + bundle (alpha → beta)

- Per-platform billing UI (two cards + bundle).
- OxaPay invoice creation accepts `platform`.
- IPN extends the right `user_subscriptions` row.
- Trial flow per platform.
- Promo banner: "Bundle for $X/mo, save Y%".

### Phase 5 — Capacity hardening (beta)

- Worker affinity routing if `WORKER_POD_COUNT >= 2`.
- pgbouncer in prod.
- Socket.IO Redis adapter rolled out.
- Per-platform proxy validators wired in.
- OPS.md updated.

### Phase 6 — GA

- Remove the feature flag.
- Announce.
- Decommission the legacy `/api/*` (non-prefixed) routes after a deprecation window.

Each phase ships behind a feature flag where applicable, with a documented rollback path (drop the new tables, flip the flag, redeploy).

---

## 11. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Instagram detection bans accounts en masse during early rollout | High | High | Conservative rate limits (§5.7), per-session sticky proxies, country-matched proxies, behavior simulator on by default, per-user account caps. Surface "soft-fail" challenges to the user instead of retrying. |
| `instagram-private-api` library falls behind Instagram protocol changes | Medium | High | Vendor in a fork, CI smoke tests against a pool of canary accounts, keep the Python `instagrapi` sidecar option warm. |
| Multi-platform schema migration locks Postgres in prod | Low | High | Run migrations off-hours; all DDL in `v9_*` is `ADD COLUMN ... NOT NULL DEFAULT ...` (Postgres ≥ 11 = constant-time) + later `ALTER COLUMN SET NOT NULL` with backfill done in a separate online step. |
| Toggle UX feels slow on slow devices | Low | Medium | Use CSS variables (browser-side, instant) instead of re-rendering everything; preload the lazy chunks for the other platform's pages. |
| Subscription split breaks existing TG users | Low | High | Phase 0 ships behind a feature-flag flip in `subscriptionService` that reads from both `users.subscription_*` (legacy) and `user_subscriptions`. We backfill in the same migration; a release-2 migration removes the legacy mirror. |
| Bundle billing causes double-charge / accounting drift | Low | Medium | Single OxaPay invoice with `platform='bundle'`; IPN handler runs both `grantSubscription` calls in one DB TX, with the same `granted_until`. Subscription events log `bundle:tg_plus_ig`. |
| WS broadcast amplification at 2k+ users | Medium | Medium | Per-platform rooms (§4.8), Redis adapter (§7.6), event-payload trimming. |
| Free proxy pool depletes for Instagram quickly | Medium | Medium | Bigger pool size for IG (§7.8), recommend paid proxies in OPS, monthly budget line item. |

---

## 12. Acceptance criteria

A scenario-driven checklist that PR authors and QA can run against:

1. **AC-1: Single-account, dual-panel.** A new user registers, sees Telegram billing first (default platform = telegram), pays for Telegram, lands on `/tg/dashboard`. The Instagram toggle is reachable but routes to `/ig/billing`. Activating the Instagram trial routes them to `/ig/dashboard`. The TG and IG subscriptions have independent expiries.
2. **AC-2: Toggle smooth.** Toggling between platforms while on `/tg/sessions` → `/ig/sessions` transitions in < 300 ms with no full reload, no flash of unstyled content, theme variables visibly change.
3. **AC-3: Toggle to a panel without entitlement.** From `/tg/dashboard`, toggling to Instagram (no IG subscription) navigates to `/ig/billing` with a banner explaining why.
4. **AC-4: Existing Telegram users unaffected.** All existing `/api/*` paths return identical payloads via the backwards-compat alias. Existing browsers reload and end up on `/tg/*`.
5. **AC-5: Instagram session creation works end-to-end.** User can `start → verify (2FA) → challenge → active`, then download a plaintext IG state JSON, re-upload it, and log in successfully again.
6. **AC-6: Instagram messaging respects caps.** A 50-target DM blast on a 24-hour-old account is split into 2 days automatically; 30/day cap surfaced in the UI.
7. **AC-7: Capacity.** A staged load test sustains 2000 concurrent users (1000/platform) for 1 hour with p95 HTTP < 500 ms and zero WS disconnections from the server side.
8. **AC-8: Per-platform billing IPN.** OxaPay IPN for an Instagram invoice extends `user_subscriptions WHERE user_id=X AND platform='instagram'` and *does not* touch the Telegram row. Bundle invoice extends both.
9. **AC-9: Capability degradation.** When the IG provider returns `capabilities.groupAddRemove = false`, the IG sidebar does not show "Groups" and `/ig/groups` redirects to dashboard.
10. **AC-10: Admin parity.** Admin can grant, revoke, and audit subscriptions per-platform from the Admin page.
11. **AC-11: Observability.** Prometheus shows `panel.sessions.active{platform="instagram"}` rising as users add IG accounts.
12. **AC-12: Rollback.** Flipping `WORKER_POD_COUNT=1` and the feature flag returns the system to single-pod, single-platform behavior with no data loss.

---

## 13. Appendices

### A. New env vars introduced by this plan

| Var | Default | Notes |
|---|---|---|
| `WORKER_POD_COUNT` | `1` | Enables affinity routing when `>= 2`. |
| `INSTAGRAM_HEARTBEAT_INTERVAL_MS` | `60000` | Mirrors `SESSION_HEARTBEAT_INTERVAL_MS`. |
| `INSTAGRAM_BEHAVIOR_ENABLED` | `true` | Mirrors `BEHAVIOR_ENABLED`. |
| `INSTAGRAM_BEHAVIOR_TICK_INTERVAL_MS` | `300000` | 5 min, jittered. |
| `INSTAGRAM_DEFAULT_PROXY_COUNTRY` | unset | Optional ISO-3166 country code. |
| `RATE_LIMIT_TG_MAX` | `5000` | Per `RATE_LIMIT_WINDOW`. |
| `RATE_LIMIT_IG_MAX` | `2000` | Per `RATE_LIMIT_WINDOW`. |
| `MESSAGING_IG_DAILY_CAP_DEFAULT` | `30` | Overridable per `system_settings`. |
| `INSTAGRAM_PROVIDER_BACKEND` | `node` | `node` (dilame) or `python` (instagrapi sidecar). |

### B. New API surface

```
GET    /api/<platform>/dashboard              (existing per-platform dashboard)
GET    /api/<platform>/sessions               list
POST   /api/<platform>/sessions/upload        bulk upload
POST   /api/<platform>/sessions/create/start
POST   /api/<platform>/sessions/create/verify
POST   /api/<platform>/sessions/create/password
POST   /api/<platform>/sessions/create/challenge   (IG only)
POST   /api/<platform>/sessions/create/resend
POST   /api/<platform>/sessions/create/cancel
GET    /api/<platform>/sessions/:id
GET    /api/<platform>/sessions/:id/download   (plaintext, per PR #14 contract)
POST   /api/<platform>/sessions/:id/login
POST   /api/<platform>/sessions/:id/logout
GET    /api/<platform>/sessions/:id/status
DELETE /api/<platform>/sessions/:id
GET    /api/<platform>/capabilities            { capability flags map }
... (same shape for scrape, messaging, threads/groups, lists, reports,
     proxies, anti-detect, privacy, account-settings, change-2fa, get-otp)

GET    /api/billing/status                     returns both platform subs
POST   /api/billing/subscribe                  body: { platform, plan? }
POST   /api/billing/trial/start                body: { platform }
GET    /api/billing/invoices?platform=         filter
POST   /api/billing/oxapay/ipn                 unchanged (raw body)

GET    /api/admin/users?platform=&...
PATCH  /api/admin/users/:id/subscription/:platform
GET    /api/admin/payment-invoices?platform=
```

### C. New file layout (proposed)

```
backend/src/
├── providers/
│   ├── index.js
│   ├── telegram/
│   │   ├── index.js
│   │   ├── sessions.js
│   │   ├── interactive.js
│   │   ├── scrape.js
│   │   ├── messaging.js
│   │   ├── groups.js
│   │   ├── lists.js
│   │   ├── reports.js
│   │   ├── otp.js
│   │   ├── twoFA.js
│   │   ├── privacy.js
│   │   ├── proxies.js
│   │   ├── identity.js
│   │   └── behavior.js
│   └── instagram/
│       ├── index.js
│       ├── client.js
│       ├── sessions.js
│       ├── interactive.js
│       ├── scrape.js
│       ├── messaging.js
│       ├── threads.js
│       ├── lists.js
│       ├── reports.js
│       ├── otp.js
│       ├── twoFA.js
│       ├── privacy.js
│       ├── accountSettings.js
│       ├── proxies.js
│       ├── identity.js
│       └── behavior.js
├── services/                  (existing; trimmed to "platform-agnostic" only)
│   ├── subscriptionService.js
│   ├── oxapayService.js
│   ├── systemSettingsService.js
│   ├── userApiCredentialsService.js   (still TG-only, but lives here)
│   ├── reportService.js               (platform-agnostic core; per-platform aggregations come from providers)
│   ├── listService.js                 (platform-agnostic CRUD)
│   └── proxyService.js                (platform-agnostic pool; per-platform validators come from providers)
├── routes/                    (one router per feature; mounted twice with platform prefix)
├── controllers/               (refactored to thread req.platform)
├── queues/
│   ├── index.js
│   ├── scrapeQueue.js         (now exports a factory: scrapeQueue.for(platform))
│   ├── messageQueue.js        (factory)
│   ├── groupQueue.js          (factory)
│   └── twoFAQueue.js          (factory)
├── middleware/
│   ├── auth.js                (requireApproved(platform, feature))
│   ├── platform.js            (NEW: parsePlatform middleware)
│   └── rateLimiter.js         (per-platform buckets)
├── config/
│   ├── database.js
│   ├── redis.js
│   ├── schema.sql
│   ├── migration_v9_multiplatform.sql
│   ├── migration_v9_2_instagram_extras.sql
│   └── migration_v9_3_subscription_split.sql
└── index.js                   (mounts /api/<platform>/* twice + /api/* alias)

frontend/src/
├── App.jsx                    (:platform routing)
├── context/
│   ├── AuthContext.jsx
│   └── PlatformContext.jsx    (NEW)
├── state/
│   └── platform.js            (NEW: reads/sets the active platform from anywhere)
├── theme/
│   └── platform-tokens.css    (NEW: :root[data-platform="..."] vars)
├── api/
│   ├── client.js              (platform interceptor)
│   └── ... (per-feature modules unchanged)
├── components/
│   ├── layout/
│   │   ├── Layout.jsx
│   │   ├── Header.jsx         (toggle next to Bell)
│   │   ├── PlatformToggle.jsx (NEW)
│   │   └── Sidebar.jsx        (capability-driven)
│   └── common/                (Modal/Toast/DataTable/...)
├── hooks/
│   ├── useAuth.js
│   ├── usePlatform.js         (NEW)
│   └── useWebSocket.js
├── pages/
│   ├── Login.jsx, Register.jsx, Pending.jsx, Admin.jsx
│   ├── Billing.jsx            (per-platform + bundle)
│   ├── Dashboard.jsx, Sessions.jsx, CreateSession.jsx
│   ├── Scrape.jsx, Messaging.jsx, Groups.jsx
│   ├── Threads.jsx            (NEW; IG-only)
│   ├── Lists.jsx, Reports.jsx, AccountSettings.jsx
│   ├── Change2FA.jsx, GetOTP.jsx, Proxies.jsx
│   ├── AntiDetect.jsx, Privacy.jsx, Settings.jsx
│   └── ...
└── utils/
    └── formatters.js
```

### D. Tests / test matrix

A coarse list, not a full test plan:

- Unit: provider interface contract tests run **identically** against telegram and instagram providers.
- Unit: subscription gate matrix (admin, banned, no-sub, active-sub, trial-active, trial-feature-not-allowed) × (telegram, instagram).
- Integration: OxaPay IPN end-to-end for telegram, instagram, bundle.
- Integration: session create flow for instagram with mocked `instagram-private-api` returning each of `success / 2FA / checkpoint / feedback_required`.
- E2E (Playwright): toggle, billing redirect, page parity, session upload+download roundtrip.
- Load: k6 ramping to 2k concurrent WS + 600 RPS for 30 min.
- Chaos: kill one panel-pod and one worker-pod; verify session pinning re-routes.

### E. Open questions to resolve before Phase 2

1. Does the operator want per-platform pricing or a single price across both?
2. Bundle pricing target?
3. Should Instagram trial duration mirror Telegram (5 min default) or be longer (e.g., 10 min) given the higher checkpoint friction?
4. Are there geographic restrictions on Instagram automation we need to surface?
5. Do we want a Python `instagrapi` sidecar from day one for richer features (Reels Insights), or defer?

These don't block the plan; they affect defaults, not architecture.

---

## 14. TL;DR

- One user, one JWT, two panels.
- A `platform` enum gets threaded through the data model, services, routes, queues, sockets, and the frontend.
- Telegram code gets repackaged as a `telegramProvider`; an `instagramProvider` is built on `instagram-private-api` (Node, in-process) following the same interface.
- Subscriptions split into per-platform rows; the toggle in the header (next to the bell) flips the URL/theme/sidebar, and routes you to billing for any platform you don't own.
- Theme uses CSS variables driven by `<html data-platform>` so flipping is a CSS-only repaint.
- Capacity for 1000 concurrent users per panel is reached with 2 panel-pods + per-platform worker pods, pgbouncer, the Socket.IO Redis adapter, and a larger proxy pool (~800 working entries split 400/400). Affinity routing pins sessions to worker pods.
- Phased rollout: schema + abstraction first (no user impact), then Instagram backend, then frontend toggle behind a flag, then billing, then capacity hardening, then GA.
- Acceptance criteria are scenario-based and cover the toggle UX, dual subscriptions, end-to-end Instagram login, capacity, and rollback.
