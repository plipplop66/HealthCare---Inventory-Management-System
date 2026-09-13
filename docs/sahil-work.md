# Sahil's work board - Software Engineer & Integration Lead

Status: backend foundation, MySQL integration, deterministic golden scenario, simulation/optimization, audit persistence, and local container stack are complete. Live intelligence, frontend, final clinical rules, external deployment, and final acceptance still depend on their owners.

## Completed now

- [x] Create the shared repository layout: `frontend`, `backend`, `intelligence`, `database`, `docs`, `tests`, and `demo`.
- [x] Add a runnable Node.js/Express API skeleton with config loading, CORS, request IDs, JSON logging, `/health`, standard success envelopes, and useful errors.
- [x] Publish a versioned fixture-backed API contract for facility, inventory, forecast, simulation, plan, approval, and audit flows.
- [x] Build a deterministic insulin golden flow, including excluded expired stock, a PHC supply delay, an unsafe donor rejection, a safe plan, horizon comparison, and approval/audit persistence.
- [x] Add a FastAPI intelligence adapter with response validation, timeout handling, and a clearly labelled fallback that works with either fixtures or MySQL records.
- [x] Add automated API tests, one-command local start/test commands, `.env.example`, and a CI workflow.
- [x] Add full-horizon stock projection, protected-donor feasibility checks, safe-plan generation, MySQL decision/audit persistence, Docker health checks, and deterministic golden-scenario setup.

## Next work, ordered by dependency

### Can continue immediately

- [ ] Confirm the exact screen payload fields with Samson and record any additions in `docs/api-contract.md`.
- [ ] Build a demo-user stub only if it stays separate from the core flow.
- [x] Add production-style Docker configuration, health checks, and repeatable local stack commands; a public host selection is still required.
- [ ] Keep integration tests and README instructions current as interfaces change.

### Waiting for Dhiren - database/data contract

- [x] Add a switchable MySQL repository that reads Dhiren's schema while retaining deterministic fixtures for offline integration.
- [x] Add Compose initialization, a deterministic golden scenario, and validation for base units, exact medicine identity, batch state, expiry, routes, and replenishments.
- [x] Connect inventory, region summary, scenario simulation, plan optimization, approval, and audit reads/writes to the MySQL implementation; live database execution still needs Docker/MySQL on the development machine.

### Waiting for Druv - intelligence contract

- [ ] Set `INTELLIGENCE_SERVICE_URL` and connect the tested `/forecast` service.
- [ ] Validate the final risk, confidence, cause, stockout, regional-fragility, simulator, and optimizer response schemas.
- [ ] Replace the fixture optimiser and scenario calculation with Druv's test-verified outputs while retaining backend input/error validation and timeouts.

### Waiting for Aaryan - healthcare/safety acceptance

- [ ] Replace all provisional safety-stock and equity assumptions with Aaryan-approved rules.
- [ ] Apply approved disclaimer, warning, approval, and rejected-donor wording in API response text and frontend copy.
- [ ] Run and record Aaryan's acceptance cases on the integrated golden flow.

### Waiting for Samson - frontend contract/integration

- [ ] Reconcile each endpoint with the dashboard, facility, candidates, simulator, plan review, and audit screen requirements.
- [ ] Replace frontend mocks with live API calls and jointly test loading, error, and empty states.
- [ ] Rehearse the five-click golden demo against the deployed API.

## Release responsibility

- [ ] Fix integration defects only after every owner marks their handoff stable.
- [x] Production-style environment variables, container configuration, and health checks.
- [ ] Select a host, configure real environment secrets, and establish a stable public URL.
- [ ] Fresh-clone verification: install, seed/reset, start, test, and complete the golden scenario without manual edits.
- [ ] Release freeze, accessible README, and public repository/app checks.

## Scope guardrails

Do not spend the prototype window on enterprise authentication, unnecessary microservices, real hospital integrations, unneeded admin screens, or deployment experiments after the release candidate stabilizes.
