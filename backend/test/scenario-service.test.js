const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createInventoryStore } = require('../src/inventory-store');
const { createPlanStore } = require('../src/plan-store');
const { optimisePlan, simulateScenario } = require('../src/scenario-service');

const store = createInventoryStore({ dataSource: 'fixture' });

test('simulation rejects a donor that loses protected coverage over the full horizon', async () => {
  const result = await simulateScenario({
    horizonDays: 14,
    transfers: [{
      fromFacilityId: 'facility-central-store',
      toFacilityId: 'facility-navjeevan-phc',
      medicineId: 'med-insulin-100iu-vial',
      quantity: 61,
      arrivalDay: 1
    }]
  }, store);

  assert.equal(result.transferEvaluations[0].eligible, false);
  assert.match(result.transferEvaluations[0].rejectionReasons[0], /protected safety stock/);
});

test('optimizer returns a safe plan that removes the PHC stockout during the selected horizon', async () => {
  const plan = await optimisePlan({
    destinationFacilityId: 'facility-navjeevan-phc',
    medicineId: 'med-insulin-100iu-vial',
    quantity: 45,
    horizonDays: 14
  }, store, createPlanStore());

  const recipientBefore = plan.simulation.baseline.facilities.find((facility) => facility.facilityId === 'facility-navjeevan-phc');
  const recipientAfter = plan.simulation.intervention.facilities.find((facility) => facility.facilityId === 'facility-navjeevan-phc');
  assert.equal(plan.transfers.length, 1);
  assert.equal(plan.transfers[0].fromFacilityId, 'facility-central-store');
  assert.equal(recipientBefore.stockoutDay, 3);
  assert.equal(recipientAfter.stockoutDay, null);
  assert.equal(plan.simulation.comparison.safeToRecommend, true);
});

test('local simulator and optimizer refuse database stores so they can never decide database safety', async () => {
  const profiles = [
    {
      facilityId: 'WH-001', facilityName: 'Warehouse', medicineId: '7',
      medicine: { id: '7', genericName: 'Human Insulin', requiresColdChain: true },
      effectiveStock: 1000, dailyDemand: 10, protectedStock: 100, safeSurplus: 900,
      daysRemaining: 100, riskLabel: 'LOW', riskScore: 14, hasColdChain: true, requiresColdChain: true
    },
    {
      facilityId: 'PHC-001', facilityName: 'PHC', medicineId: '7',
      medicine: { id: '7', genericName: 'Human Insulin', requiresColdChain: true },
      effectiveStock: 10, dailyDemand: 10, protectedStock: 100, safeSurplus: 0,
      daysRemaining: 1, riskLabel: 'CRITICAL', riskScore: 92, hasColdChain: true, requiresColdChain: true
    }
  ];
  const databaseStore = {
    source: 'MYSQL',
    async getScenarioProfile(facilityId) {
      return profiles.find((profile) => profile.facilityId === facilityId) || null;
    },
    async listScenarioProfiles() {
      return profiles;
    },
    async getRoute() {
      return { distanceKm: 10, travelHours: 1, coldChainAvailable: true };
    },
    async selectTransferBatch() {
      return { batchId: 99, batchNo: 'INS-99' };
    }
  };
  for (const source of ['MYSQL', 'POSTGRES', undefined]) {
    const store = { ...databaseStore, source };
    await assert.rejects(optimisePlan({
      destinationFacilityId: 'PHC-001', medicineId: 'med-insulin-100iu-vial', quantity: 40, horizonDays: 7
    }, store, createPlanStore()), { status: 503, code: 'INTELLIGENCE_UNAVAILABLE' });
    await assert.rejects(simulateScenario({
      horizonDays: 7, transfers: [{ fromFacilityId: 'WH-001', toFacilityId: 'PHC-001', medicineId: '7', quantity: 40, arrivalDay: 1 }]
    }, store), { status: 503, code: 'INTELLIGENCE_UNAVAILABLE' });
  }
});
