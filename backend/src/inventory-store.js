const fixture = require('./fixture-store');
const { createMysqlStore } = require('./mysql-store');

function createFixtureStore() {
  return {
    source: 'FIXTURE_STORE',
    async getHealth() {
      return { connected: true, mode: 'fixture' };
    },
    async listFacilities() {
      return fixture.listFacilities();
    },
    async getInventory(facilityId) {
      return fixture.getInventory(facilityId);
    },
    async listMedicines() {
      return [fixture.medicine];
    },
    async getScenarioProfile(facilityId, medicineId) {
      return fixture.getScenarioProfile(facilityId, medicineId);
    },
    async listScenarioProfiles(medicineId) {
      return fixture.listScenarioProfiles(medicineId);
    },
    async getRoute(fromFacilityId, toFacilityId) {
      return fixture.getRoute(fromFacilityId, toFacilityId);
    },
    async selectTransferBatch(facilityId, medicineId) {
      return fixture.selectTransferBatch(facilityId, medicineId);
    },
    async recordPlanDecision() {
      return { storage: 'MEMORY' };
    },
    async listAuditEvents() {
      return [];
    }
  };
}

function createInventoryStore(config) {
  if (config.dataSource === 'mysql') return createMysqlStore(config);
  return createFixtureStore();
}

module.exports = { createInventoryStore };
