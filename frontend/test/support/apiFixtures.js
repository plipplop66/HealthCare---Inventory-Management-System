// API envelopes in the shape the local Node API returned for the PostgreSQL demo dataset (trimmed), and a fake API
// that records every call. This file is a helper, not a test.

export const insulin = { id: '7', genericName: 'Human Insulin', strength: '100.000 IU/mL', dosageForm: 'Vial', unit: 'mL', criticality: 'CRITICAL', storage: '2.0-8.0 C', requiresColdChain: true };
export const adrenaline = { id: '10', genericName: 'Adrenaline Auto-Injector', strength: '1.000 mg', dosageForm: 'PreFilledPen', unit: 'count', criticality: 'CRITICAL', storage: '15.0-25.0 C', requiresColdChain: false };

const meta = (source, extra = {}) => ({ source, fallback: false, decisionSupportOnly: false, requestId: `req-${source.toLowerCase()}`, ...extra });

export function apiError(status, code, message, details = null, requestId = 'req-error') {
  return Object.assign(new Error(message), { name: 'ApiError', status, code, details, requestId });
}

export const summary = {
  data: {
    resilienceScore: 67,
    earliestStockout: { facilityId: 'PHC-VLR-001', facilityName: 'Vellore Primary Health Centre', daysRemaining: 0.9 },
    criticalFacilityCount: 1,
    patientDaysAtRisk: 505,
    alerts: [{ facilityId: 'PHC-VLR-001', riskLabel: 'CRITICAL', cause: 'LOW_SIMULATED_COVERAGE', daysRemaining: 0.9 }],
    dataFreshness: 'SIMULATED DATABASE',
  },
  meta: meta('POSTGRES'),
};

const row = (facilityId, name, type, riskLabel, riskScore, daysRemaining, effectiveStock, protectedStock) => ({
  id: facilityId, facilityId, name, type, district: 'Tamil Nadu', medicineId: '7', medicine: insulin,
  effectiveStock, dailyDemand: 10, daysRemaining, protectedStock, safeSurplus: 0, riskLabel, riskScore, dataFreshness: 'SIMULATED DATABASE AS OF 2026-09-11',
});

export const facilities = {
  data: [
    row('WH-TN-001', 'Tamil Nadu Central Warehouse', 'Warehouse', 'LOW', 0, null, 101940, 0),
    row('DH-CBE-001', 'Coimbatore District Hospital', 'DistrictHospital', 'MEDIUM', 43, 13.2, 2941.69, 1028.01),
    row('DH-MDU-001', 'Madurai District Hospital', 'DistrictHospital', 'HIGH', 72, 6.1, 2919.93, 1050.36),
    row('PHC-VLR-001', 'Vellore Primary Health Centre', 'PHC', 'CRITICAL', 92, 0.9, 34, 548.8),
  ],
  meta: meta('POSTGRES'),
};

export const medicines = { data: [insulin, adrenaline], meta: meta('POSTGRES') };

export const inventory = {
  data: {
    facility: { id: 'PHC-VLR-001', name: 'Vellore Primary Health Centre', type: 'PHC' },
    medicine: insulin,
    recordedStock: 34,
    effectiveStock: 34,
    excludedStock: 0,
    dailyConsumption: 38.99,
    incomingReplenishment: { quantity: 1372, expectedArrivalDate: '2026-09-19', status: 'DELAYED' },
    batches: [
      { batchId: 14, batchNo: 'TN-007-B01-26', quantity: 12, expiryDate: '2028-02-29', status: 'AVAILABLE' },
      { batchId: 13, batchNo: 'TN-007-B02-26', quantity: 22, expiryDate: '2028-04-24', status: 'AVAILABLE' },
    ],
  },
  meta: meta('POSTGRES'),
};

export const forecast = {
  data: {
    forecast: { dailyDemand: 38.88, lowerBound: 34.32, upperBound: 43.45, horizonDays: 14, unit: 'mL', method: 'WEIGHTED_MOVING_AVERAGE_7D_21D' },
    risk: { score: 87, label: 'CRITICAL', components: [] },
    stockout: {
      daysRemaining: 0.9, projectedWithinHorizon: true, projectedStockoutDay: 1, projectedStockoutDate: '2026-09-12', unmetDemand: 238.16,
      replenishmentTiming: 'AFTER_STOCKOUT', nextReplenishment: { quantity: 1372, arrivalDay: 8, arrivalDate: '2026-09-19', status: 'DELAYED' },
    },
    confidence: { label: 'HIGH', reason: 'Sufficient recent data: 60 valid daily records.' },
    cause: 'SUPPLY_DELAY',
    explanation: 'Vellore runs out on day 1, before the delayed delivery on day 8.',
    decisionSupportOnly: true,
    inventory: { protectedStock: 548.8, protectedStockSource: 'FACILITY_SAFETY_STOCK' },
    projection: [0, 0, 0, 0, 0, 0, 0, 1216.24, 1177.36, 1138.48, 1099.6, 1060.72, 1021.84, 982.96].map((closingStock, index) => ({
      day: index + 1, date: `2026-09-${String(12 + index).padStart(2, '0')}`, openingStock: 0, replenishment: 0, demand: 38.88, closingStock, unmetDemand: 0,
    })),
    dataLabel: 'SIMULATED_PROTOTYPE',
    modelVersion: 'aiml-step1-wma-v1',
    source: 'INTELLIGENCE_SERVICE',
  },
  meta: { source: 'INTELLIGENCE_SERVICE', fallback: false, decisionSupportOnly: false, requestId: 'req-forecast' },
};

// What the Node API returns when the intelligence service is down (backend createFallbackForecast).
export const fallbackForecast = {
  data: {
    forecast: { dailyDemand: 38.99, lowerBound: 35.09, upperBound: 42.89, horizonDays: 14 },
    risk: { score: 92, label: 'CRITICAL' },
    stockout: { daysRemaining: 0.9, projectedWithinHorizon: true },
    confidence: { label: 'LOW', reason: 'Deterministic fallback; awaiting the tested intelligence service.' },
    cause: 'SUPPLY_DELAY',
    explanation: 'Simulated stock will deplete before the scheduled replenishment arrives.',
    source: 'DATABASE_FALLBACK',
    isFallback: true,
    decisionSupportOnly: true,
    fallbackReason: 'INTELLIGENCE_UNAVAILABLE',
  },
  meta: { source: 'DATABASE_FALLBACK', fallback: true, decisionSupportOnly: false, requestId: 'req-fallback' },
};

const candidate = (facilityId, facilityName, status, codes, reasons, values) => ({
  facilityId, facilityName, facilityType: values.type, status, rejectionCodes: codes, rejectionReasons: reasons,
  effectiveStock: values.effective, protectedStock: values.protected, retainedFloor: values.floor, safeCapacity: values.capacity,
  allocatedQuantity: values.allocated || 0, futureReplenishmentExcluded: values.future || 0, baselineRiskLabel: values.risk, baselineRiskScore: values.score,
  distanceKm: values.km ?? null, travelHours: values.hours ?? null, explanation: values.explanation || `${status}.`,
});

export const candidates = {
  cbe: candidate('DH-CBE-001', 'Coimbatore District Hospital', 'SELECTED', [], [], { type: 'DistrictHospital', effective: 2941.69, protected: 1028.01, floor: 1130.82, capacity: 604.49, allocated: 167.59, future: 2998.36, risk: 'MEDIUM', score: 30, km: 122.5, hours: 3.1 }),
  mdu: candidate('DH-MDU-001', 'Madurai District Hospital', 'SELECTED', [], [], { type: 'DistrictHospital', effective: 2919.93, protected: 1050.36, floor: 1155.4, capacity: 632.41, allocated: 632.41, future: 2827.9, risk: 'MEDIUM', score: 33, km: 141.4, hours: 3.49 }),
  slm: candidate('CHC-SLM-001', 'Salem Community Health Centre', 'REJECTED', ['NO_SAFE_DONOR_CAPACITY'], ['Salem Community Health Centre must keep 886.72 mL; counting only stock already received it has no safe surplus. Future supply (1745.5 mL scheduled for day 3) is deliberately not counted toward donor capacity.'], { type: 'CHC', effective: 1246.78, protected: 698.2, floor: 886.72, capacity: 0, future: 1745.5, risk: 'MEDIUM', score: 32, km: 78.67, hours: 2.14 }),
  wh: candidate('WH-TN-001', 'Tamil Nadu Central Warehouse', 'REJECTED', ['TRAVEL_TIME_LIMIT_EXCEEDED'], ['Tamil Nadu Central Warehouse (WH-TN-001) takes 7.73 hours, over the configured 6-hour maximum donor travel time.'], { type: 'Warehouse', effective: 101940, protected: 0, floor: 10194, capacity: 0, risk: 'LOW', score: 0, km: 301.2, hours: 7.73 }),
  tnj: candidate('PHC-TNJ-001', 'Thanjavur Primary Health Centre', 'REJECTED', ['COLD_CHAIN_UNAVAILABLE', 'NO_SAFE_DONOR_CAPACITY'], ['Human Insulin requires a cold chain, but the route is not cold-chain capable.', 'Thanjavur has no safe surplus to send.'], { type: 'PHC', effective: 300, protected: 250, floor: 312.5, capacity: 0, risk: 'MEDIUM', score: 40, km: 90, hours: 2.5 }),
  nav: candidate('PHC-NAV-001', 'Navjeevan PHC', 'REJECTED', ['ROUTE_NOT_FOUND', 'DONOR_AT_RISK'], ['No transport route exists from Navjeevan PHC to Karur Primary Health Centre.', 'Navjeevan PHC is already CRITICAL risk (90) without any transfer, so it is not asked to donate.'], { type: 'PHC', effective: 22, protected: 112, floor: 140, capacity: 0, risk: 'CRITICAL', score: 90 }),
};

const transfer = (fromFacilityId, fromFacilityName, quantity, distanceKm, travelHours) => ({
  fromFacilityId, fromFacilityName, toFacilityId: 'PHC-KRR-001', toFacilityName: 'Karur Primary Health Centre', medicineId: '7',
  batchId: 14, batchNo: 'TN-007-B01-26', expiryDate: '2028-02-29', quantity, unit: 'mL', departureDay: 1, arrivalDay: 1, arrivalDate: '2026-09-12',
  distanceKm, travelHours, coldChainAvailable: true,
});

const state = (facilityId, facilityName, role, riskLabel, riskScore, daysRemaining, stockoutDay) => ({ facilityId, facilityName, role, riskLabel, riskScore, daysRemaining, stockoutDay });

export const KARUR_PLAN_ID = 'plan-a8eeac6add7ceda7e8df2bd1b5d7b273';
export const karurRequest = { destinationFacilityId: 'PHC-KRR-001', medicineId: '7', quantity: 800, horizonDays: 14 };

export function karurPlan(status = 'PROPOSED') {
  return {
    data: {
      id: KARUR_PLAN_ID,
      status,
      medicine: insulin,
      destinationFacilityId: 'PHC-KRR-001',
      destinationFacilityName: 'Karur Primary Health Centre',
      requestedQuantity: 800,
      allocatedQuantity: 800,
      unit: 'mL',
      horizonDays: 14,
      solver: { name: 'OR-Tools', algorithm: 'CP-SAT', status: 'OPTIMAL' },
      transfers: [transfer('DH-CBE-001', 'Coimbatore District Hospital', 167.59, 122.5, 3.1), transfer('DH-MDU-001', 'Madurai District Hospital', 632.41, 141.4, 3.49)],
      recipient: { facilityId: 'PHC-KRR-001', facilityName: 'Karur Primary Health Centre', stockoutDayBefore: 2, stockoutDayAfter: null, shortageDaysBefore: 7, shortageDaysAfter: 0, unmetDemandBefore: 268.24, unmetDemandAfter: 0, stockoutPrevented: true },
      candidates: Object.values(candidates),
      equityGuardrail: { maxTravelHours: 6, donorCapacityBasis: 'RECEIVED_STOCK_ONLY', status: 'APPROVED_FOR_HACKATHON_PROTOTYPE' },
      rationale: 'Two district hospitals cover the request while keeping their retained floors.',
      validation: { validator: 'aiml-ripple-simulator-v1', passed: true, checks: [
        { name: 'ALL_TRANSFERS_ELIGIBLE', passed: true, detail: 'All 2 transfer instruction(s) passed.' },
        { name: 'ROUTES_WITHIN_TRAVEL_LIMIT', passed: true, detail: 'Every donor route takes at most 6 hours.' },
        { name: 'DONORS_SAFE_WITHOUT_FUTURE_SUPPLY', passed: true, detail: 'Counting only stock already received, every donor keeps its retained floor.' },
        { name: 'SAFE_TO_RECOMMEND', passed: true, detail: 'Safe to recommend for human review.' },
      ] },
      assumptions: ['Simulated data only.'],
      limitations: ['Prototype decision support; not clinically validated.'],
      simulation: {
        baseline: { facilities: [state('DH-CBE-001', 'Coimbatore District Hospital', 'DONOR', 'MEDIUM', 30, 34.1, null), state('DH-MDU-001', 'Madurai District Hospital', 'DONOR', 'MEDIUM', 33, 36.6, null), state('PHC-KRR-001', 'Karur Primary Health Centre', 'RECIPIENT', 'CRITICAL', 88, 1, 2), state('WH-TN-001', 'Tamil Nadu Central Warehouse', 'NOT_IN_TRANSFER', 'LOW', 0, null, null)] },
        intervention: { facilities: [state('DH-CBE-001', 'Coimbatore District Hospital', 'DONOR', 'MEDIUM', 31, 32.2, null), state('DH-MDU-001', 'Madurai District Hospital', 'DONOR', 'MEDIUM', 35, 28.7, null), state('PHC-KRR-001', 'Karur Primary Health Centre', 'RECIPIENT', 'MEDIUM', 41, 21.8, null), state('WH-TN-001', 'Tamil Nadu Central Warehouse', 'NOT_IN_TRANSFER', 'LOW', 0, null, null)] },
        transferEvaluations: [],
        comparison: { safeToRecommend: true, newShortagesCreated: [], newCriticalFacilities: [], newRisks: [], regionalOutcome: 'IMPROVED', summary: 'Karur avoids the stockout projected on day 2.' },
        maxTravelHours: 6,
        receivedStockCheck: {
          basis: 'RECEIVED_STOCK_ONLY', passed: true, explanation: 'Counting only stock already received, every donor keeps its retained floor.',
          donors: [
            { facilityId: 'DH-CBE-001', totalSent: 167.59, retainedFloor: 1130.82, lowestProjectedStock: 1567.72, lowestProjectedDay: 14, futureReplenishmentExcluded: 2998.36, passed: true, failureCodes: [], explanation: 'Keeps its retained floor.' },
            { facilityId: 'DH-MDU-001', totalSent: 632.41, retainedFloor: 1155.4, lowestProjectedStock: 1155.4, lowestProjectedDay: 14, futureReplenishmentExcluded: 2827.9, passed: true, failureCodes: [], explanation: 'Keeps its retained floor.' },
          ],
        },
        decisionSupportOnly: true,
        modelVersion: 'aiml-ripple-simulator-v1',
      },
      decisionSupportOnly: true,
      requiresHumanApproval: true,
      dataContext: { dataSource: 'POSTGRES' },
      dataLabel: 'SIMULATED_PROTOTYPE',
      modelVersion: 'aiml-transfer-optimizer-v2',
      source: 'INTELLIGENCE_SERVICE',
    },
    meta: { source: 'INTELLIGENCE_SERVICE', fallback: false, decisionSupportOnly: true, requestId: 'req-optimize' },
  };
}

export function storedPlan(status = 'PROPOSED', extra = {}) {
  const plan = karurPlan(status);
  return { data: { ...plan.data, createdAt: '2026-09-17T09:58:41.363Z', ...extra }, meta: { source: 'POSTGRES', fallback: false, decisionSupportOnly: false, requestId: 'req-plan' } };
}

export const revalidation = {
  performed: true,
  passed: true,
  source: 'INTELLIGENCE_SERVICE',
  endpoint: '/scenarios/simulate',
  modelVersion: 'aiml-ripple-simulator-v1',
  dataSource: 'POSTGRES',
  checkedAt: '2026-09-17T09:58:41.456Z',
  horizonDays: 14,
  maxTravelHours: 6,
  checks: ['DECISION_SUPPORT', 'DATA_SOURCE', 'HORIZON', 'MEDICINE_IDENTITY', 'TRANSFERS_UNCHANGED', 'QUANTITY_TOTAL', 'ALL_TRANSFERS_ELIGIBLE', 'SAFE_TO_RECOMMEND', 'NO_NEW_SHORTAGES', 'NO_NEW_RISKS', 'ROUTES_WITHIN_TRAVEL_LIMIT', 'COLD_CHAIN', 'BATCHES_UNCHANGED', 'DONORS_SAFE_ON_RECEIVED_STOCK'],
  transfers: [
    { index: 0, fromFacilityId: 'DH-CBE-001', toFacilityId: 'PHC-KRR-001', batchId: 14, batchNo: 'TN-007-B01-26', quantity: 167.59, departureDay: 1, arrivalDay: 1, travelHours: 3.1, coldChainAvailable: true },
    { index: 1, fromFacilityId: 'DH-MDU-001', toFacilityId: 'PHC-KRR-001', batchId: 14, batchNo: 'TN-007-B01-26', quantity: 632.41, departureDay: 1, arrivalDay: 1, travelHours: 3.49, coldChainAvailable: true },
  ],
  receivedStockCheck: { basis: 'RECEIVED_STOCK_ONLY', passed: true, donors: [
    { facilityId: 'DH-CBE-001', totalSent: 167.59, retainedFloor: 1130.82, lowestProjectedStock: 1567.72, futureReplenishmentExcluded: 2998.36 },
    { facilityId: 'DH-MDU-001', totalSent: 632.41, retainedFloor: 1155.4, lowestProjectedStock: 1155.4, futureReplenishmentExcluded: 2827.9 },
  ] },
};

export function approvalResponse(overrides = {}) {
  return {
    data: {
      plan: { ...karurPlan('RESERVED').data },
      audit: { id: 2, planId: KARUR_PLAN_ID, action: 'PLAN_APPROVED', note: 'Reviewed.' },
      persistence: { storage: 'POSTGRES', planStatus: 'RESERVED', auditId: 2, transferIds: [2, 3] },
      revalidation,
      ...overrides,
    },
    meta: { source: 'POSTGRES', fallback: false, decisionSupportOnly: true, requestId: 'req-approve' },
  };
}

export const noSafePlanError = apiError(422, 'NO_SAFE_PLAN', 'No safe regional redistribution plan can satisfy the requested quantity.', {
  requestedQuantity: 1300,
  safeCapacity: 1236.9,
  unmetQuantity: 63.1,
  unit: 'mL',
  medicineId: '7',
  destinationFacilityId: 'PHC-KRR-001',
  horizonDays: 14,
  solverStatus: 'INFEASIBLE',
  eligibleCandidates: [{ ...candidates.cbe, status: 'ELIGIBLE_NOT_SELECTED', allocatedQuantity: 0 }, { ...candidates.mdu, status: 'ELIGIBLE_NOT_SELECTED', allocatedQuantity: 0 }],
  rejectedCandidates: [candidates.slm, candidates.wh, candidates.tnj, candidates.nav],
  recommendedEscalation: [
    'A smaller request of up to 1236.9 mL can be planned from eligible donors now; it still needs human approval.',
    'WH-TN-001 is beyond the 6-hour route limit; a longer transfer would need logistics and clinical approval outside this prototype and is not proposed.',
  ],
  equityGuardrail: { maxTravelHours: 6, donorCapacityBasis: 'RECEIVED_STOCK_ONLY' },
}, 'req-no-safe-plan');

export const revalidationFailedError = apiError(409, 'PLAN_REVALIDATION_FAILED', 'The plan is no longer safe to reserve (ALL_TRANSFERS_ELIGIBLE, SAFE_TO_RECOMMEND, ROUTES_WITHIN_TRAVEL_LIMIT). No stock was reserved. Re-run the optimizer for current conditions and review the new plan.', {
  planId: KARUR_PLAN_ID,
  failedChecks: [
    { name: 'ALL_TRANSFERS_ELIGIBLE', detail: 'transfer 0 (DH-CBE-001 batch TN-007-B01-26): TRAVEL_TIME_LIMIT_EXCEEDED' },
    { name: 'ROUTES_WITHIN_TRAVEL_LIMIT', detail: 'Missing or too long (limit 6 h): transfer 0 (DH-CBE-001 batch TN-007-B01-26) 6.5 h.' },
    { name: 'DONORS_SAFE_ON_RECEIVED_STOCK', detail: 'Donors not safe on received stock alone: DH-MDU-001.' },
  ],
  rejectedTransfers: [{ index: 0, fromFacilityId: 'DH-CBE-001', toFacilityId: 'PHC-KRR-001', batchId: 14, batchNo: 'TN-007-B01-26', quantity: 167.59, rejectionCodes: ['TRAVEL_TIME_LIMIT_EXCEEDED'], rejectionReasons: ['The route now takes 6.5 hours.'] }],
  newShortagesCreated: ['CHC-TRY-001'],
  newCriticalFacilities: [],
  newRisks: [{ facilityId: 'CHC-TRY-001', riskType: 'NEW_STOCKOUT', detail: 'New stockout.' }],
  unsafeDonors: [{ facilityId: 'DH-MDU-001', failureCodes: ['BELOW_RETAINED_FLOOR'], retainedFloor: 1155.4, lowestProjectedStock: 1067.72, futureReplenishmentExcluded: 2827.9, explanation: 'Only safe because of future supply.' }],
  safeToRecommend: false,
  modelVersion: 'aiml-ripple-simulator-v1',
  dataSource: 'POSTGRES',
  instruction: 'No stock was reserved. Re-run the optimizer for current conditions and review the new plan.',
}, 'req-revalidation');

export const stockChangedError = apiError(409, 'PLAN_STOCK_CHANGED', 'The donor stock changed after this plan was generated. Nothing was reserved; re-run the optimizer and review the new conditions.', {
  planId: KARUR_PLAN_ID,
  failures: [
    { reason: 'DONOR_STOCK_CHANGED_DURING_REVALIDATION', detail: 'Donor inventory changed while the plan was being revalidated.' },
    { index: 1, fromFacilityId: 'DH-MDU-001', batchId: 14, batchNo: 'TN-007-B01-26', reason: 'INSUFFICIENT_BATCH_QUANTITY', available: 100 },
  ],
}, 'req-stock');

export const auditEvents = {
  data: [
    { id: 6, entityType: 'plan', entityId: KARUR_PLAN_ID, action: 'CANCEL', actor: 'Approver <a@x.test>', note: 'Shipment cancelled.', afterState: { status: 'CANCELLED' }, timestamp: '2026-09-17T11:00:00.000Z' },
    { id: 5, entityType: 'plan', entityId: 'plan-2', action: 'DELIVER', actor: 'Approver <a@x.test>', note: 'Received.', afterState: { status: 'DELIVERED' }, timestamp: '2026-09-17T10:40:00.000Z' },
    { id: 4, entityType: 'plan', entityId: 'plan-2', action: 'DISPATCH', actor: 'Approver <a@x.test>', note: 'Left the warehouse.', afterState: { status: 'IN_TRANSIT' }, timestamp: '2026-09-17T10:20:00.000Z' },
    { id: 3, entityType: 'plan', entityId: 'plan-3', action: 'REJECT', actor: 'Approver <a@x.test>', note: 'Not needed.', afterState: { status: 'REJECTED' }, timestamp: '2026-09-17T10:10:00.000Z' },
    { id: 2, entityType: 'plan', entityId: KARUR_PLAN_ID, action: 'RESERVE', actor: 'Approver <a@x.test>', note: 'Reviewed.', afterState: { status: 'RESERVED', revalidation }, timestamp: '2026-09-17T10:00:00.000Z' },
    { id: 1, entityType: 'plan', entityId: 'plan-4', action: 'PLAN_APPROVED', actor: 'Approver <a@x.test>', note: 'Fixture approval.', afterState: { status: 'APPROVED' }, timestamp: '2026-09-17T09:00:00.000Z' },
  ],
  meta: meta('POSTGRES'),
};

// A route table for the fake API. Each handler receives { method, path, body } and returns an envelope or throws.
export function defaultRoutes(overrides = {}) {
  return {
    'GET /auth/me': () => ({ data: { user: { id: 'u1', name: 'Approver', email: 'a@x.test', role: 'APPROVER' } }, meta: meta('POSTGRES') }),
    'GET /region/summary': () => summary,
    'GET /facilities': () => facilities,
    'GET /medicines': () => medicines,
    'GET /facilities/PHC-VLR-001/inventory?medicineId=7': () => inventory,
    'POST /forecast': () => forecast,
    'POST /plans/optimize': () => karurPlan(),
    [`GET /plans/${KARUR_PLAN_ID}`]: () => storedPlan(),
    [`POST /plans/${KARUR_PLAN_ID}/approve`]: () => approvalResponse(),
    'GET /audit': () => auditEvents,
    ...overrides,
  };
}

export function createFakeRequest(routes) {
  const calls = [];
  const request = async (path, { method = 'GET', body } = {}) => {
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw apiError(404, 'NOT_FOUND', `No fake route for ${method} ${path}`);
    return structuredClone(await handler({ method, path, body }));
  };
  return { request, calls, count: (method, path) => calls.filter((call) => call.method === method && call.path === path).length };
}
