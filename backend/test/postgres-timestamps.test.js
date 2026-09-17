const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PostgresInventoryStore } = require('../src/postgres-store');
const { UTC_NOW, isoInstant, utcInstant } = require('../src/postgres-time');

const PROBE = path.join(__dirname, 'support', 'postgres-timestamp-probe.js');
const EXPECTED = {
  plan: { createdAt: '2026-09-17T04:45:12.345Z', decidedAt: '2026-09-17T23:40:09.500Z' },
  audit: ['2026-09-17T23:40:09.500Z'],
  user: { createdAt: '2026-09-17T04:45:12.345Z' }
};

function probe(TZ) {
  return JSON.parse(execFileSync(process.execPath, [PROBE], { env: { ...process.env, TZ }, encoding: 'utf8' }));
}

test('PostgreSQL plan, audit and account timestamps are the same instants under UTC and Asia/Kolkata', () => {
  const utc = probe('UTC');
  const india = probe('Asia/Kolkata');
  // The child processes really ran in those zones.
  assert.deepEqual([utc.tz, utc.offsetMinutes], ['UTC', 0]);
  assert.deepEqual([india.tz, india.offsetMinutes], ['Asia/Kolkata', -330]);
  for (const result of [utc, india]) {
    assert.deepEqual(result.sessions, { UTC: EXPECTED, 'Asia/Kolkata': EXPECTED }, `TZ=${result.tz}`);
  }
});

test('A PostgreSQL timestamp is only returned when it was read as a UTC instant', () => {
  assert.equal(utcInstant('decided_at'), "(decided_at AT TIME ZONE 'UTC')");
  assert.equal(isoInstant(new Date('2026-09-17T10:15:12.345+05:30')), '2026-09-17T04:45:12.345Z');
  assert.equal(isoInstant(null), null);
  // Wall-clock text without a zone is ambiguous; it is refused rather than guessed.
  assert.throws(() => isoInstant('2026-09-17 04:45:12'), TypeError);
  assert.throws(() => isoInstant(new Date(Number.NaN)), TypeError);
});

test('PostgreSQL stores write every timestamp as UTC, whatever the database session time zone', () => {
  for (const file of ['postgres-store.js', 'postgres-auth-store.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    assert.equal(source.replaceAll(UTC_NOW, '').match(/CURRENT_TIMESTAMP|\bnow\(\)|LOCALTIMESTAMP/gi), null, file);
  }
});

function lifecycleDatabase() {
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (sql.includes('UPDATE plans SET status')) return { rows: [{ plan_id: 'plan-time-001' }], rowCount: 1 };
      if (sql.includes('INSERT INTO transfers')) return { rows: [{ transfer_id: 91 }], rowCount: 1 };
      if (sql.includes('SELECT transfer_id')) return { rows: [{ id: 91, originFacilityId: 1, destinationFacilityId: 2, batchId: 21, quantity: '10.00' }], rowCount: 1 };
      if (sql.includes('INSERT INTO inventory') || sql.includes('UPDATE inventory SET') || sql.includes('UPDATE transfers SET')) return { rows: [{ inventory_id: 5 }], rowCount: 1 };
      if (sql.includes('INSERT INTO audit_events')) return { rows: [{ audit_id: 101 }], rowCount: 1 };
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    release() {}
  };
  const pool = { async connect() { return client; }, async end() {} };
  const store = new PostgresInventoryStore({ databaseUrl: 'postgresql://not-used-in-tests', environment: 'test', simulationDate: '2026-09-11' }, { pool });
  return { calls, store };
}

test('Decision, dispatch, delivery and cancellation stamp their columns with UTC time', async () => {
  const plan = {
    id: 'plan-time-001', horizonDays: 14, medicine: { id: '7' },
    transfers: [{ fromFacilityId: 'DH-MDU-001', toFacilityId: 'PHC-KRR-001', medicineId: '7', batchId: 21, batchNo: 'LOT-A', quantity: 10 }]
  };
  const { calls, store } = lifecycleDatabase();
  const stamped = (column) => calls.some((sql) => sql.includes(column) && sql.includes(UTC_NOW));
  await store.recordPlanDecision({
    plan, decision: 'REJECT', actor: 'Approver <approver@example.test>', note: 'Not needed.',
    beforeState: { status: 'PROPOSED' }, afterState: { status: 'REJECTED' }
  });
  assert.ok(calls.some((sql) => sql.includes(`decided_at = ${UTC_NOW}`)), 'decided_at');
  assert.ok(calls.some((sql) => sql.includes(`THEN ${UTC_NOW} ELSE NULL END`)), 'approved_at');
  for (const column of ['requested_at', 'event_timestamp']) assert.ok(stamped(column), column);
  for (const action of ['DISPATCH', 'DELIVER', 'CANCEL']) {
    await store.transitionPlan({ plan, action, actor: 'Approver <approver@example.test>', note: `${action} note.`, beforeState: { status: 'RESERVED' } });
  }
  for (const column of ['dispatched_at', 'delivered_at', 'cancelled_at']) {
    assert.ok(calls.some((sql) => sql.includes(`${column} = ${UTC_NOW}`)), column);
  }
});
