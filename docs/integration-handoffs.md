# Integration handoffs

This is the single place for cross-team changes that affect the backend. Add a dated entry before changing an agreed field, unit, route, or safety rule.

## Handoff checklist

| Owner | Needed before backend can finalize | Current bridge |
| --- | --- | --- |
| Dhiren | MySQL migration, data dictionary, exact units, deterministic seed, batch/replenishment/route fields | `database/schema.sql` is now integrated through `mysql-store.js`; all database quantities retain Dhiren's base-unit policy |
| Druv | FastAPI base URL, `/forecast` request/response schema, error behaviour, timeout expectations, simulator/optimizer outputs | `intelligence-adapter.js` with fixture fallback |
| Aaryan | Approval/rejection language, safety-stock/equity rules, acceptance tests | Provisional protected-stock check only |
| Samson | Screen-level field list, loading/error/empty-state expectations, frontend base URL | `docs/api-contract.md` v0.1 |

## Change protocol

1. Propose the new field or behaviour in a pull request or team message.
2. Update `docs/api-contract.md` with request and response examples.
3. Update fixture data and tests before changing frontend or intelligence integrations.
4. Test the full golden flow: critical PHC -> unsafe donor rejected -> safe plan -> human decision -> audit.

## Fixture golden scenario

- Navjeevan PHC has 22 simulated usable insulin vials and uses 8 per day; its replenishment arrives on day 8.
- A 45-vial transfer from District Hospital is rejected because it breaks that donor's protected stock.
- The fixture optimizer uses Central District Store only when it can retain protected coverage for the selected horizon; it can add another eligible donor when one source does not have enough safe stock.
- Every result is simulated decision support and must be replaced/validated before release.
