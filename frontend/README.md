# MEDRIPPLE frontend

React/Vite workspace for the MEDRIPPLE regional medicine-resilience prototype. The data path is always:

```
React -> Node API (/api) -> intelligence service (Python) -> database
```

The browser never calls the intelligence service and never forecasts, projects stock or decides donor safety itself.

## Screens

1. **Dashboard** (the API summarises insulin, the default medicine, only): resilience score, earliest stockout, critical count and facilities monitored, with each facility's and alert's exact API risk label (`LOW`, `MEDIUM`, `HIGH`, `CRITICAL`).
2. **Facility detail**: for the selected facility and medicine, the medicine identity and unit, recorded, effective and protected stock, batches with expiry and status, demand, risk, stockout and replenishment, and the forecast's cause, confidence, explanation, model and source. The chart plots only the API's own projection; otherwise it says "Projection unavailable".
3. **Candidates**: the donors assessed by the optimizer (from a plan, or from `NO_SAFE_PLAN` details) with every rejection code and reason, safe capacity, retained floor, travel hours, cold chain and excluded future supply. Without an assessment it asks you to run the simulator.
4. **Ripple simulator**: submits the shared selection to `POST /api/plans/optimize`. A safe result shows the plan ID, donors, quantities, batches, routes, cold chain, risks before and after, validation checks, received-stock evidence and the human-approval requirement. `NO_SAFE_PLAN` shows capacity, unmet quantity, candidates, reasons and escalation steps. A new assessment always clears the previously selected plan.
5. **Plan review**: loads only the selected plan with `GET /api/plans/:id` (it never optimizes). Approvers and admins can approve or reject with a required note. Approval makes the API re-run the exact transfers through the intelligence service before the database reserves stock; the returned revalidation evidence and the `RESERVED` status are shown. `PLAN_REVALIDATION_FAILED`, `PLAN_STOCK_CHANGED`, service outages, permission, session, database and network errors are shown with the API's details, and success is shown only when the API confirmed the new status.
6. **Audit trail**: the API's recorded `RESERVE`, `REJECT`, `DISPATCH`, `DELIVER` and `CANCEL` events.

The facility, medicine (with its unit), quantity and horizon (7, 14 or 30 days) are shared across screens and kept for the browser session, as is the selected plan, so a refresh reopens the same plan. Quantities are whole numbers for medicines counted in `count` and have at most two decimal places otherwise.

Every result carries its API metadata (`meta.source`, `meta.fallback`, `meta.decisionSupportOnly`, `meta.requestId`), shown next to the data. All data is simulated, and fallback forecasts are labelled.

## Run with the local API

From the repository root:

```powershell
Copy-Item frontend/.env.example frontend/.env
npm run setup
npm run dev
```

In a second terminal:

```powershell
npm run dev:frontend
```

Open the address Vite reports, normally `http://127.0.0.1:5173`. `.env.example` points at the backend on `http://127.0.0.1:3001/api`; the API contract is in [`../docs/api-contract.md`](../docs/api-contract.md).

Setting `VITE_USE_MOCKS=true` (or leaving the API URL empty in development) serves built-in data in the API's envelope shape, labelled **MOCK DATA** on every screen. Sign in with any email; `mock.approver@medripple.demo` has the approver role. Mock results are canned examples, not calculations.

## Code layout

- `src/services/apiClient.js`: HTTP, the `{ data, meta }` envelope and `ApiError` (status, code, details, request ID).
- `src/services/medrippleClient.js`: one method per API route; `medrippleApi.js` wires it to the configured API or the mock transport.
- `src/services/workspace.js`: screen workflow (loading, assessment, plan selection, decisions).
- `src/services/viewModels.js`, `evidence.js`, `errors.js`: API fields to screen text, without recalculation.
- `src/pages/` and `src/components/`: the screens.

## Tests

```powershell
npm --prefix frontend test
npm run build:frontend
```

The tests use Node's test runner. Screens are rendered to HTML with Vite's server-side loader, so no browser is needed.
