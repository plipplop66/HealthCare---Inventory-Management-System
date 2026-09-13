const { AppError } = require('./errors');

function riskForDays(daysRemaining) {
  if (daysRemaining <= 3) return { label: 'CRITICAL', score: 92 };
  if (daysRemaining <= 7) return { label: 'HIGH', score: 72 };
  if (daysRemaining <= 14) return { label: 'MEDIUM', score: 43 };
  return { label: 'LOW', score: 14 };
}

function projectProfile(profile, stockAdjustment = 0) {
  const effectiveStock = Math.max(0, Number(profile.effectiveStock) + stockAdjustment);
  const dailyDemand = Number(profile.dailyDemand);
  const daysRemaining = dailyDemand > 0 ? Number((effectiveStock / dailyDemand).toFixed(1)) : null;
  const risk = daysRemaining === null ? { label: 'LOW', score: 0 } : riskForDays(daysRemaining);
  return {
    facilityId: profile.facilityId,
    facilityName: profile.facilityName,
    medicineId: profile.medicineId,
    effectiveStock,
    dailyDemand,
    daysRemaining,
    protectedStock: Number(profile.protectedStock),
    safeSurplus: Math.max(0, Number((effectiveStock - Number(profile.protectedStock)).toFixed(2))),
    riskLabel: risk.label,
    riskScore: risk.score
  };
}

function simulateCoverage(profile, horizonDays, transferArrivals = []) {
  let stock = Number(profile.effectiveStock);
  let stockoutDay = null;
  let shortageDays = 0;
  let patientDaysAtRisk = 0;
  const dailyDemand = Number(profile.dailyDemand);
  const arrivals = new Map();
  for (const arrival of transferArrivals) {
    arrivals.set(arrival.day, (arrivals.get(arrival.day) || 0) + arrival.quantity);
  }
  if (profile.incomingSupply > 0 && profile.incomingArrivalDay >= 1) {
    arrivals.set(profile.incomingArrivalDay, (arrivals.get(profile.incomingArrivalDay) || 0) + Number(profile.incomingSupply));
  }

  for (let day = 1; day <= horizonDays; day += 1) {
    stock += arrivals.get(day) || 0;
    stock -= dailyDemand;
    if (stock < 0) {
      if (stockoutDay === null) stockoutDay = day;
      shortageDays += 1;
      patientDaysAtRisk += Math.ceil(Math.abs(stock) / Math.max(dailyDemand, 1));
      stock = 0;
    }
  }
  const coverage = projectProfile({ ...profile, effectiveStock: stock });
  return {
    ...coverage,
    endingStock: Number(stock.toFixed(2)),
    stockoutDay,
    shortageDays,
    patientDaysAtRisk,
    plannedArrivals: [...arrivals.entries()]
      .map(([day, quantity]) => ({ day, quantity }))
      .sort((left, right) => left.day - right.day)
  };
}

async function evaluateTransfer(transfer, horizonDays, inventoryStore) {
  const [source, destination] = await Promise.all([
    inventoryStore.getScenarioProfile(transfer.fromFacilityId, transfer.medicineId),
    inventoryStore.getScenarioProfile(transfer.toFacilityId, transfer.medicineId)
  ]);
  const reasons = [];
  if (!source || !destination) reasons.push('A source or destination facility does not exist for this medicine.');
  if (source && source.facilityId === destination?.facilityId) reasons.push('A transfer cannot use the same source and destination.');
  const route = source && destination
    ? await inventoryStore.getRoute(source.facilityId, destination.facilityId)
    : null;
  if (!route) reasons.push('No transport route exists between the selected facilities.');
  if ((source?.requiresColdChain || destination?.requiresColdChain) && !route?.coldChainAvailable) {
    reasons.push('The route cannot maintain the required cold-chain condition.');
  }
  if (source && source.effectiveStock - transfer.quantity - (source.dailyDemand * horizonDays) < source.protectedStock) {
    reasons.push('The donor would fall below protected safety stock.');
  }
  if (destination?.daysRemaining !== null && transfer.arrivalDay > destination?.daysRemaining) {
    reasons.push('The transfer arrives after the projected shortage begins.');
  }
  if (transfer.arrivalDay < 1) reasons.push('arrivalDay must be at least 1.');

  return { ...transfer, eligible: reasons.length === 0, rejectionReasons: reasons, route };
}

async function simulateScenario({ transfers, horizonDays }, inventoryStore) {
  const medicineIds = [...new Set(transfers.map((transfer) => transfer.medicineId))];
  if (medicineIds.length !== 1) {
    throw new AppError(400, 'MULTI_MEDICINE_SCENARIO_UNSUPPORTED', 'A scenario may contain transfers for one exact medicine identity at a time.');
  }
  const [medicineId] = medicineIds;
  const [evaluations, profiles] = await Promise.all([
    Promise.all(transfers.map((transfer) => evaluateTransfer(transfer, horizonDays, inventoryStore))),
    inventoryStore.listScenarioProfiles(medicineId)
  ]);
  if (profiles.length === 0) {
    throw new AppError(404, 'SCENARIO_TARGET_NOT_FOUND', 'The requested medicine was not found in the active data source.');
  }
  const before = profiles.map((profile) => simulateCoverage(profile, horizonDays));
  const after = profiles.map((profile) => {
    const arrivals = evaluations
      .filter((evaluation) => evaluation.eligible && evaluation.toFacilityId === profile.facilityId)
      .map((evaluation) => ({ day: evaluation.arrivalDay, quantity: evaluation.quantity }));
    const outbound = evaluations
      .filter((evaluation) => evaluation.eligible && evaluation.fromFacilityId === profile.facilityId)
      .map((evaluation) => ({ day: evaluation.arrivalDay, quantity: -evaluation.quantity }));
    return simulateCoverage(profile, horizonDays, [...arrivals, ...outbound]);
  });
  const beforeCritical = before.filter((facility) => facility.stockoutDay !== null).length;
  const afterCritical = after.filter((facility) => facility.stockoutDay !== null).length;
  const newRisks = after.filter((facility) => {
    const previous = before.find((item) => item.facilityId === facility.facilityId);
    return previous.stockoutDay === null && facility.stockoutDay !== null;
  });

  return {
    scenarioType: inventoryStore.source === 'MYSQL' ? 'SIMULATED_DATABASE' : 'SIMULATED_FIXTURE',
    horizonDays,
    medicineId,
    transferEvaluations: evaluations,
    baseline: { facilities: before, criticalFacilityCount: beforeCritical },
    intervention: { facilities: after, criticalFacilityCount: afterCritical, appliedTransferCount: evaluations.filter((item) => item.eligible).length },
    comparison: {
      criticalFacilityDelta: afterCritical - beforeCritical,
      shortageDayDelta: after.reduce((total, facility) => total + facility.shortageDays, 0)
        - before.reduce((total, facility) => total + facility.shortageDays, 0),
      patientDaysAtRiskDelta: after.reduce((total, facility) => total + facility.patientDaysAtRisk, 0)
        - before.reduce((total, facility) => total + facility.patientDaysAtRisk, 0),
      newRisks,
      safeToRecommend: evaluations.every((item) => item.eligible) && newRisks.length === 0
    },
    limitations: ['This is simulated decision support, not clinical advice.', 'Forecast demand and final safety rules must be replaced with approved intelligence inputs before release.']
  };
}

async function optimisePlan(input, inventoryStore, planStore) {
  const destination = await inventoryStore.getScenarioProfile(input.destinationFacilityId, input.medicineId);
  if (!destination) {
    throw new AppError(404, 'OPTIMIZATION_TARGET_NOT_FOUND', 'The requested facility or medicine was not found.');
  }
  const canonicalMedicineId = destination.medicine.id;
  const profiles = await inventoryStore.listScenarioProfiles(canonicalMedicineId);
  let quantityRemaining = input.quantity;
  const transfers = [];
  const candidates = profiles
    .map((profile) => ({
      ...profile,
      availableForTransfer: Math.max(0, profile.effectiveStock - (profile.dailyDemand * input.horizonDays) - profile.protectedStock)
    }))
    .filter((profile) => profile.facilityId !== destination.facilityId && profile.availableForTransfer > 0)
    .sort((left, right) => right.safeSurplus - left.safeSurplus);

  for (const source of candidates) {
    if (quantityRemaining <= 0) break;
    const route = await inventoryStore.getRoute(source.facilityId, destination.facilityId);
    if (!route?.coldChainAvailable && (source.requiresColdChain || destination.requiresColdChain)) continue;
    const batch = await inventoryStore.selectTransferBatch(source.facilityId, canonicalMedicineId);
    if (!batch) continue;
    const quantity = Math.min(quantityRemaining, source.availableForTransfer);
    transfers.push({
      fromFacilityId: source.facilityId,
      toFacilityId: destination.facilityId,
      medicineId: canonicalMedicineId,
      batchId: batch.batchId,
      batchNo: batch.batchNo,
      quantity,
      arrivalDay: 1
    });
    quantityRemaining -= quantity;
  }
  if (quantityRemaining > 0) {
    throw new AppError(422, 'NO_SAFE_PLAN', 'No safe multi-source plan can cover the requested quantity within protected stock constraints.');
  }
  const simulation = await simulateScenario({ transfers, horizonDays: input.horizonDays }, inventoryStore);
  if (!simulation.comparison.safeToRecommend) {
    throw new AppError(422, 'NO_SAFE_PLAN', 'The proposed plan would create a new projected risk or violate a feasibility rule.');
  }
  return planStore.create({
    medicine: destination.medicine,
    destinationFacilityId: destination.facilityId,
    horizonDays: input.horizonDays,
    transfers,
    simulation,
    rationale: 'The plan uses eligible donors while preserving each donor\'s protected stock.',
    assumptions: ['Simulated data only.', 'Exact medicine identity is enforced.', 'A human must approve before any transfer action.']
  });
}

module.exports = { simulateScenario, optimisePlan, projectProfile, simulateCoverage };
