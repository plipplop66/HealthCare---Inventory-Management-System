const assert = require('node:assert/strict');
const { after, before, beforeEach, test } = require('node:test');
const { createApp } = require('../src/app');
const { resetFixtureState } = require('../src/fixture-store');

let server;
let baseUrl;

before(async () => {
  const app = createApp({ environment: 'test', dataSource: 'fixture', corsOrigins: [], intelligenceServiceUrl: '', intelligenceTimeoutMs: 50 });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

beforeEach(() => resetFixtureState());
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

test('inventory excludes expired stock from effective stock', async () => {
  const { response, body } = await request('/api/facilities/facility-navjeevan-phc/inventory');
  assert.equal(response.status, 200);
  assert.equal(body.data.recordedStock, 27);
  assert.equal(body.data.effectiveStock, 22);
  assert.equal(body.data.excludedStock, 5);
});

test('fixture forecast is explicitly labelled as a fallback', async () => {
  const { response, body } = await request('/api/forecast', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ facilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', horizonDays: 14 })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.source, 'FIXTURE_FALLBACK');
  assert.equal(body.data.risk.label, 'CRITICAL');
});

test('simulator rejects a transfer that drains a donor below protected safety stock', async () => {
  const { response, body } = await request('/api/scenarios/simulate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      horizonDays: 14,
      transfers: [{ fromFacilityId: 'facility-district-hospital', toFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, arrivalDay: 1 }]
    })
  });
  assert.equal(response.status, 200);
  assert.equal(body.data.transferEvaluations[0].eligible, false);
  assert.match(body.data.transferEvaluations[0].rejectionReasons[0], /protected safety stock/);
});

test('safe plan can be approved and creates an audit record', async () => {
  const planResponse = await request('/api/plans/optimize', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14 })
  });
  assert.equal(planResponse.response.status, 200);
  assert.equal(planResponse.body.data.simulation.comparison.safeToRecommend, true);

  const approval = await request(`/api/plans/${planResponse.body.data.id}/approve`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: 'APPROVE', actor: 'demo-user', note: 'Reviewed simulated protected-stock impact.' })
  });
  assert.equal(approval.response.status, 200);
  assert.equal(approval.body.data.plan.status, 'APPROVED');
  assert.equal(approval.body.data.audit.action, 'PLAN_APPROVED');
  assert.equal(approval.body.data.persistence.storage, 'MEMORY');

  const audit = await request('/api/audit');
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.data.length, 1);
  assert.equal(audit.body.data[0].action, 'PLAN_APPROVED');
});

test('invalid requests use the documented error envelope', async () => {
  const { response, body } = await request('/api/forecast', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({})
  });
  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'INVALID_REQUEST');
  assert.ok(body.meta.requestId);
});
