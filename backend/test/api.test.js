const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { createApp } = require('../src/app');
const { resetFixtureState } = require('../src/fixture-store');
const { resetFixtureAuthState } = require('../src/auth-store');

let server;
let baseUrl;

before(async () => {
  const app = createApp({ environment: 'test', dataSource: 'fixture', corsOrigins: [], intelligenceServiceUrl: '', intelligenceTimeoutMs: 50 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

let approverHeaders;

beforeEach(async () => {
  resetFixtureState();
  resetFixtureAuthState();
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'demo.approver@medripple.demo', password: 'MedrippleDemo!2026' })
  });
  assert.equal(login.response.status, 200);
  approverHeaders = { authorization: `Bearer ${login.body.data.token}` };
});
after(() => server.close());

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body: await response.json() };
}

test('health endpoint identifies the running backend', async () => {
  const { response, body } = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(body.data.status, 'ok');
  assert.equal(body.data.dataSource, 'FIXTURE_STORE');
});

test('the region summary reports simulated coverage risk without a patient-impact metric', async () => {
  const { response, body } = await request('/api/region/summary', { headers: approverHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(body.data).sort(), ['alerts', 'criticalFacilityCount', 'dataFreshness', 'earliestStockout', 'resilienceScore']);
  assert.doesNotMatch(JSON.stringify(body), /patient/i);
});

test('inventory excludes expired stock from effective stock', async () => {
  const { response, body } = await request('/api/facilities/facility-navjeevan-phc/inventory', { headers: approverHeaders });
  assert.equal(response.status, 200);
  assert.equal(body.data.recordedStock, 27);
  assert.equal(body.data.effectiveStock, 22);
  assert.equal(body.data.excludedStock, 5);
});

test('fixture forecast is explicitly labelled as a fallback', async () => {
  const { response, body } = await request('/api/forecast', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({ facilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', horizonDays: 14 })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.source, 'FIXTURE_FALLBACK');
  assert.equal(body.data.risk.label, 'CRITICAL');
});

test('simulator rejects a transfer that drains a donor below protected safety stock', async () => {
  const { response, body } = await request('/api/scenarios/simulate', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({
      horizonDays: 14,
      transfers: [{ fromFacilityId: 'facility-district-hospital', toFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, arrivalDay: 1 }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.transferEvaluations[0].eligible, false);
  assert.match(body.data.transferEvaluations[0].rejectionReasons[0], /protected safety stock/);
  // The local rules are a labelled development fallback, not the intelligence service.
  assert.deepEqual([body.data.source, body.data.isFallback, body.data.fallbackReason], ['FIXTURE_FALLBACK', true, 'INTELLIGENCE_UNAVAILABLE']);
  assert.deepEqual([body.meta.source, body.meta.fallback], ['FIXTURE_FALLBACK', true]);
  assert.doesNotMatch(JSON.stringify(body.data), /patient/i);
});

test('safe plan can be approved and creates an audit record', async () => {
  const planResponse = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({ destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14 })
  });
  assert.equal(planResponse.response.status, 200);
  assert.equal(planResponse.body.data.simulation.comparison.safeToRecommend, true);
  assert.deepEqual([planResponse.body.data.source, planResponse.body.data.isFallback, planResponse.body.meta.fallback], ['FIXTURE_FALLBACK', true, true]);
  assert.equal(planResponse.body.data.simulation.source, 'FIXTURE_FALLBACK');

  const approval = await request(`/api/plans/${planResponse.body.data.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({ decision: 'APPROVE', note: 'Reviewed simulated protected-stock impact.' })
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.data.plan.status, 'APPROVED');
  assert.equal(approval.body.data.audit.action, 'PLAN_APPROVED');
  assert.equal(approval.body.data.persistence.storage, 'MEMORY');
  // A fixture approval reserves nothing and says it is not a production safety check.
  assert.deepEqual([approval.body.data.revalidation.performed, approval.body.data.revalidation.reason], [false, 'FIXTURE_MODE']);
  assert.equal(approval.body.data.audit.afterState.revalidation.reason, 'FIXTURE_MODE');

  const audit = await request('/api/audit', { headers: approverHeaders });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.data.length, 1);
  assert.equal(audit.body.data[0].action, 'PLAN_APPROVED');
});

test('identical fixture optimization requests use one deterministic plan identifier', async () => {
  const requestBody = JSON.stringify({
    destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14
  });
  const first = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders }, body: requestBody
  });
  const second = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders }, body: requestBody
  });
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.match(first.body.data.id, /^plan-[a-f0-9]{32}$/);
  assert.equal(second.body.data.id, first.body.data.id);
});

test('a fixture plan cannot be approved twice', async () => {
  const planned = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({ destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 44, horizonDays: 14 })
  });
  const options = {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders },
    body: JSON.stringify({ decision: 'APPROVE', note: 'First authorised decision.' })
  };
  const first = await request(`/api/plans/${planned.body.data.id}/approve`, options);
  const repeated = await request(`/api/plans/${planned.body.data.id}/approve`, options);
  assert.equal(first.response.status, 200);
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'PLAN_ALREADY_DECIDED');
});

test('invalid requests use the documented error envelope', async () => {
  const { response, body } = await request('/api/forecast', {
    method: 'POST', headers: { 'content-type': 'application/json', ...approverHeaders }, body: JSON.stringify({})
  });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.ok(body.meta.requestId);
});

test('registration signs in an operator but does not grant approval authority', async () => {
  const registered = await request('/api/auth/signup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Sahil Test', email: 'sahil.test@example.com', password: 'StrongPass2026' })
  });
  assert.equal(registered.response.status, 200);
  assert.equal(registered.body.data.user.role, 'OPERATOR');

  const planResponse = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registered.body.data.token}` },
    body: JSON.stringify({ destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14 })
  });
  const denied = await request(`/api/plans/${planResponse.body.data.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${registered.body.data.token}` },
    body: JSON.stringify({ decision: 'APPROVE', note: 'Trying to approve.' })
  });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.body.error.code, 'INSUFFICIENT_ROLE');
});
