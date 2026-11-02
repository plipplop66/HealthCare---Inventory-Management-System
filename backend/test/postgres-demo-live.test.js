// Opt-in, read-only checks of the final PostgreSQL demo dataset through the Node store.
// Skipped unless MEDRIPPLE_LIVE_POSTGRES=1. DATABASE_URL must name a LOCAL database built with
// database/schema-postgres.sql and database/seed-postgres.sql (or upgraded with migration 005).
// Set DATABASE_SSL=true (and NODE_EXTRA_CA_CERTS for a local test CA) to connect over TLS.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');
const { PostgresInventoryStore, postgresTypes } = require('../src/postgres-store');
const { postgresTls } = require('../src/postgres-tls');

const live = process.env.MEDRIPPLE_LIVE_POSTGRES === '1';
const databaseUrl = process.env.DATABASE_URL || '';
const INSULIN = 'med-insulin-100iu-vial';

function isLocal(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

test('the Node PostgreSQL store exposes the final demo dataset', { skip: live ? false : 'Set MEDRIPPLE_LIVE_POSTGRES=1 and a local DATABASE_URL.' }, async (t) => {
  assert.ok(isLocal(databaseUrl), 'The demo dataset test only runs against a local database.');
  const config = { databaseUrl, environment: 'development', databaseSsl: process.env.DATABASE_SSL === 'true', simulationDate: '2026-09-11' };
  // The same options the shared pool uses, but a private pool this test can close.
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresTls(config), types: postgresTypes, max: 2 });
  t.after(() => pool.end());
  const store = new PostgresInventoryStore(config, { pool });
  const rowCounts = async () => (await pool.query(
    `SELECT (SELECT COUNT(*) FROM inventory) AS inventory, (SELECT COALESCE(SUM(quantity_on_hand), 0) FROM inventory) AS stock,
            (SELECT COUNT(*) FROM plans) AS plans, (SELECT COUNT(*) FROM transfers) AS transfers,
            (SELECT COUNT(*) FROM audit_events) AS audits, (SELECT COUNT(*) FROM app_users) AS users`
  )).rows[0];
  const before = await rowCounts();
  const ids = Object.fromEntries((await pool.query('SELECT batch_number, batch_id FROM batches')).rows.map((row) => [row.batch_number, row.batch_id]));

  const insulin = await store.resolveMedicine(INSULIN);
  assert.equal(insulin.genericName, 'Human Insulin');
  assert.equal(insulin.unit, 'mL');
  assert.equal(insulin.requiresColdChain, true);

  const facilities = await store.listFacilities();
  const byCode = Object.fromEntries(facilities.map((row) => [row.facilityId, row]));
  for (const code of ['WH-TN-001', 'PHC-VLR-001', 'DH-CBE-001', 'DH-MDU-001', 'PHC-KRR-001', 'PHC-HSR-001', 'PHC-NAV-001']) {
    assert.ok(byCode[code], `${code} is listed`);
  }
  assert.deepEqual(
    [byCode['PHC-KRR-001'].type, byCode['PHC-KRR-001'].district, byCode['PHC-KRR-001'].remotenessScore, byCode['PHC-KRR-001'].medicine.unit],
    ['PHC', 'Karur', 3.6, 'mL']
  );
  assert.equal(byCode['PHC-KRR-001'].effectiveStock, 40);
  assert.equal(byCode['PHC-KRR-001'].protectedStock, 539.57);
  assert.equal(byCode['PHC-KRR-001'].incomingDate, '2026-09-20');
  assert.equal(byCode['PHC-VLR-001'].riskLabel, 'CRITICAL');
  assert.equal(byCode['WH-TN-001'].type, 'Warehouse');

  const karur = await store.getScenarioProfile('PHC-KRR-001', INSULIN);
  assert.deepEqual([karur.hasColdChain, karur.requiresColdChain, karur.incomingSupply, karur.incomingArrivalDay], [true, true, 1348.91, 9]);
  const thanjavur = await store.getScenarioProfile('PHC-TNJ-001', INSULIN);
  assert.equal(thanjavur.hasColdChain, false);

  const vellore = await store.getInventory('PHC-VLR-001', INSULIN);
  assert.deepEqual([vellore.recordedStock, vellore.effectiveStock, vellore.excludedStock], [34, 34, 0]);
  assert.deepEqual(vellore.batches.map((batch) => [batch.batchId, batch.batchNo, batch.expiryDate, batch.quantity, batch.status]), [
    [ids['TN-007-B01-26'], 'TN-007-B01-26', '2028-02-29', 12, 'AVAILABLE'],
    [ids['TN-007-B02-26'], 'TN-007-B02-26', '2028-04-24', 22, 'AVAILABLE']
  ]);
  assert.deepEqual(vellore.incomingReplenishment, { quantity: 1372, expectedArrivalDate: '2026-09-19', status: 'DELAYED' });

  const coimbatore = await store.getInventory('DH-CBE-001', INSULIN);
  assert.ok(coimbatore.batches.some((batch) => batch.batchNo === 'TN-007-B03-26' && batch.expiryDate === '2028-07-19' && batch.quantity === 800));
  const rabiesId = String((await pool.query("SELECT medicine_id FROM medicines WHERE generic_name = 'Rabies Vaccine'")).rows[0].medicine_id);
  const rabies = await store.getInventory('WH-TN-001', rabiesId);
  assert.deepEqual([rabies.recordedStock, rabies.effectiveStock, rabies.excludedStock], [110880, 55440, 55440]);
  assert.ok(rabies.batches.some((batch) => batch.status === 'QUARANTINED'));

  const boundary = await store.getRoute('WH-TN-001', 'PHC-HSR-001');
  assert.deepEqual([Number(boundary.distanceKm), Number(boundary.travelHours), boundary.coldChainAvailable], [267.75, 6, true]);
  assert.equal(Number((await store.getRoute('PHC-HSR-001', 'WH-TN-001')).travelHours), 5.88);
  assert.equal(Number((await store.getRoute('WH-TN-001', 'PHC-KRR-001')).travelHours), 7.73);
  assert.equal((await store.getRoute('PHC-TNJ-001', 'PHC-KRR-001')).coldChainAvailable, false);

  // FEFO: expiry date first, then batch ID.
  assert.deepEqual(await store.selectTransferBatch('DH-CBE-001', INSULIN, 14), { batchId: ids['TN-007-B01-26'], batchNo: 'TN-007-B01-26' });
  assert.deepEqual(await store.selectTransferBatch('WH-TN-001', INSULIN, 30), { batchId: ids['TN-007-B01-26'], batchNo: 'TN-007-B01-26' });

  assert.deepEqual(await rowCounts(), before);
});
