# MEDRIPPLE

A prototype for making regional medicine shortages visible before they become emergencies. It can run from deterministic fixtures during development or from the seeded MySQL database for the integrated backend flow.

## What runs now

- Express API with consistent JSON success and error envelopes
- Regional summary, facilities, inventory, forecast, simulation, safe-plan, approval and audit routes
- Seeded MySQL schema, deterministic insulin golden scenario, and switchable fixture fallback
- Source-aware simulator, constrained safe-plan generator, and human approve/reject audit persistence
- FastAPI intelligence adapter with timeout validation and an explicitly labelled fixture fallback
- Automated API tests and a GitHub Actions check

## Quick start

Requires Node.js 20+ and pnpm 9+.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm dev
```

The API starts at `http://127.0.0.1:3001`; verify it with `GET /health`.

```powershell
pnpm test
pnpm check
```

## Integrated local stack

With Docker Desktop running, start the MySQL database and backend together:

```powershell
pnpm stack:up
```

Wait for the backend health check, then open `http://127.0.0.1:3001/health`. It should report `"dataSource": "MYSQL"`. Use `pnpm stack:logs` to inspect services and `pnpm stack:down` to stop them. The data is intentionally simulated.

For a backend process running outside Docker, use `pnpm db:up`, set `DATA_SOURCE=mysql` in `.env`, and then run `pnpm dev`.

## Important prototype boundaries

All data is simulated. Forecasts and plans are decision support, not clinical advice or autonomous transfer instructions. The backend validates exact medicine identity, route cold-chain capability, protected stock over the selected horizon, and human approval/audit data. Before release, connect Druv's tested FastAPI service and have Aaryan validate the final safety wording, equity rules, and acceptance cases.

## Team handoffs

- API contract: [docs/api-contract.md](docs/api-contract.md)
- Sahil's task board: [docs/sahil-work.md](docs/sahil-work.md)
- Integration notes: [docs/integration-handoffs.md](docs/integration-handoffs.md)
