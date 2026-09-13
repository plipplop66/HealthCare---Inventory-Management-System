# MEDRIPPLE API contract - fixture vertical slice v0.1

**Contract status:** provisional until Dhiren freezes the data contract, Druv freezes intelligence JSON, Samson supplies exact screen fields, and Aaryan approves healthcare wording. No client should silently rely on undocumented fields.

Base URL: `http://127.0.0.1:3001` in local development. All content is JSON.

## Envelopes

Every successful API response is shaped as:

```json
{
  "data": {},
  "meta": { "requestId": "uuid", "source": "FIXTURE_STORE" }
}
```

Every failure is shaped as:

```json
{
  "error": { "code": "INVALID_REQUEST", "message": "facilityId is required." },
  "meta": { "requestId": "uuid" }
}
```

`source` is important: `FIXTURE_*` means deterministic simulated data; `DATABASE_FALLBACK` means the active MySQL records were used while the intelligence service was unavailable; `INTELLIGENCE_SERVICE` means Druv's live service answered. Any fallback forecast is usable for integration only, not a release result.

When `DATA_SOURCE=mysql`, inventory, simulation, optimization, approval, and audit routes use Dhiren's seeded MySQL database and return `source: "MYSQL"`. Facility IDs are then stable database `facility_code` values such as `PHC-VLR-001`; medicine IDs are the database medicine IDs, while the fixture alias `med-insulin-100iu-vial` remains accepted for the default insulin view.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server readiness and environment |
| `GET` | `/api/region/summary` | Resilience score, alerts, earliest stockout, and patient-days at risk |
| `GET` | `/api/facilities` | Facility coordinates, simulated risk, supply coverage, and safe surplus |
| `GET` | `/api/facilities/:facilityId/inventory?medicineId=:medicineId` | Medicine identity, batches, effective/recorded stock, consumption, and incoming supply |
| `GET` | `/api/medicines` | Fixture medicine catalogue |
| `POST` | `/api/forecast` | Forecast, risk, stockout projection, cause, confidence, and source |
| `POST` | `/api/scenarios/simulate` | Evaluate proposed transfers and compare baseline vs intervention |
| `POST` | `/api/plans/optimize` | Produce a safe fixture plan with scenario comparison |
| `GET` | `/api/plans/:planId` | Read a proposed or decided plan |
| `POST` | `/api/plans/:planId/approve` | Human approve/reject action and immutable audit event |
| `GET` | `/api/audit` | In-memory fixture audit trail |

## POST request shapes

### Forecast

```json
{
  "facilityId": "facility-navjeevan-phc",
  "medicineId": "med-insulin-100iu-vial",
  "horizonDays": 14
}
```

`horizonDays` must be `7`, `14`, or `30`.

### Simulate a transfer

```json
{
  "horizonDays": 14,
  "transfers": [
    {
      "fromFacilityId": "facility-district-hospital",
      "toFacilityId": "facility-navjeevan-phc",
      "medicineId": "med-insulin-100iu-vial",
      "quantity": 45,
      "arrivalDay": 1
    }
  ]
}
```

Each returned `transferEvaluation` includes `eligible`, `rejectionReasons`, and route details. Clients must display rejected reasons rather than treating an ineligible transfer as a recommendation.

### Ask for a plan

```json
{
  "destinationFacilityId": "facility-navjeevan-phc",
  "medicineId": "med-insulin-100iu-vial",
  "quantity": 45,
  "horizonDays": 14
}
```

The return includes `id`, `status`, `transfers`, `rationale`, `assumptions`, and a full `simulation`. The current fixture uses one or two safe sources only to demonstrate the flow; it is not an operational allocator.

### Record a human decision

```json
{
  "decision": "APPROVE",
  "actor": "demo-user",
  "note": "Reviewed simulated protected-stock impact."
}
```

`decision` must be `APPROVE` or `REJECT`. A plan can only be decided once. The response returns the plan and audit event with actor, timestamp, note, before state, and after state.

## Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_HORIZON`, `INVALID_DECISION` | Request schema is invalid |
| 404 | `NOT_FOUND`, `FACILITY_NOT_FOUND`, `FORECAST_TARGET_NOT_FOUND`, `OPTIMIZATION_TARGET_NOT_FOUND`, `PLAN_NOT_FOUND` | Resource or target is unavailable |
| 409 | `PLAN_ALREADY_DECIDED` | A final decision already exists |
| 422 | `NO_SAFE_PLAN` | No compliant fixture plan could be produced |
| 422 | `TRANSFER_PERSISTENCE_FAILED` | A decision could not be mapped to the seeded transfer records |
| 503 | `DATABASE_UNAVAILABLE` | MySQL is not reachable or has not been seeded |
| 500 | `INTERNAL_ERROR` | Unexpected server failure |

## Integration requirements

- Keep IDs stable; do not rename JSON fields without a documented version change.
- Quantities must arrive with exact medicine identity and unit meaning from Dhiren's contract.
- Forecast/simulation results must retain `cause`, `confidence`, freshness, and a human-readable limitation from Druv's contract.
- Recommendation and rejection language remains pending Aaryan's safety review.
- Frontend display needs from Samson should be added to this file before client implementation changes.
