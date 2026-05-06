# Test plan: PR #44 — fix IG/TG scrape (unblock pending, capture rich fields)

## What changed (operator-visible)

1. **Instagram scrape jobs no longer hang in `pending`.** The active-hours
   gate is bypassed for operator-initiated scrapes, and the panel now
   negotiates HTTP/2 (`undici allowH2: true`) so Instagram stops
   responding with body-less HTTP/1.1 `429`s on the first request.
2. **Cold-start warmup is skipped for browser-cookie sessions** so the
   timeline/inbox/news triplet doesn't burn the rate-limit budget before
   the real call.
3. **CSV/JSON exports now contain the full enriched user record** for
   both IG and TG instead of just `username`/`pk` (IG) or `telegram_id`
   (TG). New columns: TG `is_verified`, `is_scam`, `is_fake`,
   `is_restricted`, `is_deleted`, `is_support`, `is_contact`,
   `is_mutual_contact`, `is_close_friend`, `lang_code`, `status`,
   `last_seen`, `access_hash`, `dc_id`, `has_profile_photo`, `bio`,
   `restriction_reason`; IG `profile_pic_id`,
   `has_anonymous_profile_picture`, `is_business`, `account_type`,
   `latest_reel_media`, `has_chaining`, `social_context`, `bio`,
   `has_profile_photo`.

## Primary flow under test

Single continuous browser walkthrough on `http://localhost:5176`:

1. Log in as admin.
2. Run an Instagram followers scrape against `gurnajgill_4350` (the
   exact target from the bug report) with **Use proxy = OFF**, limit
   `10`. Verify the job reaches `completed` and the result table shows
   `10` rows with full names + verified/private flags.
3. Export that IG job as CSV and confirm the file header + sample row
   include the new IG enrichment columns.
4. Switch to Telegram → Scrape, run a scrape on `@argue` with **Filter
   bots = OFF**, limit `100`. Verify the job reaches `completed` and
   the result table populates with `>= 20` members.
5. Export the TG job as CSV and confirm the file header includes
   `is_premium`, `is_verified`, `lang_code`, `dc_id`,
   `has_profile_photo`, etc., AND that at least one row has a non-empty
   `is_premium=true` and at least one row has a non-null `dc_id`.

The plan deliberately mixes UI verification (live job state, table
contents) with file-content verification (CSV header bytes) so a broken
implementation cannot pass by silently rendering placeholder values.

## Test cases

### TC1 — IG followers scrape on `gurnajgill_4350` reaches `completed`

- **Setup state:** logged in as admin, IG session 1 (`jashanxjagy7`)
  shown in the session selector, no pending jobs.
- **Steps:**
  1. Navigate to `Instagram → Scrape`.
  2. Select session `jashanxjagy7`.
  3. Target type = `Followers`.
  4. Target Usernames = `gurnajgill_4350`.
  5. Limit = `10`.
  6. Untick `Use proxy`.
  7. Click `Run scrape`.
- **Pass criteria:**
  - Within 60s the job listed in `History` shows status
    **`completed`** (not `pending`, not `failed`).
  - Total scraped count displayed equals `10`.
  - Clicking the job opens a result table with `10` rows; at least one
    row's `Full name` column is non-empty (e.g. `Jashan` /
    `Vishav Sandhu`) and at least one row has the verified/private
    badge column populated (`true`/`false`, not blank).
- **Fail-distinguishing rationale:** Before the fix the job would stay
  in `pending` forever (active-hours gate) OR fail with
  `Instagram is rate-limiting this session...` (HTTP/1.1 429). Either
  failure is visually different from `completed` + populated table.

### TC2 — IG export CSV contains the new IG columns and real values

- **Steps:**
  1. From the same job's row in `History`, click `Export → CSV`.
  2. Save the file and inspect it (open in editor / `head` / view).
- **Pass criteria:**
  - CSV header line contains, at minimum, the exact tokens
    `instagram_pk`, `username`, `full_name`, `is_private`,
    `is_verified`, `is_business`, `account_type`, `has_profile_photo`,
    `has_anonymous_profile_picture`, `thumbnail_url`,
    `profile_pic_id`, `latest_reel_media`, `has_chaining`,
    `social_context`, `bio`, `scraped_at`.
  - At least one data row has a non-empty `profile_pic_id` value
    (e.g. `36...8856061363169_47827890208`).
  - At least one data row has `account_type` rendered as a number
    (e.g. `1` or `2`), proving the field was actually persisted (not
    just defaulted to null/blank).
- **Fail-distinguishing rationale:** Before the fix the export only
  carried `instagram_pk, username, full_name, is_private, is_verified,
  thumbnail_url`. A header missing any of the new tokens or a CSV
  where every row's `profile_pic_id`/`account_type` is empty proves
  the persistence path didn't widen.

### TC3 — TG scrape on `@argue` (filter bots OFF) reaches `completed`

- **Steps:**
  1. Navigate to `Telegram → Scrape`.
  2. Select session 2 (`sprked`).
  3. Target = `@argue`.
  4. Disable `Filter bots`.
  5. Limit = `100`.
  6. Click `Run scrape`.
- **Pass criteria:**
  - Within 30s the job in `History` shows **`completed`**.
  - Total scraped count `>= 20`.
  - Result table opens and shows mixed humans + at least one bot row
    (since bot filter is off) — proves the scrape did run, captured
    real data, and did not silently filter.
- **Fail-distinguishing rationale:** A broken TG scrape either fails
  with a session error or returns `0` rows — both are visually
  distinct from `>= 20` members + a visible bot.

### TC4 — TG export CSV contains the new TG columns and real values

- **Steps:**
  1. From the TG job's row in `History`, click `Export → CSV`.
  2. Save the file and inspect it.
- **Pass criteria:**
  - CSV header contains the exact tokens `telegram_id`, `username`,
    `first_name`, `last_name`, `phone`, `is_bot`, `is_premium`,
    `is_verified`, `is_scam`, `is_fake`, `is_restricted`, `is_deleted`,
    `is_support`, `is_contact`, `is_mutual_contact`, `is_close_friend`,
    `lang_code`, `status`, `last_seen`, `access_hash`, `dc_id`,
    `has_profile_photo`, `bio`, `restriction_reason`.
  - At least one data row has `is_premium=true`.
  - At least one data row has `dc_id` populated with an integer
    (`1`/`2`/`4`/`5`).
  - At least one data row has `status` populated with a value like
    `UserStatusRecently` / `UserStatusOnline` / `UserStatusOffline`.
- **Fail-distinguishing rationale:** Before the fix every row's
  `is_premium`/`dc_id`/`status` were null and the header missed every
  new column. Asserting BOTH the header tokens AND non-null values in
  >=1 row catches both "schema only" regressions (header but no data)
  and "data-only" regressions (data but export config still narrow).

## Out of scope

- IG `likers`/`commenters`/`tagged` flows. They share the same
  `igFetch` H2 dispatcher path TC1 exercises, so a TC1 pass implies
  the H2 fix applies to them too. Adding them as separate browser
  cases would be redundant for what the user wants demonstrated.
- TG monitor (admin-only / hidden chat) flow — `@argue` is not
  admin-only (`canScrape: true, isAdminOnly: false` per
  `/api/scrape/preview`), so the regular scrape path is what the user
  was hitting and what's covered.
- Migration backfill — pre-existing rows export with `null`/`false`
  for the new columns; TC2/TC4 only assert new rows after the fix.

## Evidence to capture

- Recorded screen of the full UI walkthrough (login → IG scrape →
  IG export → TG scrape → TG export).
- The two CSV files attached to the test report.
- Screenshot of the IG and TG result tables with rows visible.
- Screenshot of `History` showing the two `completed` jobs.

## Code references

- `backend/src/providers/instagram/scrape.js:316-331` (active-hours
  bypass).
- `backend/src/providers/instagram/igFetch.js:65-113` (H2 agent /
  `allowH2`).
- `backend/src/providers/instagram/coldStart.js:72-92` (web-cookie
  warmup skip).
- `backend/src/services/telegramService.js:128-190`
  (`normalizeParticipant` widened to 24 fields).
- `backend/src/services/scrapeService.js:719-815` (`_insertUsersBatch`
  widened from 12 → 24 columns).
- `backend/src/controllers/scrapeController.js:362-380` and `:648-655`
  (export column lists widened).
- `backend/src/config/migration_v19_rich_scrape_fields.sql` (new
  columns).
- `frontend/src/pages/instagram/Scrape.jsx:62-78,140-175,353-368`
  (IG form fields and submit payload).
- `frontend/src/pages/Scrape.jsx:80-115,300-360` (TG form fields and
  submit payload).
