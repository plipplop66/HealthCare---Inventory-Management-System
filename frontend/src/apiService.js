// Mock API Layer mapped exactly to the Frontend Display Contract
const MOCK_DELAY = 600;
const delay = (ms) => new Promise(res => setTimeout(res, ms));

export const getDashboardData = async () => {
  await delay(MOCK_DELAY);
  return {
    meta: {
      source: 'Live Intelligence',
      requestId: 'req_8f7d9a1b',
      fallback: false
    },
    resilienceScore: 78,
    dataFreshness: '2 minutes ago',
    criticalFacilityCount: 4,
    totalFacilities: 10, // Must not hardcode 8
    earliestStockout: {
      facilityName: 'PHC-VLR-001',
      medicine: 'Human Insulin',
      daysRemaining: 2.8,
      stockoutDate: '2026-09-17'
    },
    regionalShortageDaysPrevented: 14, // Cannot use patient-days at risk
    facilities: [
      { 
        facilityId: 'f_001', facilityName: 'PHC-VLR-001', facilityType: 'PHC', 
        medicine: { genericName: 'Human Insulin', strength: '100 IU/mL', dosageForm: 'vial', unit: 'mL' }, 
        effectiveStock: 34, dailyDemand: 38.88, daysRemaining: 0.8,
        risk: { label: 'CRITICAL', score: 92 }, cause: 'Delayed Replenishment',
        lat: 12.924, lng: 79.135
      },
      { 
        facilityId: 'f_002', facilityName: 'WH-TN-001', facilityType: 'Warehouse', 
        medicine: { genericName: 'Human Insulin', strength: '100 IU/mL', dosageForm: 'vial', unit: 'mL' }, 
        effectiveStock: 6200, dailyDemand: 120, daysRemaining: 51,
        risk: { label: 'LOW', score: 14 }, cause: 'Stable',
        lat: 13.082, lng: 80.270
      }
    ]
  };
};

export const getFacilityDetails = async (facilityId) => {
  await delay(MOCK_DELAY);
  
  // Generating a 14-day projection array for the Recharts timeline
  const baseStock = 34;
  const demand = 38.88;
  const projection = [];
  let currentStock = baseStock;
  
  for(let i=0; i<14; i++) {
    const day = new Date();
    day.setDate(day.getDate() + i);
    const dateStr = day.toISOString().split('T')[0];
    
    // Simulate replenishment on day 8
    const replenishment = i === 8 ? 1000 : 0;
    const openingStock = currentStock;
    currentStock = Math.max(0, currentStock + replenishment - demand);
    const unmetDemand = openingStock + replenishment < demand ? demand - (openingStock + replenishment) : 0;
    
    projection.push({
      date: dateStr,
      day: `Day ${i}`,
      openingStock,
      replenishment,
      demand,
      closingStock: currentStock,
      unmetDemand,
      protectedStock: 155 // fixed safety stock
    });
  }

  return {
    meta: { source: 'Live Intelligence', fallback: false },
    facilityId: facilityId || 'f_001',
    facilityName: 'PHC-VLR-001',
    facilityType: 'PHC',
    region: 'Vellore District',
    medicine: { genericName: 'Human Insulin', strength: '100 IU/mL', dosageForm: 'vial', unit: 'mL', criticality: 'HIGH' },
    dataContext: { asOfDate: '2026-09-14', simulationDate: '2026-09-14', dataLabel: 'Live Sync' },
    risk: { score: 92, label: 'CRITICAL', cause: 'Delayed replenishment', decisionSupportLabel: 'Immediate Action Required' },
    inventory: { recordedStock: 34, effectiveStock: 34, excludedStock: 0, protectedStock: 155, unit: 'mL' },
    forecast: { dailyDemand: 38.88, daysRemaining: 0.8, projectedStockoutDate: '2026-09-15', shortageGapDays: 7 },
    replenishment: { quantity: 1000, status: 'In Transit', expectedDate: '2026-09-22', arrivesBeforeStockout: false },
    confidence: { label: 'HIGH', reason: 'Based on 60 days of verified live inventory.', dataQuality: 'Reliable' },
    projection // Recharts will use this exact array
  };
};

export const getCandidates = async () => {
  await delay(MOCK_DELAY);
  return {
    requestedQuantity: 450,
    unit: 'mL',
    totalSafeCapacity: 3400,
    allocatedQuantity: 450,
    counts: { selected: 1, eligibleNotSelected: 1, rejected: 2 },
    maxTravelHours: 6,
    candidates: [
      {
        facilityId: 'f_002', facilityName: 'WH-TN-001', facilityType: 'Warehouse',
        effectiveStock: 6200, predictedDailyDemand: 120, baselineRiskLabel: 'LOW', baselineRiskScore: 14,
        protectedStock: 2400, equityUplift: 400, retainedFloor: 2800, safeCapacity: 3400,
        status: 'SELECTED', allocatedQuantity: 450,
        futureReplenishmentExcluded: 0, explanation: '',
        distanceKm: 135, travelHours: 3.19, maxTravelHours: 6, coldChainAvailable: true,
        rejectionCodes: [], rejectionReasons: []
      },
      {
        facilityId: 'f_003', facilityName: 'DH-VLR-002', facilityType: 'District Hospital',
        effectiveStock: 2600, predictedDailyDemand: 80, baselineRiskLabel: 'MEDIUM', baselineRiskScore: 45,
        protectedStock: 2600, equityUplift: 0, retainedFloor: 2600, safeCapacity: 0,
        status: 'REJECTED', allocatedQuantity: 0,
        futureReplenishmentExcluded: 0, explanation: '',
        distanceKm: 18, travelHours: 0.5, maxTravelHours: 6, coldChainAvailable: true,
        rejectionCodes: ['NO_SAFE_DONOR_CAPACITY'], 
        rejectionReasons: ['Retained floor (2600) limits safe surplus against projected demand.']
      },
      {
        facilityId: 'f_004', facilityName: 'CHC-VLR-003', facilityType: 'CHC',
        effectiveStock: 1000, predictedDailyDemand: 20, baselineRiskLabel: 'LOW', baselineRiskScore: 20,
        protectedStock: 800, equityUplift: 0, retainedFloor: 800, safeCapacity: 200,
        status: 'REJECTED', allocatedQuantity: 0,
        futureReplenishmentExcluded: 0, explanation: '',
        distanceKm: 250, travelHours: 7.2, maxTravelHours: 6, coldChainAvailable: false,
        rejectionCodes: ['TRAVEL_TIME_LIMIT_EXCEEDED', 'COLD_CHAIN_UNAVAILABLE'], 
        rejectionReasons: ['Actual travel time (7.2h) exceeds 6h maximum.', 'Cold-chain continuity failed routing check.']
      }
    ]
  };
};

export const getRippleSimulation = async () => {
  await delay(MOCK_DELAY);
  return {
    meta: { source: 'Python Optimizer v2.4', fallback: false },
    horizon: 14,
    facilities: [
      {
        role: 'Donor', facilityId: 'f_002', facilityName: 'WH-TN-001', facilityType: 'Warehouse',
        effectiveStock: 6200, transferIn: 0, transferOut: 450, stockAfterTransfers: 5750,
        predictedDailyDemand: 120, protectedStock: 2800, belowProtectedStock: false,
        stockoutDate: null, shortageDays: 0, unmetDemand: 0,
        endingStock: 4070, riskScore: 18, riskLabel: 'LOW'
      },
      {
        role: 'Recipient', facilityId: 'f_001', facilityName: 'PHC-VLR-001', facilityType: 'PHC',
        effectiveStock: 34, transferIn: 450, transferOut: 0, stockAfterTransfers: 484,
        predictedDailyDemand: 38.88, protectedStock: 155, belowProtectedStock: false,
        stockoutDate: null, shortageDays: 0, unmetDemand: 0,
        endingStock: 939, riskScore: 25, riskLabel: 'MEDIUM' // Simulation solved it
      }
    ],
    transfers: [
      {
        donor: 'WH-TN-001', recipient: 'PHC-VLR-001', medicine: 'Human Insulin 100 IU/mL', quantity: 450, unit: 'mL',
        departureDay: 0, arrivalDay: 0,
        eligible: true, applied: true,
        rejectionCodes: [],
        distanceKm: 135, travelHours: 3.19, coldChainAvailable: true,
        batch: { id: '14', number: 'TN-007-B01-26', quantity: 450, expiry: '2027-01-31' }
      }
    ],
    regionalOutcome: {
      safeToRecommend: true,
      stockoutDaysBefore: 7, stockoutDaysAfter: 0, shortageDaysPrevented: 7,
      unmetDemandBefore: 272, unmetDemandAfter: 0, unmetDemandReduced: 272,
      newShortages: 0, newCriticalFacilities: 0, newRisks: 0, improvedFacilities: 1, worsenedFacilities: 0,
      assumptions: ['Stable demand forecast', 'Zero routing delays']
    }
  };
};

export const getPlanReview = async () => {
  await delay(MOCK_DELAY);
  return {
    planId: 'plan_99a8b1',
    status: 'PROPOSED',
    meta: { source: 'Live Python Optimizer', fallback: false },
    destination: { facilityId: 'f_001', facilityName: 'PHC-VLR-001' },
    medicine: { id: 'm_001', genericName: 'Human Insulin', strength: '100 IU/mL', dosageForm: 'vial', unit: 'mL' },
    requestedQuantity: 450,
    allocatedQuantity: 450,
    horizon: 14,
    solver: { name: 'Medripple Solver', status: 'Optimal', modelVersion: 'v2.4', validationPassed: true },
    batches: [
      {
        source: { facilityId: 'f_002', facilityName: 'WH-TN-001' },
        quantity: 450,
        batch: { id: '14', number: 'TN-007-B01-26', expiryDate: '2027-01-31' },
        timing: { departureDay: 0, arrivalDay: 0, arrivalDate: '2026-09-14' },
        routeSafety: { distanceKm: 135, travelHours: 3.19, coldChainAvailable: true },
        donorProtection: { retainedFloor: 2800, safeCapacity: 3400, simulationOutcome: 'LOW' }
      }
    ],
    decision: {
      rationale: 'All safety constraints met. Prevents 7 shortage days without risking donor.',
      safeToRecommend: true,
      shortageDaysPrevented: 7,
      unmetDemandReduced: 272
    }
  };
};

export const getAuditTrail = async () => {
  await delay(MOCK_DELAY);
  return {
    active: {
      eventId: 'evt_9912',
      scenario: 'PHC-VLR-001 stockout prevention',
      details: 'Human Insulin 100 IU/mL · safe multi-source transfer under review.'
    },
    history: []
  };
};
