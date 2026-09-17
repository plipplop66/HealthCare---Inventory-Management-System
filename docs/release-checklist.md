# MEDRIPPLE production release checklist

**Status: prepared, not executed.** Nothing in this checklist has been run against production. The Supabase migration and each Vercel deployment need separate, explicit approval from the project owner before anyone starts.

- **Release candidate:** branch `test-branch-2`, at the commit that adds this file or a later reviewed commit. Record the exact SHA in the sign-off table.
- **Production today:**
  - frontend: https://frontend-psi-plum-56.vercel.app
  - Express API: https://health-care-inventory-management-sy-ecru.vercel.app (Vercel project `health-care-inventory-management-system-backend-biv9`)
  - intelligence service: https://medripple-intelligence.vercel.app
  - database: Supabase PostgreSQL. The service details are in [vercel-supabase.md](vercel-supabase.md).

All MEDRIPPLE data is **simulated**. Plans are decision support only and every stock movement needs **human approval** by an `APPROVER` or `ADMIN`. The dashboard currently summarises **insulin only**.

## What this release changes

| Area | Change | Production action |
| --- | --- | --- |
| Database schema | None: `database/schema-postgres.sql` and `database/secure-supabase.sql` are unchanged since `master` (`ce1d940`). | None |
| Database data | Migration 005 adds the final demo dataset. It is insert-only and does not touch existing rows, accounts, plans, transfers or audit events. | Run migration 005 (section 3) |
| Intelligence service | Final optimizer (`aiml-transfer-optimizer-v2`), the received-stock donor check and the evidence the API requires | Deploy |
| Express API | Approval revalidation before any reservation, and fail-closed simulation and optimization. It also returns UTC timestamps and no longer reports a patient-impact metric. | Deploy |
| Frontend | Dashboard, facility detail, candidates, Ripple Simulator, plan review and audit connected to the API | Deploy |

The MySQL files (`database/schema.sql`, migrations 002-004) are for the local Compose stack only. Do not run them on Supabase.

## Ground rules

- Keep every secret out of the terminal output, shell history, tickets and chat. Read passwords with a silent prompt, never `echo` them, and never run `env`, `set` or `vercel env pull` on a shared screen.
- Use one terminal for the whole run, with `set -o pipefail`. Do not use `set -x`.
- Work from a clean checkout of the candidate commit.
- Keep the backup and the verification output outside the repository.
- Announce a maintenance window. No one approves, dispatches, delivers or cancels plans during it.
- Stop at the first failure and use section 9 (rollback). Do not improvise fixes on production.

## 1. Pre-flight (read-only)

1. Confirm that the candidate commit passes CI and the local release verification (frontend, Node and Python tests, the PostgreSQL live tests and the local browser run).
2. For each Vercel project (frontend, backend, intelligence), record the current production deployment URL and ID. Rollback uses these.
3. List the environment-variable **names** in each project and check them against section 5. Use the dashboard, or `vercel env ls` in each linked project directory, which lists names without values.
4. Check the Preview environment of each project. A preview build of `test-branch-2` must not use the production `DATABASE_URL`, unless the owner has accepted that previews write to production.
5. Install PostgreSQL client tools. `pg_dump` must be the same major version as the Supabase server, or newer. After the setup below, compare `pg_dump --version` with `psql "$DB" -XAtc 'SHOW server_version'`.
6. Choose the Supabase **session pooler** (port 5432) or the direct connection for `psql` and `pg_dump`. Do not use the transaction pooler (port 6543) for these steps. The applications keep using the transaction pooler.

```bash
set -o pipefail
cd <clean checkout of the candidate commit>
export PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/backend/certs/supabase-ca.crt" PGCONNECT_TIMEOUT=15
# No password in this string. Copy host and user from Supabase > Connect > Session pooler.
export DB="host=<session-pooler-host> port=5432 dbname=postgres user=postgres.<project-ref>"
read -rsp 'Supabase database password: ' PGPASSWORD; echo; export PGPASSWORD
export OUT="$HOME/medripple-release-$(date -u +%Y%m%dT%H%M%SZ)"; mkdir -p "$OUT"; chmod 700 "$OUT"
```

## 2. Supabase backup

1. In Supabase, open **Database > Backups** and note the time of the most recent automatic backup, if your plan provides one. Availability and retention depend on the plan, so do not rely on it alone.
2. Take a logical backup of the `public` schema. It contains password hashes, so keep it private.

   ```bash
   pg_dump "$DB" --schema=public --format=custom --no-owner --no-privileges --file "$OUT/medripple-pre-005.dump"
   pg_restore --list "$OUT/medripple-pre-005.dump" | grep -c 'TABLE DATA'   # expect 12
   sha256sum "$OUT/medripple-pre-005.dump" > "$OUT/medripple-pre-005.dump.sha256"
   ```

3. Record the pre-migration state (read-only):

   ```bash
   psql "$DB" -v ON_ERROR_STOP=1 -X -f database/verify-005-postgres.sql > "$OUT/verify-before.txt"
   ```

   In section 1 of the output, `session_time_zone` and `default_time_zone` must both be `UTC`, because the API stores timestamps as UTC wall-clock time. If either is not UTC, stop and review the existing timestamp rows with the owner.

4. Recommended: restore the dump into a local, disposable PostgreSQL database with `pg_restore --no-owner --no-privileges --dbname <local database URL> "$OUT/medripple-pre-005.dump"`.
   - The only expected error is `schema "public" already exists`.
   - Run `verify-005-postgres.sql` against the copy. Sections 2 to 10 must match `verify-before.txt`; they did in the rehearsal.
5. Encrypt or move the dump to access-controlled storage, and agree how long to keep it.

## 3. Migration 005

Never run `database/schema-postgres.sql` (it drops tables) or `database/seed-postgres.sql` (fresh databases only) on production.

```bash
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/migrations/005_expand_final_demo_scenarios_postgres.sql 2>&1 | tee "$OUT/migration-005.txt"
```

- The script opens and commits its own transaction, so do not add psql's `-1` option. With `ON_ERROR_STOP=1`, any error stops psql before `COMMIT`; the transaction is rolled back and the database is unchanged.
- **Expected output:** exit status 0 and exactly one notice, `MEDRIPPLE final demo dataset present: Human Insulin medicine_id <M>, TN-007-B01-26 batch_id <B> ...`. Record `<M>` and `<B>`. On the deployed database, insulin keeps its existing ID (`1` in the local rehearsal), so clients use the alias `med-insulin-100iu-vial`.
- **On error:** the transaction was rolled back. Keep `migration-005.txt`, run `verify-005-postgres.sql` again to confirm nothing changed, and stop.
- The migration is safe to rerun. A second run inserts nothing, but only rerun it when needed.

## 4. Migration verification

```bash
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/verify-005-postgres.sql > "$OUT/verify-after.txt"
diff <(sed -n '/^3\./,/^5\./p' "$OUT/verify-before.txt") <(sed -n '/^3\./,/^5\./p' "$OUT/verify-after.txt") && echo 'existing rows unchanged'
```

The script runs in a `READ ONLY` transaction and prints digests, not account data. Expected results after the migration:

| Section | Expected |
| --- | --- |
| 1 | Time zones `UTC` |
| 2 | Compared with `verify-before.txt`: `app_users`, `plans`, `transfers` and `audit_events` unchanged. In the rehearsal, which started from the earlier four-facility dataset, the other counts increased by: facilities +12 (to 16), medicines +11 (to 12), batches +25, inventory +290, consumption +9900, replenishments +266, routes +132 and facility_safety_stock +132. Production should show the same increases; investigate any difference before deploying. |
| 3, 4 | Identical to `verify-before.txt` (the `diff` above prints `existing rows unchanged`) |
| 5 | 12 rows, `copies` 1: `CHC-SLM-001`, `CHC-TRY-001`, `DH-CBE-001`, `DH-MDU-001`, `PHC-HSR-001`, `PHC-KRR-001`, `PHC-TNJ-001`, `PHC-TNV-001`, `PHC-VLR-001`, `SC-DPI-001`, `SC-RMD-001`, `WH-TN-001`; only `PHC-TNJ-001`, `PHC-TNV-001`, `SC-DPI-001`, `SC-RMD-001` have `has_cold_chain` false |
| 6 | No rows |
| 7 | Two rows for the insulin medicine: `TN-007-B01-26` and `TN-007-B03-26`, matching the migration notice |
| 8 | `DH-CBE-001`→`PHC-KRR-001` 122.50 km 3.10 h cold chain; `DH-MDU-001`→`PHC-KRR-001` 115.17 km 2.94 h cold chain; `PHC-TNJ-001`→`PHC-KRR-001` 117.47 km 2.99 h **no** cold chain; `WH-TN-001`→`PHC-HSR-001` 267.75 km 6.00 h; `WH-TN-001`→`PHC-KRR-001` 335.62 km 7.73 h; `WH-TN-001`→`PHC-VLR-001` 124.70 km 3.19 h |
| 9 | 42 |
| 10 | `DH-CBE-001` 2941.69, SCHEDULED 2026-09-23 2998.36; `DH-MDU-001` 2919.93, SCHEDULED 2026-09-24 2827.90; `PHC-HSR-001` 340.00, DELAYED 2026-09-21 1409.43; `PHC-KRR-001` 40.00, DELAYED 2026-09-20 1348.91; `PHC-VLR-001` 34.00, DELAYED 2026-09-19 1372.00 |

These values come from a local rehearsal. The rehearsal database held `master`'s four-facility seed plus accounts, plans, a reserved transfer, an audit event and a stock change. Migration 005 was applied to it twice, and every result above matched.

If any row differs, stop before deploying. The previous applications keep working with the added rows; see section 9.

## 5. Environment variables

Set values in the Vercel project settings (Production environment) only. Never place them in Git or in any `VITE_*` variable.

### Express API (`backend/`)

| Name | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Supabase **transaction pooler** URL (port 6543, user `postgres.<project-ref>`) | Secret. It selects the PostgreSQL store; TLS is verified with `backend/certs/supabase-ca.crt`. |
| `AUTH_JWT_SECRET` | Existing secret, at least 32 characters | Secret. Keep the current value; changing it signs every user out. |
| `CORS_ORIGINS` | `https://frontend-psi-plum-56.vercel.app` | Exact origin, no trailing slash |
| `INTELLIGENCE_SERVICE_URL` | `https://medripple-intelligence.vercel.app` | No trailing slash |
| `INTELLIGENCE_TIMEOUT_MS` | `30000` | The default of 2500 ms is too short for serverless cold starts |
| `SIMULATION_DATE` | `2026-09-11` | Must equal the intelligence service's value |
| `NODE_ENV` | `production` | Set by `backend/vercel.json` |
| `AUTH_TOKEN_TTL_MINUTES` | optional, default `480` | |

Do not set `DATA_SOURCE`, `DATABASE_HOST` or `DATABASE_SSL_REJECT_UNAUTHORIZED` in this project. `TZ` is not needed.

### Intelligence service (`intelligence/`)

| Name | Value | Notes |
| --- | --- | --- |
| `DATA_SOURCE` | `postgres` | |
| `DATABASE_URL` | Same transaction pooler URL as the API | Secret. The service opens read-only transactions without prepared statements, and verifies TLS with `intelligence/certs/supabase-ca.crt`. |
| `SIMULATION_DATE` | `2026-09-11` | |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | optional, default `5` | |

### Frontend (`frontend/`)

| Name | Value | Notes |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `https://health-care-inventory-management-sy-ecru.vercel.app/api` | Public, embedded at build time |
| `VITE_USE_MOCKS` | `false` | `true` shows the MOCK DATA banner and never calls the API |

The frontend must not have a database URL, a secret or the intelligence URL. `VITE_AI_SERVICE_URL` is not used, and the browser never calls the intelligence service. Vite reads these variables at build time, so redeploy after any change.

## 6. Deployment order

1. Maintenance window announced; section 1 complete.
2. Backup (section 2).
3. Migration 005 and its verification (sections 3 and 4).
4. **Intelligence service.** The new API rejects plans and simulations that lack the new evidence, so the service goes first. Then run the service checks from sections 7 and 8.
5. **Express API**, then its health check and the API smoke checks.
6. **Frontend** last, because it expects the new API. Then run the frontend checks.
7. Browser check (section 8), sign-off, and the end of the maintenance window.

Deploy the exact candidate commit to each project's production environment, using the project's established method:
- promote a verified deployment in the Vercel dashboard;
- or run `vercel deploy --prod` from a clean checkout of the commit in the linked project directory (`intelligence/`, `backend/`, `frontend/`).

Changing a project's production branch, or merging `test-branch-2` into `master`, is a separate owner decision. Record each new deployment URL and ID.

## 7. Health checks

```bash
curl -fsS https://health-care-inventory-management-sy-ecru.vercel.app/health
# data.status "ok", data.environment "production", data.dataSource "POSTGRES", data.database.connected true
curl -fsS https://medripple-intelligence.vercel.app/health
# {"status":"ok","service":"medripple-intelligence"}
curl -fsS -o /dev/null -w '%{http_code}\n' https://frontend-psi-plum-56.vercel.app/
# 200
```

## 8. Read-only smoke tests

These checks read data only. Do **not** call these in production without separate approval, because they write:
- `/api/auth/signup`;
- `/api/plans/optimize`, which persists a plan;
- `/approve`, `/dispatch`, `/deliver` or `/cancel`;
- `backend/scripts/live-acceptance.js`, which creates an account and a plan.

Signing in updates only the account's `last_login_at`.

1. **Automated checks:**

   ```bash
   export SMOKE_BACKEND_URL=https://health-care-inventory-management-sy-ecru.vercel.app
   export SMOKE_INTELLIGENCE_URL=https://medripple-intelligence.vercel.app
   export SMOKE_FRONTEND_URL=https://frontend-psi-plum-56.vercel.app
   # Optional authenticated reads: sign in to the website with an existing account, run
   # copy(localStorage.getItem('medripple.session')) in the browser console, then paste at this silent prompt.
   read -rsp 'Session token (Enter to skip): ' SMOKE_TOKEN; echo; export SMOKE_TOKEN
   node backend/scripts/release-smoke.js | tee "$OUT/smoke.txt"
   unset SMOKE_TOKEN
   ```

   The script (`backend/scripts/release-smoke.js`) sends only GET and CORS preflight requests to the API, and never prints the token. It calls the intelligence service directly for forecasts, simulations and plans. The service only reads the database, so nothing is saved. The script expects:
   - API health `POSTGRES` with the database connected;
   - `401` on `/api/facilities` without a token;
   - CORS open to the frontend origin only;
   - the Vellore forecast `CRITICAL`;
   - Vellore 300 mL → `WH-TN-001 TN-007-B01-26 300`;
   - Karur 800 mL → `DH-CBE-001` 167.59 + `DH-MDU-001` 632.41;
   - Karur 1300 mL → `422 NO_SAFE_PLAN`, safe capacity 1236.9;
   - `COLD_CHAIN_UNAVAILABLE` and `TRAVEL_TIME_LIMIT_EXCEEDED` rejections;
   - a frontend bundle that uses this API and contains no database settings.

   With a token, it also checks:
   - the session;
   - a region summary without any patient-impact field;
   - 16 insulin facilities;
   - at least 12 medicines;
   - Vellore inventory;
   - audit timestamps as ISO-8601 UTC instants.

2. **Browser** (read-only), signed in with an existing account:
   - The dashboard shows the resilience score, earliest stockout, critical count and "Facilities monitored" (16), for insulin.
   - Facility detail for `PHC-VLR-001` shows batches and an intelligence-service forecast. Switching the medicine updates the page.
   - The audit trail lists events, and their times read correctly in local time: an event recorded at 06:30 UTC shows 12:00 in India.
   - Signing out returns to the sign-in screen. Refreshing the page stays signed out.
   - Do not run an assessment or approve anything in production without separate approval.

## 9. Rollback

**When:** a health check fails, a smoke check fails, or error rates rise after a deployment.

1. **Applications.** Roll back in reverse order: frontend, then API, then intelligence service. In each Vercel project, open **Deployments**, choose the production deployment recorded in section 1, and use **Instant Rollback** (or **Promote to Production**). The CLI equivalent is `vercel rollback <recorded deployment URL>`. Environment variables are unchanged by this release, so nothing else needs reverting. Repeat section 7 and the unauthenticated checks of section 8.
2. **Database: keep migration 005 data.** The migration only added rows, and the schema is unchanged. The previous API and service read the extra facilities without any change, so rolling back the applications is enough. In the local rehearsal, `master`'s API and intelligence service (`ce1d940`) worked on the migrated database: health, sign-up, the 16-facility insulin dashboard, inventory, forecasts and a Vellore plan. Do not delete the added rows by hand. Plans, transfers and stock changes made after the migration can refer to them.
3. **Database: full restore (last resort, owner approval required).** Use only if data is found to be corrupted.
   1. Stop writes by rolling back or pausing the API.
   2. Export everything created after the backup (`app_users`, `plans`, `transfers`, `audit_events` and the inventory changes), because a restore discards it.
   3. Restore `"$OUT/medripple-pre-005.dump"` into a **new** Supabase project or a new database with `pg_restore --no-owner --no-privileges`. Check it with `verify-005-postgres.sql` against `verify-before.txt`.
   4. Apply `database/secure-supabase.sql` to it. The dump does not carry the revoked browser-role privileges.
   5. Only then switch `DATABASE_URL` in the API and intelligence projects, and redeploy both.
   6. Do **not** run `pg_restore --clean` against the production database. With a `public`-schema dump, it drops and recreates the whole `public` schema.
4. Record what happened, what was rolled back and the final health-check output.

## Sign-off

| Step | Operator | UTC time | Result / evidence file |
| --- | --- | --- | --- |
| Owner approval for migration and deployment | | | |
| Candidate SHA | | | |
| 1 Pre-flight (deployment IDs recorded) | | | |
| 2 Backup (`medripple-pre-005.dump` + sha256) | | | |
| 3 Migration 005 (`migration-005.txt`, medicine/batch IDs) | | | |
| 4 Verification (`verify-after.txt`, diff clean) | | | |
| 6 Intelligence deployed (URL/ID) | | | |
| 6 API deployed (URL/ID) | | | |
| 6 Frontend deployed (URL/ID) | | | |
| 7 Health checks | | | |
| 8 Smoke tests (`smoke.txt`) and browser check | | | |
| Maintenance window closed | | | |

Finally, unset `PGPASSWORD` and `SMOKE_TOKEN`, and close the terminal.
