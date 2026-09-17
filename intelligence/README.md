# MEDRIPPLE intelligence service - AIML Step 1 / Day 1

> **All data used by this service is simulated prototype data.** Nothing here is real patient, facility or supply data. Results are decision support only, not clinical advice or transfer instructions. Risk weights and thresholds are prototype assumptions and are **not clinically validated**.

A standalone Python FastAPI service that forecasts medicine demand, projects stock day by day, and returns an explainable risk score, cause and confidence. It can be used in two ways:

- **In Python:** `analyse_shortage(facility_data)`, the Day 1 entry point.
- **Over HTTP:** `POST /forecast`. When the Node backend's `INTELLIGENCE_SERVICE_URL` points at this service, `POST /api/forecast` returns `source: "INTELLIGENCE_SERVICE"` instead of a fallback.
- **Ripple Simulator:** `POST /scenarios/simulate` projects every facility before and after proposed transfers, with the same forecast and projection, and says whether they are safe to recommend. See [Ripple Simulator](#ripple-simulator-post-scenariossimulate).
- **Transfer optimizer:** `POST /plans/optimize` proposes the smallest safe multi-source plan for a requested quantity, using OR-Tools CP-SAT. The Ripple Simulator validates every plan before it is returned. See [Transfer optimizer](#transfer-optimizer-post-plansoptimize).

The HTTP service reads the offline Navjeevan PHC fixture, Dhiren's MySQL database, or PostgreSQL holding Dhiren's dataset plus the final demo scenarios (see [Data sources](#data-sources)). All three use the same calculation code, so they always return the same numbers for the same data. Day 1 is intentionally transparent: a weighted moving average and simple rules, with no deep learning, LLMs or randomness.

## Quick start

Requires Python 3.10+ (tested on 3.10.11 and 3.13.5). Run everything from this `intelligence/` directory.

Windows PowerShell:

```powershell
cd intelligence
py -3.13 -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python -m pytest
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

macOS / Linux:

```bash
cd intelligence
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python -m pytest
.venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Check it at `http://127.0.0.1:8000/health`; interactive API docs are at `http://127.0.0.1:8000/docs`.

If `pip install` fails with `CERTIFICATE_VERIFY_FAILED`, the venv's pip is probably older than 24.2 and cannot use the operating-system certificate store. Create the venv with a newer Python (for example `py -3.13`) instead of disabling certificate checks.

## Data sources

`DATA_SOURCE` selects where facilities, medicines, stock and consumption come from. All modes run exactly the same forecast, projection and risk code: `app/mysql_store.py` only reads database rows and normalises them into the structures the fixture uses, and `app/postgres_store.py` reuses it with a PostgreSQL connection.

| `DATA_SOURCE` | Reads | IDs | Quantities |
| --- | --- | --- | --- |
| `fixture` (default) | Offline Navjeevan PHC fixture (`app/data_store.py`, `data/simulated_consumption.csv`) | `facility-navjeevan-phc` and three others; `med-insulin-100iu-vial` | `vial` |
| `mysql` | Only Dhiren's MySQL database (`database/schema.sql` and `golden-scenario.sql`), read-only | `facilities.facility_code` (e.g. `PHC-VLR-001`) or the numeric `facility_id`; the numeric `medicine_id` (e.g. `7`) or the documented alias `med-insulin-100iu-vial` | The medicine's base unit (`mg`, `mL` or `count`), decimals kept |
| `postgres` | PostgreSQL (Supabase for the Vercel deployment) through `DATABASE_URL`, read-only, with the same queries and interpretation rules as `mysql`. `database/seed-postgres.sql` holds Dhiren's dataset plus the final demo scenarios; see `database/README.md` | As `mysql` | As `mysql` |

In `mysql` and `postgres` mode the service never uses fixture data: fixture IDs return 404, and if the database cannot be reached `POST /forecast` returns 503 `DATABASE_UNAVAILABLE`. PostgreSQL connections verify the server certificate (`sslmode=verify-full`, with `certs/supabase-ca.crt` for Supabase hosts) and run in a read-only transaction. `dataContext.dataSource` is `POSTGRES`, and the reviewed transfer rules and mapping statuses are identical to `mysql`.

Environment variables use the names in `backend/src/config.js`. This service does not read `.env`, so set them in the shell.

| Variable | Default | Mode |
| --- | --- | --- |
| `DATA_SOURCE` | `fixture` | all |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` | `127.0.0.1`, `3306`, `medripple`, `medripple`, empty | `mysql` |
| `DATABASE_URL` | none (required) | `postgres` |
| `SIMULATION_DATE` | `2026-09-11` | `mysql`, `postgres` |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `5` | `mysql`, `postgres` |

`DATABASE_URL` is rejected at startup in `mysql` mode, so the service cannot silently connect to a different database than configured, and `postgres` mode refuses to start without it.

Run against the database started by `pnpm db:up` (PowerShell):

```powershell
$env:DATA_SOURCE = "mysql"; $env:DATABASE_PASSWORD = "medripple_dev_only"
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### How database fields are interpreted

Every MySQL or PostgreSQL forecast returns these rules in `dataContext.mappings` and `assumptions`. `units` is database policy, and `effectiveStock` is approved by Dhiren for the hackathon prototype (`APPROVED_FOR_HACKATHON_PROTOTYPE`). The others are **provisional** until the named owner confirms them.

| Mapping | Rule | Review |
| --- | --- | --- |
| `units` | Quantities stay in `medicines.base_unit` with their decimals; nothing is converted | Dhiren (database policy) |
| `asOfDate` | Inventory is an end-of-day snapshot (`last_updated` 18:00 on `SIMULATION_DATE`), so projection day 1 is `SIMULATION_DATE + 1` and the 60-day history ends on `SIMULATION_DATE`. Arrival day = `DATEDIFF(expected_arrival_date, SIMULATION_DATE)`, as in `backend/src/mysql-store.js` | Dhiren and Sahil |
| `medicineCriticality` | `CRITICAL` scores 1.0, the same as `HIGH` | Aaryan |
| `facilityRemoteness` | Signal = `remoteness_score / 10` (the schema's 0-10 scale) | Aaryan |
| `protectedStock` | `facility_safety_stock.safety_stock_qty` is used directly; a facility without a row gets 0, as in the backend | Aaryan |
| `effectiveStock` | `AVAILABLE` inventory from non-quarantined batches expiring on or after day 1. The backend also counts a batch expiring exactly on `SIMULATION_DATE` | Dhiren |
| `replenishments` | `SCHEDULED` and `DELAYED` orders expected after `SIMULATION_DATE` arrive in full on their date; `ARRIVED`, `CANCELLED` and `supplier_reliability_score` are not used. Open orders already overdue are reported in `dataContext.notes` | Dhiren and Sahil |
| `regionalPeers` | Each seeded facility has its own `region`, so fragility compares all other facilities holding the medicine | Aaryan |
| `medicineAlias` | Only when `med-insulin-100iu-vial` is requested: it resolves to Human Insulin 100 IU/mL Vial by exact identity | Sahil |

### Facilities without consumption

Warehouses dispense stock rather than consume it, so the seed has no consumption rows for `WH-TN-001`. Forecasting a facility with no consumption rows in the history window returns 422 `NO_CONSUMPTION_HISTORY` rather than an invented zero-demand forecast. Such a facility still counts as a regional peer: with recorded protected stock, its safe surplus is effective stock minus protected stock, which needs no forecast.

### Tests

`python -m pytest` never needs Docker or MySQL. `tests/conftest.py` pins the ordinary suite to the fixture. The suite covers:
- the MySQL store (`tests/test_mysql_store.py`);
- the Ripple Simulator (`tests/test_simulator.py`, `tests/test_simulator_api.py`);
- the transfer optimizer (`tests/test_optimizer.py`, `tests/test_optimizer_api.py`).

These use in-memory rows (`tests/simulator_support.py`, `tests/optimizer_support.py`) and the fixture. The real-database checks in `tests/test_mysql_live.py`, `tests/test_simulator_live.py` and `tests/test_optimizer_live.py` run only when opted in:

```powershell
$env:MEDRIPPLE_LIVE_MYSQL = "1"; $env:DATABASE_PASSWORD = "medripple_dev_only"
.\.venv\Scripts\python -m pytest tests/test_mysql_live.py tests/test_simulator_live.py tests/test_optimizer_live.py
```

Run only the simulator tests with `.\.venv\Scripts\python -m pytest tests/test_simulator.py tests/test_simulator_api.py`, and only the optimizer tests with `.\.venv\Scripts\python -m pytest tests/test_optimizer.py tests/test_optimizer_api.py`.

The PostgreSQL demo dataset is checked by two modules:
- `tests/test_postgres_demo_dataset.py` always runs and needs no database.
- `tests/test_postgres_demo_live.py` runs only with `MEDRIPPLE_LIVE_POSTGRES=1` and a local `DATABASE_URL`; see `database/README.md`.

## Day 1: `analyse_shortage(facility_data)`

```python
from app.risk_engine import analyse_shortage

facility_data = {
    "as_of_date": "2026-09-01",
    "consumption_history": [{"date": "2026-07-03", "units_consumed": 5}, ...],  # daily records
    "current_stock": 22,
    "expected_replenishment_date": "2026-09-08",
    "incoming_quantity": 100,
    "medicine_criticality": "HIGH",
    "facility_remoteness": 0.8,
    "regional_fragility": 1 / 3,
    "protected_days": 14,
    "horizon_days": 14,
    "unit": "vial",
}

result = analyse_shortage(facility_data)
print(result)
```

With Navjeevan PHC's simulated history this prints (reason and explanation shortened here):

```python
{'predicted_demand': 8.06, 'days_remaining': 2.7, 'stockout_date': '2026-09-03', 'risk_score': 83,
 'risk_level': 'CRITICAL', 'cause': 'SUPPLY_DELAY',
 'confidence': {'label': 'HIGH', 'reason': 'Sufficient recent data: 60 valid daily records, ...'},
 'explanation': 'Effective stock is projected to run out before the scheduled replenishment arrives. ...'}
```

### Input

| Key | Required | Meaning |
| --- | --- | --- |
| `as_of_date` | yes | `YYYY-MM-DD`; day 1 of the projection |
| `consumption_history` | yes | List of `{"date": "YYYY-MM-DD", "units_consumed": number}`. The 60 days before `as_of_date` are used. Missing, blank, non-numeric, negative, duplicated or undatable records are handled (they lower confidence), not rejected |
| `current_stock` | yes | Effective (usable, unexpired) stock, 0 or more |
| `medicine_criticality` | yes | `CRITICAL`, `HIGH`, `MEDIUM` or `LOW` (signal 1.0 / 1.0 / 0.6 / 0.3; `CRITICAL` is provisional) |
| `facility_remoteness` | yes | 0 (central) to 1 (most remote) |
| `regional_fragility` | yes | 0 to 1: share of other facilities in the region with no safe donor surplus. The API calculates this from the other facilities; a standalone caller supplies it |
| `protected_days` | yes | Days of forecast demand kept as protected stock |
| `expected_replenishment_date` | no | `YYYY-MM-DD`, on or after `as_of_date`; give it together with `incoming_quantity` |
| `incoming_quantity` | no | Quantity arriving on that date |
| `horizon_days` | no | `7`, `14` or `30` (default `14`) |
| `unit` | no | Unit name used in the explanation (default `"unit"`) |

Other keys are ignored. These field names are provisional and still need aligning with the MySQL column names.

### Output

| Key | Meaning |
| --- | --- |
| `predicted_demand` | Forecast daily demand |
| `days_remaining` | Days of cover from current stock, before replenishment |
| `stockout_date` | First date on which demand cannot be fully met, or `None` if no stockout within the horizon |
| `risk_score` | 0-100 |
| `risk_level` | `LOW`, `MEDIUM`, `HIGH` or `CRITICAL` |
| `cause` | `DEMAND_SHOCK`, `SUPPLY_DELAY`, `INVENTORY_IMBALANCE`, `DATA_ANOMALY`, `TEMPORARY_DIP` or `STABLE` |
| `confidence` | `{"label": "HIGH" / "MEDIUM" / "LOW", "reason": "..."}` |
| `explanation` | Plain-language summary built from the computed facts |

Invalid input raises `ValueError` naming the field. Fewer than 14 valid daily records raises `InsufficientHistoryError` (a `ValueError`).

## Connect the Node backend

1. Start this service on port 8000 with the same `DATA_SOURCE` as the backend (for `mysql`, also the same database settings and `SIMULATION_DATE`).
2. In the repository root `.env` (copied from `.env.example`), set `INTELLIGENCE_SERVICE_URL=http://127.0.0.1:8000`.
3. From the repository root, run `pnpm dev`.
4. `POST http://127.0.0.1:3001/api/forecast` now returns `meta.source: "INTELLIGENCE_SERVICE"` and `meta.fallback: false`, for example with `{"facilityId": "PHC-VLR-001", "medicineId": "7", "horizonDays": 14}` in MySQL mode.

If this service is stopped, slower than `INTELLIGENCE_TIMEOUT_MS` (default 2500 ms), or returns a 5xx status, the Node adapter falls back to its own labelled forecast (`FIXTURE_FALLBACK`, or `DATABASE_FALLBACK` with a database). This service's deliberate 4xx answers, such as `NO_CONSUMPTION_HISTORY` for a warehouse, are passed through to the caller instead; see [Node backend integration](#node-backend-integration).

This directory is deliberately **not** a pnpm workspace member. pnpm members must be Node packages, and adding one changes `pnpm-lock.yaml`, which CI installs with `--frozen-lockfile`. The Python commands above are kept separate.

## API

### `GET /health`

```json
{ "status": "ok", "service": "medripple-intelligence" }
```

### `POST /forecast`

```json
{ "facilityId": "facility-navjeevan-phc", "medicineId": "med-insulin-100iu-vial", "horizonDays": 14 }
```

In MySQL mode the IDs are database IDs, for example `{ "facilityId": "PHC-VLR-001", "medicineId": "7", "horizonDays": 14 }`.

`horizonDays` must be the integer `7`, `14` or `30`, and defaults to `14` when omitted (matching the Node validation).

The response keeps every field the Node adapter and `docs/api-contract.md` rely on:

| Field | Meaning |
| --- | --- |
| `forecast.dailyDemand`, `lowerBound`, `upperBound`, `horizonDays` | Weighted-moving-average demand and its bounds |
| `forecast.trend`, `forecast.trendChangePercent` | Recent demand trend: `INCREASING`, `DECREASING` or `STABLE`, with % change |
| `risk.score` (0-100 integer), `risk.label` | Prototype risk score and level |
| `stockout.daysRemaining` | Days of cover from current effective stock, before replenishment |
| `stockout.projectedWithinHorizon`, `projectedStockoutDay`, `projectedStockoutDate` | First projected day (and date) on which demand cannot be fully met |
| `stockout.shortageGapDays` | Duration of the shortage: days from that stockout until supply is restored (or the horizon ends) |
| `stockout.minimumProjectedStock` | Lowest projected closing stock in the horizon |
| `stockout.replenishmentArrivesBeforeStockout`, `replenishmentTiming` | Whether the next scheduled delivery arrives before the stockout |
| `confidence.label`, `confidence.reason` | HIGH / MEDIUM / LOW with a human-readable reason |
| `cause` | One primary cause code |
| `explanation` | Plain-language summary |
| `assumptions` | Modelling and safety assumptions, including the simulated-data notice |
| `decisionSupportOnly` | Always `true` |

Additional fields: `forecast.recentAverage` / `baselineAverage` / `recentVariability`, `contributingFactors`, `risk.components` (per-weight signal and points), extra `stockout` fields (`totalShortageDays`, `unmetDemand`, `supplyRestoredDay`, `nextReplenishment`), `facility` (including `sourceRemotenessScore` as stored), `medicine`, `inventory` (recorded, effective and protected stock, `protectedStockSource`, safe surplus, and `nextReplenishment` / `scheduledReplenishments` with arrival day and date), a day-by-day `projection`, `dataQuality`, `dataContext` (data source, simulation date, as-of date, history window, mappings and notes), `dataLabel` and `modelVersion`. All quantities are in `forecast.unit` and keep their decimals. The service does not send `source`; the Node adapter sets it.

### Errors

Errors use `{ "error": { "code", "message", "details"? } }`.

| Status | Code | When |
| --- | --- | --- |
| 404 | `FACILITY_NOT_FOUND` | Unknown `facilityId` |
| 404 | `MEDICINE_NOT_FOUND` | Unknown `medicineId` |
| 404 | `FORECAST_TARGET_NOT_FOUND` | Facility and medicine exist but have no inventory record |
| 422 | `INVALID_HORIZON` | `horizonDays` is not the integer 7, 14 or 30 |
| 422 | `INVALID_REQUEST` | Missing, empty or wrongly typed fields, or malformed JSON |
| 422 | `NO_CONSUMPTION_HISTORY` | No consumption rows at all in the history window (for example a warehouse) |
| 422 | `INVALID_HISTORY` | Fewer than 14 valid consumption records to forecast from |
| 500 | `DATABASE_DATA_INVALID` | A database value is outside the schema contract (for example remoteness above 10) |
| 503 | `DATABASE_UNAVAILABLE` | `DATA_SOURCE=mysql` and MySQL cannot be reached or queried |

The Node backend validates requests itself (returning 400) before calling this service, and converts any error from this service into its labelled fallback (`FIXTURE_FALLBACK` or `DATABASE_FALLBACK`).

## Ripple Simulator: `POST /scenarios/simulate`

> **Simulated decision support only.** All data is simulated. A qualified person must review and approve every operational transfer before any stock moves. The simulator never substitutes one medicine for another, never writes a transfer and never changes inventory.

The simulator shows what happens to **every facility holding the medicine** if one or more proposed transfers are carried out. It answers:

- Does the recipient avoid its stockout?
- Does a donor fall below protected stock or become critical?
- Does any other facility become unsafe?
- Does regional shortage get better or worse?
- Is the scenario safe to recommend, and why is each transfer accepted or rejected?

Node's `/api/scenarios/simulate` route calls it when `INTELLIGENCE_SERVICE_URL` is set, and uses its own labelled simulator only when this service is unavailable; see [Node backend integration](#node-backend-integration).

### Request

The same shape the Node backend accepts (`backend/src/validation.js`):

```json
{
  "horizonDays": 14,
  "transfers": [
    { "fromFacilityId": "WH-TN-001", "toFacilityId": "PHC-VLR-001", "medicineId": "7", "quantity": 300, "arrivalDay": 1 }
  ]
}
```

| Field | Rule |
| --- | --- |
| `horizonDays` | `7`, `14` or `30`; defaults to `14` (422 `INVALID_HORIZON` otherwise) |
| `transfers` | 1 to 50 transfers, all evaluated together |
| `fromFacilityId`, `toFacilityId` | Non-empty and different; resolved through the active data source (database code or numeric ID in MySQL mode) |
| `medicineId` | Resolved through the active data source; every transfer must be the same exact medicine |
| `quantity` | Positive number in the medicine's unit; decimals are kept |
| `arrivalDay` | Whole number of at least 1; defaults to `1`. Day 1 is the as-of date |

Malformed requests return 422 `INVALID_REQUEST`. If none of the requested medicines exists the response is 404 `MEDICINE_NOT_FOUND`; an unknown facility is reported as a rejected transfer. MySQL outages return 503 `DATABASE_UNAVAILABLE`.

### Response

| Field | Meaning |
| --- | --- |
| `medicine` | `id`, `genericName`, `strength`, `dosageForm`, `unit`, `criticality`, `requiresColdChain` |
| `baseline`, `intervention` | `criticalFacilityCount`, `stockoutFacilityCount`, `regionalShortageDays`, `regionalUnmetDemand`, `regionalRisk` (highest facility score), `averageRisk`, `appliedTransferCount`, `facilities[]` |
| `facilities[]` | `facilityId`, `facilityName`, `role`, `effectiveStock`, `transferIn`, `transferOut`, `stockAfterTransfers`, `protectedStock`, `predictedDailyDemand`, `demandBasis`, `daysRemaining`, `stockoutDay` / `stockoutDate`, `shortageDays`, `unmetDemand`, `minimumProjectedStock`, `endingStock`, `belowProtectedStock`, `riskScore`, `riskLabel`, and `projectedDailyStock[]` (`openingStock`, `transferOut`, `scheduledReplenishment`, `transferIn`, `demand`, `closingStock`, `unmetDemand` per day) |
| `transferEvaluations[]` | The request fields plus `departureDay`, `eligible`, `applied`, `rejectionReasons[]`, `rejectionCodes[]`, `route` (`distanceKm`, `travelHours`, `coldChainAvailable`), `batches[]` (`batchId`, null for the fixture; `batchNo`, `quantity`, `expiryDate`) and a plain-language `explanation` |
| `comparison` | `recipientStockoutPrevented`, `recipientOutcomes[]`, `newShortagesCreated[]`, `newCriticalFacilities[]`, `newRisks[]`, `improvedFacilities[]`, `worsenedFacilities[]`, shortage days and unmet demand before/after with `shortageDaysPrevented` and `unmetDemandReduced`, `criticalFacilityDelta`, `regionalRiskBefore` / `regionalRiskAfter`, `regionalOutcome` (`IMPROVED`, `WORSENED`, `MIXED`, `UNCHANGED`), `safeToRecommend` and `summary` |
| `maxTravelHours` | The route limit applied (6 hours by default) |
| `receivedStockCheck` | Donor evidence on stock already received: `basis` (`RECEIVED_STOCK_ONLY`), `passed`, `explanation` and `donors[]` (`facilityId`, `facilityName`, `totalSent`, `retainedFloor`, `lowestProjectedStock`, `lowestProjectedDay`, `futureReplenishmentExcluded`, `passed`, `failureCodes[]`, `explanation`); see [Received-stock donor evidence](#received-stock-donor-evidence) |
| `assumptions`, `limitations`, `decisionSupportOnly`, `dataContext` | Modelling rules, known gaps, always `true`, and data source, simulation and as-of dates, history window, unit, mappings and notes |

`scenarioType` (`SIMULATED_DATABASE` or `SIMULATED_FIXTURE`) and `medicineId` match the Node response.

### Simulation algorithm

1. **Load one regional snapshot.** MySQL: one read-only connection loads every facility's inventory, safety stock, replenishments and consumption for the medicine, plus the medicine catalogue, cold-chain flags and all routes. Fixture: the in-memory store is only read.
2. **Baseline.** Every facility holding the medicine gets exactly the `POST /forecast` analysis: weighted-moving-average demand, day-by-day projection from effective stock with scheduled and delayed replenishments, protected stock, regional fragility and risk score. Tests check that each baseline facility matches `POST /forecast`.
3. **Gate the transfers** (below). Transfers that cannot physically happen are not simulated.
4. **Intervention.** Every remaining transfer is projected together:
   - outbound stock leaves the donor at the start of its departure day, before that day's replenishment and demand, and never below zero;
   - inbound stock arrives in full at the start of `arrivalDay`, like a replenishment.
   The departure day is `arrivalDay` minus whole days of route travel time. Risk is rescored with the same formula, and regional fragility uses every facility's safe surplus after the transfers.
5. **Impact checks.** Donor safety and recipient timing are checked on the simulated result. A transfer that fails them stays in the intervention, so the harm is visible, but it is not eligible.
6. **Compare** baseline and intervention for every facility.

A storage facility (warehouse) without consumption records is projected with zero clinical demand and no risk score. Any other facility whose demand cannot be forecast is excluded from regional totals and listed in `dataContext.notes`.

### Feasibility gate

| Code | Not simulated when |
| --- | --- |
| `SOURCE_FACILITY_NOT_FOUND`, `DESTINATION_FACILITY_NOT_FOUND`, `MEDICINE_NOT_FOUND` | An ID does not resolve in the active data source |
| `SAME_SOURCE_AND_DESTINATION` | Both IDs resolve to one facility (for example a code and its numeric ID) |
| `MEDICINE_IDENTITY_MISMATCH` | The transfer's medicine is not the scenario medicine; nothing is substituted |
| `INCOMPLETE_DATA` | No inventory record, no usable forecast, unknown cold-chain requirement, or routes not loaded |
| `ROUTE_NOT_FOUND` | No directed route from donor to recipient |
| `COLD_CHAIN_UNAVAILABLE` | The medicine needs a cold chain and the route (or recipient storage) lacks one |
| `TRAVEL_TIME_EXCEEDS_ARRIVAL_DAY`, `ARRIVAL_OUTSIDE_HORIZON` | The transfer cannot arrive by `arrivalDay`, or arrives after the horizon |
| `INSUFFICIENT_DONOR_STOCK` | The donor is projected to hold less usable stock than requested when it departs (expired, quarantined and reserved stock never count) |
| `BATCH_EXPIRES_BEFORE_USE` | Not enough of the donor's usable batches stay in date until the end of the horizon |
| `INVALID_QUANTITY`, `INVALID_ARRIVAL_DAY` | Only reachable from Python; the API rejects these with 422 first |

| Code | Simulated but not eligible when |
| --- | --- |
| `BELOW_PROTECTED_STOCK` | The donor's projected stock is below its protected safety stock on any day from departure to the end of the horizon |
| `DONOR_BECOMES_CRITICAL` | The donor's risk label is CRITICAL with the transfers |
| `CREATES_REGIONAL_SHORTAGE` | The donor gains a stockout, more shortage days or more unmet demand |
| `ARRIVES_AFTER_RECIPIENT_STOCKOUT` | Without this transfer the recipient runs out before `arrivalDay` |
| `TRAVEL_TIME_LIMIT_EXCEEDED` | The route takes longer than `OptimizerConfig.max_travel_hours` (6 hours), the same limit `POST /plans/optimize` applies. A route of exactly 6 hours is allowed |

A recipient that is already critical is never a reason to reject; helping it is the purpose.

**`safeToRecommend`** is true only when at least one transfer was simulated, every transfer is eligible, no facility gains a new risk (`NEW_STOCKOUT`, `MORE_SHORTAGE`, `NEW_CRITICAL`, `NEW_HIGH_RISK` or `FELL_BELOW_PROTECTED_STOCK`), and regional shortage is `IMPROVED` or `UNCHANGED`. So a transfer that saves the recipient but makes a donor critical returns `recipientStockoutPrevented: true`, the donor in `newShortagesCreated`, and `safeToRecommend: false`.

### Received-stock donor evidence

The simulator counts a donor's scheduled and delayed deliveries, as `POST /forecast` does. The optimizer does not: a donor must be safe on stock already received. `receivedStockCheck` applies the optimizer's donor rules to the simulated transfers so a caller can check both. Every applied transfer leaves its donor on its departure day, and each donor is projected with no future supply, from the first departure day to the end of the horizon. A donor passes only if all of these hold:

| Failure code | Rule |
| --- | --- |
| `WITHDRAWAL_EXCEEDS_RECEIVED_STOCK` | Its stock already received covers every withdrawal |
| `BELOW_RETAINED_FLOOR` | Its lowest projected stock stays at or above the retained floor (protected stock plus the equity or operational reserve; the same `donor_floor` rule as optimizer candidates) |
| `SAFETY_STOCK_NOT_RECORDED` | A facility with forecast consumption has recorded safety stock |
| `DONOR_AT_RISK` | It is not already `HIGH` or `CRITICAL` without the transfers |
| `DONOR_DATA_UNAVAILABLE` | It can be projected |

`passed` is true only when at least one transfer was applied and every donor passes. The check is evidence only: it never changes `eligible`, `applied` or `safeToRecommend`. A donor that is safe only because of a delivery can therefore show `safeToRecommend: true` with `receivedStockCheck.passed: false`. For a plan returned by `POST /plans/optimize`, re-simulating its exact transfers gives the same passing check as `simulation.receivedStockCheck`. The Node backend requires `safeToRecommend`, eligible transfers and this check before it reserves stock.

### Data-source and unit rules

- Fixture mode uses only the offline fixture, including the three routes of `backend/src/fixture-store.js`; database IDs are not found. MySQL mode uses only the database; fixture facility IDs are not found. The documented alias `med-insulin-100iu-vial` still resolves to Human Insulin.
- Quantities stay in the medicine's base unit (`mg`, `mL`, `count`, or `vial` for the fixture) with their decimals.
- MySQL mode uses `facility_safety_stock`, `routes` (distance, travel time, cold chain), `medicines.requires_cold_chain`, `facilities.has_cold_chain`, and `SCHEDULED` / `DELAYED` replenishments. Expired, quarantined and reserved stock is excluded. These rules are returned in `dataContext.mappings`: `coldChain` is approved by Aaryan for the hackathon prototype, while `routes` and `donorSafety` stay provisional for Aaryan, Dhiren and Sahil to confirm.

### Read-only guarantee

The simulator only reads. The MySQL session is opened with `SET SESSION TRANSACTION READ ONLY` and runs only `SELECT` statements. Transfers are held in per-request schedules and never written to the data store. Tests check that every simulator query is a `SELECT`, that the fixture store and forecasts are unchanged after simulating, and (live) that `inventory`, `batches`, `replenishments`, `transfers` and `audit_events` are unchanged.

### Limitations

- Risk weights are prototype assumptions and are not clinically validated.
- Demand does not respond to transfers; patients are not redistributed.
- Batch expiry within the horizon, transport losses, vehicle and storage capacity, and cost are not modelled.
- Stock from replenishments arriving during the horizon has no recorded batch, so it is not sent onward.
- Supplier reliability is ignored: delayed orders arrive on their current expected date.
- One medicine per scenario. The simulator evaluates transfers you propose; `POST /plans/optimize` (below) searches for them.

## Transfer optimizer: `POST /plans/optimize`

> **Simulated decision support only.** All data is simulated. A plan is a proposal: a qualified person must review and approve it before any stock moves. The optimizer never substitutes one medicine for another, never writes a transfer and never changes inventory.
>
> The objective order, equity guardrail, donor exclusions, six-hour route cap and received-stock-only donor rule were accepted in the biomedical (Aaryan) and database (Dhiren) reviews **for this hackathon prototype only**. They are not clinically validated; real deployment requires clinical, regulatory and operational validation.

Given a destination, one exact medicine, a quantity and a horizon, the optimizer proposes the smallest safe redistribution plan, from one or more donors. It uses Google OR-Tools CP-SAT for the allocation and the Ripple Simulator as the final safety check: a plan is returned only after the simulator evaluates the complete plan and marks it safe. Node's `/api/plans/optimize` route calls it and keeps the returned plan `id`. With a database, Node creates no plan while this service is unavailable; only the fixture store falls back to the labelled Node optimizer. See [Node backend integration](#node-backend-integration).

### Request

The same shape the Node backend accepts (`validateOptimizeRequest` in `backend/src/validation.js`):

```json
{ "destinationFacilityId": "PHC-VLR-001", "medicineId": "7", "quantity": 300, "horizonDays": 14 }
```

| Field | Rule |
| --- | --- |
| `destinationFacilityId` | Required; database code or numeric ID in MySQL mode |
| `medicineId` | Required; database ID or the documented alias. Only this exact medicine is moved |
| `quantity` | Positive, at most 2 decimals and at most 9999999999.99 (`DECIMAL(12,2)`). A finer quantity is refused, never rounded. Medicines counted in whole units (`count`) need a whole number |
| `horizonDays` | `7`, `14` or `30`; defaults to `14` |

| Status | Code | When |
| --- | --- | --- |
| 200 | - | A plan that passed simulator validation |
| 404 | `FACILITY_NOT_FOUND`, `MEDICINE_NOT_FOUND` | Unknown destination or medicine in the active data source |
| 404 | `OPTIMIZATION_TARGET_NOT_FOUND` | The destination has no inventory record for the medicine |
| 422 | `INVALID_REQUEST`, `INVALID_HORIZON` | Malformed request |
| 422 | `INVALID_QUANTITY_FOR_UNIT` | A fractional quantity of a `count` medicine |
| 422 | `OPTIMIZATION_DATA_INCOMPLETE` | The destination's demand cannot be forecast |
| 422 | `NO_SAFE_PLAN` | No plan meets every safety rule; see [No safe plan](#no-safe-plan) |
| 503 | `DATABASE_UNAVAILABLE`, `OPTIMIZER_UNAVAILABLE` | MySQL cannot be reached, or OR-Tools is not installed |

### How a plan is made

1. **Load one read-only snapshot.** The same regional store as the simulator, over one read-only MySQL connection (or the in-memory fixture).
2. **Project every facility** with the simulator's `load_facility_state` and `baseline_outcome`, which reuse `POST /forecast` (weighted moving average, day-by-day projection with scheduled and delayed replenishments, protected stock, risk).
3. **Filter candidates** with hard rules (below), including the six-hour route cap. Route, cold-chain, identity, data and timing checks call the simulator's own feasibility gate, so both give the same reasons.
4. **Work out each donor's safe capacity** from stock already received, never future deliveries, and confirm it with the Ripple Simulator: sending the full capacity must be eligible and create no new risk at that donor.
5. **Allocate** donors, batches and arrival days with CP-SAT.
6. **Validate** the complete plan in the Ripple Simulator, and re-check the route cap and received-stock donor safety. If it fails, the donors the simulator rejected are excluded (or, when no donor is to blame, that donor combination is forbidden) and the model is solved again, up to 5 attempts. Otherwise the result is `NO_SAFE_PLAN`.

### Candidate filtering

| Code | The facility cannot donate because |
| --- | --- |
| `DESTINATION_FACILITY` | It is the destination |
| `NO_INVENTORY_RECORD` | It holds no inventory of this exact medicine |
| `NO_EFFECTIVE_STOCK`, `NO_USABLE_BATCH` | It has no usable stock; expired, quarantined and reserved stock never counts |
| `BATCH_EXPIRES_BEFORE_USE` | None of its usable batches stays in date until the end of the horizon |
| `ROUTE_NOT_FOUND`, `COLD_CHAIN_UNAVAILABLE`, `INCOMPLETE_DATA`, `ARRIVAL_OUTSIDE_HORIZON` | The simulator's gate: no directed route, no cold chain on the route or at the destination, missing data, or it cannot arrive within the horizon |
| `TRAVEL_TIME_LIMIT_EXCEEDED` | Its route to the destination takes longer than `maxTravelHours` (6 hours by default; exactly 6 is allowed). The reason names the donor, the actual travel time and the limit |
| `ARRIVES_AFTER_RECIPIENT_STOCKOUT` | Its earliest delivery arrives after the destination's projected stockout day |
| `SAFETY_STOCK_NOT_RECORDED` | A clinical facility without recorded safety stock, so no safe capacity can be established |
| `DONOR_AT_RISK` | It is already `HIGH` or `CRITICAL` risk without any transfer |
| `NO_SAFE_DONOR_CAPACITY` | Its projected stock never rises above its retained floor |
| `CAPACITY_NOT_VERIFIED` | The Ripple Simulator did not confirm its safe capacity |
| `SIMULATION_REJECTED` | The simulator rejected a combined plan that used it |

Distance alone never excludes a donor; it only affects ranking, unless the route cannot arrive in time.

### Safe donor capacity

For each arrival day in the useful window (from the route's earliest arrival to the horizon end, and no later than the destination's projected stockout day):

```
departure day  = arrival day - whole days of route travel time
safe capacity  = min( opening stock on the departure day,
                      lowest received-stock projection from the departure day to the horizon end - retained floor,
                      usable batches that stay in date until the horizon end,
                      safe surplus at the snapshot - 0.01 )
```

**Donors count only stock already received.** The received-stock projection is the normal day-by-day projection (`project_stock`: forecast consumption, stock floored at zero) with **no** `SCHEDULED`, `DELAYED` or other future replenishment.
- **No future stock for donors.** A delivery that has not arrived can never make a donor eligible or increase what it may send.
- **No double counting.** `ARRIVED` stock is already in inventory and is never added again.
- **Visible exclusions.** Each candidate reports the left-out supply in `futureReplenishmentExcluded`, and its explanation names the orders.
- **Recipients unchanged.** The recipient's projection, `POST /forecast` and the Ripple Simulator still count scheduled and delayed replenishments.

Capacity is therefore **not** `effective stock - protected stock`. A hospital with 1000 mL, 50 mL/day and 700 mL safety stock looks like it has 300 mL to spare, but without its 700 mL delivery on day 7 its stock falls to 300 mL by day 14, so its safe capacity is 0. The last term keeps every donor's safe surplus positive, so no other facility's regional fragility rises. Capacities are rounded **down** to the hundredth (or whole unit).

### Donor guardrails (approved for the hackathon prototype)

These values were accepted in Aaryan's biomedical review for this hackathon prototype only (`status: APPROVED_FOR_HACKATHON_PROTOTYPE`). They are not clinically validated. All are configurable in `OptimizerConfig` (`app/optimizer.py`) and returned in `equityGuardrail`, `assumptions` and `dataContext.mappings`.

**Six-hour route cap.**
- A donor's route to the destination may take at most `maxTravelHours`, 6 hours by default; a route of exactly 6 hours is allowed.
- A longer route is rejected with `TRAVEL_TIME_LIMIT_EXCEEDED`, and the reason names the donor, the actual hours and the limit.
- A missing route is rejected (`ROUTE_NOT_FOUND`), never assumed safe.
- The cap is re-checked on the final plan (`ROUTES_WITHIN_TRAVEL_LIMIT`).
- It does not change how departure and arrival days are calculated.
- `POST /scenarios/simulate` applies the same configured cap. A longer route is still simulated, so its effect on stock stays visible, but the transfer is ineligible (`TRAVEL_TIME_LIMIT_EXCEEDED`) and `safeToRecommend` is false.

**Donor exclusions.** Facilities already `HIGH` or `CRITICAL` never donate.

**Equity and warehouse reserve.**

```
retained floor      = max( protected stock x (1 + equity uplift), operational reserve )
equity uplift       = facility-type uplift + 0.5 x remoteness (0-1; MySQL remoteness_score / 10)
operational reserve = 10% of effective stock, for storage facilities (warehouses) only
```

| Facility type | Type uplift |
| --- | --- |
| Warehouse, District hospital | 0.00 |
| CHC | 0.10 |
| PHC (and any unlisted type) | 0.25 |
| SubCentre | 0.35 |

With the seed data this means a donor keeps, on every day from departure to the end of the horizon:
- `DH-CBE-001` (hospital, remoteness 2.0): 110% of its safety stock.
- `CHC-SLM-001` (3.4): 127%.
- `PHC-VLR-001` (4.0): 145%.
- `SC-RMD-001` (7.8): 174%.
- `WH-TN-001`, which has no safety stock row: 10% of its usable stock.

Remoteness is still the stored `remoteness_score` (MySQL 0-10, divided by 10) with the 0.5 weight. A travel-time-derived remoteness is deferred; see [Deferred decisions](#deferred-decisions).

### Solver, decision variables and quantity scaling

**Solver:** Google OR-Tools **CP-SAT** (`app/allocation_solver.py`).
- **Why CP-SAT:** the problem is integer and combinatorial: which donors, how much from which batch, which arrival day, and first-expiry-first rules. The recipient's stock is floored at zero each day, which CP-SAT models exactly with integer max constraints; a pure linear model cannot.
- **Determinism:** the search uses one worker, a fixed seed and a *deterministic* time limit (not wall-clock), so identical input gives identical output.

**Quantity scaling:** every quantity is passed to the solver as an integer number of **hundredths** of the medicine's unit (`quantityScale: 100`). That matches `DECIMAL(12,2)`, so no meaningful quantity is lost: 600.25 mL is 60025. Results are divided by 100 on the way out. `count` medicines move in steps of 100 (whole units).

**Decision variables** (per donor):
- the quantity sent from each usable batch (one transfer instruction per batch used);
- whether each batch is used;
- which single arrival day the donor delivers on;
- the quantity arriving that day;
- the parts per million of that day's safe capacity used (rounded up).

The destination's daily stock, unmet demand and shortage days are modelled exactly as `app/stock_projection.py` projects them.

**Hard constraints:**
- The requested quantity is allocated exactly.
- No donor exceeds its safe capacity for its arrival day, so no donor falls below its retained floor or gains a shortage.
- No batch sends more than it holds.
- Batches are used earliest expiry first.
- Each donor delivers once, within the useful window.
- `count` medicines move in whole units.

### Objective

Priorities 1 (no new stockout) and 2 (full quantity) are hard constraints. The rest are optimised in three lexicographic stages: each stage's optimum is fixed before the next, so safety always dominates convenience.

| Stage | Priorities | Minimised value | Weights |
| --- | --- | --- | --- |
| 1 `RECIPIENT_SHORTAGE` | 3 unmet demand, 4 shortage days | `31 x recipient unmet demand (hundredths) + 1 x shortage days` | 31 exceeds the 30 possible shortage days, so less unmet demand always wins |
| 2 `DONOR_PROTECTION` | 5 donor safety-stock preservation, 6 equity impact | `sum over donors of headroom used (parts per million of safe capacity, rounded up) x (100 + equity index)` | 100 per part per million of headroom, plus the equity index `round(100 x equity uplift)` (0-85), so remote donors cost up to 1.85x as much |
| 3 `LOGISTICS` | 7 arrival, 8 distance, 9 transfers | `10^10 x arrival days + 1000 x distance (0.1 km) + 1 x (donors + transfer instructions)` | Each weight exceeds the largest possible total of the terms after it (at most 999 donors plus batches, at most 9,999,999 tenths of a km) |

Regional unmet demand and shortage days can only change at the destination, because donors are not allowed any new shortage, so stage 1 measures the destination. `solver.objectiveValue` is the stage 1 value; every stage's value, status and weights are in `solver.objectiveStages`. There is no "AI confidence": `solver.status` is `OPTIMAL` or `FEASIBLE` for a returned plan, and `INFEASIBLE` or `VALIDATION_FAILED` in `NO_SAFE_PLAN`.

### FEFO batch allocation

Only usable batches count: `AVAILABLE` inventory, not quarantined, in date on day 1, and in date until the end of the horizon. They are used earliest expiry first, then by `batches.batch_id` (by batch number only in the fixture, which has no batch IDs). The simulator uses the same order. A later batch is used only when every earlier one is fully allocated, and a donor's allocation is split across batches when needed.

Each batch becomes a **separate transfer instruction** with `batchId` (`batches.batch_id`) and `batchNo`, because Node persists one `transfers` row per batch. The fixture has no database batch IDs, so `batchId` is the batch number there, as in `backend/src/fixture-store.js`. Dhiren approved this batch interpretation for the hackathon prototype (`batchIdentity`); persisting it in `transfers` is still Sahil's pending Node work.

### Simulator validation

The complete plan is sent to `simulate()` as transfer requests in batch order. It is returned only when every check in `validation.checks` passes:

| Check | Requires |
| --- | --- |
| `ALL_TRANSFERS_ELIGIBLE` | Every transfer passes the feasibility gate and impact checks |
| `NO_NEW_REGIONAL_RISK` | No facility gains a stockout, more shortage, a new `HIGH`/`CRITICAL` label, or falls below protected stock |
| `NO_DONOR_CRITICAL` | No donor is `CRITICAL` afterwards |
| `NO_NEW_STOCKOUT` | `newShortagesCreated` is empty |
| `REQUESTED_QUANTITY_SUPPLIED` | Allocated and simulated arrivals equal the request exactly |
| `REGIONAL_SHORTAGE_NOT_WORSE` | Regional outcome `IMPROVED` or `UNCHANGED` |
| `BATCH_ALLOCATION_MATCHES` | The simulator allocated exactly the planned batches and quantities |
| `ROUTES_WITHIN_TRAVEL_LIMIT` | Every donor route takes at most `maxTravelHours` (the candidate rule, applied again) |
| `DONORS_SAFE_WITHOUT_FUTURE_SUPPLY` | Projected from stock already received, with its whole transfer on its departure day, every donor keeps its retained floor |
| `SAFE_TO_RECOMMEND` | The simulator's `safeToRecommend` is true |

The optimizer never declares its own result safe.

### Response

Node-compatible plan fields are `id`, `status` (`PROPOSED`), `medicine`, `destinationFacilityId`, `transfers`, `rationale`, `assumptions`, `simulation` and `decisionSupportOnly`. It adds:

| Field | Meaning |
| --- | --- |
| `requestedQuantity`, `allocatedQuantity`, `unit`, `horizonDays` | Always equal quantities for a returned plan |
| `solver` | `name` (`OR-Tools`), `algorithm` (`CP-SAT`), `version`, `status`, `quantityScale`, `objectiveValue`, `objectiveStages[]`, `attempts`, `hardConstraints[]` |
| `transfers[]` | `fromFacilityId`, `toFacilityId`, `medicineId`, `batchId`, `batchNo`, `expiryDate`, `quantity`, `unit`, `departureDay`, `arrivalDay`, `arrivalDate`, `distanceKm`, `travelHours`, `coldChainAvailable` (and facility names) |
| `recipient` | Stockout day, shortage days and unmet demand before and after, `stockoutPrevented`, and `quantityToAvoidShortage` (the day-1 quantity that removes the projected shortage) |
| `candidates[]` | Every facility with `status` (`SELECTED`, `ELIGIBLE_NOT_SELECTED`, `REJECTED`), `rejectionCodes`/`rejectionReasons`, stock, demand, protected stock, `equityUplift`, `equityReserve`, `operationalReserve`, `retainedFloor`, `futureReplenishmentExcluded`, `safeCapacity`, `allocatedQuantity`, route and a plain-language `explanation` |
| `equityGuardrail` | The donor guardrails in effect: equity formula and uplifts, `maxTravelHours`, `donorCapacityBasis` (`RECEIVED_STOCK_ONLY`), excluded risk labels, `status` (`APPROVED_FOR_HACKATHON_PROTOTYPE`), `reviewOwner` and `validationNote`. Also returned in the `NO_SAFE_PLAN` details |
| `validation` | Validator version, `passed`, `checks[]` |
| `simulation` | The full `POST /scenarios/simulate` response for the plan |
| `limitations`, `requiresHumanApproval` (always `true`), `dataContext` (with `equityReserve`, `batchIdentity` and `quantityScale` mappings), `dataLabel`, `modelVersion` | |

**Plan ID.** `id` is `plan-` followed by the first 32 hex digits of a SHA-256 digest. The digest covers the destination, medicine, requested quantity, horizon, the normalised transfers (donor, batch, quantity, departure and arrival day) and the data context (source, simulation date, as-of date). An identical request on unchanged data always returns the same ID. No clock, UUID or random number is used. **This ID is authoritative:** Sahil's Node backend must persist the `id` returned here and must not generate a second one.

### No safe plan

```json
{
  "error": {
    "code": "NO_SAFE_PLAN",
    "message": "No safe regional redistribution plan can satisfy the requested quantity.",
    "details": {
      "requestedQuantity": 100000, "safeCapacity": 4500, "unmetQuantity": 95500, "unit": "mL",
      "solverStatus": "INFEASIBLE", "attempts": 1, "candidatesConsidered": 4,
      "eligibleCandidates": [ ... ], "rejectedCandidates": [ ... ],
      "recommendedEscalation": [ "Ask the supplier to expedite the delayed replenishment ...", "..." ],
      "explanation": "...", "decisionSupportOnly": true, "dataContext": { ... }
    }
  }
}
```

(Values from the in-memory test rows.)
- **`safeCapacity`** is the sum of eligible donors' safe capacities. `unmetQuantity` is what they cannot cover.
- **Candidate lists:** every rejected candidate carries its codes and reasons.
- **Escalation steps** are built from the data:
  - expedite the destination's scheduled or delayed replenishment;
  - follow up overdue orders;
  - arrange cold-chain storage;
  - request a smaller quantity up to `safeCapacity`;
  - emergency procurement.
- **No supply is created.** No stock is invented, and no donor's protected stock is lowered to meet a request.

### Read-only guarantee

The optimizer only reads. It uses the simulator's regional store (MySQL: `SET SESSION TRANSACTION READ ONLY`, `SELECT` only), and neither `app/optimizer.py` nor `app/allocation_solver.py` contains SQL. Nothing is stored: no plan, transfer or audit event.

**Tests check that:**
- every query is a `SELECT`;
- the fixture store, forecasts and simulator output are unchanged after optimising;
- (live) row counts, quantity totals and `CHECKSUM TABLE` of `inventory`, `batches`, `transfers` and `audit_events` are unchanged.

### Exact medicine identity

A different medicine, strength or dosage form is always rejected.
- **Simulator:** `MEDICINE_IDENTITY_MISMATCH`.
- **Optimizer:** only facilities holding the exact medicine are candidates; any other facility gets `NO_INVENTORY_RECORD`.

No request field can override this: extra fields such as an emergency or branch-manager flag are ignored, and tests check that they change nothing. The rejection recommends manual pharmacist or qualified clinical review, but the transfer stays rejected.

### Fields for the UI

Where each item Samson's UI needs already appears (no duplicate fields were added):

| Item | `POST /forecast` | `POST /scenarios/simulate` | `POST /plans/optimize` |
| --- | --- | --- | --- |
| Current effective stock | `inventory.effectiveStock` | `baseline.facilities[].effectiveStock` | `recipient.effectiveStock`, `candidates[].effectiveStock` |
| Daily demand (depletion rate) | `forecast.dailyDemand` | `facilities[].predictedDailyDemand` | `recipient.predictedDailyDemand`, `candidates[].predictedDailyDemand` |
| Risk score and label | `risk.score`, `risk.label` | `facilities[].riskScore`, `riskLabel` | `candidates[].baselineRiskScore`, `baselineRiskLabel`; after the plan `simulation.intervention.facilities[].riskScore`, `riskLabel` |
| Stockout day and date | `stockout.projectedStockoutDay`, `projectedStockoutDate` | `facilities[].stockoutDay`, `stockoutDate` | `recipient.stockoutDayBefore`, `stockoutDayAfter`; dates in `simulation.baseline` / `simulation.intervention` `.facilities[].stockoutDate` |
| Donor retained floor | - | `receivedStockCheck.donors[].retainedFloor` | `candidates[].retainedFloor`, `simulation.receivedStockCheck.donors[].retainedFloor` |
| Safe donor capacity | - | - | `candidates[].safeCapacity`; `NO_SAFE_PLAN` `details.safeCapacity` |
| Future supply left out of donor capacity | - | `receivedStockCheck.donors[].futureReplenishmentExcluded` | `candidates[].futureReplenishmentExcluded` |
| Route travel time and limit | - | `transferEvaluations[].route.travelHours`, `maxTravelHours` | `transfers[].travelHours`, `candidates[].travelHours`, `equityGuardrail.maxTravelHours` |
| Batch ID and batch number | - | `transferEvaluations[].batches[].batchId`, `batchNo` | `transfers[].batchId`, `transfers[].batchNo` |
| Rejection code and reason | - | `transferEvaluations[].rejectionCodes`, `rejectionReasons` | `candidates[].rejectionCodes`, `rejectionReasons`; `NO_SAFE_PLAN` `details.rejectedCandidates[]` |
| Shortage days prevented | - | `comparison.shortageDaysPrevented` | `simulation.comparison.shortageDaysPrevented` |
| Unmet demand reduced | - | `comparison.unmetDemandReduced` | `simulation.comparison.unmetDemandReduced` |
| Facilities protected | - | `comparison.recipientOutcomes[].stockoutPrevented`, `comparison.improvedFacilities[]` | `recipient.stockoutPrevented`, `simulation.comparison.improvedFacilities[]` |
| Safe to recommend | - | `comparison.safeToRecommend` | `simulation.comparison.safeToRecommend`, `validation.passed` |
| Human approval required | `decisionSupportOnly` | `decisionSupportOnly` | `requiresHumanApproval`, `decisionSupportOnly` |

**No patient-days-at-risk.** No response from this service calculates or exposes patient-days at risk or any other patient-impact metric; Aaryan rejected it as not clinically validated. The simulator and optimizer state this in `limitations`. The Node backend's own `patientDaysAtRisk` is outside this service.

### Deferred decisions

These review suggestions are **not implemented**. The prototype lacks the secure data, authorization design or agreed definitions they need.

| Suggestion | Why it is deferred |
| --- | --- |
| Remoteness derived from travel time | The review does not define the reference facility (nearest hospital, warehouse, district hospital or another). The stored `remoteness_score` and the 0.5 weight stay. |
| Emergency warehouse reserve of 5% instead of 10% | Needs authenticated Regional Manager authorization, emergency declaration data, attached reports and audit handling in Node/MySQL. A client-supplied flag is never trusted. |
| Outbreak exception letting `HIGH`/`CRITICAL` donors give 2% | Not clinically validated, and needs an authenticated outbreak declaration and senior approval. `HIGH`/`CRITICAL` donors stay fully excluded. |
| Urgency defined as less than 5% of stock remaining | Ambiguous, and it does not change the approved objective order or the route cap. The existing risk and stockout logic stays. |
| Vehicle and destination storage capacity, temperature logs, transport cost, supplier reliability, route-validity dates | No data yet; listed in `limitations`. |
| Plans table, transfer persistence, inventory reservation, approval transactions, locking, audit events, `409 PLAN_STOCK_CHANGED` | Belong to Sahil's Node backend and Dhiren's database; this service stays read-only. |

### Assumptions and limitations

Returned with every plan in `assumptions` and `limitations`. The main ones:

- All data is simulated; results are decision support and require human approval; there is no clinical substitution.
- **Prototype-only approval.** These rules are approved for this hackathon prototype only:
  - the objective order;
  - the equity uplifts and the 0.5 remoteness weight;
  - the 10% warehouse reserve;
  - the `HIGH`/`CRITICAL` donor exclusion;
  - the six-hour route cap;
  - received-stock-only donor capacity.

  They are not clinically validated; real deployment requires clinical, regulatory and operational validation.
- **No patient-impact metric.** Patient impact is not calculated by this prototype, and there is no patient-days-at-risk metric; only a qualified clinical or public-health assessment could estimate this.
- A donor's own dispensing is assumed not to use the batches chosen for transfer. Expiry is handled only by sending batches that stay in date until the end of the horizon.
- Vehicle and destination storage capacity, temperature logs, transport cost, transport losses and route-validity dates are not modelled.
- Replenishment stock arriving during the horizon has no batch, so it is not sent onward.
- A slower donor that could only help in combination with a faster one, after the destination's projected stockout begins, is not considered.
- Supplier reliability is not used.
- One destination and one medicine per request.

### Tests

The optimizer test modules:
- `tests/test_optimizer.py`: optimizer scenarios.
- `tests/test_optimizer_api.py`: the API contract.
- `tests/test_optimizer_review_rules.py`: the reviewed rules, namely the six-hour cap (in the optimizer and the Ripple Simulator, from one configured value), FEFO tie-breaking by batch ID, received-stock-only donors, approved guardrail values, exact identity, cold chain, `NO_SAFE_PLAN`, determinism and the absence of a patient-impact metric.
- `tests/test_simulation_donor_evidence.py`: the simulator's `receivedStockCheck`, `maxTravelHours` and batch IDs, and that re-simulating a plan's exact transfers reproduces its passing evidence.

All four run on in-memory rows (`tests/optimizer_support.py`), the fixture and the CP-SAT model directly. `tests/test_optimizer_live.py` runs against the seeded database only when `MEDRIPPLE_LIVE_MYSQL=1`. It covers the Vellore plan, database batches, the route cap on real routes and future supply matching the database:

```powershell
.\.venv\Scripts\python -m pytest tests/test_optimizer_review_rules.py
.\.venv\Scripts\python -m pytest tests/test_optimizer.py tests/test_optimizer_api.py
$env:MEDRIPPLE_LIVE_MYSQL = "1"; $env:DATABASE_PORT = "3307"; $env:DATABASE_PASSWORD = "medripple_dev_only"
.\.venv\Scripts\python -m pytest tests/test_optimizer_live.py
```

OR-Tools (`ortools==9.15.6755`) is verified on Python 3.13.5.

## Method

### 1. Forecast daily consumption

```
predicted daily demand = 0.70 x mean(latest 7 available days) + 0.30 x mean(previous 21 available days)
lower / upper bound    = predicted demand -/+ 1.0 x standard deviation of the latest 14 available days (lower floored at 0)
recent demand trend    = latest 7-day mean vs previous 21-day mean: +10% or more INCREASING, -10% or less DECREASING, otherwise STABLE
```

The previous 21 days are the 21 available days **before** the latest 7, so the two windows do not overlap. "Available" days skip missing, invalid (blank, non-numeric, negative, duplicated date) and anomalous values. At least 14 valid records are required: 7 recent plus at least 7 previous.

**Anomalies** are isolated values that differ from the median of up to 3 valid neighbours on each side by more than the largest of 4 x sqrt(median), 50% of the median, or 5 units. The rule is deliberately conservative, because excluding genuine high days would understate demand. Sustained level shifts are not flagged, since the neighbours move with them.

### 2. Project stock day by day

For each day `d = 1..horizonDays` (day 1 is the as-of date: 2026-09-01 for the fixture, 2026-09-12 for the MySQL seed):

```
available       = previous stock + replenishment received on day d
projected stock = max(0, available - predicted daily demand)
unmet demand    = max(0, predicted daily demand - available)
```

The projection starts from **effective stock** (usable, unexpired batches), not recorded stock. Replenishment arrives in full at the start of its day, and unmet demand is not carried forward. It returns:

- **Days remaining:** current stock / predicted demand.
- **Stockout date:** the first day with unmet demand.
- **Duration of shortage:** `shortageGapDays`.
- **Minimum projected stock.**
- **Whether replenishment arrives before the stockout.** Known deliveries beyond the horizon still count.

### 3. Risk score (prototype assumptions, not clinically validated)

```
stockout urgency     = max( 1 - (stockout day - 1) / 30        (0 if no stockout within the horizon),
                            0.5 x protected-stock shortfall )   shortfall = (protected - min projected stock) / protected, 0..1
replenishment gap    = min(1, shortage gap days / 7)
medicine criticality = CRITICAL 1.0 (provisional) | HIGH 1.0 | MEDIUM 0.6 | LOW 0.3
facility remoteness  = 0..1 (MySQL: remoteness_score / 10)
regional fragility   = share of other facilities in the district (MySQL: all other facilities) with no safe donor surplus

Risk Score = 100 x (0.35 x stockout urgency + 0.25 x medicine criticality + 0.20 x replenishment gap
                    + 0.10 x facility remoteness + 0.10 x regional fragility)
```

Levels: `0-29 LOW`, `30-54 MEDIUM`, `55-74 HIGH`, `75-100 CRITICAL`. Weights are configurable in `RiskConfig` (`app/risk_engine.py`) and must sum to 1.

Two notes for the team:

- Day 1 names the 35% term "Stockout Probability". The team chose **time-based stockout urgency** for that slot: it rises the sooner a stockout is projected. It is not a statistical probability.
- The score is a plain weighted sum, so a HIGH-criticality medicine always adds 25 points. A well-stocked facility can therefore still score MEDIUM (Central District Store = 32).

Protected stock = forecast daily demand x the facility's protected days, and safe surplus = max(0, effective stock - protected stock). This mirrors the provisional rule in the Node fixture and is pending healthcare safety review. In MySQL mode protected stock is the recorded `facility_safety_stock.safety_stock_qty` instead.

### Cause detection

A demand shock is a latest 7-day mean at least 1.30x the previous 21-day mean; a temporary dip is at most 0.70x.

1. Data quality is poor (fewer than 21 valid records, more than 20% of the latest 21 days missing or invalid, or 3+ recent anomalies) -> `DATA_ANOMALY`. The underlying cause becomes a contributing factor.
2. A stockout is projected within the horizon:
   - the next delivery arrives after it and demand also shocked -> `SUPPLY_DELAY` if stock would still run out before that delivery at the pre-shock demand, otherwise `DEMAND_SHOCK` (the other is contributing)
   - the next delivery arrives after it -> `SUPPLY_DELAY`
   - demand shock -> `DEMAND_SHOCK`
   - otherwise -> `INVENTORY_IMBALANCE`
3. No stockout: demand shock -> `DEMAND_SHOCK`; dip -> `TEMPORARY_DIP`; effective stock below protected stock -> `INVENTORY_IMBALANCE`; otherwise `STABLE`.

### Confidence

| Signal | LOW if | MEDIUM if |
| --- | --- | --- |
| Valid records (of 60) | fewer than 21 | fewer than 42 |
| Missing/invalid in the latest 21 days | more than 20% | more than 5% |
| Coefficient of variation, latest 7 available days | above 0.35 (or not measurable) | above 0.20 |
| Anomalies in the latest 21 days | 3 or more | 1 or more |

The worst signal sets the label. The reason always names the triggering signals, or confirms that data is sufficient and stable.

## Offline fixture data (`DATA_SOURCE=fixture`)

Data is a fixed snapshot as of **2026-09-01** with 60 days of history (2026-07-03 to 2026-08-31) for one medicine at four facilities. Stock, batches, remoteness and protected days follow `backend/src/fixture-store.js`, except that the Node fixture has since set Central District Store's effective stock to 620; this fixture keeps 900. The history was designed deterministically (repeating weekly patterns plus explicit recent values), with no random generation.

| Facility | Simulated inventory and history | 14-day result |
| --- | --- | --- |
| Navjeevan PHC | 22 effective vials (27 recorded, 5 expired); 100 vials due 2026-09-08. About 5-6 vials/day, rising to 9/day in the latest week | Demand 8.06, trend INCREASING (+53.7%); 2.7 days left; stockout **2026-09-03**, before the delivery (5-day gap); **CRITICAL 83**; `SUPPLY_DELAY` with `DEMAND_SHOCK`; HIGH confidence |
| District Hospital | 260 vials, no delivery scheduled. About 24-27 vials/day; one 78-vial data-entry spike on 2026-07-27 (flagged and excluded) | Demand 26.19, INCREASING (+11.2%); stockout 2026-09-10; protected stock 261.9, so **safe surplus 0** despite visible stock; HIGH 69; `INVENTORY_IMBALANCE`; HIGH confidence |
| River CHC | 100 vials, no delivery scheduled. About 8 vials/day; missing reports on 2026-08-16 and 2026-08-26 | Demand 7.99, STABLE; stockout 2026-09-13; **safe surplus 20.1** (smaller but safe); HIGH 64; `INVENTORY_IMBALANCE`; MEDIUM confidence (missing reports) |
| Central District Store | 900 vials. Stable 20 vials/day | Demand 20.0, STABLE; no stockout; **safe surplus 620**; MEDIUM 32 (criticality 25 + remoteness 0.5 + fragility 6.7); `STABLE`; HIGH confidence |

Scores by horizon (7 / 14 / 30 days):

- Navjeevan PHC: 83 / 83 / 83
- District Hospital: 42 / 69 / 74
- River CHC: 45 / 64 / 78
- Central District Store: 32 / 32 / 32

## Dhiren's MySQL dataset: remaining Day 1 items

The MySQL seed (10 facilities, 12 medicines, 75 days of consumption) is now read directly with `DATA_SOURCE=mysql`. Still open:

- All eight Day 1 scenarios in the database. The seed's golden scenario is Vellore PHC insulin (critical, delayed replenishment). The other scenarios exist only in the offline fixture, and three are not covered anywhere yet:
  - sudden demand increase as a facility's main cause
  - an incorrect/extreme-data scenario
  - donor that becomes critical after transferring
- Final `analyse_shortage` input field names aligned with the database columns
- Team confirmation of the provisional mappings in [How database fields are interpreted](#how-database-fields-are-interpreted)

### Demo data limitations for the optimizer

With the six-hour route cap and received-stock-only donor capacity, the MySQL seed supports few safe plans. On the 14-day horizon only `WH-TN-001` has safe donor capacity for insulin, and it is within six hours only of `PHC-VLR-001` (3.19 h). Most other destinations therefore return `NO_SAFE_PLAN`: their donors are too far away, lack a cold chain, or are safe only because of scheduled deliveries.

This is the intended result on this data. The rules are not relaxed and the service never edits the data to produce more plans.

The PostgreSQL demo dataset (`database/seed-postgres.sql`, or migration 005 for an existing database) adds the scenarios this follow-up asked for, using simulated data only:
- a donor route under six hours and one of exactly six hours;
- a clinical donor that stays safe without incoming replenishment;
- a valid two-donor plan;
- deliberately unsafe donors;
- a cold-chain failure.

See `database/README.md`. The MySQL seed itself is unchanged.

## Node backend integration

The Express API now proxies `/forecast` and `/scenarios/simulate` to this service when `INTELLIGENCE_SERVICE_URL` is configured. It passes deliberate 4xx intelligence errors through to callers and uses its own simulator only when the service times out or is unavailable. `optimisePlan` keeps its database-selected `batchId` for approval persistence, then evaluates the selected transfers through this service when available.

`compose.yaml` runs MySQL, this service, and the Node backend together. It sets `INTELLIGENCE_SERVICE_URL=http://intelligence:8000`; backend MySQL DATE values are deliberately returned as `YYYY-MM-DD` strings so timezone conversion cannot alter a replenishment date. The backend PostgreSQL store returns DATE values the same way.

The optimiser is served as `POST /plans/optimize`. The Node integration passes the validated request to this service when it is healthy, preserves its selected database batch IDs for audit persistence, and labels the existing Node optimiser as a fallback only when the intelligence service is unavailable. Deliberate validation and no-safe-plan responses remain visible to the caller rather than being silently converted to a fallback recommendation.

## Layout

```
app/main.py              FastAPI app, data-source selection, error envelope, API response mapping
app/config.py            Environment settings (same variable names as the Node backend)
app/schemas.py           Request/response models (camelCase on the wire)
app/data_store.py        In-memory data model, offline fixture, CSV loading and daily records
app/mysql_store.py       Read-only MySQL data source: reads and normalises rows, no forecasting logic
app/forecast.py          Weighted moving average, trend, anomaly detection, confidence
app/stock_projection.py  Day-by-day effective-stock projection (with optional outbound withdrawals) and stockout date
app/risk_engine.py       Risk score, cause detection, explanation, analyse_shortage
app/simulator.py         Ripple Simulator: feasibility gate, baseline/intervention projection, regional comparison
app/optimizer.py         Transfer optimizer: candidate filtering, safe donor capacity, equity guardrail, simulator validation, plan response
app/allocation_solver.py OR-Tools CP-SAT allocation model (integer hundredths, FEFO, lexicographic objective)
data/simulated_consumption.csv
tests/                   pytest suite: fixture API and engine, MySQL store, simulator and optimizer on in-memory rows, opt-in live MySQL checks
```

## Not implemented yet

- **Prototype-only rules.** The optimizer's guardrails are approved for the hackathon prototype only, not clinically validated. Emergency and outbreak exceptions and travel-time-derived remoteness are deferred; see [Deferred decisions](#deferred-decisions).
- **Not modelled:**
  - batch expiry during the horizon (no simulated batch expires within 30 days of the snapshot), and donors dispensing from the batches chosen for transfer;
  - vehicle and storage capacity;
  - transport cost;
  - supplier reliability.
