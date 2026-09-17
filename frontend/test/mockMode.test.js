import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeRenderer, load, memoryStorage, render, sourceFiles, textOf } from './support/render.js';

after(closeRenderer);

async function mockWorkspace(email = 'mock.approver@medripple.demo') {
  const { createMockTransport } = await load('/src/services/mockTransport.js');
  const { createMedrippleClient, createTokenStore } = await load('/src/services/medrippleClient.js');
  const { createWorkspace } = await load('/src/services/workspace.js');
  const api = createMedrippleClient(createMockTransport(), createTokenStore(memoryStorage()));
  const session = await api.login({ email, password: 'any' });
  return { api, session, workspace: createWorkspace({ api, storage: memoryStorage() }) };
}

test('mock mode follows the API contract and labels every response MOCK DATA', async () => {
  const { api, session, workspace } = await mockWorkspace();
  assert.equal(session.user.role, 'APPROVER');
  const { dashboard, catalog } = await workspace.loadDashboard();
  assert.equal(dashboard.meta.source, 'MOCK_DATA');
  assert.equal(dashboard.facilitiesMonitored, 3);
  assert.deepEqual(catalog.medicines.map((medicine) => medicine.unit), ['mL', 'count']);
  for (const envelope of [await api.regionSummary(), await api.facilities(), await api.medicines(), await api.audit()]) {
    assert.deepEqual(Object.keys(envelope).sort(), ['data', 'meta']);
    assert.equal(envelope.meta.source, 'MOCK_DATA');
    assert.match(envelope.meta.requestId, /^mock-/);
  }
  const text = textOf(await render('/src/pages/Dashboard.jsx', 'Dashboard', { data: dashboard, onOpenFacility() {} }));
  assert.match(text, /dashboard data MOCK DATA/);
  assert.match(text, /mock data/i);

  const detail = await workspace.loadFacility({ facilityId: 'MOCK-PHC-001', medicineId: 'MOCK-MED-1', horizonDays: 14 });
  assert.equal(detail.forecastMeta.source, 'MOCK_DATA');
  const other = await workspace.loadFacility({ facilityId: 'MOCK-WH-001', medicineId: 'MOCK-MED-1', horizonDays: 14 });
  assert.equal(other.forecastError.code, 'NO_CONSUMPTION_HISTORY');

  const plan = await workspace.runAssessment({ facilityId: 'MOCK-PHC-001', medicineId: 'MOCK-MED-1', quantity: '250', horizonDays: 14 }, 'mL');
  assert.equal(plan.kind, 'PLAN');
  assert.equal(plan.plan.data.requiresHumanApproval, true);
  const other2 = await workspace.runAssessment({ facilityId: 'MOCK-PHC-001', medicineId: 'MOCK-MED-1', quantity: '251', horizonDays: 14 }, 'mL');
  assert.equal(other2.kind, 'NO_SAFE_PLAN');
  assert.match(other2.message, /^MOCK DATA:/);
  assert.equal(other2.details.requestedQuantity, 251);

  await workspace.runAssessment({ facilityId: 'MOCK-PHC-001', medicineId: 'MOCK-MED-1', quantity: '250', horizonDays: 14 }, 'mL');
  const approved = await workspace.decide(plan.plan.data.id, 'APPROVE', 'Mock review.');
  assert.deepEqual([approved.ok, approved.plan.data.status, approved.response.data.revalidation.performed], [true, 'RESERVED', true]);
  assert.equal((await workspace.decide(plan.plan.data.id, 'APPROVE', 'Again.')).error.code, 'PLAN_ALREADY_DECIDED');
  assert.deepEqual((await workspace.loadAudit()).rows.map((row) => row.action), ['RESERVE']);
});

test('mock operators cannot approve, and mock mode is never mixed with live data', async () => {
  const { session, workspace } = await mockWorkspace('someone@example.org');
  assert.equal(session.user.role, 'OPERATOR');
  const plan = await workspace.runAssessment({ facilityId: 'MOCK-PHC-001', medicineId: 'MOCK-MED-1', quantity: '250', horizonDays: 14 }, 'mL');
  const refused = await workspace.decide(plan.plan.data.id, 'APPROVE', 'Operator attempt.');
  assert.deepEqual([refused.ok, refused.error.code, refused.plan.data.status], [false, 'INSUFFICIENT_ROLE', 'PROPOSED']);

  const api = sourceFiles().find((file) => file.path.endsWith('medrippleApi.js')).text;
  assert.match(api, /const request = usingMockData\s*\? createMockTransport\(\)\s*: createApiClient/);
  const app = sourceFiles().find((file) => file.path.endsWith('App.jsx')).text;
  assert.match(app, /usingMockData && <span className="top-pill mock-pill">MOCK DATA<\/span>/);
  assert.match(app, /MOCK DATA: this workspace is not connected to the MEDRIPPLE API/);
});
