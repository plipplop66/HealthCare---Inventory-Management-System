// Opt-in: plan, transfer, audit and account timestamps written and read through Node -> Python -> PostgreSQL.
// THIS TEST WRITES TO THE DATABASE: run it only against a fresh disposable LOCAL database built with
// database/schema-postgres.sql and database/seed-postgres.sql.
//
//   MEDRIPPLE_LIVE_POSTGRES_TIMESTAMPS=1, DATABASE_URL (localhost only), DATABASE_SSL=true (with NODE_EXTRA_CA_CERTS for a
//   local test CA) and INTELLIGENCE_SERVICE_URL (localhost only) for the service running with DATA_SOURCE=postgres.
//
// The writer's database sessions use TimeZone=Asia/Kolkata. The API is then read back by separate Node processes running
// with TZ=UTC and TZ=Asia/Kolkata (each with a database session in the same zone); both must return identical instants,
// equal to the stored UTC values.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { createPostgresAuthStore } = require('../src/postgres-auth-store');
const { PostgresInventoryStore, postgresTypes } = require('../src/postgres-store');
const { postgresTls } = require('../src/postgres-tls');

const enabled = process.env.MEDRIPPLE_LIVE_POSTGRES_TIMESTAMPS === '1';
const databaseUrl = process.env.DATABASE_URL || '';
const intelligenceUrl = (process.env.INTELLIGENCE_SERVICE_URL || '').replace(/\/$/, '');
const READER = path.join(__dirname, 'support', 'postgres-timestamp-reader.js');
const APPROVER = { name: 'Live Timestamp Test', email: 'live.timestamps@medripple.test', password: `Live-${crypto.randomUUID()}-9` };
// A stored instant must fall inside the test run; the allowance covers clock drift between the host and a database container.
const CLOCK_ALLOWANCE_MS = 60_000;

function isLocal(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

// Milliseconds since the epoch for a stored UTC wall-clock column, computed by PostgreSQL.
const epochMs = (column) => `FLOOR(EXTRACT(EPOCH FROM (${column} AT TIME ZONE 'UTC')) * 1000)::BIGINT`;
const toIso = (value) => (value === null ? null : new Date(Number(value)).toISOString());

test('PostgreSQL timestamps are UTC instants for UTC and Asia/Kolkata processes and sessions', {
  skip: enabled ? false : 'Set MEDRIPPLE_LIVE_POSTGRES_TIMESTAMPS=1 with a fresh disposable local database and intelligence service.'
}, async (t) => {
  assert.ok(isLocal(databaseUrl), 'DATABASE_URL must name a local disposable database.');
  assert.ok(isLocal(intelligenceUrl), 'INTELLIGENCE_SERVICE_URL must name a local intelligence service.');
  const config = {
    environment: 'test', dataSource: 'postgres', databaseUrl, databaseSsl: process.env.DATABASE_SSL === 'true',
    simulationDate: process.env.SIMULATION_DATE || '2026-09-11', corsOrigins: [], intelligenceServiceUrl: intelligenceUrl, intelligenceTimeoutMs: 15000
  };
  const indiaSession = { connectionString: databaseUrl, ssl: postgresTls(config), types: postgresTypes, options: '-c TimeZone=Asia/Kolkata' };
  const inventoryPool = new Pool({ ...indiaSession, max: 4 });
  const authPool = new Pool({ ...indiaSession, max: 2 });
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresTls(config), types: postgresTypes, max: 1 });
  t.after(() => Promise.all([inventoryPool.end(), authPool.end(), pool.end()]));
  const sql = async (text, values = []) => (await pool.query(text, values)).rows;
  assert.equal((await sql('SELECT COUNT(*)::INT AS count FROM plans'))[0].count, 0, 'this test needs a fresh database');
  assert.equal((await inventoryPool.query('SHOW TimeZone')).rows[0].TimeZone, 'Asia/Kolkata');

  const started = Date.now();
  const inventoryStore = new PostgresInventoryStore(config, { pool: inventoryPool });
  const authStore = createPostgresAuthStore(config, { pool: authPool });
  await authStore.create({ id: crypto.randomUUID(), name: APPROVER.name, email: APPROVER.email, passwordHash: hashPassword(APPROVER.password), role: 'APPROVER' });
  const server = createApp(config, { inventoryStore, authStore }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token;
  const call = async (route, body) => {
    const response = await fetch(`${base}${route}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json();
    assert.equal(response.status, 200, `${route}: ${JSON.stringify(payload)}`);
    return payload.data;
  };
  ({ token } = await call('/auth/login', { email: APPROVER.email, password: APPROVER.password }));
  const plan = async (destinationFacilityId, quantity) => (await call('/plans/optimize', { destinationFacilityId, medicineId: '7', quantity, horizonDays: 14 })).id;
  const note = (action) => ({ note: `${action}: live timestamp test.` });

  // Vellore: reserve, dispatch, deliver. Karur (two donors): reserve, cancel.
  const vellore = await plan('PHC-VLR-001', 300);
  const karur = await plan('PHC-KRR-001', 800);
  for (const planId of [vellore, karur]) assert.equal((await call(`/plans/${planId}/approve`, { decision: 'APPROVE', ...note('APPROVE') })).plan.status, 'RESERVED');
  assert.equal((await call(`/plans/${vellore}/dispatch`, note('DISPATCH'))).plan.status, 'IN_TRANSIT');
  assert.equal((await call(`/plans/${vellore}/deliver`, note('DELIVER'))).plan.status, 'DELIVERED');
  assert.equal((await call(`/plans/${karur}/cancel`, note('CANCEL'))).plan.status, 'CANCELLED');
  const finished = Date.now();
  const planIds = [vellore, karur];

  // Every stamped column holds the UTC time of the write, although the writer's sessions were in Asia/Kolkata.
  const stored = {
    plans: await sql(`SELECT plan_id AS id, ${epochMs('created_at')} AS "createdAt", ${epochMs('decided_at')} AS "decidedAt" FROM plans WHERE plan_id = ANY($1) ORDER BY plan_id`, [planIds]),
    transfers: await sql(
      `SELECT plan_id AS "planId", status, ${epochMs('requested_at')} AS "requestedAt", ${epochMs('approved_at')} AS "approvedAt",
              ${epochMs('dispatched_at')} AS "dispatchedAt", ${epochMs('delivered_at')} AS "deliveredAt", ${epochMs('cancelled_at')} AS "cancelledAt"
       FROM transfers WHERE plan_id = ANY($1) ORDER BY transfer_id`, [planIds]),
    audit: await sql(`SELECT audit_id AS id, action, ${epochMs('event_timestamp')} AS timestamp FROM audit_events WHERE entity_id = ANY($1) ORDER BY audit_id`, [planIds]),
    user: (await sql(`SELECT ${epochMs('created_at')} AS "createdAt", ${epochMs('last_login_at')} AS "lastLoginAt" FROM app_users WHERE email = $1`, [APPROVER.email]))[0]
  };
  const inRun = (label, value) => {
    assert.notEqual(value, null, `${label} was not stamped`);
    const instant = Number(value);
    assert.ok(instant >= started - CLOCK_ALLOWANCE_MS && instant <= finished + CLOCK_ALLOWANCE_MS,
      `${label} ${toIso(value)} is outside the test run ${new Date(started).toISOString()} - ${new Date(finished).toISOString()}`);
  };
  for (const row of stored.plans) ['createdAt', 'decidedAt'].forEach((column) => inRun(`plans.${column}`, row[column]));
  assert.equal(stored.transfers.length, 3);
  for (const row of stored.transfers) {
    ['requestedAt', 'approvedAt'].forEach((column) => inRun(`transfers.${column}`, row[column]));
    const lifecycle = row.planId === vellore ? ['dispatchedAt', 'deliveredAt'] : ['cancelledAt'];
    lifecycle.forEach((column) => inRun(`transfers.${column}`, row[column]));
    ['dispatchedAt', 'deliveredAt', 'cancelledAt'].filter((column) => !lifecycle.includes(column)).forEach((column) => assert.equal(row[column], null));
  }
  assert.deepEqual(stored.audit.map((event) => event.action), ['RESERVE', 'RESERVE', 'DISPATCH', 'DELIVER', 'CANCEL']);
  stored.audit.forEach((event) => inRun(`audit_events.${event.action}`, event.timestamp));
  inRun('app_users.created_at', stored.user.createdAt);
  inRun('app_users.last_login_at', stored.user.lastLoginAt);

  const expected = {
    plans: Object.fromEntries(stored.plans.map((row) => [row.id, {
      status: row.id === vellore ? 'DELIVERED' : 'CANCELLED', createdAt: toIso(row.createdAt), decidedAt: toIso(row.decidedAt)
    }])),
    audit: stored.audit.map((event) => ({ id: event.id, action: event.action, timestamp: toIso(event.timestamp) })).reverse(),
    userCreatedAt: toIso(stored.user.createdAt)
  };
  const read = async (zone) => {
    const { stdout } = await promisify(execFile)(process.execPath, [READER], {
      env: {
        ...process.env, TZ: zone, PGOPTIONS: `-c TimeZone=${zone}`, TIMESTAMP_PLAN_IDS: JSON.stringify(planIds),
        TIMESTAMP_EMAIL: APPROVER.email, TIMESTAMP_PASSWORD: APPROVER.password
      }
    });
    const marker = 'TIMESTAMP_RESULT ';
    const result = stdout.split('\n').find((line) => line.startsWith(marker));
    assert.ok(result, `no result from the TZ=${zone} reader: ${stdout}`);
    return JSON.parse(result.slice(marker.length));
  };
  const utc = await read('UTC');
  const india = await read('Asia/Kolkata');
  assert.deepEqual([utc.tz, utc.offsetMinutes, utc.sessionTimeZone], ['UTC', 0, 'UTC']);
  assert.deepEqual([india.tz, india.offsetMinutes, india.sessionTimeZone], ['Asia/Kolkata', -330, 'Asia/Kolkata']);
  assert.deepEqual(utc.api, expected);
  assert.deepEqual(india.api, utc.api);
  t.diagnostic(`API timestamps under UTC and Asia/Kolkata: ${JSON.stringify(utc.api)}`);
});
