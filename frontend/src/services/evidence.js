// Safety evidence exactly as the optimizer and simulator reported it: candidates, transfers, validation checks,
// received-stock donor evidence and risk before and after. Values are selected, never recalculated.
import { medicineName, riskText } from './viewModels';

const TRANSFER_ROLES = new Set(['DONOR', 'RECIPIENT', 'DONOR_AND_RECIPIENT']);

function coldChainStatus(codes, transfers) {
  if (codes.includes('ROUTE_NOT_FOUND')) return 'no route';
  if (codes.includes('COLD_CHAIN_UNAVAILABLE')) return 'unavailable';
  if (transfers.length) return transfers.every((transfer) => transfer.coldChainAvailable === true) ? 'available on the planned route' : 'unavailable';
  return 'no cold-chain rejection reported';
}

function candidateRow(candidate, transfers = []) {
  const codes = candidate.rejectionCodes || [];
  const donorTransfers = transfers.filter((transfer) => transfer.fromFacilityId === candidate.facilityId);
  return {
    facilityId: candidate.facilityId,
    facilityName: candidate.facilityName || candidate.facilityId,
    facilityType: candidate.facilityType || '',
    status: candidate.status || (codes.length ? 'REJECTED' : 'ELIGIBLE'),
    rejectionCodes: codes,
    rejectionReasons: candidate.rejectionReasons || [],
    explanation: candidate.explanation || '',
    safeCapacity: candidate.safeCapacity,
    allocatedQuantity: candidate.allocatedQuantity,
    retainedFloor: candidate.retainedFloor,
    protectedStock: candidate.protectedStock,
    effectiveStock: candidate.effectiveStock,
    futureReplenishmentExcluded: candidate.futureReplenishmentExcluded,
    travelHours: candidate.travelHours,
    distanceKm: candidate.distanceKm,
    baselineRiskLabel: candidate.baselineRiskLabel ? riskText(candidate.baselineRiskLabel) : '',
    baselineRiskScore: candidate.baselineRiskScore,
    coldChain: coldChainStatus(codes, donorTransfers),
  };
}

export function mapCandidates(assessment) {
  if (!assessment || assessment.kind === 'MISSING') return null;
  if (assessment.kind === 'NO_SAFE_PLAN') {
    const details = assessment.details || {};
    return {
      kind: 'NO_SAFE_PLAN',
      request: assessment.request,
      requestId: assessment.requestId,
      unit: details.unit || '',
      requestedQuantity: details.requestedQuantity ?? assessment.request?.quantity,
      safeCapacity: details.safeCapacity,
      unmetQuantity: details.unmetQuantity,
      maxTravelHours: details.equityGuardrail?.maxTravelHours,
      capacityBasis: details.equityGuardrail?.donorCapacityBasis || '',
      rows: [...(details.eligibleCandidates || []), ...(details.rejectedCandidates || [])].map((candidate) => candidateRow(candidate)),
    };
  }
  const plan = assessment.plan.data;
  return {
    kind: 'PLAN',
    meta: assessment.plan.meta,
    planId: plan.id,
    request: assessment.request,
    unit: plan.medicine?.unit || '',
    medicine: medicineName(plan.medicine),
    destination: plan.destinationFacilityName || plan.destinationFacilityId,
    requestedQuantity: plan.requestedQuantity,
    allocatedQuantity: plan.allocatedQuantity,
    maxTravelHours: plan.equityGuardrail?.maxTravelHours,
    capacityBasis: plan.equityGuardrail?.donorCapacityBasis || '',
    rows: (plan.candidates || []).map((candidate) => candidateRow(candidate, plan.transfers || [])),
  };
}

function facilityStates(simulation, transfers) {
  const involved = new Set(transfers.flatMap((transfer) => [transfer.fromFacilityId, transfer.toFacilityId]));
  const after = new Map((simulation?.intervention?.facilities || []).map((item) => [item.facilityId, item]));
  return (simulation?.baseline?.facilities || [])
    .filter((item) => (item.role ? TRANSFER_ROLES.has(item.role) : involved.has(item.facilityId)))
    .map((before) => {
      const next = after.get(before.facilityId) || {};
      return {
        facilityId: before.facilityId,
        facilityName: before.facilityName || before.facilityId,
        role: before.role || (transfers.some((transfer) => transfer.toFacilityId === before.facilityId) ? 'RECIPIENT' : 'DONOR'),
        before: { riskLabel: riskText(before.riskLabel), riskScore: before.riskScore, daysRemaining: before.daysRemaining, stockoutDay: before.stockoutDay ?? null },
        after: { riskLabel: riskText(next.riskLabel), riskScore: next.riskScore, daysRemaining: next.daysRemaining, stockoutDay: next.stockoutDay ?? null },
      };
    });
}

export function mapPlanEvidence(envelope) {
  const plan = envelope.data;
  const transfers = (plan.transfers || []).map((transfer) => ({
    fromFacilityId: transfer.fromFacilityId,
    fromFacilityName: transfer.fromFacilityName || transfer.fromFacilityId,
    toFacilityId: transfer.toFacilityId,
    batchId: transfer.batchId,
    batchNo: transfer.batchNo,
    expiryDate: transfer.expiryDate || '',
    quantity: transfer.quantity,
    departureDay: transfer.departureDay,
    arrivalDay: transfer.arrivalDay,
    arrivalDate: transfer.arrivalDate || '',
    distanceKm: transfer.distanceKm,
    travelHours: transfer.travelHours,
    coldChainAvailable: transfer.coldChainAvailable,
  }));
  const simulation = plan.simulation || {};
  const comparison = simulation.comparison || {};
  return {
    meta: envelope.meta,
    id: plan.id,
    status: plan.status,
    source: plan.source || '',
    modelVersion: plan.modelVersion || '',
    dataSource: plan.dataContext?.dataSource || '',
    isFallback: plan.isFallback === true,
    medicine: { id: String(plan.medicine?.id ?? ''), name: medicineName(plan.medicine), unit: plan.medicine?.unit || '', requiresColdChain: plan.medicine?.requiresColdChain },
    destination: { id: plan.destinationFacilityId, name: plan.destinationFacilityName || plan.destinationFacilityId },
    requestedQuantity: plan.requestedQuantity,
    allocatedQuantity: plan.allocatedQuantity,
    horizonDays: plan.horizonDays,
    requiresHumanApproval: plan.requiresHumanApproval !== false,
    decisionSupportOnly: plan.decisionSupportOnly === true,
    rationale: plan.rationale || '',
    transfers,
    recipient: plan.recipient || null,
    validation: plan.validation || null,
    comparison: {
      safeToRecommend: comparison.safeToRecommend,
      newShortagesCreated: comparison.newShortagesCreated || [],
      newCriticalFacilities: comparison.newCriticalFacilities || [],
      newRisks: (comparison.newRisks || []).map((risk) => ({ facilityId: risk.facilityId, riskType: risk.riskType || '', detail: risk.detail || '' })),
      summary: comparison.summary || '',
    },
    receivedStockCheck: simulation.receivedStockCheck || null,
    maxTravelHours: plan.equityGuardrail?.maxTravelHours ?? simulation.maxTravelHours,
    facilityStates: facilityStates(simulation, transfers),
    solver: plan.solver ? `${plan.solver.name} ${plan.solver.algorithm} · ${plan.solver.status}` : '',
    limitations: plan.limitations || simulation.limitations || [],
    decision: plan.decision || null,
  };
}
