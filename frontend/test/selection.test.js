import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { facilities, medicines, summary } from './support/apiFixtures.js';
import { closeRenderer, load, memoryStorage, render, textOf } from './support/render.js';

after(closeRenderer);

test('count medicines take whole numbers; other units at most two decimals', async () => {
  const { validateQuantity } = await load('/src/services/selection.js');
  assert.deepEqual(validateQuantity('300', 'mL'), { ok: true, value: 300 });
  assert.deepEqual(validateQuantity('632.41', 'mL'), { ok: true, value: 632.41 });
  assert.equal(validateQuantity('632.415', 'mL').ok, false);
  assert.deepEqual(validateQuantity('1.5', 'mL'), { ok: true, value: 1.5 });
  assert.deepEqual(validateQuantity('12', 'count'), { ok: true, value: 12 });
  assert.match(validateQuantity('1.5', 'count').message, /whole number/);
  for (const bad of ['', '0', '0.00', '-5', 'abc', '1e3', '.5']) assert.equal(validateQuantity(bad, 'mg').ok, false, bad);
});

test('the selection uses API facility and medicine IDs and survives navigation and refresh', async () => {
  const { mapDashboard, catalogFromEnvelopes } = await load('/src/services/viewModels.js');
  const { completeSelection, createSelectionStore } = await load('/src/services/selection.js');
  const catalog = catalogFromEnvelopes(facilities, medicines);
  const dashboard = mapDashboard(summary, facilities, medicines);
  const storage = memoryStorage();
  const store = createSelectionStore(storage);
  const defaults = store.set(completeSelection(store.get(), catalog, dashboard));
  assert.deepEqual(defaults, { facilityId: 'PHC-VLR-001', medicineId: '7', quantity: '', horizonDays: 14 });
  store.set({ facilityId: 'DH-CBE-001', medicineId: '10', quantity: '4', horizonDays: 30 });
  assert.deepEqual(createSelectionStore(storage).get(), { facilityId: 'DH-CBE-001', medicineId: '10', quantity: '4', horizonDays: 30 });
  assert.equal(createSelectionStore(storage).set({ horizonDays: 21 }).horizonDays, 14, 'only 7, 14 or 30 days');
  // A stale facility or medicine is replaced from API data, never invented.
  assert.deepEqual(completeSelection({ facilityId: 'GONE', medicineId: 'GONE', quantity: '', horizonDays: 7 }, catalog, dashboard), { facilityId: 'PHC-VLR-001', medicineId: '7', quantity: '', horizonDays: 7 });
  assert.deepEqual(completeSelection({ facilityId: '', medicineId: '', quantity: '', horizonDays: 7 }, catalog, { earliestStockout: null }).facilityId, 'WH-TN-001');
});

test('the selection bar lists API facilities and medicines with units and flags invalid quantities', async () => {
  const { catalogFromEnvelopes } = await load('/src/services/viewModels.js');
  const catalog = catalogFromEnvelopes(facilities, medicines);
  const html = await render('/src/components/SelectionBar.jsx', 'SelectionBar', {
    catalog, selection: { facilityId: 'PHC-VLR-001', medicineId: '10', quantity: '2.5', horizonDays: 7 }, onChange() {}, onSubmit() {}, submitLabel: 'run safety assessment',
  });
  for (const facility of facilities.data) assert.match(html, new RegExp(`<option value="${facility.facilityId}"`));
  assert.match(html, /<option value="7">Human Insulin 100\.000 IU\/mL · mL<\/option>/);
  assert.match(html, /<option value="10" selected="">Adrenaline Auto-Injector 1\.000 mg · count<\/option>/);
  assert.match(textOf(html), /quantity \(count\)/);
  assert.match(html, /inputmode="numeric"/i);
  assert.match(textOf(html), /whole number/);
  assert.match(html, /aria-pressed="true"[^>]*>7 days/);
  assert.match(html, /<button type="submit"[^>]*disabled=""/);
  const valid = await render('/src/components/SelectionBar.jsx', 'SelectionBar', {
    catalog, selection: { facilityId: 'PHC-VLR-001', medicineId: '7', quantity: '300', horizonDays: 14 }, onChange() {}, onSubmit() {}, submitLabel: 'run safety assessment',
  });
  assert.doesNotMatch(valid, /<button type="submit"[^>]*disabled=""/);
  assert.match(valid, /inputmode="decimal"/i);
});
