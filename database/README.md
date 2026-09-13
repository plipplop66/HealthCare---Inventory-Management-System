# MEDRIPPLE MySQL database

`schema.sql` is Dhiren's deterministic schema-and-seed script. It creates the `medripple` database with 10 facilities, 12 medicines, batches, 75 days of consumption history, safety stock, replenishments, routes, transfers, and audit events. `golden-scenario.sql` then creates the deterministic Vellore PHC insulin-shortage demo. All records are simulated.

## Start locally

Requires Docker Desktop. From the repository root:

```powershell
pnpm db:up
```

The first startup runs `schema.sql` automatically and exposes MySQL on port `3306`. The credentials match `.env.example`. To inspect startup state:

```powershell
pnpm db:logs
```

To connect the backend, copy `.env.example` to `.env` and change:

```dotenv
DATA_SOURCE=mysql
```

Then run `pnpm dev`. `/health` should report `"dataSource": "MYSQL"`. The MySQL backend powers regional summary, facilities, medicines, inventory, scenario simulation, safe-plan generation, and plan approval/rejection audit persistence. Forecast remains a clearly labelled fallback until Druv's intelligence service is connected.

## Resetting the database

The seed is deterministic. To reset, stop the Compose stack, remove its `mysql_data` volume, then start it again. This deletes local simulated database data only; do not use the command against a shared or production database.
