const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createIntelligenceAdapter } = require('../src/intelligence-adapter');

test('database mode fallback forecasts against active database profiles', async () => {
  const requested = [];
  const inventoryStore = {
    source: 'MYSQL',
    async getScenarioProfile(facilityId, medicineId) {
      requested.push({ facilityId, medicineId });
      return {
        facilityId,
        medicineId,
        dailyDemand: 30,
        daysRemaining: 2,
        riskScore: 92,
        riskLabel: 'CRITICAL',
        incomingArrivalDay: 8
      };
    }
  };
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: '' }, inventoryStore);
  const forecast = await adapter.forecast({ facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });

  assert.deepEqual(requested, [{ facilityId: 'PHC-VLR-001', medicineId: '7' }]);
  assert.equal(forecast.source, 'DATABASE_FALLBACK');
  assert.equal(forecast.isFallback, true);
  assert.equal(forecast.cause, 'SUPPLY_DELAY');
});

