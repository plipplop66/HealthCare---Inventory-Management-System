# Isolated test-branch-2 deployment

## Status: prepared, not deployed

Prepared on 2026-09-17 from candidate `1509145`. This environment must not
change the existing MEDRIPPLE deployment or its Supabase database.

Separate Vercel projects have been created in `sahil-2006s-projects`:

| Directory | Project | Project ID |
| --- | --- | --- |
| intelligence | medripple-test2-ai | prj_2ZoAXs6cLIW2X1q7ztBtaMmYibHA |
| backend | medripple-test2-api | prj_F0ooeRb53Y7axrUwt5Qm3ejr5OKl |
| frontend | medripple-test2-web | prj_FAiLPLOjICzHN0VKrBKctNAoTHnp |

No deployment has been published. No live app settings, secrets, aliases,
production branch, database rows, or roles were changed. The new projects
must not inherit credentials from the old projects.

## Current blocker

Supabase refused creation of a new free project because the owner's two
active free-project slots are occupied. Obtain an isolated database before
deploying. Do not pause or delete any existing project without the owner's
specific choice. Do not work around this by using the production database.

## Resume safely

1. Provision a new, empty PostgreSQL database. For Supabase, verify its project
   reference is **not** the working project's `jfmuhpgsvrqdpljhxivz`.
2. For this **fresh install only**, check the target has no application tables
   or enum types, then run `database/schema-postgres.sql`,
   `database/seed-postgres.sql`, and `database/secure-supabase.sql`.
   The schema has DROP statements: never run it on an existing database.
   The fresh seed already includes the final dataset from migration 005;
   do not copy production accounts, plans, inventory changes, or audit data.
3. Run `database/verify-005-postgres.sql`. The fresh database has 16 facilities
   and 12 medicines; numeric medicine IDs differ from an upgraded older
   database. Use the documented medicine alias in tests. Confirm UTC, RLS,
   and denied anonymous/authenticated direct table privileges.
4. Follow section 5 of `release-checklist.md`, replacing **all** old service
   URLs and secrets with this environment's values. Use a new JWT secret and
   this database's URL only. Use a verified CA for the selected provider;
   never disable certificate validation. Use the same simulation date in
   API and intelligence.
5. Check each local `.vercel/project.json` matches the ID above before every
   deploy. Clear any inherited `VERCEL_PROJECT_ID`/`VERCEL_ORG_ID` overrides
   or set them explicitly to the new project/team. Keep `.vercel` and secret
   environment files untracked.
6. Deploy intelligence, verify it against the isolated database, deploy API,
   verify health and CORS, and only then build/deploy frontend with
   `VITE_API_BASE_URL=<new API origin>/api` and `VITE_USE_MOCKS=false`.
   The checked-in frontend default is deliberately `/api`, not the old API.
7. Do not connect these projects to `master`. CLI deployments are independent;
   any future Git deployment integration must use `test-branch-2` only.
8. Run `backend/scripts/release-smoke.js` with `SMOKE_BACKEND_URL`,
   `SMOKE_INTELLIGENCE_URL`, and `SMOKE_FRONTEND_URL` set to the **new** services.
   Run isolated database integration and browser tests before calling it ready.
   Create accounts in the new app, not by copying production password hashes.
9. Record actual deployment URLs/IDs and acceptance results here. Roll back
   only the new projects if necessary; never touch the existing live aliases.

## Local checks completed

- `npm run check`: passed.
- Backend: 88 passed, 6 skipped (database-dependent tests pending).
- Frontend: 49 passed; production build passed.
- Intelligence: 360 passed, 35 skipped (external/database-dependent tests pending).
- Live migration, deployed smoke tests, browser acceptance, and Python
  dependency audit are not yet completed for this environment.

These checks do not constitute a live deployment. All seeded data remains
simulated decision-support data, not a real hospital feed.
