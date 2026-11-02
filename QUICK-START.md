# MEDRIPPLE quick start

Everything here runs locally on simulated data. To deploy, see [VERCEL-SUPABASE-DEPLOYMENT.md](VERCEL-SUPABASE-DEPLOYMENT.md). To release to the existing deployment, see [docs/release-checklist.md](docs/release-checklist.md).

Requirements: Node.js 24 and npm, Python 3.12 or later, and Docker Desktop for the database options.

## 1. Fixture mode (no database)

```powershell
Copy-Item .env.example .env
npm run setup
npm run dev                # Express API on http://127.0.0.1:3001 (GET /health)
npm run dev:frontend       # second terminal; open the URL Vite prints
```

The local demo approver is `demo.approver@medripple.demo` with the password `MedrippleDemo!2026`. It exists only in fixture mode and in the local MySQL seed; the PostgreSQL seed creates no accounts. Sign-up creates an `OPERATOR`, who cannot approve plans.

## 2. Full local stack (MySQL)

```powershell
npm run stack:up           # MySQL, intelligence service, API and frontend
```

Open `http://127.0.0.1:8080`. Stop the stack with `npm run stack:down`. The MySQL data lives in a Docker volume; see [database/README.md](database/README.md) to reset it.

## 3. Local PostgreSQL

Create a local database, then load `database/schema-postgres.sql` followed by `database/seed-postgres.sql` (see [database/README.md](database/README.md)).

Run the intelligence service with:
- `DATA_SOURCE=postgres`;
- `DATABASE_URL`;
- `PGSSLROOTCERT` for your local TLS certificate authority.

Run the API with:
- the same `DATABASE_URL`;
- `DATABASE_SSL=true`;
- `INTELLIGENCE_SERVICE_URL`;
- `INTELLIGENCE_TIMEOUT_MS=15000`.

For the frontend, set `VITE_API_BASE_URL=http://127.0.0.1:3001/api`.

## Tests

```powershell
npm run check
npm test                              # API
npm --prefix frontend test            # frontend
npm run build:frontend
python -m pytest intelligence/tests   # intelligence service
```

The live database tests are opt-in and refuse non-local databases. See [database/README.md](database/README.md) and the test file headers.

## Boundaries

All data is simulated. Forecasts and plans are decision support; stock moves only after a human approval. The dashboard summarises insulin only.
