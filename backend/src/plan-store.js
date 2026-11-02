const crypto = require('node:crypto');
const { AppError } = require('./errors');

function deterministicPlanId({ medicine, destinationFacilityId, horizonDays, transfers, simulation, source }) {
  const normalizedTransfers = [...transfers]
    .map((transfer) => ({
      fromFacilityId: String(transfer.fromFacilityId),
      toFacilityId: String(transfer.toFacilityId),
      medicineId: String(transfer.medicineId),
      batchId: String(transfer.batchId),
      batchNo: transfer.batchNo || null,
      quantity: Number(transfer.quantity).toFixed(2),
      departureDay: transfer.departureDay || 1,
      arrivalDay: transfer.arrivalDay || 1
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const payload = {
    destinationFacilityId: String(destinationFacilityId),
    medicineId: String(medicine?.id || normalizedTransfers[0]?.medicineId || ''),
    requestedQuantity: normalizedTransfers.reduce((total, transfer) => total + Number(transfer.quantity), 0).toFixed(2),
    horizonDays,
    dataSource: source || simulation?.dataContext?.dataSource || simulation?.source || 'LOCAL',
    simulationDate: simulation?.dataContext?.simulationDate || null,
    transfers: normalizedTransfers
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return `plan-${digest.slice(0, 32)}`;
}

function createPlanStore() {
  const plans = new Map();
  const audits = [];

  return {
    create({ id, medicine, destinationFacilityId, horizonDays, transfers, rationale, assumptions, simulation, ...extra }) {
      const planId = id || deterministicPlanId({ medicine, destinationFacilityId, horizonDays, transfers, simulation, source: extra.source });
      if (plans.has(planId)) return plans.get(planId);
      const plan = {
        id: planId,
        status: 'PROPOSED',
        medicine,
        destinationFacilityId,
        horizonDays,
        transfers,
        rationale,
        assumptions,
        simulation,
        decisionSupportOnly: true,
        ...extra
      };
      plans.set(plan.id, plan);
      return plan;
    },
    hydrate(plan) {
      if (!plan?.id) throw new AppError(500, 'PLAN_PERSISTENCE_FAILED', 'The database returned a plan without an identifier.');
      plans.set(plan.id, plan);
      return plan;
    },
    get(planId) {
      return plans.get(planId) || null;
    },
    // revalidation is the approval-time safety summary kept in the audit record; expectedDonorStock is the donor
    // inventory read before revalidation, which the database transaction requires to be unchanged.
    async decide(planId, { decision, actor, note, revalidation, expectedDonorStock }, inventoryStore) {
      const plan = plans.get(planId);
      if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'The requested plan was not found.');
      if (plan.status !== 'PROPOSED') {
        throw new AppError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.');
      }

      const afterStatus = decision === 'APPROVE'
        ? (['MYSQL', 'POSTGRES'].includes(inventoryStore.source) ? 'RESERVED' : 'APPROVED')
        : 'REJECTED';
      const beforeState = { status: plan.status, transfers: plan.transfers };
      const afterState = { status: afterStatus, transfers: plan.transfers, ...(revalidation ? { revalidation } : {}) };
      const persistence = await inventoryStore.recordPlanDecision({
        plan,
        decision,
        actor,
        note,
        beforeState,
        afterState,
        expectedDonorStock
      });
      const audit = {
        id: persistence.auditId || `audit-${audits.length + 1}`,
        planId,
        actor,
        action: decision === 'APPROVE' ? 'PLAN_APPROVED' : 'PLAN_REJECTED',
        note,
        timestamp: new Date().toISOString(),
        beforeState,
        afterState,
        persistence: persistence.storage
      };
      plan.status = persistence.planStatus || afterStatus;
      plan.decision = audit;
      audits.unshift(audit);
      return { plan, audit, persistence };
    },
    async transition(planId, { action, actor, note }, inventoryStore) {
      const plan = plans.get(planId);
      if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'The requested plan was not found.');
      const beforeState = { status: plan.status, transfers: plan.transfers };
      const persistence = await inventoryStore.transitionPlan({ plan, action, actor, note, beforeState });
      const afterStatus = persistence.planStatus;
      const afterState = { status: afterStatus, transfers: plan.transfers };
      const audit = {
        id: persistence.auditId || `audit-${audits.length + 1}`,
        planId,
        actor,
        action: `PLAN_${afterStatus}`,
        note,
        timestamp: new Date().toISOString(),
        beforeState,
        afterState,
        persistence: persistence.storage
      };
      plan.status = afterStatus;
      plan.decision = audit;
      audits.unshift(audit);
      return { plan, audit, persistence };
    },
    listAudits() {
      return audits;
    }
  };
}

module.exports = { createPlanStore, deterministicPlanId };

