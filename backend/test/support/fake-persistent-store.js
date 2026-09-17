// An in-memory stand-in for a database store (source POSTGRES) and an in-memory account store, for route tests.
// Approval uses the real reservation checks and changes nothing unless all of them pass, as the database transaction
// does. This file is not a test itself.
const { AppError } = require('../../src/errors');
const { DEMO_APPROVER } = require('../../src/auth');
const { assertReservable, normaliseDonorRows } = require('../../src/reservation-guard');

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value) => Math.round(value * 100) / 100;

function createFakePersistentStore(events = []) {
  const state = {
    plans: new Map(),
    inventory: [
      { inventoryId: 268, facilityCode: 'WH-TN-001', batchId: 14, batchNo: 'TN-007-B01-26', medicineId: '7', status: 'AVAILABLE', quarantined: false, expiryDate: '2028-02-29', quantity: 51120 },
      { inventoryId: 269, facilityCode: 'WH-TN-001', batchId: 13, batchNo: 'TN-007-B02-26', medicineId: '7', status: 'AVAILABLE', quarantined: false, expiryDate: '2028-04-24', quantity: 51120 }
    ],
    safety: new Map(),
    transfers: [],
    audits: []
  };
  const donorRows = (plan) => state.inventory.filter((row) => row.medicineId === String(plan.medicine?.id)
    && plan.transfers.some((transfer) => transfer.fromFacilityId === row.facilityCode));

  return {
    source: 'POSTGRES',
    state,
    events,
    snapshot() {
      return clone({ plans: [...state.plans], inventory: state.inventory, transfers: state.transfers, audits: state.audits });
    },
    async getHealth() { return { connected: true, mode: 'fake-postgres' }; },
    async assertQuantityPrecision() {},
    async listFacilities() { return []; },
    async listMedicines() { return []; },
    async getInventory() { return null; },
    async getScenarioProfile(facilityId, medicineId) {
      return { facilityId, medicineId, dailyDemand: 30, daysRemaining: 1, riskScore: 92, riskLabel: 'CRITICAL', incomingArrivalDay: 8 };
    },
    async persistPlan(plan) {
      events.push('store:persistPlan');
      if (!state.plans.has(plan.id)) state.plans.set(plan.id, clone({ ...plan, status: 'PROPOSED' }));
      return { plan: clone(state.plans.get(plan.id)) };
    },
    async getPlan(planId) {
      return state.plans.has(planId) ? clone(state.plans.get(planId)) : null;
    },
    async readDonorStock(plan) {
      events.push('store:readDonorStock');
      return normaliseDonorRows(donorRows(plan));
    },
    async recordPlanDecision({ plan, decision, actor, note, beforeState, afterState, expectedDonorStock }) {
      events.push(`store:recordPlanDecision:${decision}`);
      const stored = state.plans.get(plan.id);
      if (!stored || stored.status !== 'PROPOSED') {
        throw new AppError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.');
      }
      const planStatus = decision === 'APPROVE' ? 'RESERVED' : 'REJECTED';
      if (decision === 'APPROVE') {
        assertReservable({ plan, rows: donorRows(plan), safetyStock: state.safety, simulationDate: '2026-09-11', expectedRows: expectedDonorStock });
        for (const transfer of plan.transfers) {
          const row = state.inventory.find((item) => item.facilityCode === transfer.fromFacilityId
            && String(item.batchId) === String(transfer.batchId) && item.status === 'AVAILABLE');
          row.quantity = round(row.quantity - transfer.quantity);
        }
      }
      stored.status = planStatus;
      const transferIds = plan.transfers.map((transfer) => {
        state.transfers.push({
          id: state.transfers.length + 1, planId: plan.id, fromFacilityId: transfer.fromFacilityId, batchId: transfer.batchId,
          quantity: transfer.quantity, status: planStatus
        });
        return state.transfers.length;
      });
      state.audits.push({
        id: state.audits.length + 1, entityId: plan.id, action: decision === 'APPROVE' ? 'RESERVE' : 'REJECT', actor, note,
        beforeState: clone(beforeState), afterState: clone(afterState)
      });
      return { storage: 'POSTGRES', planStatus, auditId: state.audits.length, transferIds };
    },
    async transitionPlan() {
      throw new AppError(409, 'INVALID_PLAN_TRANSITION', 'Not used in these tests.');
    },
    async listAuditEvents() {
      return clone(state.audits);
    }
  };
}

function createMemoryAuthStore() {
  const users = new Map([[DEMO_APPROVER.email, { ...DEMO_APPROVER }]]);
  return {
    source: 'MEMORY',
    async findByEmail(email) { return users.has(email) ? { ...users.get(email) } : null; },
    async create(user) { users.set(user.email, { ...user }); return { ...user }; },
    async recordLogin() {}
  };
}

module.exports = { createFakePersistentStore, createMemoryAuthStore };
