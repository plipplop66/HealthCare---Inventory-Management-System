const { AppError } = require('./errors');

const INTELLIGENCE_SOURCE = 'INTELLIGENCE_SERVICE';
// The documented alias both database stores and the intelligence service resolve to Human Insulin.
const INSULIN_ALIAS = 'med-insulin-100iu-vial';
// Failures of the service itself. Deliberate 4xx answers keep their own status and code.
const SERVICE_FAILURE_CODES = new Set(['INTELLIGENCE_UNAVAILABLE', 'INTELLIGENCE_TIMEOUT', 'INVALID_INTELLIGENCE_RESPONSE']);

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim() !== '';
const isIdentifier = (value) => (typeof value === 'number' && Number.isFinite(value)) || isText(value);
const hundredths = (value) => Math.round(Number(value) * 100);

function isServiceFailure(error) {
  return error instanceof AppError && SERVICE_FAILURE_CODES.has(error.code);
}

function invalidResponse(operation, reason) {
  return new AppError(503, 'INVALID_INTELLIGENCE_RESPONSE',
    `The intelligence service returned an unusable ${operation} response. Nothing was saved; retry when the service is healthy.`,
    { operation, reason });
}

function check(condition, operation, reason) {
  if (!condition) throw invalidResponse(operation, reason);
}

function validateIntelligenceResponse(payload) {
  check(isObject(payload) && isObject(payload.risk) && isObject(payload.forecast), 'forecast', 'forecast or risk data is missing.');
  check(Number.isFinite(payload.risk.score) && typeof payload.risk.label === 'string', 'forecast', 'The risk object is invalid.');
  return payload;
}

// Every simulation: both regional states, a boolean safety decision and one result per submitted transfer.
function validateSimulationResponse(payload, request, operation = 'simulation') {
  check(isObject(payload), operation, 'The response is not a JSON object.');
  check(isObject(payload.baseline) && Array.isArray(payload.baseline.facilities), operation, 'baseline.facilities is missing.');
  check(isObject(payload.intervention) && Array.isArray(payload.intervention.facilities), operation, 'intervention.facilities is missing.');
  const { comparison } = payload;
  check(isObject(comparison) && typeof comparison.safeToRecommend === 'boolean', operation, 'comparison.safeToRecommend is missing.');
  for (const field of ['newShortagesCreated', 'newCriticalFacilities', 'newRisks']) {
    check(Array.isArray(comparison[field]), operation, `comparison.${field} is missing.`);
  }
  check(payload.decisionSupportOnly === true, operation, 'decisionSupportOnly is not true.');
  check(Array.isArray(payload.transferEvaluations), operation, 'transferEvaluations is missing.');
  if (request) {
    check(payload.transferEvaluations.length === request.transfers.length, operation,
      `${request.transfers.length} transfer(s) were submitted but ${payload.transferEvaluations.length} evaluation(s) were returned.`);
  }
  payload.transferEvaluations.forEach((evaluation, index) => {
    check(isObject(evaluation) && evaluation.index === index, operation, `transferEvaluations[${index}] is missing or out of order.`);
    check(typeof evaluation.eligible === 'boolean' && typeof evaluation.applied === 'boolean', operation,
      `transferEvaluations[${index}] has no eligibility result.`);
    check(Array.isArray(evaluation.rejectionCodes) && Array.isArray(evaluation.rejectionReasons) && Array.isArray(evaluation.batches), operation,
      `transferEvaluations[${index}] has no rejection or batch lists.`);
  });
  return payload;
}

// Approval also needs the identity, route, batch and received-stock evidence of every transfer.
function validateRevalidationResponse(payload, request) {
  const operation = 'plan revalidation';
  validateSimulationResponse(payload, request, operation);
  check(isText(payload.modelVersion), operation, 'modelVersion is missing.');
  check(isObject(payload.dataContext) && isText(payload.dataContext.dataSource), operation, 'dataContext.dataSource is missing.');
  check(Number.isInteger(payload.horizonDays) && isIdentifier(payload.medicineId), operation, 'horizonDays or medicineId is missing.');
  check(isObject(payload.medicine) && isIdentifier(payload.medicine.id) && typeof payload.medicine.requiresColdChain === 'boolean', operation,
    'The medicine identity or its cold-chain requirement is missing.');
  check(Number.isFinite(payload.maxTravelHours) && payload.maxTravelHours > 0, operation, 'maxTravelHours is missing.');
  const evidence = payload.receivedStockCheck;
  check(isObject(evidence) && isText(evidence.basis) && typeof evidence.passed === 'boolean' && Array.isArray(evidence.donors), operation,
    'receivedStockCheck is missing.');
  evidence.donors.forEach((donor, index) => {
    check(isObject(donor) && isText(donor.facilityId) && typeof donor.passed === 'boolean' && Array.isArray(donor.failureCodes)
      && Number.isFinite(donor.totalSent), operation, `receivedStockCheck.donors[${index}] is incomplete.`);
  });
  payload.transferEvaluations.forEach((evaluation, index) => {
    check(isText(evaluation.fromFacilityId) && isText(evaluation.toFacilityId) && isIdentifier(evaluation.medicineId)
      && Number.isFinite(evaluation.quantity) && Number.isInteger(evaluation.arrivalDay), operation,
    `transferEvaluations[${index}] does not identify its transfer.`);
    check(evaluation.departureDay === null || Number.isInteger(evaluation.departureDay), operation, `transferEvaluations[${index}].departureDay is invalid.`);
    check(evaluation.route === null || (isObject(evaluation.route) && Number.isFinite(evaluation.route.travelHours)
      && typeof evaluation.route.coldChainAvailable === 'boolean'), operation, `transferEvaluations[${index}].route is incomplete.`);
    evaluation.batches.forEach((batch, batchIndex) => {
      check(isObject(batch) && 'batchId' in batch && isText(batch.batchNo) && Number.isFinite(batch.quantity), operation,
        `transferEvaluations[${index}].batches[${batchIndex}] is incomplete.`);
    });
  });
  return payload;
}

function medicineMatches(requestedId, medicine) {
  return String(medicine.id) === String(requestedId) || (requestedId === INSULIN_ALIAS && medicine.genericName === 'Human Insulin');
}

// A proposed plan must be the plan that was asked for, fully batched, simulated safe and awaiting human approval.
function validateOptimizationResponse(payload, request) {
  const operation = 'optimization';
  check(isObject(payload) && payload.status === 'PROPOSED', operation, 'status is not PROPOSED.');
  check(isText(payload.id), operation, 'The plan ID is missing.');
  check(isObject(payload.medicine) && isIdentifier(payload.medicine.id), operation, 'medicine is missing.');
  const medicineId = String(payload.medicine.id);
  if (request) {
    check(medicineMatches(request.medicineId, payload.medicine), operation, `The plan moves medicine ${medicineId}, not the requested ${request.medicineId}.`);
    check(payload.destinationFacilityId === request.destinationFacilityId, operation, 'The plan destination is not the requested facility.');
    check(payload.horizonDays === request.horizonDays, operation, 'The plan horizon is not the requested horizon.');
    check(hundredths(payload.requestedQuantity) === hundredths(request.quantity), operation, 'The plan quantity is not the requested quantity.');
  }
  check(payload.requiresHumanApproval === true && payload.decisionSupportOnly === true, operation,
    'The plan is not marked as decision support that requires human approval.');
  check(Array.isArray(payload.transfers) && payload.transfers.length > 0, operation, 'The plan has no transfers.');
  payload.transfers.forEach((transfer, index) => {
    check(isObject(transfer) && isText(transfer.fromFacilityId) && transfer.toFacilityId === payload.destinationFacilityId
      && String(transfer.medicineId) === medicineId, operation, `transfers[${index}] does not match the plan destination and medicine.`);
    check(Number.isFinite(transfer.quantity) && transfer.quantity > 0, operation, `transfers[${index}].quantity is not positive.`);
    check(isIdentifier(transfer.batchId) && isText(transfer.batchNo), operation, `transfers[${index}] has no batch.`);
    check(Number.isInteger(transfer.departureDay) && transfer.departureDay >= 1 && Number.isInteger(transfer.arrivalDay)
      && transfer.arrivalDay >= transfer.departureDay, operation, `transfers[${index}] has invalid departure or arrival days.`);
  });
  const allocated = payload.transfers.reduce((total, transfer) => total + hundredths(transfer.quantity), 0);
  check(allocated === hundredths(payload.requestedQuantity), operation, 'The transfer quantities do not add up to the requested quantity.');
  check(isObject(payload.validation) && payload.validation.passed === true, operation, 'The plan did not pass its validation checks.');
  validateSimulationResponse(payload.simulation, { transfers: payload.transfers }, operation);
  check(payload.simulation.comparison.safeToRecommend === true, operation, 'The plan simulation is not safe to recommend.');
  check(payload.simulation.receivedStockCheck?.passed === true, operation, 'The plan has no passing received-stock donor check.');
  return payload;
}

async function requestIntelligence(config, path, body, operation) {
  if (!config.intelligenceServiceUrl) {
    throw new AppError(503, 'INTELLIGENCE_UNAVAILABLE',
      `The intelligence service is not configured, so no ${operation} can be run. Nothing was saved.`, { operation, reason: 'NOT_CONFIGURED' });
  }
  const timeoutMs = config.intelligenceTimeoutMs;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let text;
  try {
    response = await fetch(`${config.intelligenceServiceUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    // Reading the body is inside the same deadline.
    text = await response.text();
  } catch {
    if (controller.signal.aborted) {
      throw new AppError(503, 'INTELLIGENCE_TIMEOUT',
        `The intelligence service did not complete the ${operation} within ${timeoutMs} ms. Nothing was saved; retry when the service is healthy.`,
        { operation, timeoutMs });
    }
    throw new AppError(503, 'INTELLIGENCE_UNAVAILABLE',
      `The intelligence service could not be reached for the ${operation}. Nothing was saved; retry when the service is healthy.`,
      { operation, reason: 'CONNECTION_FAILED' });
  } finally {
    clearTimeout(timeout);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = undefined;
  }
  if (response.status >= 400 && response.status < 500) {
    const error = payload?.error;
    // Deliberate decisions (NO_SAFE_PLAN, validation, not found, quantity precision) keep their status, code and details.
    if (isObject(error) && isText(error.code) && isText(error.message)) {
      throw new AppError(response.status, error.code, error.message, error.details);
    }
    throw invalidResponse(operation, `The service rejected the request with status ${response.status} and no error envelope.`);
  }
  if (!response.ok) {
    throw new AppError(503, 'INTELLIGENCE_UNAVAILABLE',
      `The intelligence service failed during the ${operation}. Nothing was saved; retry when the service is healthy.`,
      { operation, reason: 'SERVICE_ERROR', upstreamStatus: response.status });
  }
  check(payload !== undefined, operation, 'The response is not valid JSON.');
  return payload;
}

async function createFallbackForecast({ facilityId, medicineId, horizonDays }, inventoryStore) {
  const profile = await inventoryStore.getScenarioProfile(facilityId, medicineId);
  if (!profile) {
    throw new AppError(404, 'FORECAST_TARGET_NOT_FOUND', 'The requested facility or medicine was not found.');
  }
  const source = inventoryStore.source === 'FIXTURE_STORE' ? 'FIXTURE_FALLBACK' : 'DATABASE_FALLBACK';
  return {
    forecast: {
      dailyDemand: profile.dailyDemand,
      lowerBound: Math.max(0, profile.dailyDemand * 0.9),
      upperBound: profile.dailyDemand * 1.1,
      horizonDays
    },
    risk: { score: profile.riskScore, label: profile.riskLabel },
    stockout: { daysRemaining: profile.daysRemaining, projectedWithinHorizon: profile.daysRemaining <= horizonDays },
    confidence: { label: 'LOW', reason: 'Deterministic fallback; awaiting the tested intelligence service.' },
    cause: profile.incomingArrivalDay && profile.incomingArrivalDay > profile.daysRemaining ? 'SUPPLY_DELAY' : 'INVENTORY_IMBALANCE',
    explanation: profile.incomingArrivalDay && profile.incomingArrivalDay > profile.daysRemaining
      ? 'Simulated stock will deplete before the scheduled replenishment arrives.'
      : 'Simulated coverage is based on effective stock and daily demand.',
    source,
    isFallback: true,
    decisionSupportOnly: true
  };
}

function logServiceFailure(error) {
  console.warn(JSON.stringify({ intelligence: error.details?.operation, code: error.code, reason: error.details?.reason, upstreamStatus: error.details?.upstreamStatus }));
}

function createIntelligenceAdapter(config, inventoryStore) {
  const call = async (path, body, operation) => {
    try {
      return await requestIntelligence(config, path, body, operation);
    } catch (error) {
      if (isServiceFailure(error) && error.details?.reason !== 'NOT_CONFIGURED') logServiceFailure(error);
      throw error;
    }
  };
  return {
    // Informational only, so an outage returns a labelled fallback that is never used for approval.
    async forecast(input) {
      try {
        const payload = validateIntelligenceResponse(await call('/forecast', input, 'forecast'));
        return { ...payload, source: INTELLIGENCE_SOURCE, decisionSupportOnly: true };
      } catch (error) {
        if (!isServiceFailure(error)) throw error;
        return {
          ...(await createFallbackForecast(input, inventoryStore)),
          fallbackReason: error.code === 'INTELLIGENCE_TIMEOUT' ? 'INTELLIGENCE_TIMEOUT' : 'INTELLIGENCE_UNAVAILABLE'
        };
      }
    },
    // The remaining calls fail closed: an outage, timeout or invalid response is an AppError, never null.
    async simulate(input) {
      const payload = validateSimulationResponse(await call('/scenarios/simulate', input, 'simulation'), input);
      return { ...payload, source: INTELLIGENCE_SOURCE, decisionSupportOnly: true };
    },
    async revalidatePlan(request) {
      const payload = validateRevalidationResponse(await call('/scenarios/simulate', request, 'plan revalidation'), request);
      return { ...payload, source: INTELLIGENCE_SOURCE };
    },
    async optimize(input) {
      const payload = validateOptimizationResponse(await call('/plans/optimize', input, 'optimization'), input);
      return { ...payload, source: INTELLIGENCE_SOURCE, decisionSupportOnly: true };
    }
  };
}

module.exports = {
  createIntelligenceAdapter,
  isServiceFailure,
  validateIntelligenceResponse,
  validateSimulationResponse,
  validateRevalidationResponse,
  validateOptimizationResponse,
  createFallbackForecast
};
