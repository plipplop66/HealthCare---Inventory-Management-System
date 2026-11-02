const assert = require('node:assert/strict');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { createMysqlStore } = require('../src/mysql-store');

const enabled = process.env.MEDRIPPLE_LIVE_MYSQL_CONCURRENCY === '1';
const host = process.env.DATABASE_HOST || '127.0.0.1';
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

const config = {
  databaseUrl: '',
  databaseHost: host,
  databasePort: Number(process.env.DATABASE_PORT || 3306),
  databaseName: process.env.DATABASE_NAME || 'medripple',
  databaseUser: process.env.DATABASE_USER || 'medripple',
  databasePassword: process.env.DATABASE_PASSWORD || 'medripple_dev_only',
  simulationDate: '2026-09-11'
};

test('live MySQL reservation contention is atomic and never becomes DATABASE_UNAVAILABLE', { skip: !enabled }, async (t) => {
  assert.ok(localHosts.has(host), 'Live concurrency tests are restricted to disposable local MySQL instances.');
  const pool = mysql.createPool({
    host: config.databaseHost,
    port: config.databasePort,
    database: config.databaseName,
    user: config.databaseUser,
    password: config.databasePassword,
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
    dateStrings: ['DATE']
  });
  const store = createMysqlStore(config, { pool });
  const suffix = `${process.pid}-${Date.now()}`;
  const prefix = `test-concurrency-${suffix}`;
  const codes = {
    donorA: `TCA-${String(process.pid).slice(-5)}`,
    donorB: `TCB-${String(process.pid).slice(-5)}`,
    destination: `TCD-${String(process.pid).slice(-5)}`
  };
  const ids = { plans: [] };

  t.after(async () => {
    if (ids.plans.length > 0) {
      await pool.query('DELETE FROM audit_events WHERE entity_type = ? AND entity_id IN (?)', ['plan', ids.plans]);
      await pool.query('DELETE FROM transfers WHERE plan_id IN (?)', [ids.plans]);
      await pool.query('DELETE FROM plans WHERE plan_id IN (?)', [ids.plans]);
    }
    if (ids.facilities) {
      await pool.query('DELETE FROM inventory WHERE facility_id IN (?)', [ids.facilities]);
      await pool.query('DELETE FROM facility_safety_stock WHERE facility_id IN (?)', [ids.facilities]);
    }
    if (ids.batches) await pool.query('DELETE FROM batches WHERE batch_id IN (?)', [ids.batches]);
    if (ids.medicine) await pool.query('DELETE FROM medicines WHERE medicine_id = ?', [ids.medicine]);
    if (ids.facilities) await pool.query('DELETE FROM facilities WHERE facility_id IN (?)', [ids.facilities]);
    await store.close();
  });

  for (const [code, name, type] of [
    [codes.donorA, `${prefix} donor A`, 'Warehouse'],
    [codes.donorB, `${prefix} donor B`, 'Warehouse'],
    [codes.destination, `${prefix} destination`, 'PHC']
  ]) {
    const [result] = await pool.query(
      `INSERT INTO facilities (
        facility_code, name, facility_type, region, latitude, longitude,
        population_served, remoteness_score, storage_capacity_ml, has_cold_chain
      ) VALUES (?, ?, ?, 'TEST', 0, 0, 1, 0, 10000, TRUE)`,
      [code, name, type]
    );
    ids.facilities ||= [];
    ids.facilities.push(result.insertId);
  }
  const [medicineResult] = await pool.query(
    `INSERT INTO medicines (
      generic_name, strength_value, strength_unit, form, base_unit,
      storage_temp_min_c, storage_temp_max_c, requires_cold_chain,
      criticality_level, shelf_life_days
    ) VALUES (?, 1, 'mg', 'Test', 'count', 2, 8, TRUE, 'HIGH', 730)`,
    [`${prefix} medicine`]
  );
  ids.medicine = medicineResult.insertId;
  ids.batches = [];
  for (const batchNo of [`${prefix}-A`, `${prefix}-B`]) {
    const [result] = await pool.query(
      `INSERT INTO batches (
        medicine_id, batch_number, manufacture_date, expiry_date,
        quantity_received, supplier_name, quarantined
      ) VALUES (?, ?, '2026-01-01', '2028-12-31', 1000, 'Test only', FALSE)`,
      [ids.medicine, batchNo]
    );
    ids.batches.push(result.insertId);
  }
  const [donorA, donorB, destination] = ids.facilities;
  await pool.query(
    `INSERT INTO inventory (facility_id, batch_id, quantity_on_hand, status)
     VALUES (?, ?, 100, 'AVAILABLE'), (?, ?, 100, 'AVAILABLE'), (?, ?, 100, 'AVAILABLE')`,
    [donorA, ids.batches[0], donorA, ids.batches[1], donorB, ids.batches[1]]
  );
  await pool.query(
    `INSERT INTO facility_safety_stock (facility_id, medicine_id, safety_stock_qty, basis, confirmed_by_aaryan)
     VALUES (?, ?, 0, 'Concurrency test only', TRUE), (?, ?, 0, 'Concurrency test only', TRUE)`,
    [donorA, ids.medicine, donorB, ids.medicine]
  );

  const batchNumbers = [`${prefix}-A`, `${prefix}-B`];
  const transfer = (fromFacilityId, batchIndex, quantity) => ({
    fromFacilityId,
    toFacilityId: codes.destination,
    medicineId: String(ids.medicine),
    batchId: ids.batches[batchIndex],
    batchNo: batchNumbers[batchIndex],
    quantity,
    departureDay: 1,
    arrivalDay: 1
  });
  const createPlan = async (label, transfers) => {
    const plan = {
      id: `${prefix}-${label}`,
      status: 'PROPOSED',
      destinationFacilityId: codes.destination,
      requestedQuantity: transfers.reduce((sum, item) => sum + item.quantity, 0),
      horizonDays: 14,
      medicine: { id: String(ids.medicine) },
      rationale: 'Disposable local MySQL concurrency test.',
      transfers
    };
    ids.plans.push(plan.id);
    await store.persistPlan(plan);
    return plan;
  };
  const approve = (plan) => store.recordPlanDecision({
    plan,
    decision: 'APPROVE',
    actor: 'Concurrency Test <local@test.invalid>',
    note: 'Disposable local contention test.',
    beforeState: { status: 'PROPOSED' },
    afterState: { status: 'RESERVED' }
  });
  const runTogether = (...plans) => Promise.allSettled(plans.map(approve));
  const assertNoAvailabilityError = (results) => {
    for (const result of results) {
      if (result.status === 'rejected') assert.notEqual(result.reason.code, 'DATABASE_UNAVAILABLE');
    }
  };
  const setStock = async (first, second = 100, donorBQuantity = 100) => {
    await pool.query(
      `UPDATE inventory SET quantity_on_hand = CASE
         WHEN facility_id = ? AND batch_id = ? THEN ?
         WHEN facility_id = ? AND batch_id = ? THEN ?
         WHEN facility_id = ? AND batch_id = ? THEN ?
         ELSE quantity_on_hand END
       WHERE (facility_id = ? AND batch_id IN (?)) OR (facility_id = ? AND batch_id = ?)`,
      [
        donorA, ids.batches[0], first,
        donorA, ids.batches[1], second,
        donorB, ids.batches[1], donorBQuantity,
        donorA, ids.batches, donorB, ids.batches[1]
      ]
    );
  };
  const quantity = async (facilityId, batchId) => {
    const [rows] = await pool.query(
      'SELECT quantity_on_hand AS quantity FROM inventory WHERE facility_id = ? AND batch_id = ? AND status = \'AVAILABLE\'',
      [facilityId, batchId]
    );
    return Number(rows[0].quantity);
  };
  const counts = async (planIds) => {
    const [transfers] = await pool.query('SELECT COUNT(*) AS count FROM transfers WHERE plan_id IN (?)', [planIds]);
    const [audits] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE entity_type = 'plan' AND entity_id IN (?)", [planIds]);
    const [plans] = await pool.query('SELECT plan_id AS id, status FROM plans WHERE plan_id IN (?) ORDER BY plan_id', [planIds]);
    return { transfers: Number(transfers[0].count), audits: Number(audits[0].count), plans };
  };

  assert.deepEqual(await store.getHealth(), { connected: true, mode: 'mysql' });

  await t.test('the same plan reserves once', async () => {
    await setStock(100);
    const plan = await createPlan('same-plan', [transfer(codes.donorA, 0, 20)]);
    const results = await runTogether(plan, plan);
    assertNoAvailabilityError(results);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'PLAN_ALREADY_DECIDED');
    assert.equal(await quantity(donorA, ids.batches[0]), 80);
    assert.deepEqual(await counts([plan.id]), {
      transfers: 1,
      audits: 1,
      plans: [{ id: plan.id, status: 'RESERVED' }]
    });
  });

  await t.test('different plans using the same donor serialize when stock is sufficient', async () => {
    await setStock(100);
    const plans = await Promise.all([
      createPlan('same-donor-a', [transfer(codes.donorA, 0, 20)]),
      createPlan('same-donor-b', [transfer(codes.donorA, 0, 20)])
    ]);
    const results = await runTogether(...plans);
    assertNoAvailabilityError(results);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.equal(await quantity(donorA, ids.batches[0]), 60);
    const state = await counts(plans.map((plan) => plan.id));
    assert.deepEqual([state.transfers, state.audits], [2, 2]);
    assert.ok(state.plans.every((plan) => plan.status === 'RESERVED'));
  });

  await t.test('different plans using overlapping batches serialize without duplicates', async () => {
    await setStock(100, 100);
    const plans = await Promise.all([
      createPlan('overlap-a', [transfer(codes.donorA, 0, 20), transfer(codes.donorA, 1, 10)]),
      createPlan('overlap-b', [transfer(codes.donorA, 1, 20), transfer(codes.donorA, 0, 10)])
    ]);
    const results = await runTogether(...plans);
    assertNoAvailabilityError(results);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.deepEqual([
      await quantity(donorA, ids.batches[0]),
      await quantity(donorA, ids.batches[1])
    ], [70, 70]);
    const state = await counts(plans.map((plan) => plan.id));
    assert.deepEqual([state.transfers, state.audits], [4, 2]);
  });

  await t.test('multi-donor plans with opposite input order acquire the same lock order', async () => {
    await setStock(100, 100, 100);
    const plans = await Promise.all([
      createPlan('opposite-a', [transfer(codes.donorA, 0, 10), transfer(codes.donorB, 1, 10)]),
      createPlan('opposite-b', [transfer(codes.donorB, 1, 10), transfer(codes.donorA, 0, 10)])
    ]);
    const results = await runTogether(...plans);
    assertNoAvailabilityError(results);
    assert.ok(results.every((result) => result.status === 'fulfilled'));
    assert.deepEqual([
      await quantity(donorA, ids.batches[0]),
      await quantity(donorB, ids.batches[1])
    ], [80, 80]);
    const state = await counts(plans.map((plan) => plan.id));
    assert.deepEqual([state.transfers, state.audits], [4, 2]);
  });

  await t.test('insufficient combined stock permits only one complete reservation', async () => {
    await setStock(60);
    const plans = await Promise.all([
      createPlan('insufficient-a', [transfer(codes.donorA, 0, 40)]),
      createPlan('insufficient-b', [transfer(codes.donorA, 0, 40)])
    ]);
    const results = await runTogether(...plans);
    assertNoAvailabilityError(results);
    assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'PLAN_STOCK_CHANGED');
    assert.equal(await quantity(donorA, ids.batches[0]), 20);
    const state = await counts(plans.map((plan) => plan.id));
    assert.deepEqual([state.transfers, state.audits], [1, 1]);
    assert.deepEqual(state.plans.map((plan) => plan.status).sort(), ['PROPOSED', 'RESERVED']);
  });
});
