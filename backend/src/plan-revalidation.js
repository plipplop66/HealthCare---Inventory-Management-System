// Approval-time revalidation: the stored plan's exact transfers go back through the intelligence service's
// POST /scenarios/simulate, and stock is reserved only if every condition below holds. The plan is never regenerated
// or re-optimized; a failure leaves the database untouched and asks for a new plan.
const { AppError } = require('./errors');

// The approved donor route limit (hours). The service reports its own limit, which may not exceed this.
const MAX_TRAVEL_HOURS = 6;
const HORIZONS = [7, 14, 30];
const RECEIVED_STOCK_ONLY = 'RECEIVED_STOCK_ONLY';
const RERUN_INSTRUCTION = 'No stock was reserved. Re-run the optimizer for current conditions and review the new plan.';

const isText = (value) => typeof value === 'string' && value.trim() !== '';
const hundredths = (value) => Math.round(Number(value) * 100);
const sumUnits = (items) => items.reduce((total, item) => total + hundredths(item.quantity), 0);
const format = (units) => (units / 100).toString();

function revalidationFailed(plan, failedChecks, extra = {}) {
  const names = failedChecks.map((item) => item.name).join(', ');
  return new AppError(409, 'PLAN_REVALIDATION_FAILED',
    `The plan is no longer safe to reserve (${names}). ${RERUN_INSTRUCTION}`,
    {
      planId: plan.id,
      failedChecks: failedChecks.map(({ name, detail }) => ({ name, detail })),
      ...extra,
      instruction: RERUN_INSTRUCTION
    });
}

// The exact stored transfers, in order, as the simulator request. Throws if the stored plan cannot be revalidated.
function buildRevalidationRequest(plan) {
  const problems = [];
  const medicineId = plan.medicine?.id === undefined || plan.medicine?.id === null ? '' : String(plan.medicine.id);
  if (!medicineId) problems.push('The plan has no medicine identity.');
  if (!HORIZONS.includes(plan.horizonDays)) problems.push('The plan has no valid horizon.');
  if (!isText(plan.destinationFacilityId)) problems.push('The plan has no destination.');
  if (!Array.isArray(plan.transfers) || plan.transfers.length === 0) {
    problems.push('The plan has no transfers.');
  } else {
    plan.transfers.forEach((transfer, index) => {
      const valid = transfer && isText(transfer.fromFacilityId) && transfer.toFacilityId === plan.destinationFacilityId
        && String(transfer.medicineId) === medicineId && Number.isFinite(transfer.quantity) && transfer.quantity > 0
        && (Number.isFinite(transfer.batchId) || isText(transfer.batchId)) && isText(transfer.batchNo)
        && Number.isInteger(transfer.departureDay) && transfer.departureDay >= 1
        && Number.isInteger(transfer.arrivalDay) && transfer.arrivalDay >= transfer.departureDay;
      if (!valid) problems.push(`transfers[${index}] lacks a donor, destination, medicine, quantity, batch, departure day or arrival day.`);
    });
  }
  if (problems.length > 0) {
    throw revalidationFailed(plan, [{ name: 'PLAN_STRUCTURE', detail: problems.join(' ') }]);
  }
  return {
    horizonDays: plan.horizonDays,
    transfers: plan.transfers.map((transfer) => ({
      fromFacilityId: transfer.fromFacilityId,
      toFacilityId: transfer.toFacilityId,
      medicineId: transfer.medicineId,
      quantity: transfer.quantity,
      batchId: transfer.batchId,
      batchNo: transfer.batchNo,
      departureDay: transfer.departureDay,
      arrivalDay: transfer.arrivalDay
    }))
  };
}

function describeTransfer(transfer, index) {
  return `transfer ${index} (${transfer.fromFacilityId} batch ${transfer.batchNo})`;
}

function evaluateChecks(plan, simulation, dataSource) {
  const checks = [];
  const add = (name, passed, passedDetail, failedDetail) => checks.push({ name, passed: Boolean(passed), detail: passed ? passedDetail : failedDetail });
  const medicineId = String(plan.medicine.id);
  const evaluations = simulation.transferEvaluations;
  const pairs = plan.transfers.map((transfer, index) => [transfer, evaluations[index], index]);
  const { comparison } = simulation;

  add('DECISION_SUPPORT', simulation.decisionSupportOnly === true && isText(simulation.modelVersion),
    `Reviewed decision support from ${simulation.modelVersion}.`, 'The response is not marked as decision support.');

  const planSource = plan.dataContext?.dataSource ?? plan.simulation?.dataContext?.dataSource;
  add('DATA_SOURCE', simulation.dataContext.dataSource === dataSource && planSource === dataSource,
    `The plan and the revalidation both use ${dataSource}.`,
    `The plan was made on ${planSource || 'an unknown source'} and revalidated on ${simulation.dataContext.dataSource}; this backend uses ${dataSource}.`);

  add('HORIZON', simulation.horizonDays === plan.horizonDays,
    `${plan.horizonDays}-day horizon.`, `Revalidated over ${simulation.horizonDays} days, not the plan's ${plan.horizonDays}.`);

  const sameMedicine = String(simulation.medicineId) === medicineId && String(simulation.medicine.id) === medicineId
    && evaluations.every((evaluation) => String(evaluation.medicineId) === medicineId)
    && (typeof plan.medicine.requiresColdChain !== 'boolean' || plan.medicine.requiresColdChain === simulation.medicine.requiresColdChain);
  add('MEDICINE_IDENTITY', sameMedicine, `Medicine ${medicineId} throughout; nothing substituted.`,
    `The revalidated medicine (${simulation.medicineId}) or its cold-chain requirement differs from the plan's exact medicine ${medicineId}.`);

  const changed = pairs.filter(([transfer, evaluation]) => evaluation.fromFacilityId !== transfer.fromFacilityId
    || evaluation.toFacilityId !== transfer.toFacilityId || hundredths(evaluation.quantity) !== hundredths(transfer.quantity)
    || evaluation.arrivalDay !== transfer.arrivalDay || evaluation.departureDay !== transfer.departureDay);
  add('TRANSFERS_UNCHANGED', changed.length === 0, `All ${plan.transfers.length} transfer(s) were evaluated exactly as planned.`,
    `Evaluated differently from the plan: ${changed.map(([transfer, , index]) => describeTransfer(transfer, index)).join('; ')}.`);

  const planned = sumUnits(plan.transfers);
  const requested = plan.requestedQuantity === undefined ? planned : hundredths(plan.requestedQuantity);
  const simulated = sumUnits(evaluations);
  add('QUANTITY_TOTAL', planned === requested && simulated === planned, `${format(planned)} in total, as requested.`,
    `Requested ${format(requested)}, planned ${format(planned)}, revalidated ${format(simulated)}.`);

  const rejected = pairs.filter(([, evaluation]) => !evaluation.eligible || !evaluation.applied || evaluation.rejectionCodes.length > 0);
  add('ALL_TRANSFERS_ELIGIBLE', rejected.length === 0, 'Every transfer passed the feasibility gate and impact checks.',
    rejected.map(([transfer, evaluation, index]) => `${describeTransfer(transfer, index)}: ${evaluation.rejectionCodes.join(', ') || 'not applied'}`).join('; '));

  add('SAFE_TO_RECOMMEND', comparison.safeToRecommend === true, 'The simulator marks the plan safe to recommend.',
    'The simulator no longer marks the plan safe to recommend.');
  add('NO_NEW_SHORTAGES', comparison.newShortagesCreated.length === 0, 'No facility gains a stockout or more shortage.',
    `New or larger shortage at: ${comparison.newShortagesCreated.join(', ')}.`);
  add('NO_NEW_RISKS', comparison.newRisks.length === 0 && comparison.newCriticalFacilities.length === 0,
    'No facility gains a new risk or becomes critical.',
    `New risks: ${comparison.newRisks.map((risk) => `${risk.facilityId} ${risk.riskType}`).join(', ') || comparison.newCriticalFacilities.join(', ')}.`);

  const limit = Math.min(MAX_TRAVEL_HOURS, simulation.maxTravelHours);
  const slow = pairs.filter(([, evaluation]) => !evaluation.route || !(evaluation.route.travelHours <= limit));
  add('ROUTES_WITHIN_TRAVEL_LIMIT', simulation.maxTravelHours <= MAX_TRAVEL_HOURS && slow.length === 0,
    `Every route exists and takes at most ${limit} hours.`,
    `Missing or too long (limit ${limit} h): ${slow.map(([transfer, evaluation, index]) => `${describeTransfer(transfer, index)} ${evaluation.route ? `${evaluation.route.travelHours} h` : 'no route'}`).join('; ') || `service limit ${simulation.maxTravelHours} h`}.`);

  const coldChain = simulation.medicine.requiresColdChain;
  const warm = pairs.filter(([, evaluation]) => evaluation.rejectionCodes.includes('COLD_CHAIN_UNAVAILABLE')
    || (coldChain && evaluation.route?.coldChainAvailable !== true));
  add('COLD_CHAIN', warm.length === 0, coldChain ? 'Every route and destination keeps the cold chain.' : 'The medicine does not need a cold chain.',
    `No cold chain for: ${warm.map(([transfer, , index]) => describeTransfer(transfer, index)).join('; ')}.`);

  const batchMismatch = pairs.filter(([transfer, evaluation]) => evaluation.batches.length !== 1
    || String(evaluation.batches[0].batchId) !== String(transfer.batchId) || evaluation.batches[0].batchNo !== transfer.batchNo
    || hundredths(evaluation.batches[0].quantity) !== hundredths(transfer.quantity));
  add('BATCHES_UNCHANGED', batchMismatch.length === 0,
    'First-expiry-first allocation still uses exactly the planned batches, valid through the horizon.',
    `The simulator would now allocate different stock for: ${batchMismatch.map(([transfer, , index]) => describeTransfer(transfer, index)).join('; ')}.`);

  const evidence = simulation.receivedStockCheck;
  const sentByDonor = new Map();
  for (const transfer of plan.transfers) {
    sentByDonor.set(transfer.fromFacilityId, (sentByDonor.get(transfer.fromFacilityId) || 0) + hundredths(transfer.quantity));
  }
  const unsafeDonors = [...sentByDonor].filter(([facilityId, sent]) => {
    const donor = evidence.donors.find((item) => item.facilityId === facilityId);
    return !donor || !donor.passed || donor.failureCodes.length > 0 || hundredths(donor.totalSent) !== sent;
  }).map(([facilityId]) => facilityId);
  add('DONORS_SAFE_ON_RECEIVED_STOCK',
    evidence.basis === RECEIVED_STOCK_ONLY && evidence.passed === true && evidence.donors.length === sentByDonor.size && unsafeDonors.length === 0,
    'Counting only stock already received, every donor keeps its retained floor.',
    `Donors not safe on received stock alone: ${unsafeDonors.join(', ') || 'evidence incomplete'}.`);

  return checks;
}

function failureDetails(plan, simulation) {
  return {
    rejectedTransfers: simulation.transferEvaluations
      .filter((evaluation) => !evaluation.eligible || !evaluation.applied || evaluation.rejectionCodes.length > 0)
      .map((evaluation) => ({
        index: evaluation.index,
        fromFacilityId: evaluation.fromFacilityId,
        toFacilityId: evaluation.toFacilityId,
        batchId: plan.transfers[evaluation.index]?.batchId,
        batchNo: plan.transfers[evaluation.index]?.batchNo,
        quantity: evaluation.quantity,
        rejectionCodes: evaluation.rejectionCodes,
        rejectionReasons: evaluation.rejectionReasons
      })),
    newShortagesCreated: simulation.comparison.newShortagesCreated,
    newCriticalFacilities: simulation.comparison.newCriticalFacilities,
    newRisks: simulation.comparison.newRisks,
    unsafeDonors: simulation.receivedStockCheck.donors.filter((donor) => !donor.passed),
    safeToRecommend: simulation.comparison.safeToRecommend,
    modelVersion: simulation.modelVersion,
    dataSource: simulation.dataContext.dataSource
  };
}

/**
 * Revalidates a stored PROPOSED plan through the intelligence service. Returns a summary for the audit record.
 * Throws 409 PLAN_REVALIDATION_FAILED when the plan is no longer safe (including a deliberate 4xx from the service),
 * and passes through 503 INTELLIGENCE_UNAVAILABLE, INTELLIGENCE_TIMEOUT or INVALID_INTELLIGENCE_RESPONSE.
 */
async function revalidatePlan(plan, request, intelligenceAdapter, dataSource) {
  let simulation;
  try {
    simulation = await intelligenceAdapter.revalidatePlan(request);
  } catch (error) {
    if (error instanceof AppError && error.status >= 400 && error.status < 500) {
      throw revalidationFailed(plan, [{ name: 'INTELLIGENCE_ACCEPTS_PLAN', detail: `The intelligence service rejected the plan: ${error.code}: ${error.message}` }], {
        intelligenceError: { status: error.status, code: error.code, message: error.message, details: error.details }
      });
    }
    throw error;
  }
  const checks = evaluateChecks(plan, simulation, dataSource);
  const failed = checks.filter((item) => !item.passed);
  if (failed.length > 0) throw revalidationFailed(plan, failed, failureDetails(plan, simulation));
  return {
    performed: true,
    passed: true,
    source: simulation.source,
    endpoint: '/scenarios/simulate',
    modelVersion: simulation.modelVersion,
    dataSource: simulation.dataContext.dataSource,
    checkedAt: new Date().toISOString(),
    horizonDays: simulation.horizonDays,
    maxTravelHours: simulation.maxTravelHours,
    checks: checks.map((item) => item.name),
    transfers: simulation.transferEvaluations.map((evaluation) => ({
      index: evaluation.index,
      fromFacilityId: evaluation.fromFacilityId,
      toFacilityId: evaluation.toFacilityId,
      batchId: evaluation.batches[0].batchId,
      batchNo: evaluation.batches[0].batchNo,
      quantity: evaluation.quantity,
      departureDay: evaluation.departureDay,
      arrivalDay: evaluation.arrivalDay,
      travelHours: evaluation.route.travelHours,
      coldChainAvailable: evaluation.route.coldChainAvailable
    })),
    receivedStockCheck: {
      basis: simulation.receivedStockCheck.basis,
      passed: true,
      donors: simulation.receivedStockCheck.donors.map((donor) => ({
        facilityId: donor.facilityId, totalSent: donor.totalSent, retainedFloor: donor.retainedFloor,
        lowestProjectedStock: donor.lowestProjectedStock, futureReplenishmentExcluded: donor.futureReplenishmentExcluded
      }))
    }
  };
}

// Fixture approvals reserve nothing and are not evidence of production safety.
const FIXTURE_REVALIDATION = Object.freeze({
  performed: false,
  reason: 'FIXTURE_MODE',
  detail: 'Fixture approvals reserve no stock; the intelligence service is not consulted and this is not proof of production safety.'
});

module.exports = { FIXTURE_REVALIDATION, MAX_TRAVEL_HOURS, buildRevalidationRequest, revalidatePlan };
