const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMysqlStore, isMysqlContentionError, orderTransfersForReservation, project } = require('../src/mysql-store');

const config = {
  databaseUrl: '', databaseHost: '127.0.0.1', databasePort: 3306, databaseName: 'medripple',
  databaseUser: 'medripple', databasePassword: '', simulationDate: '2026-09-11'
};

test('database projection preserves base units and protected safety stock', () => {
  assert.deepEqual(project({ effectiveStock: 90, dailyDemand: 10, protectedStock: 80 }), {
    effectiveStock: 90,
    dailyDemand: 10,
    daysRemaining: 9,
    protectedStock: 80,
    safeSurplus: 10,
    riskLabel: 'MEDIUM',
    riskScore: 43
  });
});

test('MySQL store maps the database facility read model to the public API contract', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM medicines') && sql.includes("generic_name = 'Human Insulin'")) {
        return [[{ id: 7, genericName: 'Human Insulin', strengthValue: 100, strengthUnit: 'IU/mL', form: 'Vial', unit: 'mL', criticality: 'CRITICAL', storageMinC: 2, storageMaxC: 8, requiresColdChain: 1 }]];
      }
      if (sql.includes('FROM facilities f') && sql.includes('CROSS JOIN medicines m')) {
        return [[{ facilityId: 6, facilityCode: 'PHC-VLR-001', facilityName: 'Vellore Primary Health Centre', facilityType: 'PHC', region: 'Vellore', latitude: 12.916517, longitude: 79.1325, populationServed: 78000, remotenessScore: 4, medicineId: 7, genericName: 'Human Insulin', strengthValue: 100, strengthUnit: 'IU/mL', form: 'Vial', unit: 'mL', criticality: 'CRITICAL', effectiveStock: 120, recordedStock: 125, dailyDemand: 30, protectedStock: 300, incomingSupply: 0, incomingDate: null }]];
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  const store = createMysqlStore(config, { pool });
  const facilities = await store.listFacilities();

  assert.equal(facilities.length, 1);
  assert.equal(facilities[0].facilityId, 'PHC-VLR-001');
  assert.equal(facilities[0].medicine.unit, 'mL');
  assert.equal(facilities[0].riskLabel, 'HIGH');
  assert.equal(queries.length, 2);
});

test('MySQL transfer batch selection requires expiry through the selected horizon', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM facilities') && sql.includes('facility_code = ?')) return [[{ id: 1, code: 'WH-001' }]];
      if (sql.includes('FROM medicines') && sql.includes('CAST(medicine_id AS CHAR)')) return [[{ id: 7, unit: 'mL' }]];
      if (sql.includes('FROM inventory i JOIN batches')) return [[{ batchId: 14, batchNo: 'TN-007-B01-26' }]];
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  const store = createMysqlStore(config, { pool });
  const batch = await store.selectTransferBatch('WH-001', '7', 14);
  assert.equal(batch.batchId, 14);
  const selection = queries.find((item) => item.sql.includes('FROM inventory i JOIN batches'));
  assert.match(selection.sql, /DATE_ADD\(\?, INTERVAL \? DAY\)/);
  assert.deepEqual(selection.values, [1, 7, '2026-09-11', 13]);
});

test('MySQL quantity precision rejects a fractional count and more than two decimals', async () => {
  const countPool = {
    async query() { return [[{ id: 8, unit: 'count' }]]; },
    async end() {}
  };
  const countStore = createMysqlStore(config, { pool: countPool });
  await assert.rejects(() => countStore.assertQuantityPrecision('8', 3.5), { code: 'INVALID_QUANTITY_PRECISION' });

  const liquidPool = {
    async query() { return [[{ id: 7, unit: 'mL' }]]; },
    async end() {}
  };
  const liquidStore = createMysqlStore(config, { pool: liquidPool });
  await assert.rejects(() => liquidStore.assertQuantityPrecision('7', 3.125), { code: 'INVALID_QUANTITY_PRECISION' });
  await liquidStore.assertQuantityPrecision('7', 3.12);
});

function decisionPlan(transfers = [[14, 'TN-007-B01-26', 40]], fromFacilityId = 'WH-001') {
  return {
    id: 'plan-atomic-001', horizonDays: 14, medicine: { id: '7' },
    transfers: transfers.map(([batchId, batchNo, quantity]) => ({
      fromFacilityId, toFacilityId: 'PHC-001', medicineId: '7', batchId, batchNo, quantity, departureDay: 1, arrivalDay: 1
    }))
  };
}

// WH-001 holds one 5000 mL batch. DH-MDU-001 holds two batches (600 + 900 mL usable) and keeps 1000 mL of safety stock.
const DONOR_ROWS = [
  { inventoryId: 11, facilityId: 1, medicineId: 7, facilityCode: 'WH-001', batchId: 14, batchNo: 'TN-007-B01-26', status: 'AVAILABLE', quarantined: 0, expiryDate: '2028-02-29', quantity: 5000 },
  { inventoryId: 31, facilityId: 3, medicineId: 7, facilityCode: 'DH-MDU-001', batchId: 21, batchNo: 'LOT-A', status: 'AVAILABLE', quarantined: 0, expiryDate: '2028-02-29', quantity: 600 },
  { inventoryId: 32, facilityId: 3, medicineId: 7, facilityCode: 'DH-MDU-001', batchId: 22, batchNo: 'LOT-B', status: 'AVAILABLE', quarantined: 0, expiryDate: '2028-04-24', quantity: 900 },
  { inventoryId: 33, facilityId: 3, medicineId: 7, facilityCode: 'DH-MDU-001', batchId: 22, batchNo: 'LOT-B', status: 'QUARANTINED', quarantined: 0, expiryDate: '2028-04-24', quantity: 300 }
];

function transactionStore({ updateRows = 1, rows = DONOR_ROWS, contentionError = null } = {}) {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); },
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('SELECT status FROM plans')) return [[{ status: 'PROPOSED' }]];
      if (sql.includes('UPDATE plans')) return [{ affectedRows: 1 }];
      if (sql.includes('ORDER BY i.facility_id')) return [rows.filter((row) => values[0].includes(row.facilityCode))];
      if (sql.includes('WHERE i.inventory_id = ?')) {
        if (contentionError) throw contentionError;
        return [[rows.find((row) => row.inventoryId === values[0])].filter(Boolean)];
      }
      if (sql.includes('FROM facility_safety_stock')) return [[{ facilityCode: 'DH-MDU-001', safetyStock: 1000 }].filter((row) => values[0].includes(row.facilityCode))];
      if (sql.includes('UPDATE inventory i')) return [{ affectedRows: updateRows }];
      if (sql.includes('INSERT INTO transfers')) return [{ affectedRows: 1, insertId: 91 }];
      if (sql.includes('INSERT INTO audit_events')) return [{ insertId: 101 }];
      throw new Error(`Unexpected transaction query: ${sql.slice(0, 80)}`);
    }
  };
  const pool = {
    async getConnection() { return connection; },
    async query(sql, values) {
      if (sql.includes('FROM inventory i') && !sql.includes('FOR UPDATE')) return [rows.filter((row) => values[0].includes(row.facilityCode))];
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  return { calls, store: createMysqlStore(config, { pool }) };
}

const approve = (store, plan, extra = {}) => store.recordPlanDecision({
  plan, decision: 'APPROVE', actor: 'Approver <approver@example.test>', note: 'Reserve approved stock.',
  beforeState: { status: 'PROPOSED' }, afterState: { status: 'RESERVED' }, ...extra
});
const sqlCalls = (calls, text) => calls.filter((item) => item.sql?.includes(text));

test('MySQL approval reserves donor stock, transfer item, and audit in one transaction', async () => {
  const { calls, store } = transactionStore();
  const plan = decisionPlan();
  const result = await approve(store, plan, { expectedDonorStock: await store.readDonorStock(plan) });
  assert.equal(result.planStatus, 'RESERVED');
  assert.deepEqual(calls.filter((item) => typeof item === 'string'), ['BEGIN', 'COMMIT', 'RELEASE']);
  assert.match(calls.find((item) => item.sql)?.sql, /SELECT status FROM plans.*FOR UPDATE/);
  assert.deepEqual(sqlCalls(calls, 'WHERE i.inventory_id = ?').map((item) => item.values[0]), [11]);
  assert.match(sqlCalls(calls, 'ORDER BY i.facility_id')[0].sql, /ORDER BY i\.facility_id, b\.medicine_id, i\.batch_id/);
  assert.match(sqlCalls(calls, 'FROM facility_safety_stock')[0].sql, /FOR SHARE OF safety/);
  const [stockUpdate] = sqlCalls(calls, 'UPDATE inventory i');
  assert.doesNotMatch(stockUpdate.sql, /safety_stock_qty/);
  assert.match(stockUpdate.sql, /b\.batch_number = \?/);
  assert.deepEqual(stockUpdate.values, [40, 'WH-001', 14, 'TN-007-B01-26', '7', '2026-09-11', 14, 40]);
  assert.ok(calls.some((item) => item.sql?.includes('INSERT INTO transfers') && item.values[0] === 'plan-atomic-001'));
});

test('MySQL approval checks protected stock across a donor facility with two batches', async () => {
  // 1500 mL usable (the quarantined row does not count); sending 400 keeps 1100 mL, although each row alone would not.
  const accepted = transactionStore();
  await approve(accepted.store, decisionPlan([[21, 'LOT-A', 300], [22, 'LOT-B', 100]], 'DH-MDU-001'));
  assert.deepEqual(sqlCalls(accepted.calls, 'UPDATE inventory i').map((item) => item.values.slice(0, 4)), [
    [300, 'DH-MDU-001', 21, 'LOT-A'], [100, 'DH-MDU-001', 22, 'LOT-B']
  ]);

  const refused = transactionStore();
  await assert.rejects(approve(refused.store, decisionPlan([[21, 'LOT-A', 400], [22, 'LOT-B', 200]], 'DH-MDU-001')), (error) => {
    assert.equal(error.code, 'PLAN_STOCK_CHANGED');
    assert.deepEqual(error.details.failures, [
      { fromFacilityId: 'DH-MDU-001', reason: 'DONOR_BELOW_PROTECTED_STOCK', usableStock: 1500, sent: 600, protectedStock: 1000 }
    ]);
    return true;
  });
  assert.deepEqual(sqlCalls(refused.calls, 'UPDATE inventory'), []);
  assert.deepEqual(refused.calls.filter((item) => typeof item === 'string'), ['BEGIN', 'ROLLBACK', 'RELEASE']);
});

test('MySQL approval refuses changed donor stock and changed batch identity', async () => {
  const plan = decisionPlan();
  const before = await transactionStore().store.readDonorStock(plan);
  const changed = transactionStore({ rows: DONOR_ROWS.map((row) => (row.inventoryId === 11 ? { ...row, quantity: 4999.99 } : row)) });
  await assert.rejects(approve(changed.store, plan, { expectedDonorStock: before }),
    (error) => error.details.failures[0].reason === 'DONOR_STOCK_CHANGED_DURING_REVALIDATION');
  assert.deepEqual(sqlCalls(changed.calls, 'UPDATE inventory'), []);

  const renamed = transactionStore();
  await assert.rejects(approve(renamed.store, decisionPlan([[14, 'TN-007-B02-26', 40]])),
    (error) => error.details.failures[0].reason === 'BATCH_NUMBER_MISMATCH');
});

test('MySQL stale stock rolls back without persisting a transfer or audit event', async () => {
  const { calls, store } = transactionStore({ updateRows: 0 });
  await assert.rejects(() => approve(store, decisionPlan()), { code: 'PLAN_STOCK_CHANGED' });
  assert.ok(calls.includes('ROLLBACK'));
  assert.ok(!calls.includes('COMMIT'));
  assert.deepEqual(sqlCalls(calls, 'INSERT INTO transfers'), []);
  assert.deepEqual(sqlCalls(calls, 'INSERT INTO audit_events'), []);
});

test('MySQL approval locks and updates opposite-input donors in canonical numeric key order', async () => {
  const rows = [DONOR_ROWS[2], DONOR_ROWS[1], DONOR_ROWS[0]];
  const { calls, store } = transactionStore({ rows });
  const plan = decisionPlan();
  plan.transfers = [
    { fromFacilityId: 'DH-MDU-001', toFacilityId: 'PHC-001', medicineId: '7', batchId: 21, batchNo: 'LOT-A', quantity: 100 },
    { fromFacilityId: 'WH-001', toFacilityId: 'PHC-001', medicineId: '7', batchId: 14, batchNo: 'TN-007-B01-26', quantity: 40 }
  ];

  assert.deepEqual(orderTransfersForReservation(plan.transfers, rows).map((item) => item.fromFacilityId), ['WH-001', 'DH-MDU-001']);
  await approve(store, plan);
  assert.deepEqual(sqlCalls(calls, 'WHERE i.inventory_id = ?').map((item) => item.values[0]), [11, 31, 32]);
  assert.deepEqual(sqlCalls(calls, 'UPDATE inventory i').map((item) => item.values.slice(0, 4)), [
    [40, 'WH-001', 14, 'TN-007-B01-26'],
    [100, 'DH-MDU-001', 21, 'LOT-A']
  ]);
});

test('MySQL deadlocks and serialization conflicts roll back as retryable stock conflicts', async () => {
  for (const databaseError of [
    Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK', errno: 1213 }),
    Object.assign(new Error('serialization'), { sqlState: '40001' })
  ]) {
    assert.equal(isMysqlContentionError(databaseError), true);
    const { calls, store } = transactionStore({ contentionError: databaseError });
    await assert.rejects(approve(store, decisionPlan()), (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.code, 'PLAN_STOCK_CHANGED');
      assert.deepEqual(error.details, {
        planId: 'plan-atomic-001',
        reason: 'CONCURRENT_RESERVATION',
        instruction: 'Refresh the plan and re-run the optimizer before approving again.'
      });
      return true;
    });
    assert.deepEqual(calls.filter((item) => typeof item === 'string'), ['BEGIN', 'ROLLBACK', 'RELEASE']);
    assert.deepEqual(sqlCalls(calls, 'UPDATE inventory'), []);
    assert.deepEqual(sqlCalls(calls, 'INSERT INTO transfers'), []);
    assert.deepEqual(sqlCalls(calls, 'INSERT INTO audit_events'), []);
  }
});

test('MySQL delivery adds the reserved batch to recipient inventory and audits it', async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push('BEGIN'); },
    async commit() { calls.push('COMMIT'); },
    async rollback() { calls.push('ROLLBACK'); },
    release() { calls.push('RELEASE'); },
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('UPDATE plans SET status')) return [{ affectedRows: 1 }];
      if (sql.includes('FROM transfers WHERE plan_id')) return [[{ id: 91, originFacilityId: 1, destinationFacilityId: 2, batchId: 14, quantity: 40 }]];
      if (sql.includes('INSERT INTO inventory')) return [{ affectedRows: 1 }];
      if (sql.includes('UPDATE transfers SET status')) return [{ affectedRows: 1 }];
      if (sql.includes('INSERT INTO audit_events')) return [{ insertId: 102 }];
      throw new Error(`Unexpected transaction query: ${sql.slice(0, 80)}`);
    }
  };
  const store = createMysqlStore(config, { pool: { async getConnection() { return connection; }, async end() {} } });
  const result = await store.transitionPlan({
    plan: decisionPlan(), action: 'DELIVER', actor: 'Approver <approver@example.test>', note: 'Receipt checked.', beforeState: { status: 'IN_TRANSIT' }
  });
  assert.equal(result.planStatus, 'DELIVERED');
  assert.deepEqual(calls.filter((item) => typeof item === 'string'), ['BEGIN', 'COMMIT', 'RELEASE']);
  const recipientInventory = calls.find((item) => item.sql?.includes('INSERT INTO inventory'));
  assert.deepEqual(recipientInventory.values, [2, 14, 40]);
});

