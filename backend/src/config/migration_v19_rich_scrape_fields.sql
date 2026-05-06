-- ============================================================================
-- v19: capture richer scrape fields for both Telegram and Instagram
--
-- Goal: end users were exporting scrape jobs and only getting the bare
-- telegram_id (or for IG, only username + pk). The scraping code itself
-- was already pulling rich user objects from MTProto / IG web — they
-- just weren't being persisted. This migration adds the missing columns
-- so scrape exports cover everything we have on hand without any
-- additional network round-trips.
-- ============================================================================

-- Telegram (regular getParticipants scrape) — User object enrichments.
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_verified         BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_scam             BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_fake             BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_restricted       BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_deleted          BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_support          BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_contact          BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_mutual_contact   BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_close_friend     BOOLEAN DEFAULT FALSE;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS lang_code           VARCHAR(10);
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS status              VARCHAR(40);
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS dc_id               INTEGER;

-- Instagram — extra fields directly available on IG's friend-list /
-- likers / commenters payloads.
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS profile_pic_id              VARCHAR(120);
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS has_anonymous_profile_picture BOOLEAN;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS is_business                 BOOLEAN;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS account_type                SMALLINT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS latest_reel_media           BIGINT;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS has_chaining                BOOLEAN;
ALTER TABLE scraped_users ADD COLUMN IF NOT EXISTS social_context              TEXT;

-- Telegram (passive monitor — admin-only / "hidden" chats) needs the
-- same enrichment. The monitor table started life as a small dedup
-- table but the export code now treats it as a full scrape result, so
-- the schema needs to keep up.
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_verified       BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_scam           BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_fake           BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_restricted     BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_deleted        BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_support        BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_contact        BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_mutual_contact BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS is_close_friend   BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS lang_code         VARCHAR(10);
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS status            VARCHAR(40);
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS dc_id             INTEGER;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS access_hash       BIGINT;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS has_profile_photo BOOLEAN DEFAULT FALSE;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS bio               TEXT;
ALTER TABLE scrape_monitor_users ADD COLUMN IF NOT EXISTS restriction_reason TEXT;
