const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PostgresInventoryStore, project } = require('../src/postgres-store');

const config = {
  databaseUrl: 'postgresql://not-used-in-tests', environment: 'production', simulationDate: '2026-09-11'
};

test('PostgreSQL projection preserves base units and protected safety stock', () => {
  assert.deepEqual(project({ effectiveStock: 90, dailyDemand: 10, protectedStock: 80 }), {
    effectiveStock: 90, dailyDemand: 10, daysRemaining: 9, protectedStock: 80,
    safeSurplus: 10, riskLabel: 'MEDIUM', riskScore: 43
  });
});

test('PostgreSQL store maps Supabase rows to the public API contract', async () => {
  const queries = [];
  const pool = {
    async query(sql, values) {
      queries.push({ sql, values });
      if (sql.includes('FROM medicines')) return { rows: [{
        id: 7, genericName: 'Human Insulin', strengthValue: 100, strengthUnit: 'IU/mL', form: 'Vial',
        unit: 'mL', criticality: 'HIGH', storageMinC: 2, storageMaxC: 8, requiresColdChain: true
      }] };
      if (sql.includes('WITH stock AS')) return { rows: [{
        facilityId: 4, facilityCode: 'PHC-NAV-001', facilityName: 'Navjeevan PHC', facilityType: 'PHC', region: 'MEDRIPPLE District',
        latitude: '18.472000', longitude: '73.928000', populationServed: 12000, remotenessScore: '0.80',
        hasColdChain: true, medicineId: 7, genericName: 'Human Insulin', strengthValue: '100', strengthUnit: 'IU/mL',
        form: 'Vial', unit: 'mL', criticality: 'HIGH', requiresColdChain: true, effectiveStock: '22', recordedStock: '22',
        dailyDemand: '8', protectedStock: '112', incomingSupply: '100', incomingDate: '2026-09-19', incomingArrivalDay: 8
      }] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  const store = new PostgresInventoryStore(config, { pool });
  const facilities = await store.listFacilities();
  assert.equal(store.source, 'POSTGRES');
  assert.equal(facilities.length, 1);
  assert.equal(facilities[0].facilityId, 'PHC-NAV-001');
  assert.equal(facilities[0].medicine.unit, 'mL');
  assert.equal(facilities[0].riskLabel, 'CRITICAL');
  assert.equal(queries.length, 2);
  assert.equal(queries[1].values[0], '2026-09-11');
});

test('PostgreSQL transfer batch selection keeps stock usable through the requested horizon', async () => {
  const pool = {
    async query(sql) {
      if (sql.includes('FROM facilities')) return { rows: [{ id: 1, code: 'WH-CENTRAL-001' }] };
      if (sql.includes('FROM medicines')) return { rows: [{ id: 7, unit: 'mL' }] };
      if (sql.includes('FROM inventory i JOIN batches')) return { rows: [{ batchId: 14, batchNo: 'INS-CENTRAL-001' }] };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  const store = new PostgresInventoryStore(config, { pool });
  const batch = await store.selectTransferBatch('WH-CENTRAL-001', '7', 14);
  assert.deepEqual(batch, { batchId: 14, batchNo: 'INS-CENTRAL-001' });
});

// Donor DH-MDU-001 holds two insulin batches (600 + 900 mL usable) and must keep 1000 mL of safety stock.
const DONOR_ROWS = [
  { inventoryId: 31, facilityCode: 'DH-MDU-001', batchId: 21, batchNo: 'LOT-A', status: 'AVAILABLE', quarantined: false, expiryDate: '2028-02-29', quantity: '600.00' },
  { inventoryId: 32, facilityCode: 'DH-MDU-001', batchId: 22, batchNo: 'LOT-B', status: 'AVAILABLE', quarantined: false, expiryDate: '2028-04-24', quantity: '900.00' },
  { inventoryId: 33, facilityCode: 'DH-MDU-001', batchId: 23, batchNo: 'LOT-OLD', status: 'AVAILABLE', quarantined: false, expiryDate: '2026-09-11', quantity: '500.00' }
];

function decisionPlan(transfers) {
  return {
    id: 'plan-postgres-001', horizonDays: 14, medicine: { id: '7' },
    transfers: transfers.map(([batchId, batchNo, quantity]) => ({
      fromFacilityId: 'DH-MDU-001', toFacilityId: 'PHC-KRR-001', medicineId: '7', batchId, batchNo, quantity, departureDay: 1, arrivalDay: 1
    }))
  };
}

function fakeDatabase({ rows = DONOR_ROWS, safety = [{ facilityCode: 'DH-MDU-001', safetyStock: '1000.00' }], updateRowCount = 1 } = {}) {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE plans SET status')) return { rows: [{ plan_id: 'plan-postgres-001' }], rowCount: 1 };
      if (sql.includes('FOR UPDATE OF i')) return { rows, rowCount: rows.length };
      if (sql.includes('FROM facility_safety_stock')) return { rows: safety, rowCount: safety.length };
      if (sql.includes('UPDATE inventory i SET')) return { rows: [], rowCount: updateRowCount };
      if (sql.includes('INSERT INTO transfers')) return { rows: [{ transfer_id: 91 }], rowCount: 1 };
      if (sql.includes('INSERT INTO audit_events')) return { rows: [{ audit_id: 101 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  const pool = {
    async connect() { return client; },
    async query(sql, values) {
      calls.push({ sql, values, outsideTransaction: true });
      if (sql.includes('FROM inventory i') && !sql.includes('FOR UPDATE')) return { rows };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
  return { calls, store: new PostgresInventoryStore(config, { pool }) };
}

function decide(store, plan, extra = {}) {
  return store.recordPlanDecision({
    plan, decision: 'APPROVE', actor: 'Approver <approver@example.test>', note: 'Reserve approved stock.',
    beforeState: { status: 'PROPOSED' }, afterState: { status: 'RESERVED' }, ...extra
  });
}

const statements = (calls, text) => calls.filter((call) => call.sql.includes(text));

test('PostgreSQL approval checks protected stock across a donor facility, not per batch row', async () => {
  const { calls, store } = fakeDatabase();
  // Each row alone would fall below 1000 mL; the donor keeps 1500 - 400 = 1100 mL (the expired row does not count).
  const plan = decisionPlan([[21, 'LOT-A', 300], [22, 'LOT-B', 100]]);
  const result = await decide(store, plan, { expectedDonorStock: await store.readDonorStock(plan) });
  assert.deepEqual([result.storage, result.planStatus, result.auditId], ['POSTGRES', 'RESERVED', 101]);
  const [lock] = statements(calls, 'FOR UPDATE OF i');
  assert.match(lock.sql, /ORDER BY i\.inventory_id\s+FOR UPDATE OF i$/);
  assert.deepEqual(lock.values, [['DH-MDU-001'], '7']);
  const updates = statements(calls, 'UPDATE inventory i SET');
  assert.ok(updates.every((call) => !call.sql.includes('safety_stock_qty') && call.sql.includes('b.batch_number = $4')));
  assert.deepEqual(updates.map((call) => call.values), [
    [300, 'DH-MDU-001', 21, 'LOT-A', '7', '2026-09-11', 14],
    [100, 'DH-MDU-001', 22, 'LOT-B', '7', '2026-09-11', 14]
  ]);
  // Locks are taken after the plan row and before any stock moves.
  const order = calls.map((call) => call.sql);
  assert.ok(order.findIndex((sql) => sql.includes('UPDATE plans')) < order.findIndex((sql) => sql.includes('FOR UPDATE OF i')));
  assert.ok(order.findIndex((sql) => sql.includes('FOR UPDATE OF i')) < order.findIndex((sql) => sql.includes('UPDATE inventory')));
  assert.deepEqual(statements(calls, 'INSERT INTO transfers').length, 2);
  assert.equal(calls.at(-1).sql, 'RELEASE');
});

test('PostgreSQL approval rolls back when the donor facility would fall below safety stock', async () => {
  const { calls, store } = fakeDatabase();
  await assert.rejects(decide(store, decisionPlan([[21, 'LOT-A', 400], [22, 'LOT-B', 200]])), (error) => {
    assert.equal(error.code, 'PLAN_STOCK_CHANGED');
    assert.deepEqual(error.details.failures, [
      { fromFacilityId: 'DH-MDU-001', reason: 'DONOR_BELOW_PROTECTED_STOCK', usableStock: 1500, sent: 600, protectedStock: 1000 }
    ]);
    return true;
  });
  assert.deepEqual(statements(calls, 'UPDATE inventory'), []);
  assert.deepEqual(statements(calls, 'INSERT INTO'), []);
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK') && !calls.some((call) => call.sql === 'COMMIT'));
});

test('PostgreSQL approval refuses a changed batch identity, short expiry, quarantine or changed donor stock', async () => {
  const cases = [
    [decisionPlan([[21, 'LOT-X', 10]]), {}, 'BATCH_NUMBER_MISMATCH'],
    [decisionPlan([[23, 'LOT-OLD', 10]]), {}, 'BATCH_EXPIRES_BEFORE_HORIZON_END'],
    [decisionPlan([[21, 'LOT-A', 10]]), { rows: DONOR_ROWS.map((row) => (row.batchId === 21 ? { ...row, quarantined: true } : row)) }, 'BATCH_QUARANTINED'],
    [decisionPlan([[21, 'LOT-A', 601]]), {}, 'INSUFFICIENT_BATCH_QUANTITY'],
    [decisionPlan([[29, 'LOT-Z', 10]]), {}, 'BATCH_NOT_AVAILABLE'],
    [{ ...decisionPlan([[21, 'LOT-A', 10]]), medicine: { id: '8' } }, {}, 'MEDICINE_MISMATCH']
  ];
  for (const [plan, database, reason] of cases) {
    const { calls, store } = fakeDatabase(database);
    await assert.rejects(decide(store, plan), (error) => error.code === 'PLAN_STOCK_CHANGED' && error.details.failures.some((item) => item.reason === reason), reason);
    assert.deepEqual(statements(calls, 'UPDATE inventory'), [], reason);
  }
  // A batch valid on the last horizon day (SIMULATION_DATE + 14) is accepted.
  const lastDay = DONOR_ROWS.map((row) => (row.batchId === 21 ? { ...row, expiryDate: '2026-09-25' } : row));
  await decide(fakeDatabase({ rows: lastDay }).store, decisionPlan([[21, 'LOT-A', 10]]));
  const oneDayShort = DONOR_ROWS.map((row) => (row.batchId === 21 ? { ...row, expiryDate: '2026-09-24' } : row));
  await assert.rejects(decide(fakeDatabase({ rows: oneDayShort }).store, decisionPlan([[21, 'LOT-A', 10]])), { code: 'PLAN_STOCK_CHANGED' });

  const plan = decisionPlan([[21, 'LOT-A', 10]]);
  const before = await fakeDatabase().store.readDonorStock(plan);
  const changed = DONOR_ROWS.map((row) => (row.batchId === 22 ? { ...row, quantity: '899.99' } : row));
  const { calls, store } = fakeDatabase({ rows: changed });
  await assert.rejects(decide(store, plan, { expectedDonorStock: before }), (error) => error.details.failures[0].reason === 'DONOR_STOCK_CHANGED_DURING_REVALIDATION');
  assert.deepEqual(statements(calls, 'UPDATE inventory'), []);
});

test('PostgreSQL approval rolls back when a reserved row changes at the update', async () => {
  const { calls, store } = fakeDatabase({ updateRowCount: 0 });
  await assert.rejects(decide(store, decisionPlan([[21, 'LOT-A', 10]])), (error) => error.details.failures[0].reason === 'RESERVATION_ROW_CHANGED');
  assert.deepEqual(statements(calls, 'INSERT INTO'), []);
  assert.ok(calls.some((call) => call.sql === 'ROLLBACK'));
});

test('PostgreSQL rejection records the decision without locking or moving stock', async () => {
  const { calls, store } = fakeDatabase();
  const result = await store.recordPlanDecision({
    plan: decisionPlan([[21, 'LOT-A', 10]]), decision: 'REJECT', actor: 'Approver <approver@example.test>', note: 'Not needed.',
    beforeState: { status: 'PROPOSED' }, afterState: { status: 'REJECTED' }
  });
  assert.equal(result.planStatus, 'REJECTED');
  assert.deepEqual(statements(calls, 'FOR UPDATE OF i'), []);
  assert.deepEqual(statements(calls, 'UPDATE inventory'), []);
  assert.equal(statements(calls, 'INSERT INTO audit_events').length, 1);
});
