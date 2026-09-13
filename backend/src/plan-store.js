const crypto = require('node:crypto');
const { AppError } = require('./errors');

function createPlanStore() {
  const plans = new Map();
  const audits = [];

  return {
    create({ medicine, destinationFacilityId, horizonDays, transfers, rationale, assumptions, simulation }) {
      const plan = {
        id: `plan-${crypto.randomUUID()}`,
        status: 'PROPOSED',
        medicine,
        destinationFacilityId,
        horizonDays,
        transfers,
        rationale,
        assumptions,
        simulation,
        decisionSupportOnly: true
      };
      plans.set(plan.id, plan);
      return plan;
    },
    get(planId) {
      return plans.get(planId) || null;
    },
    async decide(planId, { decision, actor, note }, inventoryStore) {
      const plan = plans.get(planId);
      if (!plan) throw new AppError(404, 'PLAN_NOT_FOUND', 'The requested plan was not found.');
      if (plan.status !== 'PROPOSED') {
        throw new AppError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.');
      }

      const afterStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      const beforeState = { status: plan.status, transfers: plan.transfers };
      const afterState = { status: afterStatus, transfers: plan.transfers };
      const persistence = await inventoryStore.recordPlanDecision({
        plan,
        decision,
        actor,
        note,
        beforeState,
        afterState
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

module.exports = { createPlanStore };

