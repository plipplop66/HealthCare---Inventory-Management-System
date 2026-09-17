# MEDRIPPLE API contract - authenticated prototype v0.2

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

`source` is important: `INTELLIGENCE_SERVICE` means Druv's live service answered; `FIXTURE_STORE` means deterministic simulated fixture data; `FIXTURE_FALLBACK` means the fixture used the local Node rules because the service was unavailable (development only); `DATABASE_FALLBACK` means a forecast was estimated from the active database records while the service was unavailable. Fallback results carry `isFallback: true`, a `fallbackReason` and `meta.fallback: true`. They are usable for integration only, not a release result, and are never used for approval.

With a database (`DATA_SOURCE=mysql`, or PostgreSQL through `DATABASE_URL`), inventory, optimization, approval, lifecycle and audit routes use that database, and the intelligence service is the only authority for simulation, optimization and approval safety:

| Route | Service unavailable, slow or invalid |
| --- | --- |
| `POST /api/forecast` | `200` labelled `DATABASE_FALLBACK` forecast (informational) |
| `POST /api/scenarios/simulate` | `503`; no local simulation, nothing saved |
| `POST /api/plans/optimize` | `503`; no local plan, nothing saved |
| `POST /api/plans/:planId/approve` (`APPROVE`) | `503`; nothing reserved |

The service's deliberate `4xx` answers (`NO_SAFE_PLAN`, validation, not found, quantity precision) keep their status, code, message and `details`. Only a network failure, timeout (`INTELLIGENCE_TIMEOUT_MS`, default 2500 ms), invalid response or `5xx` becomes a `503`. Facility IDs are stable database `facility_code` values such as `PHC-VLR-001`; medicine IDs are database medicine IDs, while the fixture alias `med-insulin-100iu-vial` remains accepted for the default insulin view.

## Authentication and access control

`POST /api/auth/signup` creates an `OPERATOR` account and returns a signed,
expiring bearer token. `POST /api/auth/login` returns the same session shape.
Pass it on all workspace requests as `Authorization: Bearer <token>`.

`GET /api/auth/me` returns the signed-in user; `POST /api/auth/logout` lets the
client end its stateless session locally. The API derives the audit actor from
the verified token, not from the request body. `APPROVER` and `ADMIN` roles can
approve/reject plans; public sign-up can never create either role.

The public Vercel fixture uses a visible simulated `APPROVER` account. Its
in-memory registrations and audit history may reset on a serverless cold start.
Persistent accounts require `DATA_SOURCE=mysql` and the `app_users` table.

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Server readiness and environment |
| `POST` | `/api/auth/signup` | Register an operator and start a signed session |
| `POST` | `/api/auth/login` | Start a signed session |
| `GET` | `/api/auth/me` | Read the current signed-in account |
| `POST` | `/api/auth/logout` | End the client-side stateless session |
| `GET` | `/api/region/summary` | Resilience score, alerts, earliest stockout, and patient-days at risk |
| `GET` | `/api/facilities` | Facility coordinates, simulated risk, supply coverage, and safe surplus |
| `GET` | `/api/facilities/:facilityId/inventory?medicineId=:medicineId` | Medicine identity, batches, effective/recorded stock, consumption, and incoming supply |
| `GET` | `/api/medicines` | Fixture medicine catalogue |
| `POST` | `/api/forecast` | Forecast, risk, stockout projection, cause, confidence, and source |
| `POST` | `/api/scenarios/simulate` | Evaluate proposed transfers and compare baseline vs intervention |
| `POST` | `/api/plans/optimize` | Produce and persist a deterministic safe plan with scenario comparison |
| `GET` | `/api/plans/:planId` | Read a proposed or decided plan |
| `POST` | `/api/plans/:planId/approve` | Approver-only reserve/reject action and immutable audit event |
| `POST` | `/api/plans/:planId/dispatch` | Mark a reserved plan in transit |
| `POST` | `/api/plans/:planId/deliver` | Add the reserved batch to recipient inventory and mark delivered |
| `POST` | `/api/plans/:planId/cancel` | Cancel a reserved plan and release donor stock |
| `GET` | `/api/audit` | Persistent MySQL audit trail, or fixture audit history offline |

## POST request shapes

### Sign up / login

```json
{
  "name": "Sahil Kumar",
  "email": "sahil@example.org",
  "password": "StrongPass2026"
}
```

Sign-up requires `name`, `email`, and a password with at least 10 characters,
one letter, and one number. Login accepts `email` and `password`. Both return:

```json
{
  "data": {
    "user": { "id": "uuid", "name": "Sahil Kumar", "email": "sahil@example.org", "role": "OPERATOR" },
    "token": "signed-session-token",
    "expiresAt": "2026-09-14T00:00:00.000Z"
  }
}
```

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

Each returned `transferEvaluation` includes `eligible`, `rejectionReasons`, and route details. Clients must display rejected reasons rather than treating an ineligible transfer as a recommendation. With a database the response is the intelligence service's own simulation, including `comparison.safeToRecommend`, `maxTravelHours`, batch IDs and the `receivedStockCheck` donor evidence; Node does not add or override a safety decision.

### Ask for a plan

```json
{
  "destinationFacilityId": "facility-navjeevan-phc",
  "medicineId": "med-insulin-100iu-vial",
  "quantity": 45,
  "horizonDays": 14
}
```

The return includes a deterministic `id`, `status`, `transfers`, `rationale`, `assumptions`, and a full `simulation`. With a database, the plan is the intelligence service's `PROPOSED` plan exactly as returned (ID, transfers, batch IDs and numbers, candidates, validation, context and model version) and is persisted by `plan_id`; the backend never recreates the ID. It rejects a plan that is not for the requested medicine, destination, quantity and horizon, has no batch for a transfer, is not simulated safe with a passing `receivedStockCheck`, or does not require human approval (`503 INVALID_INTELLIGENCE_RESPONSE`).

### Record a human decision

```json
{
  "decision": "APPROVE",
  "note": "Reviewed simulated protected-stock impact."
}
```

`decision` must be `APPROVE` or `REJECT`. The verified signed-in account (`APPROVER` or `ADMIN`) becomes the audit actor, and only a `PROPOSED` plan can be decided; anything else returns `409 PLAN_ALREADY_DECIDED` before any other work.

With a database, `APPROVE` revalidates the stored plan and never regenerates it:

1. The plan's exact transfers (`fromFacilityId`, `toFacilityId`, `medicineId`, `quantity`, `batchId`, `batchNo`, `departureDay`, `arrivalDay`) are sent to the intelligence service's `POST /scenarios/simulate` with the plan's horizon. `/plans/optimize` is never called.
2. The response must show, for the same data source, horizon and exact medicine: every transfer evaluated unchanged, eligible and applied; the planned total; `safeToRecommend: true`; no new shortage, critical facility or other new risk; every route present and at most 6 hours; the cold chain kept; the same single batch and quantity for each transfer (first-expiry-first, valid through the horizon); and a passing received-stock check for every donor (`receivedStockCheck`, which ignores future deliveries). A response missing any of this evidence is `503 INVALID_INTELLIGENCE_RESPONSE`.
3. Only then does one database transaction reserve the stock. It locks the donors' inventory rows and refuses (`409 PLAN_STOCK_CHANGED`, with `details.failures`) unless the donor rows are unchanged since step 1, each transfer's facility, batch ID, batch number and medicine name an `AVAILABLE`, non-quarantined row valid through `SIMULATION_DATE + horizonDays` that holds the quantity, and each donor's usable stock of the medicine, less everything it sends, stays at or above its safety stock. It then marks the plan `RESERVED` (still conditional on `PROPOSED`), writes the transfer items and one audit event, and commits; any failure rolls everything back.

If the plan is no longer safe, the response is `409 PLAN_REVALIDATION_FAILED` and nothing is written. For a donor route raised to 6.5 hours:

```json
{
  "error": {
    "code": "PLAN_REVALIDATION_FAILED",
    "message": "The plan is no longer safe to reserve (ALL_TRANSFERS_ELIGIBLE, SAFE_TO_RECOMMEND, ROUTES_WITHIN_TRAVEL_LIMIT). No stock was reserved. Re-run the optimizer for current conditions and review the new plan.",
    "details": {
      "planId": "plan-...",
      "failedChecks": [
        { "name": "ALL_TRANSFERS_ELIGIBLE", "detail": "transfer 0 (WH-TN-001 batch TN-007-B01-26): TRAVEL_TIME_LIMIT_EXCEEDED" },
        { "name": "SAFE_TO_RECOMMEND", "detail": "The simulator no longer marks the plan safe to recommend." },
        { "name": "ROUTES_WITHIN_TRAVEL_LIMIT", "detail": "Missing or too long (limit 6 h): transfer 0 (WH-TN-001 batch TN-007-B01-26) 6.5 h." }
      ],
      "rejectedTransfers": [{
        "index": 0, "fromFacilityId": "WH-TN-001", "toFacilityId": "PHC-VLR-001", "batchId": 14, "batchNo": "TN-007-B01-26",
        "quantity": 250, "rejectionCodes": ["TRAVEL_TIME_LIMIT_EXCEEDED"], "rejectionReasons": ["..."]
      }],
      "newShortagesCreated": [], "newCriticalFacilities": [], "newRisks": [],
      "unsafeDonors": [], "safeToRecommend": false, "modelVersion": "aiml-ripple-simulator-v1", "dataSource": "POSTGRES",
      "instruction": "No stock was reserved. Re-run the optimizer for current conditions and review the new plan."
    }
  }
}
```

A deliberate `4xx` from the service during revalidation (for example the medicine no longer exists) is also `409 PLAN_REVALIDATION_FAILED`, with the service error in `details.intelligenceError`. A successful approval returns `revalidation` (checks passed, model version, data source, checked transfers and donor evidence) beside `plan`, `audit` and `persistence`, and the same summary is stored in the audit event's after-state.

`REJECT` needs no intelligence call: it records the decision and audit event and leaves inventory unchanged. In fixture mode an approval reserves nothing, becomes `APPROVED`, and returns `revalidation: { "performed": false, "reason": "FIXTURE_MODE" }`; it is not evidence of production safety. The recipient inventory changes only at `DELIVER`.

### Lifecycle actions

`POST /api/plans/:planId/dispatch`, `/deliver`, and `/cancel` each take
`{"note":"..."}` and require `APPROVER` or `ADMIN`. Valid states are
`RESERVED → IN_TRANSIT → DELIVERED`, or `RESERVED → CANCELLED`. Delivery adds
the exact reserved batch to the recipient inventory; cancellation restores the
donor quantity. Every action is transactional and appends an audit event.

## Error codes

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_HORIZON`, `INVALID_DECISION` | Request schema is invalid |
| 400 | `INVALID_EMAIL`, `WEAK_PASSWORD` | Account registration input is invalid |
| 401 | `AUTH_REQUIRED`, `INVALID_SESSION`, `INVALID_CREDENTIALS` | Sign in is missing, expired, invalid, or rejected |
| 403 | `INSUFFICIENT_ROLE` | The signed-in account is not an approver/admin |
| 409 | `ACCOUNT_EXISTS` | The email address is already registered |
| 409 | `PLAN_ALREADY_DECIDED`, `PLAN_STOCK_CHANGED`, `PLAN_STATE_CHANGED`, `INVALID_PLAN_TRANSITION` | A plan was already handled, inventory changed, or a lifecycle transition is no longer valid |
| 409 | `PLAN_REVALIDATION_FAILED` | Approval revalidation found the plan no longer safe; nothing was reserved; re-run the optimizer |
| 422 | `PLAN_QUANTITY_MISMATCH` | Optimizer transfer items do not sum to the requested quantity |
| 503 | `INTELLIGENCE_UNAVAILABLE`, `INTELLIGENCE_TIMEOUT`, `INVALID_INTELLIGENCE_RESPONSE` | With a database, the intelligence service could not be reached, did not answer within `INTELLIGENCE_TIMEOUT_MS`, failed with a `5xx`, or returned an unusable response; nothing was simulated, saved or reserved |
| 404 | `NOT_FOUND`, `FACILITY_NOT_FOUND`, `FORECAST_TARGET_NOT_FOUND`, `OPTIMIZATION_TARGET_NOT_FOUND`, `PLAN_NOT_FOUND` | Resource or target is unavailable |
| 409 | `PLAN_ALREADY_DECIDED` | A final decision already exists |
| 422 | `NO_SAFE_PLAN` | No safe plan exists; with the intelligence service, `details` keeps its safe capacity, candidates and escalation |
| 4xx | Intelligence service codes | Deliberate intelligence decisions (for example `INVALID_QUANTITY_FOR_UNIT`, `MEDICINE_NOT_FOUND`) pass through unchanged |
| 422 | `TRANSFER_PERSISTENCE_FAILED` | A decision could not be mapped to the seeded transfer records |
| 503 | `DATABASE_UNAVAILABLE` | MySQL is not reachable or has not been seeded |
| 500 | `INTERNAL_ERROR` | Unexpected server failure |

## Integration requirements

- Keep IDs stable; do not rename JSON fields without a documented version change.
- Quantities must arrive with exact medicine identity and unit meaning from Dhiren's contract.
- Forecast/simulation results must retain `cause`, `confidence`, freshness, and a human-readable limitation from Druv's contract.
- Recommendation and rejection language remains pending Aaryan's safety review.
- Treat bearer tokens as credentials; use HTTPS and a unique `AUTH_JWT_SECRET` outside local development.
- Frontend display needs from Samson should be added to this file before client implementation changes.
