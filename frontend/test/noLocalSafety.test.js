import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { apiError, forecast, inventory } from './support/apiFixtures.js';
import { closeRenderer, load, render, sourceFiles, textOf } from './support/render.js';
import { setupWorkspace } from './support/workspace.js';

after(closeRenderer);

test('the browser never calls the intelligence service or the simulator directly', () => {
  for (const file of sourceFiles()) {
    assert.doesNotMatch(file.text, /:8000|intelligence-service|scenarios\/simulate|INTELLIGENCE_SERVICE_URL/, file.path);
  }
});

test('no forecast, projection or donor-safety arithmetic exists in the browser code', () => {
  for (const file of sourceFiles()) {
    assert.doesNotMatch(file.text, /createStockSeries|safeSurplus|dailyDemand\s*\*|effectiveStock\s*-|protectedStock\s*[-*]|remaining\s*:\s*Math/, file.path);
  }
  // Only the assessment action reaches the optimizer.
  const optimizeCallers = sourceFiles().filter((file) => /\.optimize\(/.test(file.text)).map((file) => file.path.replace(/\\/g, '/').replace(/.*\/src\//, 'src/'));
  assert.deepEqual(optimizeCallers, ['src/services/workspace.js']);
});

test('facility detail reads inventory and forecast only, and plots only the API projection', async () => {
  const { workspace, fake } = await setupWorkspace();
  await workspace.loadDashboard();
  const detail = await workspace.loadFacility({ facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });
  assert.deepEqual(fake.calls.slice(3).map((call) => `${call.method} ${call.path}`), ['GET /facilities/PHC-VLR-001/inventory?medicineId=7', 'POST /forecast']);
  assert.deepEqual(fake.calls[4].body, { facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });
  assert.deepEqual(detail.projection.map((day) => day.closingStock), forecast.data.projection.map((day) => day.closingStock));
  assert.deepEqual([detail.stock.recorded, detail.stock.effective, detail.stock.protected], [34, 34, 548.8]);
  const html = await render('/src/pages/FacilityDetail.jsx', 'FacilityDetail', { data: detail, onAssess() {} });
  const text = textOf(html);
  for (const expected of ['Human Insulin · 100.000 IU/mL · Vial', 'medicine ID 7 · unit mL', 'recorded stock 34 mL', 'effective stock 34 mL', 'protected stock 548.8 mL',
    'TN-007-B01-26 batch ID 14 12 mL 2028-02-29 AVAILABLE', 'daily demand 38.88 mL/day', 'days of cover 0.9 days', 'projected stockout day 1 · 2026-09-12',
    'next replenishment 1,372 mL · DELAYED · 2026-09-19 · After stockout', 'primary cause Supply delay', 'forecast confidence HIGH', 'model and source aiml-step1-wma-v1']) {
    assert.ok(text.includes(expected), expected);
  }
  assert.equal((html.match(/<polyline/g) || []).length, 1);
  assert.match(html, /points="0,92 [^"]*100,/);
});

test('a forecast that cannot be made is reported and nothing is projected in its place', async () => {
  const { workspace } = await setupWorkspace({
    'POST /forecast': () => { throw apiError(422, 'NO_CONSUMPTION_HISTORY', 'No consumption records exist for this warehouse.'); },
  });
  await workspace.loadDashboard();
  const detail = await workspace.loadFacility({ facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 7 });
  assert.equal(detail.forecast, null);
  assert.equal(detail.projection, null);
  const text = textOf(await render('/src/pages/FacilityDetail.jsx', 'FacilityDetail', { data: detail, onAssess() {} }));
  assert.match(text, /Forecast unavailable No consumption records exist for this warehouse\. \(NO_CONSUMPTION_HISTORY\)/);
  assert.match(text, /Projection unavailable/);
  assert.match(text, /daily demand Unavailable/);
  assert.match(text, /protected stock 548\.8 mL Database safety stock/, 'the database safety stock is still reported');
  assert.match(inventory.data.facility.name, /Vellore/);
});

test('a session that ends while loading is not treated as a missing forecast', async () => {
  const { workspace } = await setupWorkspace({ 'POST /forecast': () => { throw apiError(401, 'INVALID_SESSION', 'Expired.'); } });
  await assert.rejects(workspace.loadFacility({ facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 }), { status: 401 });
});
