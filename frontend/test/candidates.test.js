import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { KARUR_PLAN_ID, karurRequest, noSafePlanError } from './support/apiFixtures.js';
import { closeRenderer, load, render, textOf } from './support/render.js';
import { setupWorkspace } from './support/workspace.js';

after(closeRenderer);

const selection = { facilityId: 'PHC-KRR-001', medicineId: '7', quantity: '800', horizonDays: 14 };

async function candidatesText(assessment) {
  const { mapCandidates } = await load('/src/services/evidence.js');
  const data = mapCandidates(assessment);
  return { data, text: textOf(await render('/src/pages/Candidates.jsx', 'Candidates', { data, onOpenSimulator() {} })) };
}

test('without an assessment, the candidates page asks for a simulation and requests nothing', async () => {
  const { workspace, fake } = await setupWorkspace();
  assert.equal(await workspace.loadAssessment(), null);
  assert.equal(fake.calls.length, 0);
  const { text } = await candidatesText(null);
  assert.match(text, /No donor assessment yet Run the ripple simulator/);
});

test('candidates come from the optimizer plan with every code, reason and the excluded future supply', async () => {
  const { workspace, fake } = await setupWorkspace();
  const assessment = await workspace.runAssessment(selection, 'mL');
  const { data, text } = await candidatesText(assessment);
  assert.equal(fake.calls.filter((call) => call.path.includes('simulate')).length, 0, 'facilities are not simulated one by one');
  assert.deepEqual(data.rows.map((row) => [row.facilityId, row.status]), [
    ['DH-CBE-001', 'SELECTED'], ['DH-MDU-001', 'SELECTED'], ['CHC-SLM-001', 'REJECTED'], ['WH-TN-001', 'REJECTED'], ['PHC-TNJ-001', 'REJECTED'], ['PHC-NAV-001', 'REJECTED'],
  ]);
  assert.match(text, new RegExp(`plan ${KARUR_PLAN_ID}`));
  assert.match(text, /Donor capacity counts only stock already received \(Received stock only\)/);
  assert.match(text, /Routes may take at most 6 hours/);
  assert.match(text, /allocated quantity 800 mL/);
  assert.match(text, /2 eligible 4 rejected of 6 assessed/);
  // Selected donor: safe capacity, retained floor, route, cold chain and excluded future supply.
  assert.ok(text.includes('Coimbatore District Hospital DH-CBE-001 · DistrictHospital MEDIUM · 30 SELECTED'));
  assert.ok(text.includes('604.49 mL allocated 167.59 mL 1,130.82 mL protected 1,028.01 mL · effective 2,941.69 mL 3.1 h 122.5 km available on the planned route 2,998.36 mL scheduled or delayed stock not counted toward donor capacity'));
  // Rejections keep every code with its reason.
  assert.ok(text.includes('NO_SAFE_DONOR_CAPACITY Salem Community Health Centre must keep 886.72 mL'));
  assert.ok(text.includes('1,745.5 mL scheduled or delayed stock not counted toward donor capacity'));
  assert.ok(text.includes('TRAVEL_TIME_LIMIT_EXCEEDED Tamil Nadu Central Warehouse (WH-TN-001) takes 7.73 hours'));
  assert.ok(text.includes('7.73 h 301.2 km'));
  assert.ok(text.includes('COLD_CHAIN_UNAVAILABLE Human Insulin requires a cold chain') && text.includes('NO_SAFE_DONOR_CAPACITY Thanjavur has no safe surplus to send.'));
  assert.match(text, /Thanjavur[^]*? unavailable /);
  assert.ok(text.includes('ROUTE_NOT_FOUND No transport route exists') && text.includes('DONOR_AT_RISK Navjeevan PHC is already CRITICAL'));
  assert.match(text, /no route no route/);
  assert.doesNotMatch(text, /REJECTED\./, 'a rejected explanation does not repeat the listed reasons');
  assert.match(text, /SELECTED\. 604\.49 mL/, 'a selected donor keeps its explanation');
});

test('NO_SAFE_PLAN details supply the candidates, capacity and unmet quantity', async () => {
  const { workspace } = await setupWorkspace({ 'POST /plans/optimize': () => { throw noSafePlanError; } });
  const assessment = await workspace.runAssessment({ ...selection, quantity: '1300' }, 'mL');
  assert.equal(assessment.kind, 'NO_SAFE_PLAN');
  const { data, text } = await candidatesText(assessment);
  assert.deepEqual([data.requestedQuantity, data.safeCapacity, data.unmetQuantity], [1300, 1236.9, 63.1]);
  assert.match(text, /Donor candidates: no safe plan request 1,300 mL/);
  assert.match(text, /safe donor capacity 1,236\.9 mL unmet 63\.1 mL/);
  assert.match(text, /2 eligible 4 rejected of 6 assessed/);
  assert.match(text, /ELIGIBLE_NOT_SELECTED/);
  assert.match(text, /NO_SAFE_PLAN request req-no-safe-plan/);
  assert.ok(text.includes('TRAVEL_TIME_LIMIT_EXCEEDED'));
  assert.deepEqual(assessment.request, { ...karurRequest, quantity: 1300 });
});
