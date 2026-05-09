-- Migration v26: backfill list_items.access_hash from scraped_users.
--
-- Background: even after migration v25 added the `access_hash` column,
-- existing list rows (created from CSV imports OR from older scrapes
-- when the value was being silently truncated by Number() coercion in
-- normalizeParticipant) are still NULL. The add-members worker then
-- can't build a valid InputUser for those rows and every numeric-id
-- invite fails with "Could not find the input entity".
--
-- This migration is purely additive: for any list_items row that has a
-- numeric telegram_id but no access_hash, copy the most recent
-- non-null access_hash from `scraped_users` keyed on the same
-- telegram_id. Rows the panel has never seen before are left untouched.
--
-- Note: `scraped_users.access_hash` is BIGINT NULL; values written by
-- the older (broken) Number-coerced normalizer may already be
-- truncated and thus invalid. Operators with corrupted historical
-- scrapes should re-scrape via the panel after this fix is deployed.

UPDATE list_items li
SET    access_hash = sub.access_hash
FROM   (
    SELECT DISTINCT ON (telegram_id) telegram_id, access_hash
    FROM   scraped_users
    WHERE  access_hash IS NOT NULL
    ORDER  BY telegram_id, scraped_at DESC NULLS LAST
) sub
WHERE  li.access_hash IS NULL
  AND  li.telegram_id IS NOT NULL
  AND  li.telegram_id = sub.telegram_id;
