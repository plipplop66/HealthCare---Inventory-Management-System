# MEDRIPPLE deployment status

**Updated:** 17 September 2026. Production was not accessed for this update. The production facts below come from [docs/vercel-supabase.md](docs/vercel-supabase.md), which was last verified on 17 September 2026.

## Production

| Service | URL |
| --- | --- |
| Frontend | https://frontend-psi-plum-56.vercel.app |
| Express API | https://health-care-inventory-management-sy-ecru.vercel.app (`/health`, `/api`) |
| Intelligence service | https://medripple-intelligence.vercel.app |
| Database | Supabase PostgreSQL (earlier four-facility simulated dataset; migration 005 **not applied**) |

## Release candidate

The `test-branch-2` branch holds the release candidate. It is **not deployed**. Compared with `master`, it adds:
- the final demo dataset for PostgreSQL (`database/seed-postgres.sql` for new databases, migration 005 for the deployed one);
- the final optimizer and received-stock donor check in the intelligence service;
- approval revalidation before any reservation, and fail-closed simulation and optimization;
- the frontend connected to the API: dashboard, facility detail, candidates, Ripple Simulator, plan review and audit;
- UTC API timestamps, and no patient-impact metric.

The database schema is unchanged. Applying migration 005 and deploying need the owner's explicit approval. Follow [docs/release-checklist.md](docs/release-checklist.md) (backup, migration, verification, deployment order, smoke tests, rollback).

## Known boundaries

- All data is simulated; outputs are decision support only. Every stock movement needs a human approval by an `APPROVER` or `ADMIN` and is audited.
- The dashboard summarises insulin only.
- No patient-impact metric is calculated.
- The local MySQL store reads timestamps in the Node process's time zone. The Compose containers run in UTC; a MySQL backend started directly on a host needs `TZ=UTC`. PostgreSQL is not affected.
- Free hosting tiers have usage limits and no uptime guarantee.

## Documents

| Document | Use |
| --- | --- |
| [VERCEL-SUPABASE-DEPLOYMENT.md](VERCEL-SUPABASE-DEPLOYMENT.md) | Setting up Vercel and Supabase |
| [docs/release-checklist.md](docs/release-checklist.md) | Releasing to the existing deployment |
| [docs/vercel-supabase.md](docs/vercel-supabase.md) | Current services, configuration and data boundaries |
| [database/README.md](database/README.md) | Datasets, migration 005, IDs and demo scenarios |
| [docs/api-contract.md](docs/api-contract.md) | API routes, approval rules and error codes |
| [docs/deployment.md](docs/deployment.md) | Docker host with MySQL |
| [QUICK-START.md](QUICK-START.md) | Running MEDRIPPLE locally |
