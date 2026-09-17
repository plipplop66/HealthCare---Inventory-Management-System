# MEDRIPPLE databases

All records in these scripts are **simulated prototype data**, referenced to `SIMULATION_DATE=2026-09-11`. There is no real patient, facility, stock or supply data, and no patient counts or patient-impact values.

## MySQL (Dhiren's dataset)

`schema.sql` is Dhiren's deterministic schema-and-seed script. It creates the `medripple` database with 10 facilities, 12 medicines, batches, 75 days of consumption history, safety stock, replenishments, routes, transfers, and audit events. `golden-scenario.sql` then creates the deterministic Vellore PHC insulin-shortage demo.

### Start locally

Requires Docker Desktop. From the repository root:

```powershell
npm run db:up
```

The first startup runs `schema.sql` automatically and exposes MySQL on port `3306`. The credentials match `.env.example`. To inspect startup state:

```powershell
npm run db:logs
```

To connect the backend, copy `.env.example` to `.env` and change:

```dotenv
DATA_SOURCE=mysql
```

Then run `npm run dev`. `/health` should report `"dataSource": "MYSQL"`. The MySQL backend powers regional summary, facilities, medicines, inventory, scenario simulation, safe-plan generation, plan approval/rejection audit persistence, and durable application accounts. The seeded Demo Approver is only for synthetic-data review; rotate or remove it in any persistent team environment.

### Resetting the database

The seed is deterministic. To reset, stop the Compose stack, remove its `mysql_data` volume, then start it again. This deletes local simulated database data only; do not use the command against a shared or production database.

## PostgreSQL (final demo dataset)

| File | Use |
| --- | --- |
| `schema-postgres.sql` | Creates the tables. It **drops existing tables**, so run it only on a new database. |
| `seed-postgres.sql` | Fresh install: the full demo dataset with fixed IDs. One transaction; a rerun changes nothing. |
| `migrations/005_expand_final_demo_scenarios_postgres.sql` | Upgrades an existing database to the same dataset. Insert-only, one transaction, safe to rerun. |
| `secure-supabase.sql` | Enables row-level security and revokes browser-role access (Supabase). |
| `verify-005-postgres.sql` | Read-only checks before and after migration 005. |

Neither data script touches accounts, plans, transfers or audit events, and neither updates, deletes or truncates anything. None of this was applied to the deployed Supabase database. Running migration 005 there is a separate decision for the database owner; [docs/release-checklist.md](../docs/release-checklist.md) covers the backup, the migration, its verification and rollback.

`verify-005-postgres.sql` is a read-only check to run before and after migration 005: it runs in a `READ ONLY` transaction and reports the time zone, row counts, digests of rows the migration must not change, the added facilities, routes and IDs, and the scenario stock. The PostgreSQL `TIMESTAMP` columns hold UTC time.

### Fresh install (local)

```powershell
psql "<local database URL>" -v ON_ERROR_STOP=1 -f database/schema-postgres.sql
psql "<local database URL>" -v ON_ERROR_STOP=1 -f database/seed-postgres.sql
```

The seed refuses to run where its IDs already belong to other rows, for example on a database that holds the earlier four-facility dataset. Use the migration there instead:

```powershell
psql "<local database URL>" -v ON_ERROR_STOP=1 -f database/migrations/005_expand_final_demo_scenarios_postgres.sql
```

The migration's closing notice reports the insulin medicine ID and the ID of batch `TN-007-B01-26` in that database.

### Contents

1. **Dhiren's MySQL dataset**, identical to `schema.sql` plus `golden-scenario.sql`: 10 facilities, 12 medicines, 24 batches, 90 routes, 8,100 consumption rows, 108 safety-stock rows, 240 inventory rows and 216 replenishments. It is generated with Dhiren's formulas from each row's MySQL ID, and a live check compares it row by row with the seeded MySQL database.
2. **Final demo scenarios** (additions):
   - `PHC-KRR-001`, Karur Primary Health Centre;
   - `PHC-HSR-001`, Hosur Primary Health Centre;
   - insulin lot `TN-007-B03-26`, already received: 800 mL at `DH-CBE-001` and 900 mL at `DH-MDU-001`.

   Both PHCs get 75 days of consumption, stock and orders from the same formulas. Their insulin stock and current orders are set for the scenarios below. All 42 routes to and from them use `schema.sql`'s rule: Haversine distance, time = distance / 46 + destination remoteness × 0.12, and a cold chain only when both ends have one.
3. **The earlier four-facility Navjeevan dataset**, with the same rows as before; `backend/scripts/live-acceptance.js` uses it. Its inventory now carries the 2026-09-11 18:00 snapshot time.

Not copied from MySQL: the historical transfers and audit events, because a PostgreSQL transfer must belong to a plan. Accounts are created through signup.

### IDs

A **fresh install** uses Dhiren's IDs:
- Human Insulin is medicine `7`;
- `TN-007-B01-26` is batch `14`;
- `PHC-VLR-001` is facility `6`.

The additions follow:
- `PHC-KRR-001` is facility `11` and `PHC-HSR-001` is facility `12`;
- `TN-007-B03-26` is batch `25`;
- the four earlier facilities are `13`-`16`.

An **upgraded database** keeps its existing IDs, and new rows take the next free IDs. Existing rows are never renumbered, because plans and transfers refer to them. On a database that held the earlier dataset, insulin stays medicine `1`; use the alias `med-insulin-100iu-vial` or the reported ID. The earlier insulin row also keeps its `HIGH` criticality, which the risk score treats the same as `CRITICAL`.

**Plan ID.** The deterministic plan ID includes the data source. The same Vellore transfer is therefore:
- `plan-a4d757f3efa18dc5765e61e71f993073` in a fresh PostgreSQL install;
- `plan-b9b11f08be174706d5dae2a446b74596` in MySQL.

The ID is only reproducible where the IDs above are the same.

### Scenarios (insulin, 14-day horizon)

**Golden Vellore shortage.** `POST /plans/optimize` with `PHC-VLR-001`, 300 mL.
- Vellore starts CRITICAL: 34 mL, 38.88 mL/day and a stockout on day 1. Its 1372 mL order is DELAYED to day 8.
- `WH-TN-001` sends 300 mL of `TN-007-B01-26` over 124.7 km in 3.19 h, with a cold chain.
- The stockout is prevented, every validation check passes and `safeToRecommend` is true.

**Clinical donor, received stock only.** In the Karur plan below, `DH-CBE-001` (3.10 h) has:
- effective stock 2941.69 mL and a retained floor of 1130.82 mL;
- a safe capacity of 604.49 mL, computed without counting its 2998.36 mL scheduled delivery;
- no `DONOR_AT_RISK` or `NO_SAFE_DONOR_CAPACITY`;
- `donorCapacityBasis` `RECEIVED_STOCK_ONLY`.

**Two-donor plan.** `PHC-KRR-001`, 800 mL: the amount needed to close the shortage and rebuild safety stock.
- Karur starts CRITICAL: 40 mL and a stockout on day 2; its order is DELAYED to day 9.
- No single donor can send 800 mL. The plan uses `DH-CBE-001` (167.59 mL) and `DH-MDU-001` (632.41 mL, 2.94 h), each from its earliest-expiring lot `TN-007-B01-26`.
- `WH-TN-001` is 7.73 h away, so it is excluded.
- Asking for 1300 mL returns `NO_SAFE_PLAN`, with a safe capacity of 1236.9 mL and escalation steps.

**Unsafe donor.** `POST /scenarios/simulate`:
- `DH-CBE-001` sending 1500 mL to `PHC-KRR-001` is `BELOW_PROTECTED_STOCK`. The donor holds 1913.68 mL above its protected stock, but projected use takes it to 493.82 mL by day 11.
- `CHC-TRY-001` sending 700 mL also gets `CREATES_REGIONAL_SHORTAGE`.

**Cold-chain failure.** `COLD_CHAIN_UNAVAILABLE`:
- `PHC-TNJ-001` → `PHC-KRR-001`: the route has no cold chain because Thanjavur has no cold-chain storage;
- any insulin sent to `PHC-TNJ-001`.

**Route over six hours.**
- These routes are still simulated for their stock effect but are ineligible (`TRAVEL_TIME_LIMIT_EXCEEDED`), and `safeToRecommend` is false:
  - `WH-TN-001` → `PHC-KRR-001`, 7.73 h;
  - `DH-MDU-001` → `PHC-HSR-001`, 7.02 h;
  - Dhiren's `DH-CBE-001` → `PHC-VLR-001`, 7.38 h.
- The optimizer gives the same reason.

**Exactly six hours.** `PHC-HSR-001`, 150 mL.
- Hosur is HIGH: stockout on day 9, order DELAYED to day 10.
- `WH-TN-001` → `PHC-HSR-001` is exactly 6.00 h (267.75 km) and is accepted.

**Future-supply-dependent donor.** `CHC-SLM-001` has:
- a safe capacity of 0 and `NO_SAFE_DONOR_CAPACITY`;
- a 1745.5 mL delivery due on day 3, reported in `futureReplenishmentExcluded`.

Its reason says the delivery is not counted and that the donor would look able to send stock only because of it. The Ripple Simulator, which counts the delivery, finds a small transfer safe.

Adding the demo and earlier facilities changes regional numbers compared with MySQL. For example, Vellore's risk score is 87 here and 84 in MySQL; its label and the plan are the same.

### Tests

- **Always:** `intelligence/tests/test_postgres_demo_dataset.py` checks both scripts without a database:
  - the shared sections are identical, and each script is one transaction;
  - the migration is insert-only, and the seed has its ID guard;
  - both are deterministic and label the data as simulated;
  - the IDs, the route rule, the six-hour and cold-chain fixtures, and the scenario rows are consistent.
- **Opt-in, local database only:**
  - `intelligence/tests/test_postgres_demo_live.py` runs every scenario through the real PostgreSQL data source and checks that requests are read-only and repeatable. With `MEDRIPPLE_LIVE_MYSQL=1` it also compares Dhiren's rows with the seeded MySQL database.
  - `backend/test/postgres-demo-live.test.js` checks what the Node store exposes.
  - Both refuse a `DATABASE_URL` that is not `localhost` or `127.0.0.1`.

The Python connector always uses `sslmode=verify-full`. A local server therefore needs a certificate that the client trusts through `PGSSLROOTCERT`. The Node test uses TLS when `DATABASE_SSL=true`, with `NODE_EXTRA_CA_CERTS` for a local CA.

```powershell
$env:MEDRIPPLE_LIVE_POSTGRES = "1"; $env:PGSSLROOTCERT = "<local test CA certificate>"
$env:DATABASE_URL = "postgresql://<user>:<password>@127.0.0.1:<port>/<database>"
cd intelligence; .\.venv\Scripts\python -m pytest tests/test_postgres_demo_live.py; cd ..
node --test backend/test/postgres-demo-live.test.js
```
