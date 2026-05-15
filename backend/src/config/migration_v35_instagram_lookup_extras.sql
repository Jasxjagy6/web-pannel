-- =============================================================================
-- Migration v35 — Instagram identity-lookup extras (PRs #5, #5.5, #6, #7, #8)
-- =============================================================================
-- Adds the schema bits the post-PR-#4 pipeline needs but the v34 foundation
-- didn't carve out:
--
--   * user_lookup_keys     — per-user encrypted API keys for paid providers
--                            (Dehashed / LeakCheck / Snusbase / IntelligenceX /
--                             HIBP / SerpAPI / PimEyes / TinEye / WHOIS-XML /
--                             whoxy / 2captcha).
--   * lookup_api_cache     — 7-day cache for paid-API responses, keyed by
--                            (provider, query_hash). DB-backed mirror of the
--                            Redis cache so a cold panel still warm-starts.
--   * lookup_org_budgets   — per-(user, month) USD cap for PR #8.
--   * lookup_audit_log     — append-only audit trail (operator, IP, purpose,
--                            method, action) with 90-day default retention.
--   * lookup_findings.mask_hash + GIN index — PR #5.5 Oracle 6 alt-account
--     cluster join.
--   * lookup_jobs.retained_until + lookup_jobs.org_id  — PR #8 retention
--     sweeper + per-org budget grouping.
--   * lookup_burners.last_outcome / soft_block_count — PR #8 risk-score
--     dashboard signal.
--   * lookup_watches.cooldown_until / last_diff_summary — PR #7 watch worker
--     bookkeeping.
--
-- All statements idempotent.
-- =============================================================================

-- 1. user_lookup_keys --------------------------------------------------------
-- Per-user encrypted API keys for the paid providers used by the lookup
-- pipeline. `provider` is one of:
--   'dehashed' | 'leakcheck' | 'snusbase' | 'intelligencex' | 'hibp' |
--   'serpapi'  | 'pimeyes'   | 'tineye'   | 'whoisxml'      | 'whoxy' |
--   '2captcha'
-- Each provider may also use the optional `meta` JSONB for things like
-- the Dehashed email username (which Dehashed requires alongside the key).
CREATE TABLE IF NOT EXISTS user_lookup_keys (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider   VARCHAR(40) NOT NULL,
  key_enc    TEXT        NOT NULL,
  meta       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  label      VARCHAR(120),
  is_active  BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_lookup_keys_user_provider
  ON user_lookup_keys (user_id, provider);
CREATE INDEX IF NOT EXISTS idx_user_lookup_keys_user
  ON user_lookup_keys (user_id);

-- 2. lookup_api_cache --------------------------------------------------------
-- 7-day cache for paid-API responses. The Redis cache is the hot path; this
-- table is the cold-start mirror so a freshly-rebooted panel doesn't pay
-- $$$ to rehydrate a watch worker that just ran 12h earlier.
CREATE TABLE IF NOT EXISTS lookup_api_cache (
  id          SERIAL PRIMARY KEY,
  provider    VARCHAR(40) NOT NULL,
  query_hash  VARCHAR(64) NOT NULL,
  query_shape JSONB,
  response    JSONB       NOT NULL,
  cost_usd    NUMERIC(8,4) DEFAULT 0,
  created_at  TIMESTAMP   NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMP   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lookup_api_cache_key
  ON lookup_api_cache (provider, query_hash);
CREATE INDEX IF NOT EXISTS idx_lookup_api_cache_expires
  ON lookup_api_cache (expires_at);

-- 3. lookup_org_budgets ------------------------------------------------------
-- Per-(user, year-month) USD cap on paid-API spend. PR #8 §3 says the
-- enforcement point is BEFORE each paid API call — workers check the cap
-- and short-circuit if spend would exceed it. Per-user instead of per-org
-- because the panel today is single-tenant per user_id; a future migration
-- can add org_id without breaking the API.
CREATE TABLE IF NOT EXISTS lookup_org_budgets (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year_month   VARCHAR(7)   NOT NULL,  -- 'YYYY-MM'
  budget_cap_usd  NUMERIC(10,4) NOT NULL DEFAULT 50,
  spent_usd       NUMERIC(10,4) NOT NULL DEFAULT 0,
  warn_at_pct  SMALLINT     NOT NULL DEFAULT 80,
  hard_block_at_pct SMALLINT NOT NULL DEFAULT 100,
  created_at   TIMESTAMP    NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP    NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lookup_org_budgets_user_month
  ON lookup_org_budgets (user_id, year_month);

-- 4. lookup_audit_log --------------------------------------------------------
-- Append-only audit trail of operator actions on the lookup module.
-- Retention: 90 days default (configurable per-row via `retained_until`).
CREATE TABLE IF NOT EXISTS lookup_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  job_id        INTEGER REFERENCES lookup_jobs(id) ON DELETE SET NULL,
  username      VARCHAR(64),
  action        VARCHAR(40) NOT NULL,
  -- One of: 'job_created' | 'job_started' | 'job_cancelled' | 'job_deleted' |
  --        'job_exported' | 'watch_created' | 'watch_deleted' | 'key_set' |
  --        'key_deleted' | 'budget_changed' | 'retention_purge' |
  --        'paid_call' | 'budget_warn' | 'budget_block'
  method        VARCHAR(40),
  stated_purpose TEXT,
  client_ip     VARCHAR(64),
  meta          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  cost_usd      NUMERIC(8,4) DEFAULT 0,
  retained_until TIMESTAMP  NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  created_at    TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lookup_audit_user_time
  ON lookup_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lookup_audit_job
  ON lookup_audit_log (job_id);
CREATE INDEX IF NOT EXISTS idx_lookup_audit_retained
  ON lookup_audit_log (retained_until);

-- 5. lookup_findings — mask_hash for Oracle 6 (PR #5.5) ---------------------
ALTER TABLE lookup_findings
  ADD COLUMN IF NOT EXISTS mask_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_lookup_findings_mask_hash
  ON lookup_findings (mask_hash) WHERE mask_hash IS NOT NULL;

-- 6. lookup_jobs — retention + org grouping (PR #8) -------------------------
ALTER TABLE lookup_jobs
  ADD COLUMN IF NOT EXISTS retained_until TIMESTAMP
    NOT NULL DEFAULT (NOW() + INTERVAL '90 days'),
  ADD COLUMN IF NOT EXISTS deep_mode      BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS stage_p50_ms   JSONB,
  ADD COLUMN IF NOT EXISTS stage_p95_ms   JSONB;

CREATE INDEX IF NOT EXISTS idx_lookup_jobs_retained
  ON lookup_jobs (retained_until);

-- 7. lookup_burners — risk-score signals (PR #8) -----------------------------
ALTER TABLE lookup_burners
  ADD COLUMN IF NOT EXISTS last_outcome      VARCHAR(40),
  ADD COLUMN IF NOT EXISTS soft_block_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS checkpoint_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_seen_at     TIMESTAMP;

-- 8. lookup_watches — worker bookkeeping (PR #7) -----------------------------
ALTER TABLE lookup_watches
  ADD COLUMN IF NOT EXISTS cooldown_until      TIMESTAMP,
  ADD COLUMN IF NOT EXISTS consecutive_errors  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_diff_summary   TEXT,
  ADD COLUMN IF NOT EXISTS last_findings_count INTEGER NOT NULL DEFAULT 0;

-- =============================================================================
-- COMMENTS
-- =============================================================================
COMMENT ON TABLE  user_lookup_keys IS 'Per-user encrypted API keys for the paid lookup providers (Dehashed/LeakCheck/Snusbase/IntelligenceX/HIBP/SerpAPI/PimEyes/TinEye/WHOIS/2captcha). Resolved by lookupKeysService.';
COMMENT ON TABLE  lookup_api_cache IS '7-day mirror of Redis paid-API cache. Cold-start safety net so the panel does not re-spend USD after a reboot.';
COMMENT ON TABLE  lookup_org_budgets IS 'Per-(user, month) USD cap on paid lookup API spend. Workers check spent_usd < budget_cap_usd before each paid call.';
COMMENT ON TABLE  lookup_audit_log IS 'Append-only audit trail of operator actions on the lookup module. Retention enforced by lookupRetentionWorker.';
COMMENT ON COLUMN lookup_findings.mask_hash IS 'SHA-256 of the obfuscated email/phone for Oracle 6 alt-account-cluster joins. Same salt as resetOracle._maskHash.';
COMMENT ON COLUMN lookup_jobs.retained_until IS '90-day default retention horizon. lookupRetentionWorker hard-deletes jobs + findings past this.';
COMMENT ON COLUMN lookup_jobs.deep_mode IS 'Set TRUE when operator explicitly requested resetOracle.deep() (Oracle 4 differential probes).';
COMMENT ON COLUMN lookup_jobs.stage_p50_ms IS 'Per-stage p50 wall-time observed by the runner for SLO tracking.';
COMMENT ON COLUMN lookup_burners.last_outcome IS 'Most recent release() outcome (ok / rate_limited / checkpoint / soft_block / login_required).';
COMMENT ON COLUMN lookup_watches.cooldown_until IS 'When non-null, the worker skips this watch until the timestamp (set by consecutive_errors policy).';
