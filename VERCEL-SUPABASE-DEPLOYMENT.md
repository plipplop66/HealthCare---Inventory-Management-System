# MEDRIPPLE on Vercel and Supabase

This guide covers setting up MEDRIPPLE on three Vercel projects and one Supabase PostgreSQL database. For a release to the existing deployment, follow [docs/release-checklist.md](docs/release-checklist.md). The current public services are listed in [docs/vercel-supabase.md](docs/vercel-supabase.md).

> **Prototype boundaries**
> - All data is **simulated**. There is no real patient, facility, stock or supply record.
> - Forecasts and plans are **decision support only**. No stock is reserved or moved without a **human approval** by an `APPROVER` or `ADMIN`, and every decision is audited.
> - The dashboard (`/api/region/summary` and `/api/facilities`) currently summarises **insulin only**. Other medicines are available in facility detail and the Ripple Simulator.
> - No patient-impact metric is calculated.

## Architecture

```
Browser (frontend/, Vite build)
  -> Express API (backend/, Vercel function)        accounts, plans, reservations, lifecycle, audit
       -> FastAPI intelligence service (intelligence/)  forecast, simulation, optimization, approval revalidation
       -> Supabase PostgreSQL                           the API writes; the intelligence service only reads
```

The browser talks only to the Express API. The intelligence service and the database are never called from the browser. With a database, simulation, optimization and approval **fail closed** (`503`) when the intelligence service is unavailable. Only forecasts fall back, and that fallback is labelled.

## Before you start

- Accounts: GitHub access to this repository, Vercel and Supabase.
- Tools: Node.js 24 and npm, Python 3.12 or later, and the PostgreSQL client tools (`psql`, and `pg_dump` for backups).
- Secrets live only in Vercel environment settings and your password manager. Never commit them, put them in `VITE_*` variables or paste them into chat.

## 1. Database

Supabase's **Connect** dialog offers several connection strings:
- **Transaction pooler** (port 6543, user `postgres.<project-ref>`): used by both applications.
- **Session pooler** or **direct connection** (port 5432): used for `psql` and `pg_dump`.

Both applications verify TLS with the Supabase CA certificate committed in `backend/certs/` and `intelligence/certs/`. Use the same file for `psql`:

```bash
export PGSSLMODE=verify-full PGSSLROOTCERT="$PWD/backend/certs/supabase-ca.crt"
export DB="host=<session-pooler-host> port=5432 dbname=postgres user=postgres.<project-ref>"   # no password here
read -rsp 'Database password: ' PGPASSWORD; echo; export PGPASSWORD
```

### New database

Only for an empty project. `schema-postgres.sql` **drops existing tables**.

```bash
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/schema-postgres.sql
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/seed-postgres.sql
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/secure-supabase.sql
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/verify-005-postgres.sql
```

What each script does:
- `seed-postgres.sql` loads the full final demo dataset in one transaction: 16 facilities, 12 medicines, routes, 75 days of consumption, safety stock, inventory and orders, all simulated. It uses fixed IDs (insulin is medicine `7`, batch `TN-007-B01-26` is `14`). It creates no accounts, and it refuses to run where those IDs already belong to other rows.
- `secure-supabase.sql` enables row-level security and revokes table access from Supabase's `anon` and `authenticated` roles. Only the server-side applications read and write tables.
- `verify-005-postgres.sql` is read-only. Its expected results are in [docs/release-checklist.md](docs/release-checklist.md#4-migration-verification).

### Existing database: migration 005

The deployed database was created earlier with the four-facility dataset. **Never run `schema-postgres.sql` or `seed-postgres.sql` on it.** `database/migrations/005_expand_final_demo_scenarios_postgres.sql` upgrades it to the same final demo dataset.
- It is one transaction and insert-only. Rows are matched on natural keys and never updated or deleted, and a rerun changes nothing.
- It never touches accounts, plans, transfers, audit events or stock changed by approvals.
- Existing IDs are kept (insulin stays medicine `1`), so clients request insulin by the alias `med-insulin-100iu-vial`. The closing notice reports the IDs in use.
- It has **not** been applied to the deployed database. Applying it is an owner-approved production change. Take a backup first and follow the [release checklist](docs/release-checklist.md), sections 2 to 4.

```bash
psql "$DB" -v ON_ERROR_STOP=1 -X -f database/migrations/005_expand_final_demo_scenarios_postgres.sql
```

Migrations 002-004 and `schema.sql` are **MySQL** files for the local Compose stack. `schema-postgres.sql` already contains the plan lifecycle tables they add.

### Timestamps

The `TIMESTAMP` columns hold UTC wall-clock time. The API writes and reads them as UTC and returns ISO-8601 instants (`...Z`), and the browser shows them in the viewer's time zone. Keep the database time zone at Supabase's default, `UTC`; `verify-005-postgres.sql` prints it.

## 2. Vercel projects

Create one project per directory from this repository.

| Project | Root directory | Build settings |
| --- | --- | --- |
| Intelligence service | `intelligence` | `intelligence/vercel.json` (FastAPI, 60 s functions) |
| Express API | `backend` | `backend/vercel.json` (`api/[...path].js` serves `/`, `/health` and `/api/*`) |
| Frontend | `frontend` | `frontend/vercel.json` (Vite, `npm run build`, output `dist`, SPA rewrite) |

### Environment variables

**Intelligence service**

| Name | Value |
| --- | --- |
| `DATA_SOURCE` | `postgres` |
| `DATABASE_URL` | transaction pooler URL (secret) |
| `SIMULATION_DATE` | `2026-09-11` |

**Express API**

| Name | Value |
| --- | --- |
| `DATABASE_URL` | the same transaction pooler URL (secret); it selects the PostgreSQL store |
| `AUTH_JWT_SECRET` | unique random secret of at least 32 characters, e.g. `openssl rand -base64 48` (secret) |
| `CORS_ORIGINS` | the exact frontend origin, e.g. `https://frontend-psi-plum-56.vercel.app` |
| `INTELLIGENCE_SERVICE_URL` | the intelligence service URL, no trailing slash |
| `INTELLIGENCE_TIMEOUT_MS` | `30000` |
| `SIMULATION_DATE` | `2026-09-11` |

`NODE_ENV=production` comes from `backend/vercel.json`. Without `AUTH_JWT_SECRET`, sign-in is refused. Without `DATABASE_URL`, the API runs on in-memory fixture data, which is only suitable for local development.

**Frontend** (read at build time; redeploy after a change)

| Name | Value |
| --- | --- |
| `VITE_API_BASE_URL` | the Express API URL followed by `/api` |
| `VITE_USE_MOCKS` | `false` |

The frontend needs nothing else. It must never receive a database URL, a secret or the intelligence service URL.

### Deployment order

Deploy the **intelligence service** first, then the **Express API**, then the **frontend**. The API rejects intelligence responses that lack the evidence it requires, and the frontend expects the current API.

## 3. Accounts and roles

- Sign-up through the website always creates an `OPERATOR`. The API ignores any role in the request.
- No approver account is seeded. After confirming that an account belongs to an authorised person, promote it in the Supabase SQL editor, and record who made the change:

  ```sql
  UPDATE app_users SET role = 'APPROVER' WHERE email = '<verified email>';
  ```

- To disable an account, set `is_active = FALSE`. Sessions check the current role and status on every request.

## 4. Checks

Health checks:

```bash
curl -fsS https://<api-host>/health            # data.status "ok", data.dataSource "POSTGRES", data.database.connected true
curl -fsS https://<intelligence-host>/health   # {"status":"ok","service":"medripple-intelligence"}
```

For a release, run the read-only smoke tests in [docs/release-checklist.md](docs/release-checklist.md#8-read-only-smoke-tests). `backend/scripts/live-acceptance.js` is **not** read-only: it creates an operator account and a proposed plan. Run it against production only with approval.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `503 DATABASE_UNAVAILABLE` | `DATABASE_URL` (transaction pooler, correct password and URL escaping) and Supabase project status |
| `503 INTELLIGENCE_UNAVAILABLE` or `INTELLIGENCE_TIMEOUT` | `INTELLIGENCE_SERVICE_URL`, `INTELLIGENCE_TIMEOUT_MS=30000`, and the service's `/health`. Simulation, optimization and approval fail closed by design. |
| `401 AUTH_REQUIRED` on `/api/*` | Expected without a session; sign in first |
| `503 AUTH_NOT_CONFIGURED` | `AUTH_JWT_SECRET` missing or shorter than 32 characters |
| Browser CORS error or `403 CORS_ORIGIN_DENIED` | `CORS_ORIGINS` must equal the frontend origin exactly |
| `MOCK DATA` banner in the app | The build had no `VITE_API_BASE_URL`, or had `VITE_USE_MOCKS=true`; fix it and redeploy |
| Seed refuses to run | The database already holds other rows with the seed's IDs; use migration 005 instead |
| Dashboard shows insulin only | Expected in this release |

## Limits

Free hosting tiers have usage limits and no uptime guarantee. The deployment is a simulated-data prototype for project evaluation, not a system for clinical or real medicine-transfer decisions. Actual data integration, a qualified safety-policy review, backup and restore drills, and an access review remain the owner's responsibility.
