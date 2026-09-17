const assert = require('node:assert/strict');
const { test } = require('node:test');
const { types } = require('pg');
const { PostgresInventoryStore, postgresTypes } = require('../src/postgres-store');

const DATE_OID = 1082;
const INT4_OID = 23;
const TIMESTAMP_OID = 1114;

test('PostgreSQL DATE values stay YYYY-MM-DD text, as the MySQL store returns them', () => {
  const parseDate = postgresTypes.getTypeParser(DATE_OID, 'text');
  // A local-midnight Date would serialise as 2028-02-28T18:30:00.000Z in India (UTC+05:30).
  assert.equal(parseDate('2028-02-29'), '2028-02-29');
  assert.equal(JSON.stringify({ expiryDate: parseDate('2026-09-19') }), '{"expiryDate":"2026-09-19"}');
});

test('Only DATE parsing changes; numbers and timestamps keep the pg defaults', () => {
  assert.equal(postgresTypes.getTypeParser(INT4_OID, 'text'), types.getTypeParser(INT4_OID, 'text'));
  assert.equal(postgresTypes.getTypeParser(TIMESTAMP_OID, 'text'), types.getTypeParser(TIMESTAMP_OID, 'text'));
  assert.equal(postgresTypes.getTypeParser(DATE_OID, 'binary'), types.getTypeParser(DATE_OID, 'binary'));
});

test('The shared PostgreSQL pool uses the DATE-preserving parsers', async () => {
  // Creating a pg Pool does not connect; nothing is queried here.
  const store = new PostgresInventoryStore({ databaseUrl: 'postgresql://unused@127.0.0.1:1/unused', environment: 'development', simulationDate: '2026-09-11' });
  try {
    assert.equal(store.pool.options.types, postgresTypes);
  } finally {
    await store.pool.end();
  }
});
