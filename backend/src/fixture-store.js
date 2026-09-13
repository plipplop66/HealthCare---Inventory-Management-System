const medicine = {
  id: 'med-insulin-100iu-vial',
  genericName: 'Human insulin',
  strength: '100 IU/mL',
  dosageForm: '10 mL vial',
  unit: 'vial',
  criticality: 'HIGH',
  storage: '2-8 C'
};

const facilities = [
  {
    id: 'facility-central-store', name: 'Central District Store', type: 'WAREHOUSE', district: 'Medripple District',
    latitude: 18.522, longitude: 73.857, populationServed: 0, remotenessScore: 0.05,
    effectiveStock: 620, dailyDemand: 20, protectedDays: 14, incomingSupply: 0
  },
  {
    id: 'facility-district-hospital', name: 'District Hospital', type: 'DISTRICT_HOSPITAL', district: 'Medripple District',
    latitude: 18.535, longitude: 73.848, populationServed: 120000, remotenessScore: 0.15,
    effectiveStock: 260, dailyDemand: 26, protectedDays: 10, incomingSupply: 0
  },
  {
    id: 'facility-river-chc', name: 'River CHC', type: 'CHC', district: 'Medripple District',
    latitude: 18.501, longitude: 73.891, populationServed: 45000, remotenessScore: 0.55,
    effectiveStock: 100, dailyDemand: 8, protectedDays: 10, incomingSupply: 0
  },
  {
    id: 'facility-navjeevan-phc', name: 'Navjeevan PHC', type: 'PHC', district: 'Medripple District',
    latitude: 18.472, longitude: 73.928, populationServed: 12000, remotenessScore: 0.8,
    effectiveStock: 22, dailyDemand: 8, protectedDays: 14, incomingSupply: 100, incomingSupplyDay: 8
  }
];

const batchesByFacility = {
  'facility-central-store': [
    { batchNo: 'INS-CS-2401', quantity: 600, expiryDate: '2027-01-31', status: 'USABLE' },
    { batchNo: 'INS-CS-2402', quantity: 300, expiryDate: '2027-04-30', status: 'USABLE' }
  ],
  'facility-district-hospital': [
    { batchNo: 'INS-DH-2403', quantity: 260, expiryDate: '2026-12-31', status: 'USABLE' }
  ],
  'facility-river-chc': [
    { batchNo: 'INS-RC-2404', quantity: 100, expiryDate: '2026-11-30', status: 'USABLE' }
  ],
  'facility-navjeevan-phc': [
    { batchNo: 'INS-NP-2405', quantity: 22, expiryDate: '2026-10-31', status: 'USABLE' },
    { batchNo: 'INS-NP-OLD', quantity: 5, expiryDate: '2026-01-31', status: 'EXPIRED' }
  ]
};

const routes = {
  'facility-central-store:facility-navjeevan-phc': { distanceKm: 22, travelHours: 1.2, coldChainAvailable: true },
  'facility-river-chc:facility-navjeevan-phc': { distanceKm: 14, travelHours: 0.8, coldChainAvailable: true },
  'facility-district-hospital:facility-navjeevan-phc': { distanceKm: 18, travelHours: 1, coldChainAvailable: true }
};

let audits = [];
let plans = new Map();

function riskForDays(days) {
  if (days <= 3) return { label: 'CRITICAL', score: 92 };
  if (days <= 7) return { label: 'HIGH', score: 72 };
  if (days <= 14) return { label: 'MEDIUM', score: 43 };
  return { label: 'LOW', score: 14 };
}

function getFacility(id) {
  return facilities.find((facility) => facility.id === id);
}

function projectFacility(facility, stockAdjustment = 0) {
  const adjustedStock = Math.max(0, facility.effectiveStock + stockAdjustment);
  const daysRemaining = Number((adjustedStock / facility.dailyDemand).toFixed(1));
  const protectedStock = facility.dailyDemand * facility.protectedDays;
  const risk = riskForDays(daysRemaining);

  return {
    facilityId: facility.id,
    facilityName: facility.name,
    effectiveStock: adjustedStock,
    dailyDemand: facility.dailyDemand,
    daysRemaining,
    protectedStock,
    safeSurplus: Math.max(0, adjustedStock - protectedStock),
    riskLabel: risk.label,
    riskScore: risk.score
  };
}

function listFacilities() {
  return facilities.map((facility) => ({
    ...facility,
    ...projectFacility(facility),
    medicineId: medicine.id,
    dataFreshness: 'SIMULATED FIXTURE'
  }));
}

function getInventory(facilityId) {
  const facility = getFacility(facilityId);
  if (!facility) return null;

  return {
    facility: { id: facility.id, name: facility.name, type: facility.type },
    medicine,
    recordedStock: (batchesByFacility[facilityId] || []).reduce((total, batch) => total + batch.quantity, 0),
    effectiveStock: facility.effectiveStock,
    excludedStock: (batchesByFacility[facilityId] || [])
      .filter((batch) => batch.status !== 'USABLE')
      .reduce((total, batch) => total + batch.quantity, 0),
    dailyConsumption: facility.dailyDemand,
    incomingReplenishment: facility.incomingSupply
      ? { quantity: facility.incomingSupply, expectedInDays: facility.incomingSupplyDay, status: 'EXPECTED' }
      : null,
    batches: batchesByFacility[facilityId] || [],
    fixtureAssumptions: ['Effective stock excludes expired batches.', 'All quantities are simulated vials.']
  };
}

function getRoute(fromFacilityId, toFacilityId) {
  return routes[`${fromFacilityId}:${toFacilityId}`] || { distanceKm: null, travelHours: null, coldChainAvailable: false };
}

function createPlan({ destinationFacilityId, medicineId = medicine.id, quantity = 45, horizonDays = 14 }) {
  const destination = getFacility(destinationFacilityId);
  if (!destination || medicineId !== medicine.id) return null;

  const firstQuantity = Math.min(35, quantity);
  const secondQuantity = Math.max(0, quantity - firstQuantity);
  const transfers = [
    { fromFacilityId: 'facility-central-store', toFacilityId: destinationFacilityId, medicineId, quantity: firstQuantity, arrivalDay: 1 },
    ...(secondQuantity ? [{ fromFacilityId: 'facility-river-chc', toFacilityId: destinationFacilityId, medicineId, quantity: secondQuantity, arrivalDay: 1 }] : [])
  ];
  const plan = {
    id: `plan-${Date.now()}`,
    status: 'PROPOSED',
    medicine,
    horizonDays,
    transfers,
    rationale: 'Fixture plan splits supply across facilities that retain protected stock.',
    assumptions: ['Simulated data only.', 'Exact presentation match is assumed.', 'A human must approve before any action.']
  };
  plans.set(plan.id, plan);
  return plan;
}

function getPlan(id) {
  return plans.get(id);
}

function approvePlan(id, decision, actor, note, beforeState, afterState) {
  const plan = plans.get(id);
  if (!plan) return null;
  const audit = {
    id: `audit-${audits.length + 1}`,
    planId: id,
    actor,
    action: decision === 'APPROVE' ? 'PLAN_APPROVED' : 'PLAN_REJECTED',
    note,
    timestamp: new Date().toISOString(),
    beforeState,
    afterState
  };
  plan.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  plan.decision = audit;
  audits = [audit, ...audits];
  return { plan, audit };
}

function listAudits() {
  return audits;
}

function resetFixtureState() {
  audits = [];
  plans = new Map();
}

function getScenarioProfile(facilityId, medicineId) {
  const facility = getFacility(facilityId);
  if (!facility || medicineId !== medicine.id) return null;
  const projection = projectFacility(facility);
  return {
    facilityId: facility.id,
    facilityName: facility.name,
    medicineId: medicine.id,
    medicine,
    effectiveStock: projection.effectiveStock,
    dailyDemand: projection.dailyDemand,
    protectedStock: projection.protectedStock,
    safeSurplus: projection.safeSurplus,
    daysRemaining: projection.daysRemaining,
    riskLabel: projection.riskLabel,
    riskScore: projection.riskScore,
    hasColdChain: true,
    requiresColdChain: true,
    incomingSupply: facility.incomingSupply || 0,
    incomingArrivalDay: facility.incomingSupplyDay || null
  };
}

function listScenarioProfiles(medicineId) {
  if (medicineId !== medicine.id) return [];
  return facilities.map((facility) => getScenarioProfile(facility.id, medicineId));
}

function selectTransferBatch(facilityId, medicineId) {
  if (medicineId !== medicine.id) return null;
  const batch = (batchesByFacility[facilityId] || []).find((item) => item.status === 'USABLE');
  return batch ? { batchId: batch.batchNo, batchNo: batch.batchNo } : null;
}

module.exports = {
  medicine, getFacility, getInventory, getRoute, listFacilities, listAudits, getPlan,
  createPlan, approvePlan, projectFacility, resetFixtureState, getScenarioProfile,
  listScenarioProfiles, selectTransferBatch
};
