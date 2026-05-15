-- =============================================================================
-- Migration v34 — Instagram identity-lookup module
-- =============================================================================
-- See instagram_upgrade.txt §5 for the rationale and the full lookup-stack
-- design. Implements the foundation tables (lookup_jobs, lookup_findings),
-- the longitudinal/oracle tables (lookup_snapshots, lookup_watches) that
-- PR #7 will start writing to, and the burner-cookie pool table that PR #4
-- will start populating. Schemas land together so we don't have to ship a
-- second migration just to add the indexes for downstream PRs.
--
-- All statements are idempotent so the migration is safe to re-run.
-- =============================================================================

-- 1. lookup_jobs --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_jobs (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform            VARCHAR(20)  NOT NULL DEFAULT 'instagram',
  username            VARCHAR(64)  NOT NULL,
  methods             TEXT[]       NOT NULL,
  options             JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status              VARCHAR(20)  NOT NULL DEFAULT 'pending',
  -- pending | queued | running | completed | cancelled | failed
  total_methods       INTEGER      NOT NULL DEFAULT 0,
  completed_methods   INTEGER      NOT NULL DEFAULT 0,
  error_methods       INTEGER      NOT NULL DEFAULT 0,
  total_findings      INTEGER      NOT NULL DEFAULT 0,
  budget_usd_cap      NUMERIC(8,4)          DEFAULT 0,
  budget_usd_spent    NUMERIC(8,4)          DEFAULT 0,
  stated_purpose      TEXT,
  client_ip           VARCHAR(64),
  error               TEXT,
  created_at          TIMESTAMP    NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMP,
  completed_at        TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lookup_jobs_user
  ON lookup_jobs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_lookup_jobs_status
  ON lookup_jobs (status);
CREATE INDEX IF NOT EXISTS idx_lookup_jobs_username
  ON lookup_jobs (lower(username));

-- 2. lookup_findings ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_findings (
  id           SERIAL PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES lookup_jobs(id) ON DELETE CASCADE,
  method       VARCHAR(40) NOT NULL,
  -- profile_info | recovery_mask | recovery_methods | recovery_meta |
  -- email_enum | phone_enum | breach | link_expand | whois |
  -- cross_platform | reverse_image | dork | geo | note | error
  kind         VARCHAR(20) NOT NULL,
  -- email | phone | address | location | url | name | username |
  -- password | password_hash | profile_url | note | error
  value        TEXT,
  raw          JSONB,
  source_url   TEXT,
  confidence   SMALLINT    NOT NULL DEFAULT 50,
  verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lookup_findings_job
  ON lookup_findings (job_id, kind);
CREATE INDEX IF NOT EXISTS idx_lookup_findings_val
  ON lookup_findings (lower(value));

-- 3. lookup_snapshots --------------------------------------------------------
-- PR #7 (longitudinal monitoring) will populate this table. Schema lands
-- now so the indexes exist when the cron worker starts writing.
CREATE TABLE IF NOT EXISTS lookup_snapshots (
  id               SERIAL PRIMARY KEY,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username         VARCHAR(64) NOT NULL,
  ig_pk            BIGINT,
  snap_at          TIMESTAMP NOT NULL DEFAULT NOW(),
  snap             JSONB     NOT NULL,
  mask_hash_email  VARCHAR(64),
  mask_hash_phone  VARCHAR(64),
  diff_from_prev   JSONB
);

CREATE INDEX IF NOT EXISTS idx_lookup_snapshots_user_uname
  ON lookup_snapshots (user_id, lower(username), snap_at DESC);
CREATE INDEX IF NOT EXISTS idx_lookup_snapshots_mask_email
  ON lookup_snapshots (mask_hash_email) WHERE mask_hash_email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lookup_snapshots_mask_phone
  ON lookup_snapshots (mask_hash_phone) WHERE mask_hash_phone IS NOT NULL;

-- 4. lookup_watches ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS lookup_watches (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username      VARCHAR(64) NOT NULL,
  cadence_hours INTEGER NOT NULL DEFAULT 24,
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMP DEFAULT NOW(),
  last_run_at   TIMESTAMP,
  next_run_at   TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_lookup_watches_user_uname
  ON lookup_watches (user_id, lower(username));
CREATE INDEX IF NOT EXISTS idx_lookup_watches_due
  ON lookup_watches (next_run_at) WHERE active = TRUE;

-- 5. lookup_burners ----------------------------------------------------------
-- PR #4 (burner pool + enumeration) will populate this table.
CREATE TABLE IF NOT EXISTS lookup_burners (
  id                 SERIAL PRIMARY KEY,
  cookie_blob_enc    TEXT NOT NULL,
  web_fingerprint    JSONB,
  bound_proxy_id     INTEGER REFERENCES proxies(id) ON DELETE SET NULL,
  ds_user_id         VARCHAR(64),
  created_at         TIMESTAMP DEFAULT NOW(),
  last_used_at       TIMESTAMP,
  probe_count        INTEGER  DEFAULT 0,
  blocked            BOOLEAN  DEFAULT FALSE,
  blocked_reason     VARCHAR(60),
  blocked_at         TIMESTAMP,
  risk_score         SMALLINT DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_lookup_burners_alive
  ON lookup_burners (blocked) WHERE blocked = FALSE;

-- 6. proxies.validated_for_lookup --------------------------------------------
-- Separate from validated_for_instagram because the IG lookup workload
-- hits /users/lookup/ which is rate-limited independently of the
-- scrape endpoints. A proxy that passes scrape validation may still be
-- soft-blocked for the recovery flow, so we track the two flags
-- independently.
ALTER TABLE proxies
  ADD COLUMN IF NOT EXISTS validated_for_lookup        BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_validated_lookup_at    TIMESTAMP;

-- =============================================================================
-- COMMENTS — documentation for future operators
-- =============================================================================
COMMENT ON TABLE  lookup_jobs                IS 'IG identity-lookup jobs. One per username (or per-username row in a bulk job). Methods is an array of method codes from providers/instagram/lookup/.';
COMMENT ON COLUMN lookup_jobs.stated_purpose IS 'Free-text legal purpose recorded for GDPR/DPDP/CCPA audit. Required non-empty by the API layer.';
COMMENT ON COLUMN lookup_jobs.client_ip      IS 'Operator IP at job submission time. Retention >=90 days per audit policy.';
COMMENT ON COLUMN lookup_jobs.budget_usd_cap IS 'Paid-API spend cap. Workers must abort the breach/serp/pimeyes stage before exceeding this.';

COMMENT ON TABLE  lookup_findings            IS 'One row per primitive learned about the target. Method tracks which probe surface, kind tracks the typed value shape.';
COMMENT ON COLUMN lookup_findings.confidence IS '0-100 score from the producing method. Aggregated by the UI grouping logic.';
COMMENT ON COLUMN lookup_findings.raw        IS 'Source-specific JSON payload (e.g. the full breach-record body, the WHOIS response). Retained for re-classification.';

COMMENT ON TABLE  lookup_snapshots           IS 'Longitudinal snapshots of the reset-flow oracle (instagram_upgrade.txt §2.9 Oracle 5). Populated by PR #7.';
COMMENT ON TABLE  lookup_watches             IS 'Usernames the operator has marked for periodic re-lookup. Populated by PR #7.';
COMMENT ON TABLE  lookup_burners             IS 'Pool of burner IG cookies used by web_create_ajax email/phone existence probes. Populated by PR #4.';
COMMENT ON COLUMN proxies.validated_for_lookup IS 'TRUE when the proxy has been validated against /users/lookup/. Independent of validated_for_instagram which covers the scrape endpoints.';
