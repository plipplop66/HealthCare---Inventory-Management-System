const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createMysqlStore, project } = require('../src/mysql-store');

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

