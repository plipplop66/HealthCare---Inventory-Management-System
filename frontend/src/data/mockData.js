// MOCK DATA for demonstrating the interface without a backend (VITE_USE_MOCKS=true). Every object follows the
// Node API contract (docs/api-contract.md) and every response is labelled MOCK_DATA. Nothing here is real, and
// the mock transport returns these canned results instead of calculating anything.

export const MOCK_SOURCE = 'MOCK_DATA';

export const mockUsers = {
  'mock.approver@medripple.demo': { id: 'mock-approver', name: 'Mock Approver', email: 'mock.approver@medripple.demo', role: 'APPROVER' },
};

export const mockMedicines = [
  { id: 'MOCK-MED-1', genericName: 'Mock Insulin', strength: '100 IU/mL', dosageForm: 'Vial', unit: 'mL', criticality: 'CRITICAL', storage: '2-8 C', requiresColdChain: true },
  { id: 'MOCK-MED-2', genericName: 'Mock Auto-Injector', strength: '1 mg', dosageForm: 'Pen', unit: 'count', criticality: 'CRITICAL', storage: '15-25 C', requiresColdChain: false },
];

const insulin = mockMedicines[0];

export const mockFacilities = [
  { id: 'MOCK-WH-001', facilityId: 'MOCK-WH-001', name: 'Mock Regional Warehouse', type: 'Warehouse', district: 'Mock District', medicineId: insulin.id, medicine: insulin, effectiveStock: 5000, dailyDemand: 0, daysRemaining: null, protectedStock: 0, riskLabel: 'LOW', riskScore: 0, dataFreshness: 'MOCK DATA' },
  { id: 'MOCK-DH-001', facilityId: 'MOCK-DH-001', name: 'Mock District Hospital', type: 'DistrictHospital', district: 'Mock District', medicineId: insulin.id, medicine: insulin, effectiveStock: 900, dailyDemand: 50, daysRemaining: 18, protectedStock: 700, riskLabel: 'LOW', riskScore: 14, dataFreshness: 'MOCK DATA' },
  { id: 'MOCK-PHC-001', facilityId: 'MOCK-PHC-001', name: 'Mock Primary Health Centre', type: 'PHC', district: 'Mock District', medicineId: insulin.id, medicine: insulin, effectiveStock: 30, dailyDemand: 40, daysRemaining: 0.8, protectedStock: 560, riskLabel: 'CRITICAL', riskScore: 92, dataFreshness: 'MOCK DATA' },
];

export const mockSummary = {
  resilienceScore: 60,
  earliestStockout: { facilityId: 'MOCK-PHC-001', facilityName: 'Mock Primary Health Centre', daysRemaining: 0.8 },
  criticalFacilityCount: 1,
  alerts: [{ facilityId: 'MOCK-PHC-001', riskLabel: 'CRITICAL', cause: 'LOW_SIMULATED_COVERAGE', daysRemaining: 0.8 }],
  dataFreshness: 'MOCK DATA',
};

export function mockInventory(facilityId, medicineId) {
  const facility = mockFacilities.find((item) => item.id === facilityId);
  const medicine = mockMedicines.find((item) => item.id === medicineId);
  if (!facility || !medicine) return null;
  const effective = medicine === insulin ? facility.effectiveStock : 0;
  return {
    facility: { id: facility.id, name: facility.name, type: facility.type },
    medicine,
    recordedStock: effective,
    effectiveStock: effective,
    excludedStock: 0,
    dailyConsumption: medicine === insulin ? facility.dailyDemand : 0,
    incomingReplenishment: facility.id === 'MOCK-PHC-001' && medicine === insulin ? { quantity: 600, expectedArrivalDate: '2026-09-19', status: 'DELAYED' } : null,
    batches: effective ? [{ batchId: 1, batchNo: `MOCK-${facility.id}-B1`, quantity: effective, expiryDate: '2028-02-29', status: 'AVAILABLE' }] : [],
    fixtureAssumptions: ['MOCK DATA'],
  };
}

export const mockForecast = {
  forecast: { dailyDemand: 40, lowerBound: 36, upperBound: 44, horizonDays: 14, unit: 'mL', method: 'MOCK DATA' },
  risk: { score: 84, label: 'CRITICAL', components: [] },
  stockout: {
    daysRemaining: 0.8, projectedWithinHorizon: true, projectedStockoutDay: 1, projectedStockoutDate: '2026-09-12', shortageGapDays: 7,
    minimumProjectedStock: 0, totalShortageDays: 7, unmetDemand: 250, supplyRestoredDay: 8, replenishmentTiming: 'AFTER_STOCKOUT', replenishmentArrivesBeforeStockout: false,
    nextReplenishment: { quantity: 600, arrivalDay: 8, arrivalDate: '2026-09-19', status: 'DELAYED' },
  },
  confidence: { label: 'LOW', reason: 'MOCK DATA: no real consumption history.', validRecords: 0, missingOrInvalidRecords: 0, anomalyCount: 0, recentVariabilityCv: null },
  cause: 'SUPPLY_DELAY',
  contributingFactors: ['SUPPLY_DELAY'],
  explanation: 'MOCK DATA: stock runs out before the delayed delivery arrives.',
  assumptions: ['MOCK DATA'],
  decisionSupportOnly: true,
  inventory: { protectedStock: 560, protectedStockSource: 'FACILITY_SAFETY_STOCK', nextReplenishment: { quantity: 600, arrivalDay: 8, arrivalDate: '2026-09-19', status: 'DELAYED' } },
  projection: Array.from({ length: 14 }, (_, index) => ({
    day: index + 1, date: `2026-09-${String(12 + index).padStart(2, '0')}`,
    closingStock: [0, 0, 0, 0, 0, 0, 0, 560, 520, 480, 440, 400, 360, 320][index],
    unmetDemand: index < 7 ? [10, 40, 40, 40, 40, 40, 40][index] : 0,
  })),
  dataLabel: 'MOCK DATA',
  modelVersion: 'mock-forecast',
  source: 'MOCK_DATA',
};

export const mockPlanRequest = { destinationFacilityId: 'MOCK-PHC-001', medicineId: insulin.id, quantity: 250, horizonDays: 14 };

function facilityState(id, name, role, daysRemaining, riskLabel, riskScore, stockoutDay) {
  return { facilityId: id, facilityName: name, role, daysRemaining, riskLabel, riskScore, stockoutDay, shortageDays: stockoutDay ? 7 : 0, unmetDemand: stockoutDay ? 250 : 0 };
}

export const mockPlan = {
  id: 'plan-mock-0001',
  status: 'PROPOSED',
  medicine: insulin,
  destinationFacilityId: 'MOCK-PHC-001',
  destinationFacilityName: 'Mock Primary Health Centre',
  requestedQuantity: 250,
  allocatedQuantity: 250,
  unit: 'mL',
  horizonDays: 14,
  transfers: [{
    fromFacilityId: 'MOCK-WH-001', fromFacilityName: 'Mock Regional Warehouse', toFacilityId: 'MOCK-PHC-001', toFacilityName: 'Mock Primary Health Centre',
    medicineId: insulin.id, batchId: 1, batchNo: 'MOCK-MOCK-WH-001-B1', expiryDate: '2028-02-29', quantity: 250, unit: 'mL',
    departureDay: 1, arrivalDay: 1, arrivalDate: '2026-09-12', distanceKm: 100, travelHours: 2.5, coldChainAvailable: true,
  }],
  recipient: { facilityId: 'MOCK-PHC-001', facilityName: 'Mock Primary Health Centre', stockoutDayBefore: 1, stockoutDayAfter: null, shortageDaysBefore: 7, shortageDaysAfter: 0, unmetDemandBefore: 250, unmetDemandAfter: 0, stockoutPrevented: true },
  candidates: [
    { facilityId: 'MOCK-WH-001', facilityName: 'Mock Regional Warehouse', facilityType: 'Warehouse', status: 'SELECTED', rejectionCodes: [], rejectionReasons: [], effectiveStock: 5000, protectedStock: 0, retainedFloor: 500, futureReplenishmentExcluded: 0, safeCapacity: 4500, allocatedQuantity: 250, baselineRiskLabel: 'LOW', baselineRiskScore: 0, distanceKm: 100, travelHours: 2.5, explanation: 'MOCK DATA: selected donor.' },
    { facilityId: 'MOCK-DH-001', facilityName: 'Mock District Hospital', facilityType: 'DistrictHospital', status: 'REJECTED', rejectionCodes: ['NO_SAFE_DONOR_CAPACITY'], rejectionReasons: ['MOCK DATA: counting only stock already received, this donor has no safe surplus.'], effectiveStock: 900, protectedStock: 700, retainedFloor: 780.5, futureReplenishmentExcluded: 700, safeCapacity: 0, allocatedQuantity: 0, baselineRiskLabel: 'LOW', baselineRiskScore: 14, distanceKm: 40, travelHours: 1.2, explanation: 'MOCK DATA: rejected donor.' },
  ],
  equityGuardrail: { maxTravelHours: 6, donorCapacityBasis: 'RECEIVED_STOCK_ONLY' },
  rationale: 'MOCK DATA: the warehouse covers the shortage and keeps its retained floor.',
  validation: { validator: 'mock-simulator', passed: true, checks: [
    { name: 'ALL_TRANSFERS_ELIGIBLE', passed: true, detail: 'MOCK DATA' },
    { name: 'DONORS_SAFE_WITHOUT_FUTURE_SUPPLY', passed: true, detail: 'MOCK DATA' },
    { name: 'SAFE_TO_RECOMMEND', passed: true, detail: 'MOCK DATA' },
  ] },
  assumptions: ['MOCK DATA'],
  limitations: ['MOCK DATA is not a safety result.'],
  simulation: {
    baseline: { facilities: [facilityState('MOCK-WH-001', 'Mock Regional Warehouse', 'DONOR', null, 'LOW', 0, null), facilityState('MOCK-PHC-001', 'Mock Primary Health Centre', 'RECIPIENT', 0.8, 'CRITICAL', 84, 1)] },
    intervention: { facilities: [facilityState('MOCK-WH-001', 'Mock Regional Warehouse', 'DONOR', null, 'LOW', 0, null), facilityState('MOCK-PHC-001', 'Mock Primary Health Centre', 'RECIPIENT', 7, 'MEDIUM', 40, null)] },
    transferEvaluations: [],
    comparison: { safeToRecommend: true, newShortagesCreated: [], newCriticalFacilities: [], newRisks: [], summary: 'MOCK DATA' },
    maxTravelHours: 6,
    receivedStockCheck: { basis: 'RECEIVED_STOCK_ONLY', passed: true, donors: [{ facilityId: 'MOCK-WH-001', facilityName: 'Mock Regional Warehouse', totalSent: 250, retainedFloor: 500, lowestProjectedStock: 4750, lowestProjectedDay: 1, futureReplenishmentExcluded: 0, passed: true, failureCodes: [], explanation: 'MOCK DATA' }], explanation: 'MOCK DATA' },
    decisionSupportOnly: true,
    modelVersion: 'mock-simulator',
  },
  decisionSupportOnly: true,
  requiresHumanApproval: true,
  dataContext: { dataSource: 'MOCK_DATA' },
  dataLabel: 'MOCK DATA',
  modelVersion: 'mock-optimizer',
  source: 'MOCK_DATA',
};

export const mockNoSafePlan = {
  code: 'NO_SAFE_PLAN',
  message: `MOCK DATA: only the sample request (${mockPlanRequest.quantity} mL of Mock Insulin for Mock Primary Health Centre over 14 days) has a sample plan.`,
  details: {
    requestedQuantity: null, safeCapacity: 0, unmetQuantity: null, unit: 'mL', solverStatus: 'INFEASIBLE',
    eligibleCandidates: [], rejectedCandidates: [mockPlan.candidates[1]],
    recommendedEscalation: ['MOCK DATA: run the sample request, or connect the API for a real assessment.'],
    equityGuardrail: mockPlan.equityGuardrail,
  },
};
