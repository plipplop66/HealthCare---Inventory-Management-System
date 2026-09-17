# Vercel + Supabase deployment

Verified 17 September 2026 (India time).

## Public services

- Frontend: https://frontend-psi-plum-56.vercel.app/
- Express health: https://health-care-inventory-management-sy-ecru.vercel.app/health
- Express API: https://health-care-inventory-management-sy-ecru.vercel.app/api
- FastAPI intelligence: https://medripple-intelligence.vercel.app

The old `backend-henna-two-yj22z5glo8.vercel.app` deployment is paused and must not
be used by the frontend. The active backend project is
`health-care-inventory-management-system-backend-biv9` (root directory `backend`).
The frontend and intelligence projects deploy from their respective directories.

## Data and model boundaries

Supabase PostgreSQL stores accounts, inventory, consumption, proposed plans,
transfer lifecycle state, and audit history. This is real persistent storage,
not a process-local fixture. The current four-facility insulin dataset is still
**simulated**, referenced to 2026-09-11. No external hospital feed is connected.
The dashboard polls every 30 seconds while visible and refreshes on focus.
This is polling, not a Supabase Realtime/WebSocket subscription.

The intelligence service reads a consistent, read-only PostgreSQL snapshot on
each request. It uses `aiml-step1-wma-v1` forecasting and OR-Tools CP-SAT, not an
LLM or a clinically validated model. The short seeded consumption history is
honestly reported as low-confidence. Safety-policy confirmation remains a
human responsibility; the seed does not claim Aaryan has approved it.

Forecast outages return an explicitly labelled database fallback. Persistent
plan optimization fails closed if the intelligence optimizer is unavailable;
it does not substitute an inventory-reserving fixture plan. A failed AI section
does not prevent the regional dashboard from loading.

## Configuration

Store secrets only in Vercel environment settings, never in Git or `VITE_*`.

Express production:

- `DATABASE_URL`: Supabase transaction-pooler URL, port 6543, user
  `postgres.<project-ref>`; use the exact endpoint in Supabase Connect.
- `AUTH_JWT_SECRET`: existing unique secret of at least 32 characters.
- `NODE_ENV=production`
- `CORS_ORIGINS=https://frontend-psi-plum-56.vercel.app`
- `INTELLIGENCE_SERVICE_URL=https://medripple-intelligence.vercel.app`
- `INTELLIGENCE_TIMEOUT_MS=30000`
- `SIMULATION_DATE=2026-09-11` (explicitly change only with a coordinated data cutover).

Intelligence production: `DATA_SOURCE=postgres`, the same `DATABASE_URL`, and
the same simulation date. Prepared statements are disabled for transaction pooling.

Frontend: `VITE_API_BASE_URL` points to the active Express `/api` URL;
`VITE_USE_MOCKS=false`. No database credentials enter the browser bundle.

Both database clients verify TLS with the Supabase public CA certificate from
the project's Database Settings download. Its SHA-256 fingerprint is
`807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA`.

## Database operations

`schema-postgres.sql` is an **initialization/reset script with DROP statements**.
Never rerun it on the deployed database. The live schema already exists.

- `database/seed-postgres.sql` is the fresh-install seed for a new database: the
  final demo dataset with fixed IDs (see `database/README.md`). It refuses to run
  where those IDs already belong to other rows, as on the deployed database, and
  it contains no public approver account.
- `database/migrations/005_expand_final_demo_scenarios_postgres.sql` adds the same
  dataset to an existing database. It is insert-only and never resets inventory
  or touches accounts, plans, transfers or audits. It has not been applied to the
  deployed database; doing so is a separate owner-approved change.
- `database/secure-supabase.sql` enables RLS and revokes direct table privileges
  from `anon` and `authenticated`. Only server-side SQL clients access tables.
- Do not grant direct browser access to `app_users` or audit/transfer tables.

Sign up through the website. New users are operators. Assign an approver only
after confirming the exact account belongs to the authorised person. Never
grant roles based only on an unverified signup email or a browser-supplied role.
Existing sessions consult current account status/role on each API request.

## Repeatable checks

```powershell
npm run setup
npm run check
npm test
npm run build:frontend
python -m pip install -r intelligence/requirements.txt
python -m pytest intelligence/tests
$env:ACCEPTANCE_BASE_URL='https://health-care-inventory-management-sy-ecru.vercel.app'
node backend/scripts/live-acceptance.js
```

The live check creates one uniquely named operator and one proposed plan. It
tests persistent signup/login, database reads, AI forecasts/optimization, plan
retrieval, and forbidden operator approval. It never approves or moves stock.
Its test account can be disabled after the check; do not remove audit history.

## Production boundaries still requiring owner acceptance

Actual operational data/import integration, qualified safety-policy review,
backup/restore drills, access review and final human workflow acceptance are
not replaced by passing software tests. Free hosting has usage limits and no
promise of unlimited uptime. The currently deployed dataset is suitable for
project evaluation, not autonomous clinical or real medicine-transfer decisions.
