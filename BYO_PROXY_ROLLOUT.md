# BYO Proxy — Phase 4 rollout checklist

This is the operational rollout guide that goes with `BYO_PROXY_PROPOSAL.md`.
Phases 1, 2, 3 are merged. This file walks through the cutover and
rollback procedure.

## Pre-flight (read-only)

```bash
# 1. Migration v14 applied?
psql "$DATABASE_URL" -c "
  SELECT column_name FROM information_schema.columns
   WHERE table_name = 'proxies'
     AND column_name IN ('user_id','label','country_code',
                         'last_health_check','last_health_ok')
   ORDER BY column_name;
"
# Must return 5 rows.

# 2. Trigger installed?
psql "$DATABASE_URL" -c "
  SELECT tgname FROM pg_trigger
   WHERE tgrelid = 'session_proxy_assignments'::regclass
     AND tgname = 'trg_enforce_session_proxy_ownership';
"
# Must return 1 row.

# 3. Cross-user violations? (Phase 1 doesn't retro-validate existing rows.)
node backend/scripts/audit-proxy-ownership.js
# Exit 0 = no violations. Exit 1 = list printed; remediate before cutover.

# 4. Smoke tests pass against staging DB?
node backend/test/proxy/userProxyPhase1.smoke.test.js
node backend/test/proxy/userProxyPhase2.smoke.test.js
node backend/test/proxy/userProxyPhase4.smoke.test.js
```

## Cutover

1. **Announce** the BYO change to active users (in-panel banner + email).
   Existing sessions on the admin pool keep working — only new sessions
   need a per-user proxy.

2. **Set the flag**:

   ```bash
   # backend .env
   REQUIRE_USER_PROXY=true
   ```

   This makes `pickProxyForSession` raise `NO_USER_PROXY` (HTTP 412)
   for non-admin callers when they have zero working proxies.

3. **Add the entitlement**: ensure `byo_proxy` is in the *paid* feature
   list in `subscriptionService.PLAN_FEATURES`. Trial users will get
   `402 TRIAL_FEATURE_NOT_ALLOWED` from `/api/me/proxies`. The frontend
   already handles that with an upsell card.

4. **Deploy the backend**, then the frontend (in that order — the
   frontend hits `/api/me/proxies` on first load).

5. **Smoke the production surface**:

   - GET `/api/me/proxies` as a normal user → 200 (or 402 if on trial)
   - POST `/api/me/proxies` with bogus host → 200 with
     `is_working: false`
   - POST `/api/me/proxies/:id/test` → 200, `egress_ip` set
   - GET `/api/admin/proxies` as a normal user → 403
   - GET `/api/admin/proxies/usage` as admin → 200, returns the
     cross-user matrix

## Rollback

If something breaks:

1. `REQUIRE_USER_PROXY=false` — `pickProxyForSession` falls back to the
   admin pool again, so existing flows keep working.
2. The `/api/me/proxies` surface stays up; users just won't be forced
   to use it.
3. The DB trigger is harmless to leave in place (it only fires on new
   cross-user assignments). Drop it only if a bug forces you to:

   ```sql
   DROP TRIGGER IF EXISTS trg_enforce_session_proxy_ownership
     ON session_proxy_assignments;
   ```

## Post-cutover monitoring

- **Dashboards**: add panels for
  - `proxies` rows where `last_health_ok = false` per user (top 10)
  - new sessions with `bound_proxy_id IS NULL` (should be ~0 after
    cutover)
  - `proxy_url`-via-bind rate (sessions joined to a `proxies` row with
    `user_id = sessions.user_id`).

- **Alerts**:
  - `NO_USER_PROXY` 412s spiking → users running out of working proxies.
  - `PROXY_DUPLICATE` 409s → users hitting the per-user uniqueness
    constraint; usually fine, but spikes indicate a UX bug.
  - Trigger fires (Postgres `RAISE EXCEPTION 'session-proxy ownership
    mismatch'`) → bug in the application code, not the user.
