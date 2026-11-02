import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { KARUR_PLAN_ID, apiError, facilities, karurPlan, karurRequest, medicines, noSafePlanError } from './support/apiFixtures.js';
import { closeRenderer, load, memoryStorage, render, textOf } from './support/render.js';
import { setupWorkspace } from './support/workspace.js';

after(closeRenderer);

const selection = { facilityId: 'PHC-KRR-001', medicineId: '7', quantity: '800', horizonDays: 14 };

async function simulatorText(assessment, error = null) {
  const { catalogFromEnvelopes } = await load('/src/services/viewModels.js');
  const catalog = catalogFromEnvelopes({ ...facilities, data: [...facilities.data, { facilityId: 'PHC-KRR-001', name: 'Karur Primary Health Centre', type: 'PHC', medicineId: '7' }] }, medicines);
  return textOf(await render('/src/pages/RippleSimulator.jsx', 'RippleSimulator', { catalog, selection, onSelection() {}, onRun() {}, busy: false, assessment, error, onReview() {} }));
}

test('an assessment submits the exact selection to POST /api/plans/optimize and shows the safe plan', async () => {
  const { workspace, fake } = await setupWorkspace();
  const assessment = await workspace.runAssessment(selection, 'mL');
  assert.deepEqual(fake.calls.map((call) => [call.method, call.path, call.body]), [['POST', '/plans/optimize', karurRequest]]);
  assert.deepEqual([assessment.kind, assessment.plan.data.id, assessment.plan.meta.source], ['PLAN', KARUR_PLAN_ID, 'INTELLIGENCE_SERVICE']);
  const text = await simulatorText(assessment);
  for (const expected of [
    `proposed plan ${KARUR_PLAN_ID}`, '800 mL of Human Insulin 100.000 IU/mL for Karur Primary Health Centre over 14 days', 'PROPOSED HUMAN APPROVAL REQUIRED',
    'assessment Intelligence service decision support only request req-optimize', '2 transfer(s) from 2 donor(s)',
    'Coimbatore District Hospital DH-CBE-001 → PHC-KRR-001 TN-007-B01-26 batch ID 14 · expires 2028-02-29 167.59 mL depart day 1 arrive day 1 · 2026-09-12 3.1 h 122.5 km available',
    'Madurai District Hospital DH-MDU-001 → PHC-KRR-001 TN-007-B01-26 batch ID 14 · expires 2028-02-29 632.41 mL',
    'SAFE TO RECOMMEND', 'recipient stockout day 2 → none', 'unmet demand 268.24 mL → 0 mL', 'new shortages created none',
    'Karur Primary Health Centre PHC-KRR-001 RECIPIENT CRITICAL · 88 1 days of cover · stockout day 2 MEDIUM · 41 21.8 days of cover',
    'PASSED ROUTES_WITHIN_TRAVEL_LIMIT', 'PASSED DONORS_SAFE_WITHOUT_FUTURE_SUPPLY', 'donor safety on stock already received PASSED',
    'DH-CBE-001 sends 167.59 mL · retained floor 1,130.82 mL · lowest projected 1,567.72 mL on day 14 · future supply excluded 2,998.36 mL',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /Tamil Nadu Central Warehouse NOT_IN_TRANSFER/, 'only facilities in the transfer are compared');
  const { RiskChanges } = await load('/src/components/Evidence.jsx');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { createElement } = await import('react');
  const unrated = textOf(renderToStaticMarkup(createElement(RiskChanges, { rows: [{ facilityId: 'WH-TN-001', facilityName: 'Warehouse', role: 'DONOR', before: { riskLabel: 'NOT RATED', daysRemaining: null }, after: { riskLabel: 'NOT RATED', daysRemaining: null } }] })));
  assert.equal(unrated, 'facility role before after Warehouse WH-TN-001 DONOR NOT RATED cover not projected NOT RATED cover not projected');
  assert.doesNotMatch(text, /patient/i);
});

test('NO_SAFE_PLAN shows capacity, unmet quantity, candidates, reasons and escalation steps', async () => {
  const { workspace } = await setupWorkspace({ 'POST /plans/optimize': () => { throw noSafePlanError; } });
  const assessment = await workspace.runAssessment({ ...selection, quantity: '1300' }, 'mL');
  const text = await simulatorText(assessment);
  for (const expected of [
    'No safe plan for 1,300 mL of Human Insulin 100.000 IU/mL for Karur Primary Health Centre over 14 days',
    'No safe regional redistribution plan can satisfy the requested quantity. No transfer was proposed and no stock moved. Request req-no-safe-plan.',
    'requested quantity 1,300 mL', 'safe donor capacity 1,236.9 mL solver: INFEASIBLE', 'unmet quantity 63.1 mL',
    'escalation steps A smaller request of up to 1236.9 mL can be planned', 'WH-TN-001 is beyond the 6-hour route limit',
    'eligible and rejected donors', 'TRAVEL_TIME_LIMIT_EXCEEDED', 'COLD_CHAIN_UNAVAILABLE Human Insulin requires a cold chain', 'NO_SAFE_DONOR_CAPACITY Salem',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /proposed plan|review this plan/);
});

test('a new assessment clears the older plan, whether it is unsafe or fails', async () => {
  const storage = memoryStorage();
  let optimize = () => { throw noSafePlanError; };
  const { workspace } = await setupWorkspace({ 'POST /plans/optimize': () => optimize() }, storage);
  optimize = () => karurPlan();
  await workspace.runAssessment(selection, 'mL');
  assert.equal((await workspace.loadAssessment()).kind, 'PLAN');

  optimize = () => { throw noSafePlanError; };
  await workspace.runAssessment({ ...selection, quantity: '1300' }, 'mL');
  const unsafe = await workspace.loadAssessment();
  assert.equal(unsafe.kind, 'NO_SAFE_PLAN');

  optimize = () => karurPlan();
  await workspace.runAssessment(selection, 'mL');
  for (const code of ['INTELLIGENCE_UNAVAILABLE', 'INTELLIGENCE_TIMEOUT', 'INVALID_INTELLIGENCE_RESPONSE']) {
    optimize = () => { throw apiError(503, code, `${code} message`); };
    await assert.rejects(workspace.runAssessment(selection, 'mL'), { code });
    assert.equal(await workspace.loadAssessment(), null, `${code} leaves no plan selected`);
  }
  const text = await simulatorText(null, apiError(503, 'INTELLIGENCE_TIMEOUT', 'The intelligence service did not complete the optimization within 2500 ms.', { timeoutMs: 2500 }, 'req-timeout'));
  assert.match(text, /INTELLIGENCE_TIMEOUT · HTTP 503 Intelligence service timed out/);
  assert.match(text, /Nothing was saved or reserved/);
  assert.match(text, /request req-timeout/);
  assert.match(text, /No plan is selected: a failed assessment never leaves an earlier plan open for approval/);
});

test('an invalid quantity is refused before any request is sent', async () => {
  const { workspace, fake } = await setupWorkspace();
  await assert.rejects(workspace.runAssessment({ ...selection, quantity: '800.125' }, 'mL'), { code: 'INVALID_QUANTITY_INPUT' });
  await assert.rejects(workspace.runAssessment({ ...selection, medicineId: '10', quantity: '2.5' }, 'count'), { code: 'INVALID_QUANTITY_INPUT' });
  assert.equal(fake.calls.length, 0);
});

test('a refresh keeps the selected plan and re-reads it by ID without optimizing', async () => {
  const storage = memoryStorage();
  const first = await setupWorkspace({}, storage);
  await first.workspace.runAssessment(selection, 'mL');
  const refreshed = await setupWorkspace({}, storage);
  const review = await refreshed.workspace.loadPlanReview();
  assert.equal(review.assessment.kind, 'PLAN');
  assert.equal(review.assessment.plan.data.id, KARUR_PLAN_ID);
  assert.deepEqual(review.assessment.request, karurRequest);
  assert.deepEqual(refreshed.fake.calls.map((call) => `${call.method} ${call.path}`), [`GET /plans/${KARUR_PLAN_ID}`]);
  assert.equal(refreshed.fake.count('POST', '/plans/optimize'), 0);
});

test('opening plan review never calls the optimizer, with or without a selection', async () => {
  const empty = await setupWorkspace();
  assert.deepEqual(await empty.workspace.loadPlanReview(), { assessment: null, decisionEvent: null });
  assert.equal(empty.fake.calls.length, 0);

  const storage = memoryStorage();
  const withPlan = await setupWorkspace({}, storage);
  await withPlan.workspace.runAssessment(selection, 'mL');
  const before = withPlan.fake.count('POST', '/plans/optimize');
  await withPlan.workspace.loadPlanReview();
  await withPlan.workspace.loadPlanReview();
  assert.equal(withPlan.fake.count('POST', '/plans/optimize'), before);

  // A plan that no longer exists clears the selection instead of creating a new one.
  const gone = await setupWorkspace({ [`GET /plans/${KARUR_PLAN_ID}`]: () => { throw apiError(404, 'PLAN_NOT_FOUND', 'Gone.'); } }, storage);
  assert.deepEqual((await gone.workspace.loadPlanReview()).assessment, { kind: 'MISSING' });
  assert.equal(gone.fake.count('POST', '/plans/optimize'), 0);
  assert.equal(gone.workspace.hasAssessment(), false);

  // The App's plan screen loads through loadPlanReview only.
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(app, /view === 'plan' \? \(\) => workspace\.loadPlanReview\(\)/);
  assert.doesNotMatch(app, /\.optimize\(|plans\/optimize/);
});
