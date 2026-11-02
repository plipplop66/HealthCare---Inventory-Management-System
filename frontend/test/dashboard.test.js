import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { facilities, medicines, summary } from './support/apiFixtures.js';
import { closeRenderer, frontendRoot, load, render, sourceFiles, textOf } from './support/render.js';

after(closeRenderer);

async function dashboardText() {
  const { mapDashboard } = await load('/src/services/viewModels.js');
  const data = mapDashboard(summary, facilities, medicines);
  return { data, text: textOf(await render('/src/pages/Dashboard.jsx', 'Dashboard', { data, onOpenFacility() {} })) };
}

test('risk labels are shown exactly as the API returns them', async () => {
  const { data, text } = await dashboardText();
  assert.deepEqual(data.rows.map((row) => row.riskLabel), ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  for (const label of ['LOW · 0', 'MEDIUM · 43', 'HIGH · 72', 'CRITICAL · 92']) assert.ok(text.includes(label), label);
  assert.doesNotMatch(text, /\bhealthy\b|\bwatch\b/i);
  const { riskText, riskTone } = await load('/src/services/viewModels.js');
  assert.equal(riskText('SEVERE'), 'UNAVAILABLE');
  assert.equal(riskText(null), 'NOT RATED');
  assert.equal(riskTone('LOW'), 'low');
});

test('the dashboard reports facilities monitored and never patient-days', async () => {
  const { data, text } = await dashboardText();
  assert.equal(data.facilitiesMonitored, 4);
  assert.equal('patientDaysAtRisk' in data, false);
  assert.match(text, /facilities monitored 4 facilities reported by the API/);
  assert.match(text, /resilience score 67 \/ 100/);
  assert.match(text, /earliest stockout 0\.9 days Vellore Primary Health Centre/);
  assert.match(text, /critical count 1 of 4 facilities/);
  assert.match(text, /Vellore Primary Health Centre 0\.9 days of cover · Low simulated coverage CRITICAL/);
  assert.match(text, /Tamil Nadu Central Warehouse WH-TN-001 · Warehouse Human Insulin · 100\.000 IU\/mL · Vial 1,01,940 mL cover not projected LOW · 0/);
  assert.doesNotMatch(text, /patient/i);
  for (const file of sourceFiles()) {
    assert.doesNotMatch(file.text, /patient[- ]?days|patientDays|patient impact/i, file.path);
  }
});

test('no IoT, sensor or hardware claims remain in the interface', async () => {
  const files = [...sourceFiles(), { path: 'index.html', text: readFileSync(path.join(frontendRoot, 'index.html'), 'utf8') }];
  for (const file of files) {
    assert.doesNotMatch(file.text, /\biot\b|sensor|hardware|gateway|weather/i, file.path);
  }
});

test('no facility, medicine, quantity or count is hard-coded in the live screens', () => {
  const live = sourceFiles().filter((file) => !file.path.includes(`${path.sep}data${path.sep}`) && !file.path.endsWith('mockTransport.js'));
  for (const file of live) {
    assert.doesNotMatch(file.text, /PHC-|WH-TN|facility-navjeevan|facility-central|Chennai|Navjeevan|med-insulin|requestedQuantity = \d|quantity: \d/, file.path);
  }
});
