# MEDRIPPLE deployment and release checklist

## Public deployment (Vercel and Supabase)

The public deployment uses Vercel for the frontend, the Express API and the
intelligence service, and Supabase PostgreSQL for persistent storage. Set it up
with [VERCEL-SUPABASE-DEPLOYMENT.md](../VERCEL-SUPABASE-DEPLOYMENT.md), and release to
it with [release-checklist.md](release-checklist.md). The Vercel API entry point uses
PostgreSQL when `DATABASE_URL` is set; without it, the API serves in-memory
fixture data with no durable accounts or audit history, for development only.
No demo approver exists on the PostgreSQL deployment.

## Persistent integrated deployment

For a real team environment, deploy the services in `compose.yaml` to a host
that provides persistent MySQL storage and can reach the FastAPI service. The
included frontend container proxies `/api` to Express, so the browser has one
public origin.

### Docker host cutover

The lowest-risk path for this repository is one Linux host with Docker Engine,
Compose v2, a persistent disk, and a domain name. The production overlay
exposes only Caddy on ports 80 and 443; MySQL, FastAPI, Express, and nginx stay
on the private Compose network. Caddy obtains and renews the TLS certificate.

Before running the stack, create an A/AAAA DNS record for `PUBLIC_DOMAIN` that
points to the host, allow inbound TCP 80 and 443 in the host firewall, and keep
all other application ports closed. Do not place the MySQL port on the public
internet.

1. Generate a unique `AUTH_JWT_SECRET`; do not use the development fallback.
2. Initialise `database/schema.sql`, then run migrations through
   `database/migrations/004_add_persistent_plans_and_lifecycle.sql` for an
   existing volume. Migration 004 adds durable plans, linked transfer items,
   lifecycle statuses, and deterministic reservation/delivery audit support.
3. Set `DATA_SOURCE=mysql`, `INTELLIGENCE_SERVICE_URL`, database credentials,
   strict `CORS_ORIGINS`, and the generated auth secret.
4. Copy `deploy/production.env.example` to `deploy/production.env`, replace
   every placeholder (including `PUBLIC_DOMAIN`, `ACME_EMAIL`, and the exact
   HTTPS `CORS_ORIGINS`), and run
   `docker compose --env-file deploy/production.env -f compose.yaml -f compose.production.yaml up --build -d`.
   Wait for all health checks, then run the backend and intelligence tests
   against the live stack.
5. Remove or rotate the seeded Demo Approver password; create real approvers
   only after organisational identity verification.
6. Verify the golden flow: login, forecast, simulate, optimise twice (the ID
   must be identical), approve as an approver, dispatch, deliver, inspect the
   persisted audit event and recipient batch quantity, then sign out. Also
   verify that a second approval returns `409 PLAN_ALREADY_DECIDED` and a
   stale donor row returns `409 PLAN_STOCK_CHANGED` with no partial writes.

For an existing MySQL volume, take a tested backup first, then apply migration
004 once before deploying the new backend. It retains historical transfers;
old `COMPLETED` rows are renamed to `DELIVERED`, while legacy rows without a
`plan_id` remain readable. Do not point the production services at a database
until its schema version and backup/restore procedure have been verified.

### Google Cloud option

The signed-in Google Cloud project must have billing enabled before Cloud Run,
Cloud SQL, Artifact Registry, or a Compute Engine host can be created. Enable
billing first, then use either a persistent Docker host (the configuration
above) or Cloud SQL plus separately deployed Node and FastAPI containers.
Cloud Run and Cloud SQL require a Cloud SQL connection, service-account access,
secret-backed database credentials, and a migration job; they are not services
that Vercel can host internally. The official Google guide describes the Cloud
Run-to-Cloud-SQL connection model.

## Release guardrails

- Keep all production secrets out of Git and rotate them after any exposure.
- Public registration grants `OPERATOR` only; it cannot grant approval rights.
- Confirm Aaryan's clinical wording and safety policy before any non-simulated
  use.
- Run a fresh-machine `npm run setup`, `npm run stack:up`, and golden-flow check
  before final demonstration.
- Production uses MySQL 8.4, which enforces the non-negative inventory CHECK
  constraint. Do not deploy to an older MySQL version that ignores CHECKs.
