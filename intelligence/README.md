# MEDRIPPLE intelligence service - AIML Step 1 / Day 1

> **All data used by this service is simulated prototype data.** Nothing here is real patient, facility or supply data. Results are decision support only, not clinical advice or transfer instructions. Risk weights and thresholds are prototype assumptions and are **not clinically validated**.

A standalone Python FastAPI service that forecasts medicine demand, projects stock day by day, and returns an explainable risk score, cause and confidence. It can be used in two ways:

- **In Python:** `analyse_shortage(facility_data)`, the Day 1 entry point.
- **Over HTTP:** `POST /forecast`. When the Node backend's `INTELLIGENCE_SERVICE_URL` points at this service, `POST /api/forecast` returns `source: "INTELLIGENCE_SERVICE"` instead of a fallback.
- **Ripple Simulator:** `POST /scenarios/simulate` projects every facility before and after proposed transfers, with the same forecast and projection, and says whether they are safe to recommend. See [Ripple Simulator](#ripple-simulator-post-scenariossimulate).

The HTTP service reads either the offline Navjeevan PHC fixture or Dhiren's MySQL database (see [Data sources](#data-sources)). Both use the same calculation code, so they always return the same numbers for the same data. Day 1 is intentionally transparent: a weighted moving average and simple rules, with no deep learning, LLMs or randomness.

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

`DATA_SOURCE` selects where facilities, medicines, stock and consumption come from. Both modes run exactly the same forecast, projection and risk code: `app/mysql_store.py` only reads database rows and normalises them into the structures the fixture uses.

| `DATA_SOURCE` | Reads | IDs | Quantities |
| --- | --- | --- | --- |
| `fixture` (default) | Offline Navjeevan PHC fixture (`app/data_store.py`, `data/simulated_consumption.csv`) | `facility-navjeevan-phc` and three others; `med-insulin-100iu-vial` | `vial` |
| `mysql` | Only Dhiren's MySQL database (`database/schema.sql` and `golden-scenario.sql`), read-only | `facilities.facility_code` (e.g. `PHC-VLR-001`) or the numeric `facility_id`; the numeric `medicine_id` (e.g. `7`) or the documented alias `med-insulin-100iu-vial` | The medicine's base unit (`mg`, `mL` or `count`), decimals kept |

In `mysql` mode the service never uses fixture data: fixture IDs return 404, and if MySQL cannot be reached `POST /forecast` returns 503 `DATABASE_UNAVAILABLE`.

Environment variables use the names in `backend/src/config.js`. This service does not read `.env`, so set them in the shell.

| Variable | Default | Mode |
| --- | --- | --- |
| `DATA_SOURCE` | `fixture` | both |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD` | `127.0.0.1`, `3306`, `medripple`, `medripple`, empty | `mysql` |
| `SIMULATION_DATE` | `2026-09-11` | `mysql` |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `5` | `mysql` |

`DATABASE_URL` is rejected at startup in `mysql` mode, so the service cannot silently connect to a different database than configured.

Run against the database started by `pnpm db:up` (PowerShell):

```powershell
$env:DATA_SOURCE = "mysql"; $env:DATABASE_PASSWORD = "medripple_dev_only"
.\.venv\Scripts\python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

### How database fields are interpreted

Every MySQL forecast returns these rules in `dataContext.mappings` and `assumptions`. All except `units` are **provisional** until the named owner confirms them.

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

`python -m pytest` never needs Docker or MySQL. `tests/conftest.py` pins the ordinary suite to the fixture. `tests/test_mysql_store.py` exercises the MySQL store, and `tests/test_simulator.py` and `tests/test_simulator_api.py` exercise the Ripple Simulator, with in-memory rows (`tests/simulator_support.py`) and the fixture. The real-database checks in `tests/test_mysql_live.py` and `tests/test_simulator_live.py` run only when opted in:

```powershell
$env:MEDRIPPLE_LIVE_MYSQL = "1"; $env:DATABASE_PASSWORD = "medripple_dev_only"
.\.venv\Scripts\python -m pytest tests/test_mysql_live.py tests/test_simulator_live.py
```

Run only the simulator tests with `.\.venv\Scripts\python -m pytest tests/test_simulator.py tests/test_simulator_api.py`.

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

If this service is stopped, slower than `INTELLIGENCE_TIMEOUT_MS` (default 2500 ms), or returns any non-2xx status, the Node adapter falls back to its own labelled forecast (`FIXTURE_FALLBACK`, or `DATABASE_FALLBACK` in MySQL mode). That includes this service's deliberate errors, such as `NO_CONSUMPTION_HISTORY` for a warehouse; see [Backend changes requested](#backend-changes-requested).

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

It is not connected to the Node `/api/scenarios/simulate` route yet; see [Backend changes requested](#backend-changes-requested).

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
| `transferEvaluations[]` | The request fields plus `departureDay`, `eligible`, `applied`, `rejectionReasons[]`, `rejectionCodes[]`, `route` (`distanceKm`, `travelHours`, `coldChainAvailable`), `batches[]` and a plain-language `explanation` |
| `comparison` | `recipientStockoutPrevented`, `recipientOutcomes[]`, `newShortagesCreated[]`, `newCriticalFacilities[]`, `newRisks[]`, `improvedFacilities[]`, `worsenedFacilities[]`, shortage days and unmet demand before/after with `shortageDaysPrevented` and `unmetDemandReduced`, `criticalFacilityDelta`, `regionalRiskBefore` / `regionalRiskAfter`, `regionalOutcome` (`IMPROVED`, `WORSENED`, `MIXED`, `UNCHANGED`), `safeToRecommend` and `summary` |
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

A recipient that is already critical is never a reason to reject; helping it is the purpose.

**`safeToRecommend`** is true only when at least one transfer was simulated, every transfer is eligible, no facility gains a new risk (`NEW_STOCKOUT`, `MORE_SHORTAGE`, `NEW_CRITICAL`, `NEW_HIGH_RISK` or `FELL_BELOW_PROTECTED_STOCK`), and regional shortage is `IMPROVED` or `UNCHANGED`. So a transfer that saves the recipient but makes a donor critical returns `recipientStockoutPrevented: true`, the donor in `newShortagesCreated`, and `safeToRecommend: false`.

### Data-source and unit rules

- Fixture mode uses only the offline fixture, including the three routes of `backend/src/fixture-store.js`; database IDs are not found. MySQL mode uses only the database; fixture facility IDs are not found. The documented alias `med-insulin-100iu-vial` still resolves to Human Insulin.
- Quantities stay in the medicine's base unit (`mg`, `mL`, `count`, or `vial` for the fixture) with their decimals.
- MySQL mode uses `facility_safety_stock`, `routes` (distance, travel time, cold chain), `medicines.requires_cold_chain`, `facilities.has_cold_chain`, and `SCHEDULED` / `DELAYED` replenishments. Expired, quarantined and reserved stock is excluded. These rules are returned in `dataContext.mappings` as provisional (`routes`, `coldChain`, `donorSafety` for Aaryan, Dhiren and Sahil to confirm).

### Read-only guarantee

The simulator only reads. The MySQL session is opened with `SET SESSION TRANSACTION READ ONLY` and runs only `SELECT` statements. Transfers are held in per-request schedules and never written to the data store. Tests check that every simulator query is a `SELECT`, that the fixture store and forecasts are unchanged after simulating, and (live) that `inventory`, `batches`, `replenishments`, `transfers` and `audit_events` are unchanged.

### Limitations

- Risk weights are prototype assumptions and are not clinically validated.
- Demand does not respond to transfers; patients are not redistributed.
- Batch expiry within the horizon, transport losses, vehicle and storage capacity, and cost are not modelled.
- Stock from replenishments arriving during the horizon has no recorded batch, so it is not sent onward.
- Supplier reliability is ignored: delayed orders arrive on their current expected date.
- One medicine per scenario. There is no optimizer yet: the simulator evaluates transfers you propose.

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

## Backend changes requested

These are outside `intelligence/` and have not been made here:

- `backend/src/intelligence-adapter.js` turns every non-2xx response from this service into a fallback with `fallbackReason: INTELLIGENCE_UNAVAILABLE`. A deliberate answer such as 422 `NO_CONSUMPTION_HISTORY` for `WH-TN-001` is therefore shown as a zero-demand `DATABASE_FALLBACK`. It should pass 4xx error codes through, or at least record them as the fallback reason.
- `backend/src/mysql-store.js` returns DATE columns as local-midnight JavaScript dates, so `expectedArrivalDate` 2026-09-19 is serialised as `2026-09-18T18:30:00.000Z` on an IST machine. Adding `dateStrings: ['DATE']` to the pool options returns plain `YYYY-MM-DD` strings.
- `compose.yaml` sets `INTELLIGENCE_SERVICE_URL` to an empty string, so the containerised stack never calls this service.
- To use the Ripple Simulator from Node, `backend/src/scenario-service.js` `simulateScenario` (called by `/api/scenarios/simulate` and by `optimisePlan`) would call `POST /scenarios/simulate` through the intelligence adapter, with its current logic as the labelled fallback. The request shape already matches. Response differences to adapt:
  - Node facilities report `dailyDemand`, `endingStock` as `effectiveStock`, and `patientDaysAtRisk`; Python reports `predictedDailyDemand`, `effectiveStock` (snapshot), `endingStock` and `unmetDemand`.
  - Node counts any facility with a stockout as critical; Python's `criticalFacilityCount` counts CRITICAL risk labels and adds `stockoutFacilityCount`.
  - Node applies only eligible transfers; Python also simulates transfers that fail impact checks, so the harm is visible, and marks them `applied: true, eligible: false`.
  - `backend/src/validation.js` accepts a non-integer or missing `arrivalDay` as 1 and flags `arrivalDay < 1` per transfer; Python rejects such requests with 422.
  - `optimisePlan` needs `batchId` for persistence; Python returns `batches[].batchNo`, and the database batch ID would have to be looked up.

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
data/simulated_consumption.csv
tests/                   pytest suite: fixture API and engine, MySQL store and simulator on in-memory rows, opt-in live MySQL checks
```

## Not implemented yet

The transfer optimizer, OR-Tools and frontend work are out of scope. The Ripple Simulator evaluates transfers a person proposes; it does not search for them. Batch expiry during the horizon is not modelled (no simulated batch expires within 30 days of the snapshot).
