// Database mode: simulation and optimization come only from the intelligence service and fail closed; the forecast
// alone may fall back, clearly labelled. A fake service and an in-memory database store.
const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { VELLORE_PLAN_ID, planResponse, simulationResponse, startFakeIntelligence } = require('./support/intelligence-fixtures');
const { createFakePersistentStore, createMemoryAuthStore } = require('./support/fake-persistent-store');

const TRANSFER = { fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, arrivalDay: 1 };
const SIMULATION = { horizonDays: 14, transfers: [TRANSFER] };
const OPTIMIZATION = { destinationFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, horizonDays: 14 };

async function startApi(t, { handler = ({ url, body }) => ({ body: url === '/plans/optimize' ? planResponse() : simulationResponse(body) }), serviceUrl, timeoutMs = 1000 } = {}) {
  const store = createFakePersistentStore();
  const service = await startFakeIntelligence(t, handler);
  const app = createApp({
    environment: 'test', corsOrigins: [], intelligenceServiceUrl: serviceUrl ?? service.url, intelligenceTimeoutMs: timeoutMs, simulationDate: '2026-09-11'
  }, { inventoryStore: store, authStore: createMemoryAuthStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (path, body, token) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };
  const token = (await post('/auth/login', { email: 'demo.approver@medripple.demo', password: 'MedrippleDemo!2026' })).body.data.token;
  return { store, service, call: (path, body) => post(path, body, token) };
}

async function unusedPortUrl() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return url;
}

function assertNoLeak(body) {
  assert.doesNotMatch(JSON.stringify(body), /\n\s+at |Traceback|password|secret|ECONNREFUSED/i);
}

test('persistent simulation 1: the intelligence result is returned as the only safety decision', async (t) => {
  const api = await startApi(t);
  const result = await api.call('/scenarios/simulate', SIMULATION);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.meta.source, 'INTELLIGENCE_SERVICE');
  assert.equal(result.body.meta.fallback, false);
  assert.equal(result.body.data.comparison.safeToRecommend, true);
  assert.equal(result.body.data.receivedStockCheck.passed, true);
  assert.deepEqual(api.service.requests.map((item) => [item.url, item.body]), [['/scenarios/simulate', SIMULATION]]);
});

test('persistent simulation 2: Node never replaces an unsafe intelligence result with its own rules', async (t) => {
  const api = await startApi(t, {
    handler: ({ body }) => {
      const response = simulationResponse(body);
      response.comparison.safeToRecommend = false;
      response.transferEvaluations[0].eligible = false;
      response.transferEvaluations[0].rejectionCodes = ['BELOW_PROTECTED_STOCK'];
      return { body: response };
    }
  });
  const result = await api.call('/scenarios/simulate', SIMULATION);
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.data.comparison.safeToRecommend, result.body.data.transferEvaluations[0].rejectionCodes], [false, ['BELOW_PROTECTED_STOCK']]);
  assert.equal(result.body.data.source, 'INTELLIGENCE_SERVICE');
});

test('persistent simulation 3: a stopped or unconfigured service returns 503 without a local simulation', async (t) => {
  for (const [serviceUrl, reason] of [[await unusedPortUrl(), 'CONNECTION_FAILED'], ['', 'NOT_CONFIGURED']]) {
    const api = await startApi(t, { serviceUrl });
    const before = api.store.snapshot();
    const result = await api.call('/scenarios/simulate', SIMULATION);
    assert.equal(result.status, 503);
    assert.deepEqual([result.body.error.code, result.body.error.details.reason], ['INTELLIGENCE_UNAVAILABLE', reason]);
    assert.equal(result.body.data, undefined);
    assert.deepEqual(api.store.snapshot(), before);
    assertNoLeak(result.body);
  }
});

test('persistent simulation 4: a timeout returns 503 INTELLIGENCE_TIMEOUT', async (t) => {
  const api = await startApi(t, { handler: () => 'HANG', timeoutMs: 200 });
  const started = Date.now();
  const result = await api.call('/scenarios/simulate', SIMULATION);
  assert.deepEqual([result.status, result.body.error.code, result.body.error.details.timeoutMs], [503, 'INTELLIGENCE_TIMEOUT', 200]);
  assert.ok(Date.now() - started < 2000);
});

test('persistent simulation 5: an invalid response returns 503 INVALID_INTELLIGENCE_RESPONSE', async (t) => {
  const invalid = [
    (response) => { delete response.comparison.safeToRecommend; },
    (response) => { response.transferEvaluations.push({ ...response.transferEvaluations[0], index: 1 }); },
    (response) => { response.baseline = null; },
    (response) => { response.comparison.newRisks = null; },
    (response) => { response.transferEvaluations[0].eligible = 'yes'; }
  ];
  for (const change of invalid) {
    const api = await startApi(t, { handler: ({ body }) => { const response = simulationResponse(body); change(response); return { body: response }; } });
    const result = await api.call('/scenarios/simulate', SIMULATION);
    assert.deepEqual([result.status, result.body.error.code], [503, 'INVALID_INTELLIGENCE_RESPONSE'], JSON.stringify(result.body));
  }
});

test('persistent simulation 6: a service 5xx returns 503 without upstream text', async (t) => {
  const api = await startApi(t, { handler: () => ({ status: 500, body: { error: { code: 'INTERNAL_ERROR', message: 'Traceback (most recent call last): password=secret' } } }) });
  const result = await api.call('/scenarios/simulate', SIMULATION);
  assert.deepEqual([result.status, result.body.error.code, result.body.error.details.upstreamStatus], [503, 'INTELLIGENCE_UNAVAILABLE', 500]);
  assertNoLeak(result.body);
});

test('persistent simulation 7: deliberate 4xx decisions pass through with status, code, message and details', async (t) => {
  const decisions = [
    [422, 'INVALID_REQUEST', 'horizonDays must be one of 7, 14 or 30.', { field: 'horizonDays' }],
    [404, 'MEDICINE_NOT_FOUND', "Medicine '99' was not found.", undefined],
    [400, 'MULTI_MEDICINE_SCENARIO_UNSUPPORTED', 'One medicine per scenario.', { medicineIds: ['7', '8'] }]
  ];
  for (const [status, code, message, details] of decisions) {
    const api = await startApi(t, { handler: () => ({ status, body: { error: { code, message, ...(details ? { details } : {}) } } }) });
    const result = await api.call('/scenarios/simulate', SIMULATION);
    assert.equal(result.status, status);
    assert.deepEqual(result.body.error, { code, message, ...(details ? { details } : {}) });
  }
  // Transfer-level rejections (route limit, cold chain) are ordinary 200 simulations that stay unsafe.
  const api = await startApi(t, {
    handler: ({ body }) => {
      const response = simulationResponse(body);
      Object.assign(response.transferEvaluations[0], { eligible: false, rejectionCodes: ['TRAVEL_TIME_LIMIT_EXCEEDED', 'COLD_CHAIN_UNAVAILABLE'] });
      response.comparison.safeToRecommend = false;
      return { body: response };
    }
  });
  const unsafe = await api.call('/scenarios/simulate', SIMULATION);
  assert.deepEqual(unsafe.body.data.transferEvaluations[0].rejectionCodes, ['TRAVEL_TIME_LIMIT_EXCEEDED', 'COLD_CHAIN_UNAVAILABLE']);
});

test('persistent simulation 8: simulation never writes to the database', async (t) => {
  const api = await startApi(t);
  const before = api.store.snapshot();
  await api.call('/scenarios/simulate', SIMULATION);
  assert.deepEqual(api.store.snapshot(), before);
  assert.deepEqual(api.store.events, []);
});

test('persistent simulation 9: optimization keeps the service plan exactly and fails closed', async (t) => {
  const api = await startApi(t);
  const result = await api.call('/plans/optimize', OPTIMIZATION);
  assert.equal(result.status, 200);
  const expected = planResponse();
  const plan = result.body.data;
  assert.deepEqual([plan.id, plan.status, plan.source, result.body.meta.fallback], [VELLORE_PLAN_ID, 'PROPOSED', 'INTELLIGENCE_SERVICE', false]);
  for (const field of ['transfers', 'candidates', 'validation', 'dataContext', 'modelVersion', 'simulation', 'equityGuardrail', 'requiresHumanApproval']) {
    assert.deepEqual(plan[field], expected[field], field);
  }
  assert.equal(api.store.state.plans.get(VELLORE_PLAN_ID).modelVersion, 'aiml-transfer-optimizer-v2');

  const noSafePlan = { requestedQuantity: 1300, safeCapacity: 1236.9, unmetQuantity: 63.1, recommendedEscalation: ['Escalate.'] };
  const outcomes = [
    [{ serviceUrl: await unusedPortUrl() }, 503, 'INTELLIGENCE_UNAVAILABLE'],
    [{ handler: () => 'HANG', timeoutMs: 200 }, 503, 'INTELLIGENCE_TIMEOUT'],
    [{ handler: () => ({ status: 502, body: 'bad gateway' }) }, 503, 'INTELLIGENCE_UNAVAILABLE'],
    [{ handler: () => ({ status: 422, body: { error: { code: 'NO_SAFE_PLAN', message: 'No safe plan.', details: noSafePlan } } }) }, 422, 'NO_SAFE_PLAN'],
    [{ handler: () => ({ status: 422, body: { error: { code: 'INVALID_QUANTITY_FOR_UNIT', message: 'Whole units only.' } } }) }, 422, 'INVALID_QUANTITY_FOR_UNIT']
  ];
  const invalidPlans = [
    (plan) => { plan.simulation.comparison.safeToRecommend = false; },
    (plan) => { plan.simulation.receivedStockCheck.passed = false; },
    (plan) => { plan.id = ''; },
    (plan) => { plan.status = 'RESERVED'; },
    (plan) => { plan.transfers[0].batchId = null; },
    (plan) => { plan.transfers[0].quantity = 0; },
    (plan) => { plan.transfers = []; },
    (plan) => { plan.requiresHumanApproval = false; },
    (plan) => { plan.validation.passed = false; },
    (plan) => { plan.horizonDays = 30; },
    (plan) => { plan.destinationFacilityId = 'PHC-KRR-001'; },
    (plan) => { plan.medicine.id = '8'; },
    (plan) => { plan.requestedQuantity = 250; }
  ];
  for (const change of invalidPlans) {
    outcomes.push([{ handler: () => { const plan = planResponse(); change(plan); return { body: plan }; } }, 503, 'INVALID_INTELLIGENCE_RESPONSE']);
  }
  for (const [options, status, code] of outcomes) {
    const outage = await startApi(t, options);
    const refused = await outage.call('/plans/optimize', OPTIMIZATION);
    assert.deepEqual([refused.status, refused.body.error.code], [status, code], JSON.stringify(refused.body));
    assert.equal(outage.store.state.plans.size, 0, `${code}: nothing persisted`);
    if (code === 'NO_SAFE_PLAN') assert.deepEqual(refused.body.error.details, noSafePlan);
  }
});

test('the documented insulin alias may resolve to the database medicine', async (t) => {
  const api = await startApi(t);
  const result = await api.call('/plans/optimize', { ...OPTIMIZATION, medicineId: 'med-insulin-100iu-vial' });
  assert.equal(result.status, 200);
  assert.equal(result.body.data.medicine.id, '7');
});

test('the database forecast stays a labelled fallback when the service is unavailable', async (t) => {
  for (const [options, reason] of [[{ serviceUrl: await unusedPortUrl() }, 'INTELLIGENCE_UNAVAILABLE'], [{ handler: () => 'HANG', timeoutMs: 200 }, 'INTELLIGENCE_TIMEOUT']]) {
    const api = await startApi(t, options);
    const result = await api.call('/forecast', { facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });
    assert.equal(result.status, 200);
    assert.deepEqual([result.body.data.source, result.body.data.isFallback, result.body.data.fallbackReason], ['DATABASE_FALLBACK', true, reason]);
    assert.deepEqual([result.body.meta.source, result.body.meta.fallback], ['DATABASE_FALLBACK', true]);
  }
  const notFound = await startApi(t, { handler: () => ({ status: 422, body: { error: { code: 'NO_CONSUMPTION_HISTORY', message: 'No history.' } } }) });
  const passed = await notFound.call('/forecast', { facilityId: 'WH-TN-001', medicineId: '7', horizonDays: 14 });
  assert.deepEqual([passed.status, passed.body.error.code], [422, 'NO_CONSUMPTION_HISTORY']);
});
