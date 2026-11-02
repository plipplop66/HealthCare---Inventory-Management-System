// Intelligence-service responses in the shape the Python service returns, and a fake service to serve them.
// Shared by the backend tests; this file is not a test itself.
const http = require('node:http');

const VELLORE_PLAN_ID = 'plan-a4d757f3efa18dc5765e61e71f993073';

const VELLORE_TRANSFER = Object.freeze({
  fromFacilityId: 'WH-TN-001', fromFacilityName: 'Tamil Nadu Central Warehouse', toFacilityId: 'PHC-VLR-001',
  toFacilityName: 'Vellore Primary Health Centre', medicineId: '7', batchId: 14, batchNo: 'TN-007-B01-26', expiryDate: '2028-02-29',
  quantity: 300, unit: 'mL', departureDay: 1, arrivalDay: 1, arrivalDate: '2026-09-12', distanceKm: 124.7, travelHours: 3.19,
  coldChainAvailable: true
});

const hundredths = (value) => Math.round(Number(value) * 100);

// POST /scenarios/simulate: every transfer eligible with its own batch, unless overrides say otherwise.
function simulationResponse(request, overrides = {}) {
  const medicineId = String(request.transfers[0]?.medicineId ?? '7');
  const sent = new Map();
  for (const transfer of request.transfers) {
    sent.set(transfer.fromFacilityId, (sent.get(transfer.fromFacilityId) || 0) + hundredths(transfer.quantity));
  }
  return {
    scenarioType: 'SIMULATED_DATABASE',
    horizonDays: request.horizonDays,
    medicineId,
    medicine: {
      id: medicineId, genericName: 'Human Insulin', strength: '100 IU/mL', dosageForm: 'Vial', unit: 'mL',
      criticality: 'CRITICAL', requiresColdChain: true
    },
    baseline: { facilities: [], regionalShortageDays: 13 },
    intervention: { facilities: [], regionalShortageDays: 0 },
    transferEvaluations: request.transfers.map((transfer, index) => ({
      index,
      fromFacilityId: transfer.fromFacilityId,
      toFacilityId: transfer.toFacilityId,
      medicineId: transfer.medicineId,
      quantity: transfer.quantity,
      arrivalDay: transfer.arrivalDay ?? 1,
      departureDay: transfer.departureDay ?? transfer.arrivalDay ?? 1,
      eligible: true,
      applied: true,
      rejectionReasons: [],
      rejectionCodes: [],
      route: { distanceKm: 124.7, travelHours: 3.19, coldChainAvailable: true },
      batches: [{ batchId: transfer.batchId ?? null, batchNo: transfer.batchNo ?? 'TN-007-B01-26', quantity: transfer.quantity, expiryDate: '2028-02-29' }],
      explanation: 'The transfer is feasible and applied.'
    })),
    comparison: {
      recipientStockoutPrevented: true, recipientOutcomes: [], newShortagesCreated: [], newCriticalFacilities: [], newRisks: [],
      improvedFacilities: [], worsenedFacilities: [], regionalOutcome: 'IMPROVED', safeToRecommend: true, summary: 'Safe to recommend.'
    },
    maxTravelHours: 6,
    receivedStockCheck: {
      basis: 'RECEIVED_STOCK_ONLY',
      passed: true,
      donors: [...sent].map(([facilityId, units]) => ({
        facilityId, facilityName: facilityId, totalSent: units / 100, retainedFloor: 100, lowestProjectedStock: 500,
        lowestProjectedDay: 1, futureReplenishmentExcluded: 0, passed: true, failureCodes: [], explanation: 'Keeps its retained floor.'
      })),
      explanation: 'Every donor keeps its retained floor.'
    },
    assumptions: ['Simulated data only.'],
    limitations: ['Not clinically validated.'],
    decisionSupportOnly: true,
    dataContext: { dataSource: 'POSTGRES', dataLabel: 'SIMULATED DATABASE', simulationDate: '2026-09-11', asOfDate: '2026-09-12' },
    dataLabel: 'SIMULATED DATABASE',
    modelVersion: 'aiml-ripple-simulator-v1',
    ...overrides
  };
}

// POST /plans/optimize: a proposed, validated plan (the Vellore golden plan by default).
function planResponse({
  id = VELLORE_PLAN_ID, destinationFacilityId = 'PHC-VLR-001', horizonDays = 14, transfers = [VELLORE_TRANSFER], dataSource = 'POSTGRES'
} = {}) {
  const requestedQuantity = transfers.reduce((total, transfer) => total + hundredths(transfer.quantity), 0) / 100;
  const dataContext = { dataSource, dataLabel: 'SIMULATED DATABASE', simulationDate: '2026-09-11', asOfDate: '2026-09-12' };
  const simulation = simulationResponse({ horizonDays, transfers }, { dataContext });
  return {
    id,
    status: 'PROPOSED',
    medicine: simulation.medicine,
    destinationFacilityId,
    destinationFacilityName: 'Vellore Primary Health Centre',
    requestedQuantity,
    allocatedQuantity: requestedQuantity,
    unit: 'mL',
    horizonDays,
    solver: { name: 'OR-Tools', algorithm: 'CP-SAT', status: 'OPTIMAL' },
    transfers: transfers.map((transfer) => ({ ...transfer })),
    recipient: { facilityId: destinationFacilityId, stockoutDayBefore: 1, stockoutDayAfter: null },
    candidates: [{ facilityId: 'WH-TN-001', status: 'SELECTED', rejectionCodes: [] }],
    equityGuardrail: { maxTravelHours: 6, donorCapacityBasis: 'RECEIVED_STOCK_ONLY' },
    rationale: 'The warehouse covers the shortage safely.',
    validation: { validator: 'aiml-ripple-simulator-v1', passed: true, checks: [{ name: 'SAFE_TO_RECOMMEND', passed: true, detail: 'Safe.' }] },
    assumptions: ['Simulated data only.'],
    limitations: ['Not clinically validated.'],
    simulation,
    decisionSupportOnly: true,
    requiresHumanApproval: true,
    dataContext,
    dataLabel: 'SIMULATED DATABASE',
    modelVersion: 'aiml-transfer-optimizer-v2'
  };
}

// A fake intelligence service. handler({ url, body }) returns { status, body }, or 'HANG' to never answer.
async function startFakeIntelligence(t, handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', async () => {
      const body = text ? JSON.parse(text) : null;
      requests.push({ url: request.url, body });
      const result = await handler({ url: request.url, body });
      if (result === 'HANG') return;
      response.writeHead(result.status || 200, { 'content-type': 'application/json' });
      response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

module.exports = { VELLORE_PLAN_ID, VELLORE_TRANSFER, simulationResponse, planResponse, startFakeIntelligence };
