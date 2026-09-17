// Fixture mode: the intelligence service is used when it answers; only an outage falls back to the local rules, and
// that fallback is labelled. These are development checks, not evidence of production safety.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createApp } = require('../src/app');
const { resetFixtureState } = require('../src/fixture-store');
const { simulationResponse, startFakeIntelligence } = require('./support/intelligence-fixtures');

const SIMULATION = {
  horizonDays: 14,
  transfers: [{ fromFacilityId: 'facility-central-store', toFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, arrivalDay: 1 }]
};

async function startFixtureApi(t, handler, timeoutMs = 200) {
  resetFixtureState();
  const service = await startFakeIntelligence(t, handler);
  const app = createApp({ environment: 'test', dataSource: 'fixture', databaseUrl: '', corsOrigins: [], intelligenceServiceUrl: service.url, intelligenceTimeoutMs: timeoutMs });
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
  return { service, call: (path, body) => post(path, body, token) };
}

test('fixture simulation uses a healthy intelligence service', async (t) => {
  const api = await startFixtureApi(t, ({ body }) => ({ body: { ...simulationResponse(body), scenarioType: 'SIMULATED_FIXTURE' } }));
  const result = await api.call('/scenarios/simulate', SIMULATION);
  assert.equal(result.status, 200);
  assert.deepEqual([result.body.data.source, result.body.data.isFallback, result.body.meta.fallback], ['INTELLIGENCE_SERVICE', undefined, false]);
});

test('fixture simulation and optimization fall back, labelled, only when the service is down', async (t) => {
  const api = await startFixtureApi(t, () => 'HANG');
  const simulation = await api.call('/scenarios/simulate', SIMULATION);
  assert.equal(simulation.status, 200);
  assert.deepEqual([simulation.body.data.source, simulation.body.data.isFallback, simulation.body.data.fallbackReason], ['FIXTURE_FALLBACK', true, 'INTELLIGENCE_TIMEOUT']);
  const plan = await api.call('/plans/optimize', { destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14 });
  assert.equal(plan.status, 200);
  assert.deepEqual([plan.body.data.source, plan.body.data.fallbackReason, plan.body.meta.fallback], ['FIXTURE_FALLBACK', 'INTELLIGENCE_TIMEOUT', true]);
  const approval = await api.call(`/plans/${plan.body.data.id}/approve`, { decision: 'APPROVE', note: 'Fixture approval.' });
  assert.deepEqual([approval.body.data.plan.status, approval.body.data.revalidation.performed], ['APPROVED', false]);
});

test('fixture mode never hides a deliberate service decision behind the fallback', async (t) => {
  const api = await startFixtureApi(t, () => ({ status: 422, body: { error: { code: 'NO_SAFE_PLAN', message: 'No safe plan.', details: { safeCapacity: 0 } } } }));
  const plan = await api.call('/plans/optimize', { destinationFacilityId: 'facility-navjeevan-phc', medicineId: 'med-insulin-100iu-vial', quantity: 45, horizonDays: 14 });
  assert.deepEqual([plan.status, plan.body.error.code, plan.body.error.details], [422, 'NO_SAFE_PLAN', { safeCapacity: 0 }]);
});
