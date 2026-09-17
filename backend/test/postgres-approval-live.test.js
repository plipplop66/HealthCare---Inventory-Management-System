// Opt-in end-to-end approval through Node -> Python -> PostgreSQL. THIS TEST WRITES TO THE DATABASE: run it only
// against a disposable LOCAL database built with database/schema-postgres.sql and database/seed-postgres.sql.
//
//   MEDRIPPLE_LIVE_POSTGRES_APPROVAL=golden  fresh database: forecast, the Vellore golden plan and its approval.
//   MEDRIPPLE_LIVE_POSTGRES_APPROVAL=unsafe  another fresh database: unsafe approvals change nothing, then the
//                                            Karur two-donor plan, rejection and concurrent approval.
//
// Also set DATABASE_URL (localhost only), DATABASE_SSL=true (with NODE_EXTRA_CA_CERTS for a local test CA) and
// INTELLIGENCE_SERVICE_URL (localhost only) for the intelligence service running with DATA_SOURCE=postgres on the same
// database. The backend talks to the service through a proxy in this test, which records every call and can hold
// or alter the response; data changes made by a case are restored afterwards.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { test } = require('node:test');
const { Pool } = require('pg');
const { createApp } = require('../src/app');
const { hashPassword } = require('../src/auth');
const { createPostgresAuthStore } = require('../src/postgres-auth-store');
const { PostgresInventoryStore, postgresTypes } = require('../src/postgres-store');
const { postgresTls } = require('../src/postgres-tls');

const scenario = process.env.MEDRIPPLE_LIVE_POSTGRES_APPROVAL || '';
const databaseUrl = process.env.DATABASE_URL || '';
const intelligenceUrl = (process.env.INTELLIGENCE_SERVICE_URL || '').replace(/\/$/, '');
const GOLDEN_PLAN_ID = 'plan-a4d757f3efa18dc5765e61e71f993073';
const APPROVER = { name: 'Live Approval Test', email: 'live.approver@medripple.test', password: `Live-${crypto.randomUUID()}-9` };
const TABLES = ['facilities', 'medicines', 'batches', 'inventory', 'consumption', 'replenishments', 'routes', 'facility_safety_stock', 'plans', 'transfers', 'audit_events', 'app_users'];

function isLocal(url) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function skipUnless(name) {
  if (scenario !== name) return `Set MEDRIPPLE_LIVE_POSTGRES_APPROVAL=${name} with a disposable local database and intelligence service.`;
  return false;
}

// A pass-through proxy in front of the intelligence service.
async function startProxy(t) {
  const proxy = {
    calls: [],
    mode: 'forward',
    beforeSimulate: null,
    afterSimulate: null
  };
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', async () => {
      const call = { url: request.url, body: text ? JSON.parse(text) : null };
      proxy.calls.push(call);
      if (proxy.mode === 'hang') return;
      const simulate = request.url === '/scenarios/simulate';
      if (simulate && proxy.beforeSimulate) await proxy.beforeSimulate(call);
      const upstream = await fetch(`${intelligenceUrl}${request.url}`, { method: request.method, headers: { 'content-type': 'application/json' }, body: text || undefined });
      const payload = await upstream.text();
      call.status = upstream.status;
      call.response = payload ? JSON.parse(payload) : null;
      if (simulate && proxy.afterSimulate) await proxy.afterSimulate(call);
      response.writeHead(upstream.status, { 'content-type': 'application/json' });
      response.end(payload);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  proxy.url = `http://127.0.0.1:${server.address().port}`;
  proxy.reset = () => Object.assign(proxy, { calls: [], mode: 'forward', beforeSimulate: null, afterSimulate: null });
  proxy.urls = () => proxy.calls.map((call) => call.url);
  return proxy;
}

async function startLive(t) {
  assert.ok(isLocal(databaseUrl), 'DATABASE_URL must name a local disposable database.');
  assert.ok(isLocal(intelligenceUrl), 'INTELLIGENCE_SERVICE_URL must name a local intelligence service.');
  const config = {
    environment: 'test', dataSource: 'postgres', databaseUrl, databaseSsl: process.env.DATABASE_SSL === 'true',
    simulationDate: process.env.SIMULATION_DATE || '2026-09-11', corsOrigins: []
  };
  const inventoryPool = new Pool({ connectionString: databaseUrl, ssl: postgresTls(config), types: postgresTypes, max: 4 });
  const authPool = new Pool({ connectionString: databaseUrl, ssl: postgresTls(config), max: 2 });
  const pool = new Pool({ connectionString: databaseUrl, ssl: postgresTls(config), types: postgresTypes, max: 2 });
  t.after(() => Promise.all([inventoryPool.end(), authPool.end(), pool.end()]));
  const sql = async (text, values = []) => (await pool.query(text, values)).rows;
  const inventoryStore = new PostgresInventoryStore(config, { pool: inventoryPool });
  const authStore = createPostgresAuthStore(config, { pool: authPool });

  await sql(
    `INSERT INTO app_users (user_id, full_name, email, password_hash, role, is_active) VALUES ($1, $2, $3, $4, 'APPROVER', TRUE)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'APPROVER', is_active = TRUE`,
    [crypto.randomUUID(), APPROVER.name, APPROVER.email, hashPassword(APPROVER.password)]
  );
  const proxy = await startProxy(t);

  const startBackend = async (serviceUrl, timeoutMs) => {
    const app = createApp({ ...config, intelligenceServiceUrl: serviceUrl, intelligenceTimeoutMs: timeoutMs }, { inventoryStore, authStore });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (path, { token, body } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      return { status: response.status, body: await response.json() };
    };
    const login = await call('/auth/login', { body: { email: APPROVER.email, password: APPROVER.password } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.data.user.role, 'APPROVER');
    const token = login.body.data.token;
    return {
      call: (path, body) => call(path, { token, body }),
      optimize: (destinationFacilityId, quantity) => call('/plans/optimize', { token, body: { destinationFacilityId, medicineId: '7', quantity, horizonDays: 14 } }),
      decide: (planId, decision) => call(`/plans/${planId}/approve`, { token, body: { decision, note: `${decision}: live revalidation test.` } })
    };
  };

  // One digest per table, so "nothing changed" covers every row and column.
  const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (table) => {
    const [row] = await sql(`SELECT COUNT(*)::INT AS rows, COALESCE(md5(string_agg(t::TEXT, '|' ORDER BY t::TEXT)), '') AS digest FROM ${table} t`);
    return [table, row];
  })));
  const stockRow = async (facilityCode, batchNumber) => (await sql(
    `SELECT i.inventory_id AS id, i.quantity_on_hand::TEXT AS quantity FROM inventory i JOIN facilities f ON f.facility_id = i.facility_id
     JOIN batches b ON b.batch_id = i.batch_id WHERE f.facility_code = $1 AND b.batch_number = $2 AND b.medicine_id = 7 AND i.status = 'AVAILABLE'`,
    [facilityCode, batchNumber]
  ))[0];
  const setStock = (facilityCode, batchNumber, quantity) => sql(
    `UPDATE inventory i SET quantity_on_hand = $3 FROM facilities f, batches b
     WHERE f.facility_id = i.facility_id AND b.batch_id = i.batch_id AND f.facility_code = $1 AND b.batch_number = $2
       AND b.medicine_id = 7 AND i.status = 'AVAILABLE'`, [facilityCode, batchNumber, quantity]
  );
  const route = async (origin, destination) => (await sql(
    `SELECT r.route_id AS id, r.transport_time_hours::TEXT AS hours, r.cold_chain_capable AS "coldChain" FROM routes r
     JOIN facilities o ON o.facility_id = r.origin_facility_id JOIN facilities d ON d.facility_id = r.destination_facility_id
     WHERE o.facility_code = $1 AND d.facility_code = $2`, [origin, destination]
  ))[0];
  const planRows = async (planId) => ({
    plan: (await sql('SELECT status, plan_json AS "planJson" FROM plans WHERE plan_id = $1', [planId]))[0],
    transfers: await sql(
      `SELECT t.status, t.quantity::TEXT AS quantity, b.batch_number AS "batchNo", t.batch_id AS "batchId", o.facility_code AS "fromFacilityId"
       FROM transfers t JOIN batches b ON b.batch_id = t.batch_id JOIN facilities o ON o.facility_id = t.origin_facility_id
       WHERE t.plan_id = $1 ORDER BY t.transfer_id`, [planId]),
    audits: await sql('SELECT action, actor, after_state_json AS "afterState" FROM audit_events WHERE entity_id = $1 ORDER BY audit_id', [planId])
  });
  return { sql, proxy, startBackend, snapshot, stockRow, setStock, route, planRows };
}

const exactTransfers = (plan) => plan.transfers.map((transfer) => ({
  fromFacilityId: transfer.fromFacilityId, toFacilityId: transfer.toFacilityId, medicineId: transfer.medicineId, quantity: transfer.quantity,
  batchId: transfer.batchId, batchNo: transfer.batchNo, departureDay: transfer.departureDay, arrivalDay: transfer.arrivalDay
}));

test('golden flow: the Vellore plan is revalidated by Python before PostgreSQL reserves it', { skip: skipUnless('golden') }, async (t) => {
  const live = await startLive(t);
  assert.equal((await live.sql('SELECT COUNT(*)::INT AS count FROM plans'))[0].count, 0, 'the golden plan ID needs a fresh database');
  const api = await live.startBackend(live.proxy.url, 15000);

  const forecast = await api.call('/forecast', { facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });
  assert.equal(forecast.status, 200);
  assert.deepEqual([forecast.body.meta.source, forecast.body.meta.fallback, forecast.body.data.dataContext.dataSource], ['INTELLIGENCE_SERVICE', false, 'POSTGRES']);
  assert.equal(forecast.body.data.risk.label, 'CRITICAL');

  const optimized = await api.optimize('PHC-VLR-001', 300);
  assert.equal(optimized.status, 200, JSON.stringify(optimized.body));
  const plan = optimized.body.data;
  assert.deepEqual([plan.id, plan.status, plan.source, optimized.body.meta.fallback], [GOLDEN_PLAN_ID, 'PROPOSED', 'INTELLIGENCE_SERVICE', false]);
  const batch = await live.stockRow('WH-TN-001', 'TN-007-B01-26');
  const batchId = (await live.sql("SELECT batch_id FROM batches WHERE batch_number = 'TN-007-B01-26'"))[0].batch_id;
  assert.deepEqual(exactTransfers(plan), [{
    fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, batchId, batchNo: 'TN-007-B01-26', departureDay: 1, arrivalDay: 1
  }]);

  const retrieved = await api.call(`/plans/${GOLDEN_PLAN_ID}`);
  assert.deepEqual([retrieved.body.data.id, retrieved.body.data.status], [GOLDEN_PLAN_ID, 'PROPOSED']);
  assert.deepEqual(retrieved.body.data.transfers, plan.transfers);

  // While Python revalidates, the database still shows the plan proposed and the stock unreserved.
  const otherInventory = async () => (await live.sql(
    'SELECT COALESCE(md5(string_agg(t::TEXT, \'|\' ORDER BY t::TEXT)), \'\') AS digest FROM inventory t WHERE inventory_id <> $1', [batch.id]
  ))[0].digest;
  const otherInventoryBefore = await otherInventory();
  const before = await live.snapshot();
  const duringRevalidation = [];
  live.proxy.reset();
  live.proxy.beforeSimulate = async (call) => {
    duringRevalidation.push({ body: call.body, plan: (await live.planRows(GOLDEN_PLAN_ID)).plan.status, stock: (await live.stockRow('WH-TN-001', 'TN-007-B01-26')).quantity });
  };
  const approval = await api.decide(GOLDEN_PLAN_ID, 'APPROVE');
  assert.equal(approval.status, 200, JSON.stringify(approval.body));
  assert.deepEqual(live.proxy.urls(), ['/scenarios/simulate'], 'approval never calls /plans/optimize');
  assert.deepEqual(duringRevalidation, [{ body: { horizonDays: 14, transfers: exactTransfers(plan) }, plan: 'PROPOSED', stock: batch.quantity }]);
  assert.equal(live.proxy.calls[0].response.receivedStockCheck.passed, true);

  const { revalidation } = approval.body.data;
  assert.deepEqual([approval.body.data.plan.id, approval.body.data.plan.status, revalidation.performed, revalidation.dataSource], [GOLDEN_PLAN_ID, 'RESERVED', true, 'POSTGRES']);
  const stored = await live.planRows(GOLDEN_PLAN_ID);
  assert.equal(stored.plan.status, 'RESERVED');
  assert.deepEqual(stored.plan.planJson.transfers, plan.transfers, 'the stored plan and its transfers are unchanged');
  assert.deepEqual(stored.transfers, [{ status: 'RESERVED', quantity: '300.00', batchNo: 'TN-007-B01-26', batchId: plan.transfers[0].batchId, fromFacilityId: 'WH-TN-001' }]);
  assert.equal(stored.audits.length, 1);
  assert.deepEqual([stored.audits[0].action, stored.audits[0].afterState.revalidation.performed], ['RESERVE', true]);
  assert.equal(Number((await live.stockRow('WH-TN-001', 'TN-007-B01-26')).quantity), Number(batch.quantity) - 300);

  const after = await live.snapshot();
  for (const table of TABLES.filter((name) => !['inventory', 'plans', 'transfers', 'audit_events'].includes(name))) {
    assert.deepEqual(after[table], before[table], `${table} is unchanged`);
  }
  assert.deepEqual([after.plans.rows, after.transfers.rows, after.audit_events.rows], [before.plans.rows, before.transfers.rows + 1, before.audit_events.rows + 1]);
  assert.equal(await otherInventory(), otherInventoryBefore, 'no other inventory row changed');
  console.info(JSON.stringify({ goldenPlan: GOLDEN_PLAN_ID, status: stored.plan.status, reservedFrom: batch.quantity, checks: revalidation.checks }));
});

test('unsafe approvals change nothing; safe multi-donor approval, rejection and concurrency work', { skip: skipUnless('unsafe') }, async (t) => {
  const live = await startLive(t);
  const api = await live.startBackend(live.proxy.url, 15000);
  const plans = {};
  for (const [key, destination, quantity] of [['route', 'PHC-VLR-001', 250], ['coldChain', 'PHC-VLR-001', 200], ['race', 'PHC-VLR-001', 150], ['karur', 'PHC-KRR-001', 800], ['reject', 'PHC-VLR-001', 120]]) {
    const result = await api.optimize(destination, quantity);
    assert.equal(result.status, 200, `${key}: ${JSON.stringify(result.body)}`);
    plans[key] = result.body.data;
  }
  assert.deepEqual(plans.karur.transfers.map((item) => [item.fromFacilityId, item.batchNo, item.quantity]), [
    ['DH-CBE-001', 'TN-007-B01-26', 167.59], ['DH-MDU-001', 'TN-007-B01-26', 632.41]
  ]);

  const refuse = async (name, planId, expectedChecks, mutate, restore) => {
    await mutate();
    live.proxy.reset();
    const before = await live.snapshot();
    try {
      const result = await api.decide(planId, 'APPROVE');
      assert.equal(result.status, 409, `${name}: ${JSON.stringify(result.body)}`);
      assert.equal(result.body.error.code, 'PLAN_REVALIDATION_FAILED', name);
      const failed = result.body.error.details.failedChecks.map((item) => item.name);
      for (const check of expectedChecks) assert.ok(failed.includes(check), `${name}: ${check} in ${failed}`);
      assert.deepEqual(live.proxy.urls(), ['/scenarios/simulate'], name);
      assert.deepEqual(await live.snapshot(), before, `${name}: no table changed`);
      console.info(JSON.stringify({ case: name, status: result.status, failedChecks: failed, rejectedTransfers: result.body.error.details.rejectedTransfers.map((item) => item.rejectionCodes), unsafeDonors: result.body.error.details.unsafeDonors.map((item) => [item.facilityId, item.failureCodes, item.futureReplenishmentExcluded]) }));
      return result.body.error.details;
    } finally {
      await restore();
    }
  };

  const vellore = await live.route('WH-TN-001', 'PHC-VLR-001');
  const setRoute = (hours, coldChain) => live.sql('UPDATE routes SET transport_time_hours = $1, cold_chain_capable = $2 WHERE route_id = $3', [hours, coldChain, vellore.id]);
  const restoreRoute = () => setRoute(vellore.hours, vellore.coldChain);

  const routeDetails = await refuse('route over six hours', plans.route.id, ['ROUTES_WITHIN_TRAVEL_LIMIT', 'ALL_TRANSFERS_ELIGIBLE'], () => setRoute('6.50', true), restoreRoute);
  assert.deepEqual(routeDetails.rejectedTransfers[0].rejectionCodes, ['TRAVEL_TIME_LIMIT_EXCEEDED']);

  const coldDetails = await refuse('cold chain lost', plans.coldChain.id, ['COLD_CHAIN', 'ALL_TRANSFERS_ELIGIBLE'], () => setRoute(vellore.hours, false), restoreRoute);
  assert.ok(coldDetails.rejectedTransfers[0].rejectionCodes.includes('COLD_CHAIN_UNAVAILABLE'));

  // DH-CBE-001 now depends on its scheduled delivery: the simulator still calls the transfer safe.
  const cbe = await live.stockRow('DH-CBE-001', 'TN-007-B03-26');
  const futureDetails = await refuse('future-supply donor', plans.karur.id, ['DONORS_SAFE_ON_RECEIVED_STOCK'],
    () => live.setStock('DH-CBE-001', 'TN-007-B03-26', 300), () => live.setStock('DH-CBE-001', 'TN-007-B03-26', cbe.quantity));
  assert.deepEqual(futureDetails.failedChecks.map((item) => item.name), ['DONORS_SAFE_ON_RECEIVED_STOCK']);
  assert.equal(futureDetails.safeToRecommend, true);
  assert.deepEqual(futureDetails.unsafeDonors.map((item) => [item.facilityId, item.failureCodes]), [['DH-CBE-001', ['BELOW_RETAINED_FLOOR']]]);
  assert.ok(futureDetails.unsafeDonors[0].futureReplenishmentExcluded > 0);

  const mdu = await live.stockRow('DH-MDU-001', 'TN-007-B03-26');
  const unsafeDetails = await refuse('unsafe donor', plans.karur.id, ['ALL_TRANSFERS_ELIGIBLE', 'SAFE_TO_RECOMMEND', 'NO_NEW_RISKS'],
    () => live.setStock('DH-MDU-001', 'TN-007-B03-26', 500), () => live.setStock('DH-MDU-001', 'TN-007-B03-26', mdu.quantity));
  assert.ok(unsafeDetails.rejectedTransfers.some((item) => item.fromFacilityId === 'DH-MDU-001' && item.rejectionCodes.includes('BELOW_PROTECTED_STOCK')));

  // The service is stopped (nothing listens) or does not answer in time.
  const stopped = http.createServer();
  await new Promise((resolve) => stopped.listen(0, '127.0.0.1', resolve));
  const stoppedUrl = `http://127.0.0.1:${stopped.address().port}`;
  await new Promise((resolve) => stopped.close(resolve));
  const down = await live.startBackend(stoppedUrl, 15000);
  const slow = await live.startBackend(live.proxy.url, 500);
  for (const [name, backend, code, prepare] of [['service stopped', down, 'INTELLIGENCE_UNAVAILABLE', () => {}], ['timeout', slow, 'INTELLIGENCE_TIMEOUT', () => { live.proxy.mode = 'hang'; }]]) {
    live.proxy.reset();
    prepare();
    const before = await live.snapshot();
    const result = await backend.decide(plans.route.id, 'APPROVE');
    assert.deepEqual([result.status, result.body.error.code], [503, code], name);
    assert.deepEqual(await live.snapshot(), before, `${name}: no table changed`);
    console.info(JSON.stringify({ case: name, status: result.status, code: result.body.error.code }));
  }
  live.proxy.reset();

  // Another reservation takes the batch after Python has answered: the transaction rolls back.
  const warehouse = await live.stockRow('WH-TN-001', 'TN-007-B01-26');
  live.proxy.afterSimulate = async (call) => {
    assert.equal(call.response.comparison.safeToRecommend, true);
    await live.setStock('WH-TN-001', 'TN-007-B01-26', 100);
  };
  const beforeRace = await live.snapshot();
  const race = await api.decide(plans.race.id, 'APPROVE');
  assert.deepEqual([race.status, race.body.error.code], [409, 'PLAN_STOCK_CHANGED'], JSON.stringify(race.body));
  const afterRace = await live.snapshot();
  for (const table of TABLES.filter((name) => name !== 'inventory')) assert.deepEqual(afterRace[table], beforeRace[table], `race: ${table} unchanged`);
  assert.equal(Number((await live.stockRow('WH-TN-001', 'TN-007-B01-26')).quantity), 100, 'only the concurrent change remains');
  assert.equal((await live.planRows(plans.race.id)).plan.status, 'PROPOSED');
  console.info(JSON.stringify({ case: 'stock race', status: race.status, code: race.body.error.code, failures: race.body.error.details.failures.map((item) => item.reason) }));
  await live.setStock('WH-TN-001', 'TN-007-B01-26', warehouse.quantity);
  live.proxy.reset();

  // With every change restored, the two-donor plan is still safe. DH-MDU-001's batch row alone is below its safety
  // stock after the transfer; the facility as a whole is not.
  const mduRow = await live.stockRow('DH-MDU-001', 'TN-007-B01-26');
  const mduSafety = Number((await live.sql(`SELECT s.safety_stock_qty FROM facility_safety_stock s JOIN facilities f ON f.facility_id = s.facility_id
    WHERE f.facility_code = 'DH-MDU-001' AND s.medicine_id = 7`))[0].safety_stock_qty);
  assert.ok(Number(mduRow.quantity) - 632.41 < mduSafety);
  const karur = await api.decide(plans.karur.id, 'APPROVE');
  assert.equal(karur.status, 200, JSON.stringify(karur.body));
  assert.deepEqual(live.proxy.urls(), ['/scenarios/simulate']);
  const karurRows = await live.planRows(plans.karur.id);
  assert.deepEqual([karurRows.plan.status, karurRows.transfers.length, karurRows.audits.length], ['RESERVED', 2, 1]);
  assert.equal(Number((await live.stockRow('DH-MDU-001', 'TN-007-B01-26')).quantity), Math.round((Number(mduRow.quantity) - 632.41) * 100) / 100);

  // A repeated approval is refused before Python is called.
  live.proxy.reset();
  const repeated = await api.decide(plans.karur.id, 'APPROVE');
  assert.deepEqual([repeated.status, repeated.body.error.code, live.proxy.calls.length], [409, 'PLAN_ALREADY_DECIDED', 0]);

  // A human rejection needs no intelligence call and moves no stock.
  const beforeReject = await live.snapshot();
  const rejected = await api.decide(plans.reject.id, 'REJECT');
  assert.deepEqual([rejected.status, rejected.body.data.plan.status, live.proxy.calls.length], [200, 'REJECTED', 0]);
  const afterReject = await live.snapshot();
  assert.deepEqual(afterReject.inventory, beforeReject.inventory);
  assert.deepEqual((await live.planRows(plans.reject.id)).audits.map((item) => item.action), ['REJECT']);

  // Concurrent approvals of one plan reserve it once.
  const beforeStock = Number((await live.stockRow('WH-TN-001', 'TN-007-B01-26')).quantity);
  const concurrent = await Promise.all([1, 2, 3].map(() => api.decide(plans.coldChain.id, 'APPROVE')));
  assert.deepEqual(concurrent.map((item) => item.status).sort(), [200, 409, 409]);
  assert.ok(concurrent.filter((item) => item.status === 409).every((item) => item.body.error.code === 'PLAN_ALREADY_DECIDED'));
  const coldRows = await live.planRows(plans.coldChain.id);
  assert.deepEqual([coldRows.plan.status, coldRows.transfers.length, coldRows.audits.length], ['RESERVED', 1, 1]);
  assert.equal(Number((await live.stockRow('WH-TN-001', 'TN-007-B01-26')).quantity), Math.round((beforeStock - 200) * 100) / 100);
  console.info(JSON.stringify({ karur: karurRows.plan.status, rejected: rejected.body.data.plan.status, concurrent: concurrent.map((item) => item.body.error?.code || item.status) }));
});
