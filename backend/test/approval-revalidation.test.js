// Approval in database mode: the stored plan's exact transfers are revalidated by the intelligence service before any
// stock is reserved. A fake service and an in-memory database store; no network beyond 127.0.0.1.
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { VELLORE_PLAN_ID, VELLORE_TRANSFER, planResponse, simulationResponse, startFakeIntelligence } = require('./support/intelligence-fixtures');
const { createFakePersistentStore, createMemoryAuthStore } = require('./support/fake-persistent-store');

const APPROVER = { email: 'demo.approver@medripple.demo', password: 'MedrippleDemo!2026' };
const REQUEST_FIELDS = ['fromFacilityId', 'toFacilityId', 'medicineId', 'quantity', 'batchId', 'batchNo', 'departureDay', 'arrivalDay'];

// The backend over a given store and intelligence URL, signed in as the demo approver.
async function startBackend(t, store, serviceUrl, timeoutMs = 1000) {
  const app = createApp({
    environment: 'test', corsOrigins: [], intelligenceServiceUrl: serviceUrl, intelligenceTimeoutMs: timeoutMs, simulationDate: '2026-09-11'
  }, { inventoryStore: store, authStore: createMemoryAuthStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { token, body, method = body ? 'POST' : 'GET' } = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, body: await response.json() };
  };
  const login = await call('/auth/login', { body: APPROVER });
  return { call, approver: login.body.data.token };
}

async function startApi(t, { simulate = ({ body }) => ({ body: simulationResponse(body) }), timeoutMs = 1000 } = {}) {
  const events = [];
  const store = createFakePersistentStore(events);
  const service = await startFakeIntelligence(t, async (call) => {
    events.push(`python:${call.url}`);
    if (call.url === '/plans/optimize') return { body: planResponse() };
    return simulate({ ...call, store });
  });
  const { call, approver } = await startBackend(t, store, service.url, timeoutMs);
  const optimized = await call('/plans/optimize', { token: approver, body: { destinationFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, horizonDays: 14 } });
  assert.equal(optimized.status, 200, JSON.stringify(optimized.body));
  const decide = (decision, token = approver, planId = VELLORE_PLAN_ID) => call(`/plans/${planId}/approve`, {
    token, body: { decision, note: `${decision} after review of the revalidated plan.` }
  });
  const simulateCalls = () => service.requests.filter((item) => item.url === '/scenarios/simulate');
  return { store, service, events, call, approver, decide, simulateCalls, plan: optimized.body.data };
}

// Mutates the default safe simulation of the submitted transfers.
function simulationWith(change) {
  return ({ body }) => {
    const response = simulationResponse(body);
    change(response);
    return { body: response };
  };
}

async function assertRefusedWithoutChanges(api, expectedChecks) {
  const before = api.store.snapshot();
  const result = await api.decide('APPROVE');
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'PLAN_REVALIDATION_FAILED');
  const { details } = result.body.error;
  assert.equal(details.planId, VELLORE_PLAN_ID);
  for (const name of expectedChecks) {
    assert.ok(details.failedChecks.some((item) => item.name === name), `${name} in ${JSON.stringify(details.failedChecks)}`);
  }
  assert.match(details.instruction, /Re-run the optimizer/);
  assert.deepEqual(api.store.snapshot(), before);
  assert.equal(api.store.state.plans.get(VELLORE_PLAN_ID).status, 'PROPOSED');
  assert.ok(!api.events.includes('store:recordPlanDecision:APPROVE'));
  return details;
}

test('1. a safe plan is revalidated with its exact transfers before stock is reserved', async (t) => {
  const api = await startApi(t);
  assert.equal(api.plan.id, VELLORE_PLAN_ID);
  const optimizeCalls = api.service.requests.length;
  const result = await api.decide('APPROVE');
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const [request] = api.simulateCalls();
  assert.deepEqual(request.body, {
    horizonDays: 14,
    transfers: [Object.fromEntries(REQUEST_FIELDS.map((field) => [field, VELLORE_TRANSFER[field]]))]
  });
  assert.equal(api.service.requests.length, optimizeCalls + 1, 'approval never calls /plans/optimize');
  assert.deepEqual(api.events.slice(-3), ['store:readDonorStock', 'python:/scenarios/simulate', 'store:recordPlanDecision:APPROVE']);

  const { plan, audit, persistence, revalidation } = result.body.data;
  assert.deepEqual([plan.id, plan.status, persistence.storage, persistence.planStatus], [VELLORE_PLAN_ID, 'RESERVED', 'POSTGRES', 'RESERVED']);
  assert.deepEqual(plan.transfers, api.plan.transfers);
  assert.equal(revalidation.performed, true);
  assert.equal(revalidation.modelVersion, 'aiml-ripple-simulator-v1');
  assert.ok(revalidation.checks.includes('DONORS_SAFE_ON_RECEIVED_STOCK') && revalidation.checks.includes('ROUTES_WITHIN_TRAVEL_LIMIT'));
  assert.deepEqual(revalidation.transfers.map((item) => [item.batchId, item.batchNo, item.quantity]), [[14, 'TN-007-B01-26', 300]]);
  assert.equal(audit.afterState.revalidation.performed, true);

  const { state } = api.store;
  assert.equal(state.inventory.find((row) => row.batchId === 14).quantity, 50820);
  assert.equal(state.inventory.find((row) => row.batchId === 13).quantity, 51120);
  assert.equal(state.transfers.length, 1);
  assert.deepEqual([state.audits.length, state.audits[0].action], [1, 'RESERVE']);
  assert.equal(state.audits[0].afterState.revalidation.passed, true);
});

test('2. an unsafe revalidation returns 409 and changes nothing', async (t) => {
  const api = await startApi(t, {
    simulate: simulationWith((response) => {
      Object.assign(response.transferEvaluations[0], {
        eligible: false, rejectionCodes: ['BELOW_PROTECTED_STOCK'], rejectionReasons: ['WH-TN-001 would fall below its protected safety stock.']
      });
      response.comparison.safeToRecommend = false;
      response.comparison.newRisks = [{ facilityId: 'WH-TN-001', facilityName: 'Warehouse', riskType: 'FELL_BELOW_PROTECTED_STOCK', day: 3, detail: 'Below protected stock.' }];
    })
  });
  const details = await assertRefusedWithoutChanges(api, ['ALL_TRANSFERS_ELIGIBLE', 'SAFE_TO_RECOMMEND', 'NO_NEW_RISKS']);
  assert.deepEqual(details.rejectedTransfers, [{
    index: 0, fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', batchId: 14, batchNo: 'TN-007-B01-26', quantity: 300,
    rejectionCodes: ['BELOW_PROTECTED_STOCK'], rejectionReasons: ['WH-TN-001 would fall below its protected safety stock.']
  }]);
  assert.equal(details.newRisks[0].riskType, 'FELL_BELOW_PROTECTED_STOCK');
  assert.equal(details.safeToRecommend, false);
});

test('3. a route over six hours is refused, whatever the service limit says', async (t) => {
  const tooLong = await startApi(t, {
    simulate: simulationWith((response) => {
      Object.assign(response.transferEvaluations[0], { eligible: false, rejectionCodes: ['TRAVEL_TIME_LIMIT_EXCEEDED'], rejectionReasons: ['The route takes 6.5 hours.'] });
      response.transferEvaluations[0].route.travelHours = 6.5;
      response.comparison.safeToRecommend = false;
    })
  });
  const details = await assertRefusedWithoutChanges(tooLong, ['ROUTES_WITHIN_TRAVEL_LIMIT', 'ALL_TRANSFERS_ELIGIBLE']);
  assert.deepEqual(details.rejectedTransfers[0].rejectionCodes, ['TRAVEL_TIME_LIMIT_EXCEEDED']);

  // A misconfigured 8-hour service limit that accepts a 7-hour route is still refused.
  const lenient = await startApi(t, {
    simulate: simulationWith((response) => {
      response.maxTravelHours = 8;
      response.transferEvaluations[0].route.travelHours = 7;
    })
  });
  await assertRefusedWithoutChanges(lenient, ['ROUTES_WITHIN_TRAVEL_LIMIT']);

  const missingRoute = await startApi(t, { simulate: simulationWith((response) => { response.transferEvaluations[0].route = null; }) });
  await assertRefusedWithoutChanges(missingRoute, ['ROUTES_WITHIN_TRAVEL_LIMIT']);
});

test('4. a cold-chain failure is refused', async (t) => {
  const api = await startApi(t, {
    simulate: simulationWith((response) => {
      Object.assign(response.transferEvaluations[0], { eligible: false, applied: false, rejectionCodes: ['COLD_CHAIN_UNAVAILABLE'], rejectionReasons: ['No cold chain.'] });
      response.transferEvaluations[0].route.coldChainAvailable = false;
      response.transferEvaluations[0].batches = [];
      response.comparison.safeToRecommend = false;
      response.receivedStockCheck = { ...response.receivedStockCheck, passed: false, donors: [] };
    })
  });
  await assertRefusedWithoutChanges(api, ['COLD_CHAIN', 'ALL_TRANSFERS_ELIGIBLE', 'BATCHES_UNCHANGED']);

  // The service marks the route cold-chain unavailable but still eligible: refused anyway.
  const inconsistent = await startApi(t, { simulate: simulationWith((response) => { response.transferEvaluations[0].route.coldChainAvailable = false; }) });
  await assertRefusedWithoutChanges(inconsistent, ['COLD_CHAIN']);
});

test('5. a donor safe only because of future replenishment is refused and the excluded supply is shown', async (t) => {
  const api = await startApi(t, {
    simulate: simulationWith((response) => {
      Object.assign(response.receivedStockCheck.donors[0], {
        passed: false, failureCodes: ['BELOW_RETAINED_FLOOR'], retainedFloor: 1130.82, lowestProjectedStock: 1067.72, futureReplenishmentExcluded: 1745.5,
        explanation: 'Below its retained floor counting only stock already received. Future supply of 1745.5 mL is not counted.'
      });
      response.receivedStockCheck.passed = false;
    })
  });
  const details = await assertRefusedWithoutChanges(api, ['DONORS_SAFE_ON_RECEIVED_STOCK']);
  assert.equal(details.failedChecks.length, 1, 'the simulator itself still called the transfer safe');
  assert.equal(details.safeToRecommend, true);
  assert.deepEqual(details.unsafeDonors.map((donor) => [donor.facilityId, donor.failureCodes, donor.futureReplenishmentExcluded]), [
    ['WH-TN-001', ['BELOW_RETAINED_FLOOR'], 1745.5]
  ]);
});

test('6. a revalidation that creates a new shortage is refused', async (t) => {
  const api = await startApi(t, {
    simulate: simulationWith((response) => {
      response.comparison.newShortagesCreated = ['CHC-TRY-001'];
      response.comparison.newCriticalFacilities = ['CHC-TRY-001'];
      response.comparison.safeToRecommend = false;
    })
  });
  const details = await assertRefusedWithoutChanges(api, ['NO_NEW_SHORTAGES', 'NO_NEW_RISKS', 'SAFE_TO_RECOMMEND']);
  assert.deepEqual([details.newShortagesCreated, details.newCriticalFacilities], [['CHC-TRY-001'], ['CHC-TRY-001']]);
});

test('identity, batch and data-source changes are refused', async (t) => {
  const batch = await startApi(t, {
    simulate: simulationWith((response) => { response.transferEvaluations[0].batches = [{ batchId: 13, batchNo: 'TN-007-B02-26', quantity: 300, expiryDate: '2028-04-24' }]; })
  });
  await assertRefusedWithoutChanges(batch, ['BATCHES_UNCHANGED']);
  const split = await startApi(t, {
    simulate: simulationWith((response) => {
      response.transferEvaluations[0].batches = [
        { batchId: 14, batchNo: 'TN-007-B01-26', quantity: 200, expiryDate: '2028-02-29' },
        { batchId: 13, batchNo: 'TN-007-B02-26', quantity: 100, expiryDate: '2028-04-24' }
      ];
    })
  });
  await assertRefusedWithoutChanges(split, ['BATCHES_UNCHANGED']);
  const source = await startApi(t, { simulate: simulationWith((response) => { response.dataContext.dataSource = 'MYSQL'; }) });
  await assertRefusedWithoutChanges(source, ['DATA_SOURCE']);
  const medicine = await startApi(t, { simulate: simulationWith((response) => { response.medicineId = '8'; response.medicine.id = '8'; }) });
  await assertRefusedWithoutChanges(medicine, ['MEDICINE_IDENTITY']);
  const quantity = await startApi(t, { simulate: simulationWith((response) => { response.transferEvaluations[0].quantity = 299.99; }) });
  await assertRefusedWithoutChanges(quantity, ['TRANSFERS_UNCHANGED', 'QUANTITY_TOTAL']);
  const horizon = await startApi(t, { simulate: simulationWith((response) => { response.horizonDays = 30; }) });
  await assertRefusedWithoutChanges(horizon, ['HORIZON']);
  const departure = await startApi(t, { simulate: simulationWith((response) => { response.transferEvaluations[0].departureDay = 2; }) });
  await assertRefusedWithoutChanges(departure, ['TRANSFERS_UNCHANGED']);
});

async function assertUnavailableWithoutChanges(api, code) {
  const before = api.store.snapshot();
  const result = await api.decide('APPROVE');
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.error.code, code);
  assert.deepEqual(api.store.snapshot(), before);
  assert.ok(!api.events.includes('store:recordPlanDecision:APPROVE'));
  const text = JSON.stringify(result.body);
  assert.doesNotMatch(text, /\n\s+at |stack|password/i);
  return result.body.error;
}

async function unusedPortUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

test('7. an unavailable intelligence service fails approval closed with 503', async (t) => {
  // The plan is made while the service is up; approval then runs against a stopped or unconfigured service.
  const { store } = await startApi(t);
  const before = store.snapshot();
  for (const [url, reason] of [[await unusedPortUrl(), 'CONNECTION_FAILED'], ['', 'NOT_CONFIGURED']]) {
    const backend = await startBackend(t, store, url);
    const result = await backend.call(`/plans/${VELLORE_PLAN_ID}/approve`, {
      token: backend.approver, body: { decision: 'APPROVE', note: 'Approve while the service is down.' }
    });
    assert.equal(result.status, 503, JSON.stringify(result.body));
    assert.deepEqual([result.body.error.code, result.body.error.details.reason], ['INTELLIGENCE_UNAVAILABLE', reason]);
    assert.doesNotMatch(JSON.stringify(result.body), /\n\s+at |ECONNREFUSED/);
    assert.deepEqual(store.snapshot(), before);
    assert.ok(!store.events.includes('store:recordPlanDecision:APPROVE'));
  }
});

test('8. a revalidation timeout fails approval closed with 503', async (t) => {
  const api = await startApi(t, { simulate: () => 'HANG', timeoutMs: 300 });
  const error = await assertUnavailableWithoutChanges(api, 'INTELLIGENCE_TIMEOUT');
  assert.equal(error.details.timeoutMs, 300);
});

test('9. an invalid or failed revalidation response is never accepted', async (t) => {
  const cases = [
    [simulationWith((response) => { delete response.receivedStockCheck; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [simulationWith((response) => { delete response.maxTravelHours; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [simulationWith((response) => { response.comparison.safeToRecommend = 'true'; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [simulationWith((response) => { response.transferEvaluations = []; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [simulationWith((response) => { delete response.transferEvaluations[0].batches; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [simulationWith((response) => { response.decisionSupportOnly = false; }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [() => ({ body: 'not json' }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [() => ({ status: 404, body: 'Not Found' }), 'INVALID_INTELLIGENCE_RESPONSE'],
    [() => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Traceback: password=secret' } } }), 'INTELLIGENCE_UNAVAILABLE']
  ];
  for (const [simulate, code] of cases) {
    const api = await startApi(t, { simulate });
    await assertUnavailableWithoutChanges(api, code);
  }

  // A deliberate 4xx from the service means the stored plan can no longer be simulated: 409, details preserved.
  const rejected = await startApi(t, {
    simulate: () => ({ status: 404, body: { error: { code: 'MEDICINE_NOT_FOUND', message: "Medicine '7' was not found.", details: { medicineId: '7' } } } })
  });
  const details = await assertRefusedWithoutChanges(rejected, ['INTELLIGENCE_ACCEPTS_PLAN']);
  assert.deepEqual(details.intelligenceError, { status: 404, code: 'MEDICINE_NOT_FOUND', message: "Medicine '7' was not found.", details: { medicineId: '7' } });
});

test('10. stock that changes during revalidation rolls the approval back with PLAN_STOCK_CHANGED', async (t) => {
  const api = await startApi(t, {
    simulate: ({ body, store }) => {
      // Another reservation takes stock from the same batch while the service is answering.
      store.state.inventory.find((row) => row.batchId === 14).quantity = 100;
      return { body: simulationResponse(body) };
    }
  });
  const result = await api.decide('APPROVE');
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.error.code, 'PLAN_STOCK_CHANGED');
  assert.deepEqual(result.body.error.details.failures.map((item) => item.reason), ['DONOR_STOCK_CHANGED_DURING_REVALIDATION', 'INSUFFICIENT_BATCH_QUANTITY']);
  const { state } = api.store;
  assert.deepEqual([state.plans.get(VELLORE_PLAN_ID).status, state.transfers.length, state.audits.length], ['PROPOSED', 0, 0]);
  assert.equal(state.inventory.find((row) => row.batchId === 14).quantity, 100, 'only the concurrent change remains');
});

test('11. an already decided plan is refused before the service is called', async (t) => {
  const api = await startApi(t);
  assert.equal((await api.decide('APPROVE')).status, 200);
  const calls = api.simulateCalls().length;
  const before = api.store.snapshot();
  for (const decision of ['APPROVE', 'REJECT']) {
    const repeated = await api.decide(decision);
    assert.equal(repeated.status, 409);
    assert.deepEqual([repeated.body.error.code, repeated.body.error.details.status], ['PLAN_ALREADY_DECIDED', 'RESERVED']);
  }
  assert.equal(api.simulateCalls().length, calls);
  assert.deepEqual(api.store.snapshot(), before);
});

test('12. a human rejection needs no intelligence call and leaves inventory unchanged', async (t) => {
  const api = await startApi(t, { simulate: () => { throw new Error('rejection must not call the simulator'); } });
  const inventory = JSON.stringify(api.store.state.inventory);
  const result = await api.decide('REJECT');
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.deepEqual([result.body.data.plan.status, result.body.data.persistence.planStatus], ['REJECTED', 'REJECTED']);
  assert.equal(result.body.data.revalidation, undefined);
  assert.equal(api.simulateCalls().length, 0);
  assert.ok(!api.events.includes('store:readDonorStock'));
  assert.equal(JSON.stringify(api.store.state.inventory), inventory);
  assert.deepEqual(api.store.state.audits.map((audit) => audit.action), ['REJECT']);
});

test('13. an operator can neither approve nor reject', async (t) => {
  const api = await startApi(t);
  const signup = await api.call('/auth/signup', { body: { name: 'Operator Test', email: 'operator.test@example.com', password: 'OperatorPass2026' } });
  assert.equal(signup.body.data.user.role, 'OPERATOR');
  const before = api.store.snapshot();
  for (const decision of ['APPROVE', 'REJECT']) {
    const denied = await api.decide(decision, signup.body.data.token);
    assert.deepEqual([denied.status, denied.body.error.code], [403, 'INSUFFICIENT_ROLE']);
  }
  const anonymous = await api.call(`/plans/${VELLORE_PLAN_ID}/approve`, { body: { decision: 'APPROVE', note: 'No session.' } });
  assert.equal(anonymous.status, 401);
  assert.equal(api.simulateCalls().length, 0);
  assert.deepEqual(api.store.snapshot(), before);
});

test('a stored plan without batch or schedule details is refused before any service call', async (t) => {
  const api = await startApi(t);
  const stored = api.store.state.plans.get(VELLORE_PLAN_ID);
  delete stored.transfers[0].departureDay;
  delete stored.transfers[0].batchNo;
  const before = api.store.snapshot();
  const result = await api.decide('APPROVE');
  assert.deepEqual([result.status, result.body.error.code], [409, 'PLAN_REVALIDATION_FAILED']);
  assert.deepEqual(result.body.error.details.failedChecks.map((item) => item.name), ['PLAN_STRUCTURE']);
  assert.equal(api.simulateCalls().length, 0);
  assert.deepEqual(api.store.snapshot(), before);
});

test('14. concurrent approvals reserve the stock only once', async (t) => {
  const api = await startApi(t);
  const results = await Promise.all([api.decide('APPROVE'), api.decide('APPROVE'), api.decide('APPROVE')]);
  const statuses = results.map((result) => result.status).sort();
  assert.deepEqual(statuses, [200, 409, 409]);
  assert.ok(results.filter((result) => result.status === 409).every((result) => result.body.error.code === 'PLAN_ALREADY_DECIDED'));
  const { state } = api.store;
  assert.equal(state.inventory.find((row) => row.batchId === 14).quantity, 50820);
  assert.deepEqual([state.transfers.length, state.audits.length], [1, 1]);
});
