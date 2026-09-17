# MEDRIPPLE

A prototype for making regional medicine shortages visible before they become emergencies. It runs from deterministic fixtures during development, from the seeded MySQL database in the local Docker stack, or from PostgreSQL (Supabase in the public deployment).

## What runs now

The public deployment now uses **Vercel + persistent Supabase PostgreSQL**, with
the FastAPI WMA forecast and OR-Tools CP-SAT service querying the same database.
See [deployment status](DEPLOYMENT-STATUS.md) and the [service runbook](docs/vercel-supabase.md). The
database contains simulated repository records, not a live hospital feed. Demo
passwords are not enabled on this deployment.

- Express API with consistent JSON success and error envelopes
- Regional summary, facilities, inventory, forecast, simulation, safe-plan, approval and audit routes
- Seeded MySQL and PostgreSQL demo datasets with deterministic insulin scenarios, and a fixture mode for development
- Deterministic database plans, approval revalidation before any reservation, and atomic reserve/dispatch/deliver/cancel audit persistence
- FastAPI intelligence service for forecasting, ripple simulation, optimisation and approval revalidation; with a database, only forecasts fall back (labelled) when it is unavailable
- React workspace: dashboard (insulin summary), facility detail, candidates, Ripple Simulator, plan review and audit trail
- Sign-up/login, signed expiring sessions, and server-enforced operator/approver roles
- Automated API, frontend and intelligence tests and a GitHub Actions check

## Quick start

Requires Node.js 24 and npm. Install each package from its committed lockfile.

```powershell
Copy-Item .env.example .env
npm run setup
npm run dev
```

The API starts at `http://127.0.0.1:3001`; verify it with `GET /health`. [QUICK-START.md](QUICK-START.md) also covers the local PostgreSQL setup.

```powershell
npm test
npm run check
```

Open the frontend in a second terminal with `npm run dev:frontend`. The local fixture-only
simulation approver is `demo.approver@medripple.demo` with password
`MedrippleDemo!2026`. Public sign-up creates an `OPERATOR` account; only an
organisation-assigned `APPROVER` or `ADMIN` can approve or reject a plan.

## Integrated local stack

With Docker Desktop running, start the complete frontend, Express API, FastAPI
intelligence service, and MySQL stack together:

```powershell
npm run stack:up
```

Wait for the health checks, then open `http://127.0.0.1:8080`. The browser
uses the same-origin `/api` proxy; it never needs a hard-coded localhost API
address. `http://127.0.0.1:3001/health` should report
`"dataSource": "MYSQL"`, and the intelligence health endpoint is
`http://127.0.0.1:8000/health`. The backend sends forecast, ripple-simulation,
and optimisation requests to that service, which is the only authority for
simulation, optimisation and approval safety with a database. If the service is
unavailable, only the forecast falls back to a labelled estimate; simulation,
optimisation and approval return `503` and save nothing. Use `npm run stack:logs`
to inspect services and `npm run stack:down` to stop them. The data is
intentionally simulated.

For a persistent deployment, copy
`deploy/production.env.example` to `deploy/production.env`, replace every
placeholder with a unique secret and public origin, then run:

```powershell
docker compose --env-file deploy/production.env -f compose.yaml -f compose.production.yaml up --build -d
```

This production overlay removes the MySQL, FastAPI, Express, and frontend host
ports. It places Caddy in front of the stack on ports 80/443 and obtains a TLS
certificate for `PUBLIC_DOMAIN`. It requires database, authentication, domain,
and CORS values rather than accepting development defaults. Point the domain's
DNS A/AAAA record at the host before starting the stack. An ACME contact email
is optional, so the committed template does not require personal contact data.
Its MySQL lifecycle is `PROPOSED → RESERVED → IN_TRANSIT → DELIVERED` (or
`REJECTED`/`CANCELLED`): approval first re-runs the plan's exact transfers
through the intelligence service's simulator, then atomically reserves donor
stock and logs the decision; delivery alone increases recipient inventory. See
[docs/api-contract.md](docs/api-contract.md) for the approval checks.

For a backend process running outside Docker, use `npm run db:up`, set `DATA_SOURCE=mysql` in `.env`, and then run `npm run dev`.

## Public deployment

The public deployment runs the frontend, the Express API and the intelligence service as three Vercel projects on a persistent Supabase PostgreSQL database. The backend project uses a Vercel serverless catch-all rather than the development `listen()` entry point. With `DATABASE_URL` set, the API uses PostgreSQL; without it, it serves in-memory fixture data, which is for development only.

- Setup: [VERCEL-SUPABASE-DEPLOYMENT.md](VERCEL-SUPABASE-DEPLOYMENT.md)
- Releases (backup, migration 005, deployment order, smoke tests, rollback): [docs/release-checklist.md](docs/release-checklist.md)
- A Docker host with MySQL instead: [docs/deployment.md](docs/deployment.md)

It is a simulated-data prototype, not a clinical production system.

## Important prototype boundaries

All data is simulated. Forecasts and plans are decision support, not clinical advice or autonomous transfer instructions; stock is reserved or moved only after a human approval by an `APPROVER` or `ADMIN`, and every decision is audited. The backend validates exact medicine identity, route cold-chain capability, protected stock over the selected horizon, and human approval/audit data. The dashboard currently summarises insulin only, and no patient-impact metric is calculated. Before release, have Aaryan validate the final safety wording, equity rules, and acceptance cases.

## Team handoffs

- API contract: [docs/api-contract.md](docs/api-contract.md)
- Deployment status and release checklist: [DEPLOYMENT-STATUS.md](DEPLOYMENT-STATUS.md), [docs/release-checklist.md](docs/release-checklist.md)
- Sahil's task board: [docs/sahil-work.md](docs/sahil-work.md)
- Integration notes: [docs/integration-handoffs.md](docs/integration-handoffs.md)
