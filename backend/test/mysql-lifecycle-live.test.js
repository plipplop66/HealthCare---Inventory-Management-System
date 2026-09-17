const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const mysql = require('mysql2/promise');
const { createApp } = require('../src/app');
const { createMysqlStore } = require('../src/mysql-store');
const { createMemoryAuthStore } = require('./support/fake-persistent-store');

const enabled = process.env.MEDRIPPLE_LIVE_MYSQL_LIFECYCLE === '1';
const host = process.env.DATABASE_HOST || '127.0.0.1';
const port = Number(process.env.DATABASE_PORT || 3306);
const database = process.env.DATABASE_NAME || 'medripple';
const user = process.env.DATABASE_USER || 'medripple';
const password = process.env.DATABASE_PASSWORD || 'medripple_dev_only';
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);
const migrationPath = path.resolve(__dirname, '..', '..', 'database', 'migrations', '004_add_persistent_plans_and_lifecycle.sql');

function poolOptions(overrides = {}) {
  return {
    host,
    port,
    user,
    password,
    database,
    waitForConnections: true,
    connectionLimit: 5,
    decimalNumbers: true,
    dateStrings: ['DATE'],
    multipleStatements: true,
    ...overrides
  };
}

test('live checked-in MySQL initialization and legacy lifecycle migration are valid and idempotent', { skip: !enabled }, async (t) => {
  assert.ok(localHosts.has(host), 'Live lifecycle tests are restricted to disposable local MySQL instances.');
  assert.equal(database, 'medripple', 'Fresh Compose verification must target its checked-in medripple database.');
  const pool = mysql.createPool(poolOptions());
  const store = createMysqlStore({
    databaseUrl: '', databaseHost: host, databasePort: port, databaseName: database,
    databaseUser: user, databasePassword: password, simulationDate: '2026-09-11'
  }, { pool });
  t.after(() => store.close());

  const [seedCounts] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM facilities WHERE facility_code IN (
        'WH-TN-001','DH-CBE-001','DH-MDU-001','CHC-TRY-001','CHC-SLM-001',
        'PHC-VLR-001','PHC-TNJ-001','PHC-TNV-001','SC-DPI-001','SC-RMD-001'
      )) AS facilities,
      (SELECT COUNT(*) FROM medicines WHERE generic_name IN (
        'Paracetamol','Amoxicillin','Azithromycin','Metformin','Amlodipine','Oral Rehydration Salts',
        'Human Insulin','Oxytocin','Rabies Vaccine','Adrenaline Auto-Injector','Salbutamol','Ceftriaxone'
      )) AS medicines,
      (SELECT COUNT(*) FROM consumption c JOIN facilities f ON f.facility_id = c.facility_id
       WHERE f.facility_code IN (
        'WH-TN-001','DH-CBE-001','DH-MDU-001','CHC-TRY-001','CHC-SLM-001',
        'PHC-VLR-001','PHC-TNJ-001','PHC-TNV-001','SC-DPI-001','SC-RMD-001'
      )) AS consumption,
      (SELECT COUNT(*) FROM inventory i JOIN facilities f ON f.facility_id = i.facility_id
       WHERE f.facility_code IN (
        'WH-TN-001','DH-CBE-001','DH-MDU-001','CHC-TRY-001','CHC-SLM-001',
        'PHC-VLR-001','PHC-TNJ-001','PHC-TNV-001','SC-DPI-001','SC-RMD-001'
      )) AS inventory,
      (SELECT COUNT(*) FROM transfers WHERE plan_id LIKE 'simulated-history-transfer-%') AS transfers,
      (SELECT COUNT(*) FROM app_users WHERE email = 'demo.approver@medripple.demo') AS users
  `);
  assert.deepEqual(seedCounts[0], {
    facilities: 10,
    medicines: 12,
    consumption: 8100,
    inventory: 240,
    transfers: 8,
    users: 1
  });

  const [history] = await pool.query(`
    SELECT
      COUNT(*) AS transferCount,
      SUM(t.plan_id IS NULL) AS missingPlan,
      SUM(p.plan_id IS NULL) AS invalidPlan,
      SUM(t.status = 'DELIVERED') AS delivered,
      SUM(JSON_EXTRACT(p.plan_json, '$.simulatedHistoricalRecord') = TRUE) AS simulatedPlans
    FROM transfers t
    LEFT JOIN plans p ON p.plan_id = t.plan_id
    WHERE t.plan_id LIKE 'simulated-history-transfer-%'
  `);
  assert.deepEqual(history[0], {
    transferCount: 8,
    missingPlan: 0,
    invalidPlan: 0,
    delivered: 3,
    simulatedPlans: 8
  });
  const [invalidLifecycle] = await pool.query(`
    SELECT COUNT(*) AS count
    FROM transfers t
    LEFT JOIN plans p ON p.plan_id = t.plan_id
    WHERE t.plan_id IS NULL OR p.plan_id IS NULL OR t.status = 'COMPLETED'
  `);
  assert.equal(Number(invalidLifecycle[0].count), 0);

  const [golden] = await pool.query(`
    SELECT SUM(i.quantity_on_hand) AS quantity
    FROM inventory i
    JOIN batches b ON b.batch_id = i.batch_id
    JOIN facilities f ON f.facility_id = i.facility_id
    JOIN medicines m ON m.medicine_id = b.medicine_id
    WHERE f.facility_code = 'PHC-VLR-001' AND m.generic_name = 'Human Insulin'
  `);
  assert.equal(Number(golden[0].quantity), 34);

  const app = createApp({
    environment: 'test', corsOrigins: [], simulationDate: '2026-09-11',
    intelligenceServiceUrl: '', intelligenceTimeoutMs: 1000
  }, { inventoryStore: store, authStore: createMemoryAuthStore() });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`);
  const body = await response.json();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(response.status, 200);
  assert.deepEqual(body.data.database, { connected: true, mode: 'mysql' });
  assert.equal(body.data.dataSource, 'MYSQL');

  const [beforeRerun] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM plans) AS plans,
      (SELECT COUNT(*) FROM transfers) AS transfers,
      (SELECT COUNT(*) FROM audit_events) AS audits,
      (SELECT COUNT(*) FROM inventory) AS inventory
  `);
  await pool.query(fs.readFileSync(migrationPath, 'utf8'));
  const [afterRerun] = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM plans) AS plans,
      (SELECT COUNT(*) FROM transfers) AS transfers,
      (SELECT COUNT(*) FROM audit_events) AS audits,
      (SELECT COUNT(*) FROM inventory) AS inventory
  `);
  assert.deepEqual(afterRerun[0], beforeRerun[0]);

  const legacyDatabase = `medripple_legacy_test_${process.pid}_${Date.now()}`;
  assert.match(legacyDatabase, /^[a-z0-9_]+$/);
  const admin = await mysql.createConnection(poolOptions({
    user: process.env.MYSQL_TEST_ADMIN_USER || 'root',
    password: process.env.MYSQL_TEST_ADMIN_PASSWORD || 'root_dev_only',
    database: undefined
  }));
  t.after(async () => {
    await admin.query(`DROP DATABASE IF EXISTS \`${legacyDatabase}\``);
    await admin.end();
  });
  await admin.query(`CREATE DATABASE \`${legacyDatabase}\``);
  await admin.query(`USE \`${legacyDatabase}\``);
  await admin.query(`
    CREATE TABLE facilities (facility_id INT PRIMARY KEY, facility_code VARCHAR(20) NOT NULL);
    CREATE TABLE medicines (medicine_id INT PRIMARY KEY, generic_name VARCHAR(120) NOT NULL);
    CREATE TABLE inventory (
      inventory_id INT PRIMARY KEY AUTO_INCREMENT,
      facility_id INT NOT NULL,
      batch_id INT NOT NULL,
      quantity_on_hand DECIMAL(12,2) NOT NULL,
      status ENUM('AVAILABLE','RESERVED','QUARANTINED','EXPIRED') NOT NULL DEFAULT 'AVAILABLE'
    );
    CREATE TABLE transfers (
      transfer_id INT PRIMARY KEY AUTO_INCREMENT,
      origin_facility_id INT NOT NULL,
      destination_facility_id INT NOT NULL,
      medicine_id INT NOT NULL,
      batch_id INT NOT NULL,
      quantity DECIMAL(12,2) NOT NULL,
      status ENUM('PROPOSED','REJECTED_UNSAFE','APPROVED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PROPOSED',
      rejection_reason VARCHAR(200),
      requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      approved_at TIMESTAMP NULL,
      approved_by VARCHAR(120),
      note VARCHAR(500)
    );
    CREATE TABLE audit_events (
      audit_id INT PRIMARY KEY AUTO_INCREMENT,
      entity_id INT NOT NULL
    );
    INSERT INTO facilities VALUES (1, 'LEGACY-A'), (2, 'LEGACY-B');
    INSERT INTO medicines VALUES (1, 'Legacy Medicine');
    INSERT INTO inventory (facility_id, batch_id, quantity_on_hand, status) VALUES (1, 1, 500, 'AVAILABLE');
    INSERT INTO transfers (
      origin_facility_id, destination_facility_id, medicine_id, batch_id, quantity,
      status, requested_at, approved_at, approved_by, note
    ) VALUES
      (1, 2, 1, 1, 40, 'COMPLETED', '2026-08-01 09:30:00', '2026-08-01 13:30:00', 'Legacy Approver', 'Delivered legacy history'),
      (1, 2, 1, 1, 20, 'REJECTED_UNSAFE', '2026-08-02 09:30:00', NULL, NULL, 'Rejected legacy history');
  `);

  const migration = fs.readFileSync(migrationPath, 'utf8')
    .replace('USE medripple;', `USE \`${legacyDatabase}\`;`);
  await admin.query(migration);
  const [legacyFirst] = await admin.query(`
    SELECT
      (SELECT COUNT(*) FROM transfers) AS transfers,
      (SELECT COUNT(*) FROM plans) AS plans,
      (SELECT COUNT(*) FROM audit_events) AS audits,
      (SELECT COUNT(*) FROM inventory) AS inventory,
      (SELECT COUNT(*) FROM transfers WHERE plan_id IS NULL) AS missingPlan,
      (SELECT COUNT(*) FROM transfers WHERE status = 'DELIVERED') AS delivered,
      (SELECT COUNT(*) FROM plans WHERE JSON_EXTRACT(plan_json, '$.simulatedHistoricalRecord') = TRUE) AS simulatedPlans
  `);
  assert.deepEqual(legacyFirst[0], {
    transfers: 2,
    plans: 2,
    audits: 0,
    inventory: 1,
    missingPlan: 0,
    delivered: 1,
    simulatedPlans: 2
  });
  await admin.query(migration);
  const [legacySecond] = await admin.query(`
    SELECT
      (SELECT COUNT(*) FROM transfers) AS transfers,
      (SELECT COUNT(*) FROM plans) AS plans,
      (SELECT COUNT(*) FROM audit_events) AS audits,
      (SELECT COUNT(*) FROM inventory) AS inventory,
      (SELECT COUNT(*) FROM transfers WHERE plan_id IS NULL) AS missingPlan,
      (SELECT COUNT(*) FROM transfers WHERE status = 'DELIVERED') AS delivered,
      (SELECT COUNT(*) FROM plans WHERE JSON_EXTRACT(plan_json, '$.simulatedHistoricalRecord') = TRUE) AS simulatedPlans
  `);
  assert.deepEqual(legacySecond[0], legacyFirst[0]);
});
