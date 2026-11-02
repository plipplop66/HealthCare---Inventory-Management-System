const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

test('fresh MySQL seed creates explicit simulated plans for every historical transfer', () => {
  const schema = read('database/schema.sql');
  const historicalSeed = schema.slice(
    schema.indexOf('CREATE TEMPORARY TABLE sim_transfer_requests'),
    schema.indexOf('DROP TEMPORARY TABLE IF EXISTS sim_transfer_requests;', schema.indexOf('CREATE TEMPORARY TABLE sim_transfer_requests'))
  );

  assert.match(historicalSeed, /plan_id VARCHAR\(64\)/);
  assert.match(historicalSeed, /simulatedHistoricalRecord', TRUE/);
  assert.match(historicalSeed, /source', 'MYSQL_SCHEMA_SEED'/);
  assert.doesNotMatch(historicalSeed, /'COMPLETED'/);
  assert.ok(historicalSeed.indexOf('INSERT INTO plans') < historicalSeed.indexOf('INSERT INTO transfers'));
  assert.match(historicalSeed, /INSERT INTO transfers \(\s*plan_id,/);
  assert.match(schema, /DROP TABLE IF EXISTS transfers;\s*DROP TABLE IF EXISTS plans;/);
  assert.match(schema, /DELETE FROM transfers;\s*DELETE FROM plans;/);
});

test('lifecycle migration converts legacy status, backfills plans, and becomes strict in a safe order', () => {
  const migration = read('database/migrations/004_add_persistent_plans_and_lifecycle.sql');
  const convert = migration.indexOf("UPDATE transfers SET status = 'DELIVERED' WHERE status = 'COMPLETED'");
  const backfill = migration.indexOf('INSERT INTO plans (', convert);
  const link = migration.indexOf("SET plan_id = CONCAT('simulated-history-transfer-'", backfill);
  const notNull = migration.indexOf('MODIFY plan_id VARCHAR(64) NOT NULL', link);
  const foreignKey = migration.indexOf('ADD CONSTRAINT fk_tr_plan', notNull);

  assert.ok(convert > 0 && convert < backfill && backfill < link && link < notNull && notNull < foreignKey);
  assert.match(migration, /WHERE t\.plan_id IS NULL\s*ON DUPLICATE KEY UPDATE/);
  assert.match(migration, /simulatedHistoricalRecord', TRUE/);
  assert.match(migration, /source', 'MYSQL_LIFECYCLE_MIGRATION'/);
  assert.doesNotMatch(migration, /DELETE FROM transfers|TRUNCATE TABLE transfers/);
  assert.doesNotMatch(migration, /UPDATE inventory|DELETE FROM inventory|INSERT INTO audit_events/);
});

test('checked-in Compose initialization applies schema, golden data, users, then lifecycle migration', () => {
  for (const composePath of ['database/compose.yaml', 'compose.yaml']) {
    const compose = read(composePath);
    const expected = [
      '01-schema.sql',
      '02-add-rejected-status.sql',
      '03-golden-scenario.sql',
      '04-add-application-users.sql',
      '05-add-persistent-plans-and-lifecycle.sql'
    ];
    const positions = expected.map((name) => compose.indexOf(name));
    assert.ok(positions.every((position) => position >= 0), composePath);
    assert.deepEqual([...positions].sort((left, right) => left - right), positions, composePath);
  }
});
