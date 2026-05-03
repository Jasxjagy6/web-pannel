# BYO PROXY — Bring-Your-Own Proxy & Per-User Proxy Ownership

> **Status:** Draft v1 · **Scope:** institutional-grade per-user egress isolation for both Telegram and Instagram panels · **Companion documents:** [`TG_ANTI_REVOKE_PROPOSAL.md`](./TG_ANTI_REVOKE_PROPOSAL.md), [`IG_ANTI_BAN_PROPOSAL.md`](./IG_ANTI_BAN_PROPOSAL.md)

---

## 0. TL;DR — what this proposal does, in one screen

Today the panel ships with a **shared, admin-curated proxy pool**:

- A single `proxies` table (no `user_id` column) is owned by the admin.
- The proxy pool is filled by a background scraper that pulls from public lists (`TheSpeedX/PROXY-List`, `hookzof/socks5_list`, `zloi-user/hideip.me`).
- Manual paid proxies live in the same table, also un-owned (`source = 'manual'`).
- When a user logs in to a Telegram or Instagram session, the panel auto-binds the session to whatever working row from the shared pool has free capacity (`max 4 sessions / IP`).
- Result: customer A's Telegram session and customer B's Instagram session may egress through the **same IP** today. From an institutional anti-revoke / anti-ban posture, this is **wrong** — every customer should bring their own egress and never share with another customer.

What we're building, in 4 phases:

| Phase | Deliverable | Deploy unit |
|------|-------------|-------------|
| **Phase 1** | Schema migration v14 — add `user_id` ownership to `proxies`, label / country / notes / health columns, partial unique constraints, backfill admin-owned rows. **Plus** minimal user-scoped service stubs (read-only first). | PR #30 (this PR) |
| **Phase 2** | Backend enforcement — full user-scoped CRUD, ownership guards, `REQUIRE_USER_PROXY` policy, subscription entitlement (`byo_proxy` feature), per-proxy health probe, integration with `assignProxyForSession` / IG `proxy_url`. | PR #31 |
| **Phase 3** | Frontend — user-facing Proxies page, "Egress proxy" picker on Add Account flow, Sessions list "Proxy" column with health pill, upgrade CTA for non-subscribers, admin proxy pool tab kept under `/admin`. | PR #32 |
| **Phase 4** | Smoke + e2e — ownership isolation matrix, `REQUIRE_USER_PROXY` blocks, entitlement gate, browser walk-through (desktop + mobile), recording, PR comment. | PR #33 |

The work is split this way so each PR is independently reviewable, the schema migration can soak in production for one release before enforcement kicks in, and frontend can be A/B'd behind a settings flag.

---

## 1. Threat model: why per-user proxy is non-negotiable

Both Telegram and Instagram revoke / ban based on **per-IP correlation**. The relevant signals:

### 1.1 Telegram (auth-key revocation)

From `TG_ANTI_REVOKE_PROPOSAL.md` §1.4 — the auth_key is bound at first sign-in to:

- The DC the sign-in landed on (`auth.signIn` → DC2 / DC4 / etc.)
- The `langPack`, `systemLangCode`, `langCode` reported at connect
- The `device_model` / `system_version` / `app_version`
- **The egress IP** at the time of `auth.signIn`

When the same auth_key reconnects later from a **wildly different IP** — different ASN, different country, different DC mapping — Telegram interprets this as either (a) the user manually moved (rare, slow), or (b) the auth_key was exfiltrated and is being reused. The latter case is what gets the auth_key burned via `AUTH_KEY_DUPLICATED` or a silent revoke that surfaces as `AUTH_KEY_UNREGISTERED` on the next call.

When **two different auth_keys for two different accounts** egress through the same IP / ASN, especially residential-IP space that's never seen Telegram traffic from this account before, both keys land on Telegram's "shared infrastructure" cluster and get correlated. The cluster's revocation rate goes up the more accounts share the IP. A panel that egresses customer-A's account and customer-B's account through the same residential IP is **building a co-occurrence graph for Telegram's anti-spam team**.

### 1.2 Instagram (`checkpoint_required`, `feedback_required`)

From `IG_ANTI_BAN_PROPOSAL.md` §1.2 — Instagram's mobile API blocks egress IPs in three buckets:

1. **Hosting-ASN data-centre IPs** are blocked outright at the L4 layer for the mobile-app endpoints. The panel host's egress IP (a VPS) trips this on the first request → `403 Forbidden` or `checkpoint_required`.
2. **High-density residential IPs** (proxies that have served > N Instagram sessions in 24 h) get progressively rate-limited and start returning `feedback_required` (a 4-hour cooldown signal).
3. **Geo-anomalies** — a session that signed up on an IP in country X and is now being used from country Y triggers a checkpoint.

The panel's existing v11 migration *already* added a per-session `proxy_url` column for Instagram, and `providers/instagram/client.js` *already* enforces `PROXY_REQUIRED` when `security.instagram.require_proxy = true`. What's missing is: **the proxy itself isn't owned by the user** — it's a free-text URL that anyone with API access could overwrite, and it isn't linked to a row that proves "user X owns this proxy and only their sessions can use it".

### 1.3 Concrete revocation scenarios this fixes

| Scenario | What goes wrong today | What this proposal fixes |
|----------|----------------------|--------------------------|
| Customer A and Customer B both run 4 TG sessions through the same shared proxy row (because the pool has only 5 working IPs and `MAX_SESSIONS_PER_PROXY=4`) | Both customers' auth_keys land in the same IP cohort. If A starts spamming and gets a flood-wait, B's sessions enter the same Telegram anti-spam cluster. | Each customer's sessions egress through *their* proxy. Customer B's risk score doesn't move when Customer A misbehaves. |
| Customer A adds a residential proxy in country IN. Customer B's session somehow gets auto-bound to the same proxy (because the assignment loop ignored ownership) | Customer A's residential-IP credit gets burned by Customer B's traffic; A's sessions start hitting the per-IP density limit on Telegram. | Ownership-guarded `assignProxyForSession(sessionId, ownerUserId)` rejects cross-user binding. |
| A user uploads a pre-existing Telegram session file that was created on a residential IP in country US. The panel binds it to a free SOCKS5 proxy in country RU (whatever has capacity) | First reconnect after upload: `AUTH_KEY_DUPLICATED` → revoke. | The user is forced to pick their own proxy that matches the session's region (or a fallback the user explicitly accepts). |
| Free proxy scraper pulls 200 IPs from public lists. ~30 of them are also being scraped by 200 other bot panels in the wild. | The panel binds new sessions to those over-shared IPs and they get instant flagging. | `REQUIRE_USER_PROXY=true` removes the public-list scraper from the user-facing flow entirely; it stays as an admin-only diagnostic. |
| A trial user signs up, adds 5 sessions, never pays, leaves. Their 5 sessions sit on shared proxies indefinitely. | Sessions consume shared-pool capacity and pollute the IP density. | `byo_proxy` is a subscription feature; trial users can use the panel but cannot bind new sessions to BYO proxies, which keeps them on a clearly-marked "trial-only shared sandbox" that an admin can isolate or rotate. |

---

## 2. Current state — full audit

### 2.1 Schema (`backend/src/config/`)

#### `migration_v2_upgrades.sql` (current proxy table — *no user ownership*)

```sql
CREATE TABLE IF NOT EXISTS proxies (
  id SERIAL PRIMARY KEY,
  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL,
  protocol VARCHAR(20) NOT NULL DEFAULT 'socks5'
    CHECK (protocol IN ('socks5', 'socks4', 'http', 'https', 'mtproto')),
  username VARCHAR(255),
  password_enc TEXT,
  secret VARCHAR(255),                    -- mtproto secret (hex)
  source VARCHAR(20) NOT NULL DEFAULT 'free'
    CHECK (source IN ('free', 'manual')),
  is_working BOOLEAN NOT NULL DEFAULT FALSE,
  priority INTEGER NOT NULL DEFAULT 0,
  active_assignments INTEGER NOT NULL DEFAULT 0,
  total_assignments INTEGER NOT NULL DEFAULT 0,
  last_checked_at TIMESTAMP,
  last_failed_at TIMESTAMP,
  last_latency_ms INTEGER,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  UNIQUE (host, port, protocol)            -- ← global uniqueness; nobody owns a row
);

CREATE TABLE IF NOT EXISTS session_proxy_assignments (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  proxy_id INTEGER NOT NULL REFERENCES proxies(id) ON DELETE CASCADE,
  assigned_at TIMESTAMP NOT NULL DEFAULT NOW()
);
```

#### `migration_v3_antidetect.sql` (denormalised hint)

```sql
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS bound_proxy_id INTEGER;
ALTER TABLE sessions
  ADD CONSTRAINT fk_sessions_proxy
    FOREIGN KEY (bound_proxy_id) REFERENCES proxies(id) ON DELETE SET NULL;
```

#### `migration_v9_multiplatform.sql`

Adds `validated_for_telegram BOOLEAN`, `validated_for_instagram BOOLEAN` on `proxies` so a single proxy can be marked valid against either platform.

#### `migration_v11_instagram_session_columns.sql`

Adds `sessions.proxy_url TEXT` — a per-IG-session free-text proxy URL. This lives **outside** the `proxies` table and is **not** linked to it; it's a parallel system the IG provider uses.

### 2.2 Backend services

#### `backend/src/services/proxyService.js`

- `listProxies({source, working})` — returns **all** rows, no `user_id` filter. Anyone with `requireApproved` can read every other user's manual proxy URL.
- `addManualProxy(payload)` — INSERT into `proxies` with `source='manual'`. No user_id stored. The DB row has no notion of who added it.
- `deleteProxy(id)` — DELETE by id. **No ownership check.** Any approved user could delete any other user's manual proxy row by guessing the id.
- `assignProxyForSession(sessionId)` — picks the highest-priority working row under `MAX_SESSIONS_PER_PROXY=4`, irrespective of session owner. Falls back to `__direct__` (panel-host VPS IP) when `STRICT_PROXY_ISOLATION=false`.
- `reserveAdHoc(key)` / `transferAdHocToSession(key, sessionId)` — same selection logic, used during `auth.SendCode` before the session row exists.
- `refreshFreeProxies()` — scrapes `TheSpeedX/PROXY-List` etc., probes them, inserts into `proxies` with `source='free'`. Runs every 10 min in the background.

#### `backend/src/controllers/proxyController.js`

- `GET /api/proxies` → `listProxies(filter)` (no ownership filter)
- `POST /api/proxies` → `addManualProxy(payload)` (logs activity to `req.user.id` but doesn't link the row to them)
- `POST /api/proxies/refresh` → triggers the scraper (any approved user can trigger this — not just admin)
- `DELETE /api/proxies/:id` → `deleteProxy(id)` (no ownership check)

#### `backend/src/middleware/auth.js`

`requireApproved` already gates routes by:

1. `req.user.role === 'admin'` → bypass everything.
2. `req.user.status === 'banned'` → 403.
3. `req.user.is_approved === false` → 403.
4. `subscriptionService.entitlementFor(user, platform, feature)` → 402 with code `SUBSCRIPTION_REQUIRED` or `TRIAL_FEATURE_NOT_ALLOWED`.

So we already have a working subscription gate; we just need to plumb the new `byo_proxy` feature label through it.

### 2.3 Frontend

- `frontend/src/pages/Proxies.jsx` — single user-facing page at `/proxies`. Shows the **shared admin pool**, including everyone's manual rows. Has an "Add manual proxy" form, a "Scrape & re-validate" button, and a delete button per row. **None of this is scoped to the current user today.**
- `frontend/src/api/proxies.js` — thin client around the four endpoints above.
- `frontend/src/pages/CreateSession.jsx` — Telegram Add Account flow. Has country + platform pickers (PR #29). **No proxy picker.** Auto-binds to the shared pool via `proxyService.reserveAdHoc`.
- `frontend/src/pages/instagram/CreateSession.jsx` — IG Add Account. Free-text `proxyUrl` field passed to `/api/instagram/sessions/create/start`. Not linked to the `proxies` table.
- `frontend/src/pages/Sessions.jsx` — Sessions list. Shows risk pill / DC / device (PR #29) but **no Proxy column**.

### 2.4 Wiring summary

```
[Add Account flow]
   │
   ▼
sessionCreationService.start
   │     proxyService.reserveAdHoc(`creation:${tempId}`)  ← global pool, no owner
   │       └─ INSERT INTO proxies (...)  if scraper just added one
   │       └─ pick from `proxies WHERE is_working=TRUE ORDER BY priority`
   ▼
GramJS / IG client connects via that proxy
   │
   ▼
On success → sessionCreationService.verify
   │     proxyService.transferAdHocToSession(`creation:${tempId}`, sessionId)
   │       └─ INSERT INTO session_proxy_assignments (session_id, proxy_id)
   │       └─ UPDATE sessions SET bound_proxy_id = proxy.id
   ▼
sessionService.loginSession (every restore)
   │     proxyService.assignProxyForSession(sessionId)  ← may pick a *different* proxy
   ▼
GramJS reconnects via that proxy (same OR different from the one used at signIn)
```

The bolded "may pick a different proxy" is the **biggest revocation hazard**: across reboots / restarts, the same auth_key can egress through different IPs because nothing pins it.

---

## 3. Target architecture

### 3.1 Ownership model

```
┌──────────────────────────────────────────────────────────────┐
│  proxies                                                     │
│  ──────                                                      │
│  user_id IS NULL   →  shared admin pool                      │
│                       (legacy free + manual rows live here)  │
│                       only admin can list / mutate           │
│                       only used as a fallback when           │
│                       REQUIRE_USER_PROXY=false (dev mode)    │
│                                                              │
│  user_id = X       →  user X's BYO proxy                     │
│                       only user X (and admin) can list /     │
│                       mutate / bind                          │
│                       FK ON DELETE CASCADE — when the user   │
│                       is deleted, their proxies vanish too   │
└──────────────────────────────────────────────────────────────┘
```

### 3.2 Per-session binding rule (Phase 2)

When a session is created or restored:

1. If `REQUIRE_USER_PROXY=true` (default) **and** the session's owner has at least one working proxy → bind to one of *their* proxies. Fail with `NO_USER_PROXY` (HTTP 412) if they have none.
2. If `REQUIRE_USER_PROXY=false` (dev / single-tenant) → fall through to the legacy admin-pool selection.
3. The bound proxy's `user_id` MUST match the session's `user_id` (or be `NULL` for fallback). The DB enforces this with a CHECK constraint added in v14.

### 3.3 Subscription entitlement (Phase 2)

Add `byo_proxy` to the feature-flag map. The middleware chain becomes:

```js
router.use(authenticate);
router.use(requireApproved('byo_proxy'));   // 402 SUBSCRIPTION_REQUIRED for trial/expired
```

For the trial tier, `byo_proxy` is **not** in `_trialAllowedFeatures` by default — i.e. trial users see the upgrade CTA. Admin can opt-in to allow it on trial via a `system_settings` row.

---

## 4. Phase-by-phase plan

### Phase 1 — Schema migration v14 + read-only stubs (this PR)

**Goal:** Land the schema changes and add user-scoped *read* stubs without changing any runtime behaviour. After Phase 1 deploys, the existing shared pool keeps working exactly as before; nothing is enforced yet.

#### 1.1 New migration `migration_v14_user_proxies.sql`

```sql
-- =====================================================================
-- Migration v14 — Per-user proxy ownership (BYO Proxy)
-- =====================================================================
-- Adds:
--   * proxies.user_id      → FK to users(id) ON DELETE CASCADE; NULL = shared
--   * proxies.label        → human-readable label for the user UI
--   * proxies.country_code → ISO-3166 alpha-2 (e.g. "in", "us") for region match
--   * proxies.notes        → free-text notes the user can attach
--   * proxies.last_health_check / .last_health_ok / .health_message
--   * Partial unique on (user_id, host, port, protocol) WHERE user_id IS NOT NULL
--   * Partial unique on (host, port, protocol)         WHERE user_id IS NULL
--   * Source: enlarge CHECK to include 'user' (BYO proxies created via the user CRUD)
--   * Index on (user_id) and (user_id, is_working)
-- All statements are idempotent (re-runnable).
-- =====================================================================

-- 1. Add new columns.
ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS user_id INTEGER,
  ADD COLUMN IF NOT EXISTS label VARCHAR(120),
  ADD COLUMN IF NOT EXISTS country_code VARCHAR(8),
  ADD COLUMN IF NOT EXISTS notes TEXT,
  ADD COLUMN IF NOT EXISTS last_health_check TIMESTAMP,
  ADD COLUMN IF NOT EXISTS last_health_ok BOOLEAN,
  ADD COLUMN IF NOT EXISTS health_message TEXT;

-- 2. FK constraint with cascade (idempotent: only added if not present).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_proxies_user_id'
  ) THEN
    ALTER TABLE proxies
      ADD CONSTRAINT fk_proxies_user_id
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END$$;

-- 3. Enlarge `source` CHECK to allow 'user' (BYO).
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_source_check;
ALTER TABLE proxies
  ADD CONSTRAINT proxies_source_check
  CHECK (source IN ('free', 'manual', 'user'));

-- 4. Drop the legacy global UNIQUE (host, port, protocol). Replace with two
--    partial uniques so:
--      * the shared admin pool stays globally unique (NULL user_id rows)
--      * each user can have their own (host, port, protocol) without clashing
--        with other users
ALTER TABLE proxies DROP CONSTRAINT IF EXISTS proxies_host_port_protocol_key;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_admin_host_port_protocol
  ON proxies (host, port, protocol)
  WHERE user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_proxies_user_host_port_protocol
  ON proxies (user_id, host, port, protocol)
  WHERE user_id IS NOT NULL;

-- 5. Helpful indexes for the user-scoped list query.
CREATE INDEX IF NOT EXISTS idx_proxies_user_id ON proxies(user_id);
CREATE INDEX IF NOT EXISTS idx_proxies_user_working
  ON proxies(user_id, is_working) WHERE user_id IS NOT NULL;

-- 6. Cross-table integrity: a session_proxy_assignments row's proxy_id MUST
--    belong either to the session's owner or to the shared admin pool.
--    Enforced via a trigger so PG handles the join.
CREATE OR REPLACE FUNCTION enforce_session_proxy_ownership() RETURNS trigger AS $$
DECLARE
  proxy_owner INTEGER;
  session_owner INTEGER;
BEGIN
  SELECT user_id INTO proxy_owner FROM proxies WHERE id = NEW.proxy_id;
  SELECT user_id INTO session_owner FROM sessions WHERE id = NEW.session_id;
  IF proxy_owner IS NOT NULL AND proxy_owner <> session_owner THEN
    RAISE EXCEPTION 'session_proxy_assignment ownership mismatch: proxy.user_id=% session.user_id=%',
      proxy_owner, session_owner
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_session_proxy_ownership ON session_proxy_assignments;
CREATE TRIGGER trg_enforce_session_proxy_ownership
  BEFORE INSERT OR UPDATE ON session_proxy_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_session_proxy_ownership();

-- 7. Backfill: existing 'manual' rows belong to the admin pool conceptually
--    (no ownership today), so we leave their user_id = NULL. They keep
--    behaving as the shared admin pool. Existing 'free' rows likewise stay
--    user_id = NULL.
--    NOTE: the existing __direct__ row stays NULL too — it represents the
--    panel-host VPS IP, owned by the platform operator, not any user.
```

Register the migration in `backend/src/config/database.js` (append to the migrations list).

#### 1.2 Read-only service stubs in `backend/src/services/proxyService.js`

> Phase 1 only adds **listing** with ownership filtering; mutations stay on the existing global functions (which we'll fix in Phase 2). This lets us validate the schema in production for one release before flipping enforcement on.

```js
/**
 * Phase 1 (BYO proxy): list proxies that belong to a specific user.
 * NULL `user_id` means "shared admin pool" — we deliberately exclude
 * those from the user view. Admin gets the full list via /admin/proxies.
 */
async listMyProxies(userId) {
  const r = await pool.query(
    `SELECT id, host, port, protocol, username, source, label, country_code,
            notes, is_working, priority, active_assignments, total_assignments,
            last_checked_at, last_failed_at, last_latency_ms,
            consecutive_failures, last_health_check, last_health_ok,
            health_message, validated_for_telegram, validated_for_instagram,
            metadata, created_at
     FROM proxies
     WHERE user_id = $1
     ORDER BY priority DESC, last_latency_ms NULLS LAST, id ASC`,
    [userId]
  );
  return r.rows.map((p) => ({ ...p, hasPassword: !!p.password_enc }));
}

/**
 * Phase 1: list the shared admin pool. Used by the /admin/proxies endpoint
 * (admin only) for the Admin → Proxy pool tab.
 */
async listAdminProxies(filter = {}) {
  // (existing listProxies body, with user_id IS NULL filter prepended)
}
```

#### 1.3 Phase 1 controller / route changes — *minimal*

We do **not** flip the existing `/api/proxies` GET to user-scoping in Phase 1. Doing so would visibly remove proxies from the existing UI that no client is ready for. Instead:

- Add a new endpoint `GET /api/me/proxies` → `proxyController.listMyProxies` (returns rows with `user_id = req.user.id`).
- Existing endpoints stay untouched. Phase 2 deprecates them.

#### 1.4 Phase 1 smoke

A single new test file `backend/src/__tests__/userProxy.phase1.smoke.test.js` covers:

| # | Assertion | How |
|---|-----------|-----|
| P1.1 | Migration v14 applies cleanly on a database that already has v2 + v9 + v11 | spin up postgres, run all migrations, check `\d proxies` shows the new columns |
| P1.2 | Re-running v14 is idempotent | run it twice, assert no errors and unchanged column set |
| P1.3 | Backfill leaves existing `'manual'` and `'free'` rows with `user_id IS NULL` | seed a row pre-migration, run migration, assert `user_id` is NULL |
| P1.4 | Inserting a row with `user_id = X` and the same `(host, port, protocol)` as an admin row is allowed (different unique partial indexes) | seed admin row, insert user row, expect success |
| P1.5 | Inserting two rows with the same `(user_id, host, port, protocol)` fails with 23505 | seed user row, attempt duplicate, expect `23505` |
| P1.6 | Trigger `trg_enforce_session_proxy_ownership` rejects a binding where `proxy.user_id <> session.user_id` | seed user-A proxy, seed user-B session, attempt binding, expect raised exception |
| P1.7 | `listMyProxies(userId)` excludes admin-pool rows | seed admin row + user row, call list, expect only user row |
| P1.8 | `listAdminProxies()` returns only `user_id IS NULL` rows | seed both, call list, expect only admin row |

#### 1.5 Phase 1 migration safety

- `ALTER TABLE … ADD COLUMN IF NOT EXISTS` is metadata-only on PG ≥ 11, so this is safe on a live DB.
- The `CREATE TRIGGER` on `session_proxy_assignments` only fires on INSERT/UPDATE going forward — existing rows are not retroactively validated. The audit script (Phase 1.6) reports any cross-user binding that already exists so admin can manually re-bind.
- No data is deleted or moved in Phase 1.

#### 1.6 Phase 1 audit script

A standalone node script `backend/scripts/audit-proxy-ownership.js`:

```
$ node scripts/audit-proxy-ownership.js
Cross-user proxy bindings found:
  session_id=42 (user_id=7)  →  proxy_id=11 (user_id=NULL, source=free)   [OK: admin pool]
  session_id=88 (user_id=12) →  proxy_id=11 (user_id=NULL, source=free)   [OK: admin pool]
  session_id=...
Phase 1 report: 0 ownership violations, 41 admin-pool bindings.
```

Phase 2 will block any **new** cross-user binding via the trigger; this audit gives admin a list of existing sessions to migrate.

---

### Phase 2 — Backend enforcement (PR #31)

**Goal:** make `user_id`-scoped CRUD the canonical API, add `REQUIRE_USER_PROXY` enforcement, gate by `byo_proxy` subscription feature, integrate per-proxy health probe.

#### 2.1 New `proxyService` methods (full)

```js
// All mutations take userId as the first arg; the service enforces
// ownership at every step (NEVER trust just the controller).

async listMyProxies(userId)                           // Phase 1
async getMyProxy(userId, proxyId)                     // ownership-checked SELECT
async addMyProxy(userId, payload)                     // validates payload, INSERT user_id=userId, source='user'
async deleteMyProxy(userId, proxyId)                  // DELETE WHERE id=$ AND user_id=$
async testMyProxy(userId, proxyId)                    // probe + write last_health_*
async validateMyProxyForPlatform(userId, proxyId, p)  // sets validated_for_telegram/instagram

// Bound-proxy lifecycle:
async assignUserProxyToSession(userId, sessionId, proxyId)
   // Pre-conditions:
   //   * proxy.user_id === userId
   //   * session.user_id === userId
   //   * session.bound_proxy_id IS NULL OR matches an old user proxy
   // Atomic: BEGIN → SELECT FOR UPDATE on both rows → INSERT/UPSERT into
   //         session_proxy_assignments → UPDATE sessions.bound_proxy_id

async pickProxyForSession(userId, sessionId)
   // Implementation:
   //   1. If session.bound_proxy_id and proxy.is_working and proxy.user_id=userId → return it
   //   2. Else pick the user's highest-priority working proxy
   //   3. If REQUIRE_USER_PROXY=true and step 2 returned nothing → throw NO_USER_PROXY
   //   4. Else fall through to legacy admin-pool selection
```

#### 2.2 Env flag

```
# Default: true. When true, sessions require a BYO proxy owned by the same
# user. Set to false for single-tenant dev installations or for installations
# that explicitly want the legacy shared admin pool.
REQUIRE_USER_PROXY=true
```

Read once at boot from `process.env.REQUIRE_USER_PROXY` and cached on the proxy service. Hot-reloadable via the admin panel system_settings (key `security.require_user_proxy`).

#### 2.3 Subscription entitlement

In `subscriptionService._trialAllowedFeatures`:

- Default `byo_proxy` is **NOT** on the trial-allowed list. Trial users get a 402 with `TRIAL_FEATURE_NOT_ALLOWED` if they try to add a BYO proxy.
- Admin can override per-installation by setting the `billing.<platform>.trial_allowed_features` array to include `byo_proxy`.

Routes:

```js
// backend/src/routes/userProxies.js (NEW — replaces /proxies in Phase 2)
router.use(authenticate);
router.use(requireApproved('byo_proxy'));   // 402 if no entitlement
router.get('/',           ctrl.listMyProxies);
router.post('/',          ctrl.addMyProxy);
router.post('/:id/test',  ctrl.testMyProxy);
router.delete('/:id',     ctrl.deleteMyProxy);

// backend/src/routes/admin.js — kept admin-only
router.get('/proxies',          ctrl.listAdminProxies);   // full pool view
router.post('/proxies/refresh', ctrl.refreshFreePool);    // admin-only scrape
router.delete('/proxies/:id',   ctrl.deleteAdminProxy);
```

#### 2.4 Health probe — `testMyProxy(userId, proxyId)`

The health probe goes beyond "TCP connect to host:port":

1. **L4 reachability** — `net.connect(host, port)` with 8 s timeout (existing `probeProxy`).
2. **L7 egress fingerprint** — when `protocol = socks5/socks4/http/https`, tunnel a request to `https://api.ipify.org?format=json` through the proxy and read the egress IP. Store as `metadata.egress_ip` and `metadata.egress_country` (via MaxMind lookup if `GEOIP_DB_PATH` is set, else null).
3. **MTProto reachability** — a real `auth.PingDelayDisconnect` to DC4 IPv4 (149.154.167.51:443) via the proxy. This is what Telegram clients actually do at boot; if it fails, the proxy is not Telegram-usable.
4. **Instagram reachability** — `https://i.instagram.com/api/v1/qe/sync/` GET (no auth, returns 200 or 401, both indicate the IP isn't blocked at L4). If `403` comes back the proxy is data-centre-banned for IG and we set `validated_for_instagram = false` with `health_message='instagram_403_dc_block'`.

Health is rerun:

- On user demand (`POST /api/me/proxies/:id/test`)
- Every 10 minutes for any proxy with at least one bound session (background tick)
- On every session restore that picks the proxy (lazy)

#### 2.5 Integration with `assignProxyForSession`

Existing call sites (`sessionService.loginSession`, `telegramService`, `sessionCreationService`) gain an `ownerUserId` argument. The signature is back-compat — when the legacy single-arg form is used the service falls through to the admin pool unconditionally.

```js
// Before:
const row = await proxyService.assignProxyForSession(sessionId);

// After:
const row = await proxyService.assignProxyForSession(sessionId, ownerUserId);
//   → throws NO_USER_PROXY (HTTP 412) if REQUIRE_USER_PROXY=true and the
//     user has no working proxy.
```

For Instagram, where the proxy is stored on the session row as `proxy_url`, Phase 2 also adds a synchroniser:

- When `assignProxyForSession` writes `bound_proxy_id`, it also writes `sessions.proxy_url` to the URL-form representation of the proxy (e.g. `socks5://user:pass@host:port`) so the existing IG `client.js` enforcement (`PROXY_REQUIRED`) keeps working without changes.

#### 2.6 Phase 2 smoke

| # | Assertion |
|---|-----------|
| P2.1 | `addMyProxy` writes `user_id = req.user.id`, `source = 'user'` |
| P2.2 | `addMyProxy` rejects a payload with `(host, port, protocol)` already owned by **another** user with 23505 (different per-user uniques) |
| P2.3 | `addMyProxy` allows the same `(host, port, protocol)` if the same user already has it deleted (insert-after-delete works) |
| P2.4 | `deleteMyProxy(userId=A, id=row_owned_by_B)` returns 404 (not 403) — never leak existence |
| P2.5 | `testMyProxy` writes `last_health_*` and a populated `metadata.egress_ip` for a known-good public proxy |
| P2.6 | `pickProxyForSession(userId, sessionId)` with `REQUIRE_USER_PROXY=true` and no user proxy throws `NO_USER_PROXY` (HTTP 412) |
| P2.7 | `assignUserProxyToSession(userId, sessionId, proxyId)` writes both `session_proxy_assignments` and `sessions.bound_proxy_id` and `sessions.proxy_url` |
| P2.8 | The trigger `trg_enforce_session_proxy_ownership` blocks an attempt to bind user-A's session to user-B's proxy with `check_violation` |
| P2.9 | `requireApproved('byo_proxy')` returns 402 with `TRIAL_FEATURE_NOT_ALLOWED` for a trial user |
| P2.10 | Admin (`role='admin'`) bypasses both the entitlement gate and the ownership trigger (admin can list / mutate any proxy) |

---

### Phase 3 — Frontend (PR #32)

**Goal:** ship the user-facing UX for BYO proxy across Telegram + Instagram panels. No backend changes.

#### 3.1 Pages

##### `frontend/src/pages/Proxies.jsx` — rewrite as user-facing My Proxies

- Calls `GET /api/me/proxies` via a new `frontend/src/api/userProxies.js` module.
- Header copy: "Your egress proxies — every Telegram or Instagram account you add will route through one of these IPs. The panel never auto-binds your sessions to anyone else's IP."
- Empty state: "You haven't added any proxies yet. Each subscription includes BYO proxy. We recommend a residential SOCKS5 / HTTP proxy in the same country as the account you're going to add."
- Add form: `label`, `host`, `port`, `protocol`, `username`, `password`, `country_code` (dropdown of 27 countries reused from `CreateSession.jsx`), `notes`. No more "priority" field — it's per-user so priority is irrelevant.
- Per-row actions: **Test** (calls `POST /api/me/proxies/:id/test`), **Delete**, **Edit label/notes**.
- Per-row chips: country flag, protocol, `egress_ip`, TG-validated, IG-validated, last-checked-at relative time.
- No "Refresh free pool" button — that's admin-only now.

##### `frontend/src/pages/admin/AdminProxies.jsx` (NEW — admin pool)

- Lives under `/admin/proxies`, gated by `requireAdmin`.
- Shows the full table of `user_id IS NULL` (admin) rows + the cross-user usage matrix (which sessions are bound to which admin row, by user).
- Keeps the "Scrape free pool" button.
- Surfaces orphan rows where `user_id` was deleted via cascade (defensive).

##### `frontend/src/pages/CreateSession.jsx` — Egress proxy picker (Telegram)

Right above the "Send login code" button, add a new section:

```
Egress proxy *
  [▼ select your proxy]
   ├─ 🇮🇳 IN  · my-residential-1   · socks5  · TG-validated  · last health 3 m ago
   ├─ 🇺🇸 US  · paid-warmer        · http    · TG-validated  · last health 1 h ago
   └─ + Add new proxy …  (opens the Proxies page in a new tab)

   This proxy will be pinned to the session for life. We never auto-rotate
   to a different IP. If your proxy goes down, the session pauses and
   prompts you to assign a new one.
```

If the user has zero proxies: replace the dropdown with a CTA card directing them to add one. Submit is disabled. Same on the IG panel.

When the user is on the trial tier without `byo_proxy` entitlement, replace the picker with the upgrade CTA instead of the dropdown — and the admin-toggle "allow byo_proxy on trial" flag in system_settings shows the picker normally.

##### `frontend/src/pages/Sessions.jsx` — Proxy column

Add a new column right after Device / DC, in the same shape as the existing risk pill:

```
Proxy
─────
🇮🇳 my-residential-1     ← greenhealth dot when last_health_ok
   socks5 · 92.x.x.x

🟡 paid-warmer           ← yellow when health is stale > 1 h
   http · 198.x.x.x

🔴 (proxy deleted)       ← red when bound_proxy_id is NULL or deleted
   Re-bind →
```

Mobile: collapses into a single chip in the card layout.

#### 3.2 New API client `frontend/src/api/userProxies.js`

```js
import api from './client';
export const listMyProxies = () => api.get('/me/proxies');
export const addMyProxy   = (p) => api.post('/me/proxies', p);
export const testMyProxy  = (id) => api.post(`/me/proxies/${id}/test`);
export const deleteMyProxy = (id) => api.delete(`/me/proxies/${id}`);
```

The legacy `frontend/src/api/proxies.js` stays for one release (admin-only fallback).

#### 3.3 Phase 3 smoke

Browser walk-through, scripted via the existing playwright wiring used for PR #28 / #29. Key assertions:

- T1 User on subscription tier sees /proxies page with empty state, can add a proxy, sees it listed with a green health dot after `Test`.
- T2 User on trial tier without `byo_proxy` entitlement sees the upgrade CTA on /proxies and on /create.
- T3 User A cannot see User B's proxies (network tab — `/me/proxies` only returns A's rows).
- T4 Sessions list shows the bound proxy with country flag + health dot.
- T5 Add Account flow refuses to submit without a proxy selected.
- T6 Mobile viewport — proxies page wraps cleanly, picker collapses to native dropdown.
- T7 Admin user sees the `/admin/proxies` tab with the full pool + usage matrix.

---

### Phase 4 — Smoke matrix + e2e (PR #33)

**Goal:** post-merge regression net + browser walk-through video.

- Re-run all Phase 1 and Phase 2 smokes against a clean database.
- Add cross-user-isolation e2e: log in as user A, add proxy A1, log in as user B in a separate browser context, attempt to bind B's session to A1 via the API, expect 404. Document via recording.
- Add a checklist for ops on rolling out `REQUIRE_USER_PROXY=true`:
  1. Run the audit script — make sure all live sessions are bound to admin-pool rows (free / manual) only, or to the right user's proxy.
  2. Email any user with a session pinned to the admin pool: "we'll require BYO proxy in 14 days".
  3. Flip `REQUIRE_USER_PROXY=true` in env and restart the backend.
  4. Re-run audit script: 0 violations expected.
- Post the test report + recording on the PR following the same template as PR #28 / #29.

---

## 5. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| User adds a dead proxy and their existing sessions immediately pause | Health probe runs at add-time and re-runs every 10 min; UI shows the failure clearly with a "Re-bind to a different proxy" CTA. |
| User's only proxy goes down and `REQUIRE_USER_PROXY=true` blocks reconnects | Sessions enter `paused_no_proxy` state, NOT `error`. The auth_key isn't burned; reconnect resumes when a new proxy is added. |
| Trial users feel frustrated by the entitlement gate | The trial-allowed feature list is admin-configurable; an installation can opt to allow `byo_proxy` on trial. |
| Admin-pool rows still exist in production and some sessions are still bound to them | Phase 1 audit + Phase 4 ops checklist; admin can run the audit script before flipping `REQUIRE_USER_PROXY`. |
| Migration v14 fails on a live DB because of a stale lock on `proxies` | Migration runs inside the boot sequence with `IF NOT EXISTS` on every step; a transient lock-wait will simply retry on next boot. We do not wrap v14 in a single transaction so a partial apply still moves forward on retry. |
| Unique partial indexes don't cover ON CONFLICT clauses written for the legacy global UNIQUE | All `ON CONFLICT (host, port, protocol)` callsites in `proxyService.js` are rewritten to `ON CONFLICT (user_id, host, port, protocol) WHERE user_id IS NOT NULL` (or the admin-side variant) in Phase 2. We grep for the conflict string before flipping. |
| Per-user proxies make the admin's existing free-pool scraper irrelevant for end users — does it still serve a purpose? | Yes: it stays as an admin-only diagnostic / sandbox pool. Default policy for end users is BYO; the free pool is only used when `REQUIRE_USER_PROXY=false` (dev mode). |

---

## 6. Out of scope (deliberately)

- **Reselling proxies inside the panel** — i.e. admin sells a proxy subscription as an add-on. That's a billing problem, separate proposal.
- **Geo-aware auto-pick** — picking the user proxy whose `country_code` matches the session's `country` automatically. Phase 2 surfaces both fields; the picker will rank by match, but we don't auto-pick without user consent.
- **Rotating residential pools (Bright Data, Smartproxy etc.)** — supported by host:port:protocol model already; Phase 2 will document the URL format, but we don't ship a vendor-specific integration.
- **Per-session proxy chains** (proxy A → proxy B). Telegram and Instagram clients only support a single hop in the libraries we use.

---

## 7. Sign-off & roll-out

- Phase 1 is **safe to merge anytime** — additive schema, no behaviour change.
- Phase 2 ships behind `REQUIRE_USER_PROXY=false` initially (the install-time default we'll flip to `true` after one release cycle). This gives operators time to backfill BYO proxies for their existing customers.
- Phase 3 is gated by Phase 2 deploy.
- Phase 4 closes the loop with the audit + e2e + recording.

— end —
