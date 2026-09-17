const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createIntelligenceAdapter } = require('../src/intelligence-adapter');
const { VELLORE_PLAN_ID, planResponse, simulationResponse, startFakeIntelligence } = require('./support/intelligence-fixtures');

test('NO_SAFE_PLAN preserves capacity and escalation details without a fallback', async (t) => {
  const details = { requestedQuantity: 45, safeCapacity: 14.3, unmetQuantity: 30.7, unit: 'mL', recommendedEscalation: ['Review replenishment.'] };
  const server = http.createServer((request, response) => {
    response.writeHead(422, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { code: 'NO_SAFE_PLAN', message: 'No safe plan', details } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: `http://127.0.0.1:${server.address().port}`, intelligenceTimeoutMs: 1000 }, {});
  await assert.rejects(adapter.optimize({ quantity: 45, horizonDays: 14 }), (error) => {
    assert.equal(error.code, 'NO_SAFE_PLAN');
    assert.equal(error.status, 422);
    assert.deepEqual(error.details, details);
    return true;
  });
});

test('database mode fallback forecasts against active database profiles', async () => {
  const requested = [];
  const inventoryStore = {
    source: 'MYSQL',
    async getScenarioProfile(facilityId, medicineId) {
      requested.push({ facilityId, medicineId });
      return {
        facilityId,
        medicineId,
        dailyDemand: 30,
        daysRemaining: 2,
        riskScore: 92,
        riskLabel: 'CRITICAL',
        incomingArrivalDay: 8
      };
    }
  };
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: '' }, inventoryStore);
  const forecast = await adapter.forecast({ facilityId: 'PHC-VLR-001', medicineId: '7', horizonDays: 14 });

  assert.deepEqual(requested, [{ facilityId: 'PHC-VLR-001', medicineId: '7' }]);
  assert.equal(forecast.source, 'DATABASE_FALLBACK');
  assert.equal(forecast.isFallback, true);
  assert.equal(forecast.cause, 'SUPPLY_DELAY');
});

test('uses the intelligence service for a compatible ripple simulation', async (t) => {
  const input = { horizonDays: 14, transfers: [{ fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, arrivalDay: 1 }] };
  const service = await startFakeIntelligence(t, ({ body }) => ({ body: simulationResponse(body) }));
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: service.url, intelligenceTimeoutMs: 1000 }, {});

  const scenario = await adapter.simulate(input);

  assert.equal(scenario.source, 'INTELLIGENCE_SERVICE');
  assert.equal(scenario.comparison.safeToRecommend, true);
  assert.deepEqual(service.requests, [{ url: '/scenarios/simulate', body: input }]);
});

test('service failures map to timeout, unavailable and invalid-response errors; decisions pass through', async (t) => {
  const request = { horizonDays: 14, transfers: [{ fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, arrivalDay: 1 }] };
  const stopped = http.createServer();
  await new Promise((resolve) => stopped.listen(0, '127.0.0.1', resolve));
  const stoppedUrl = `http://127.0.0.1:${stopped.address().port}`;
  await new Promise((resolve) => stopped.close(resolve));
  const cases = [
    [() => 'HANG', { status: 503, code: 'INTELLIGENCE_TIMEOUT' }],
    [null, { status: 503, code: 'INTELLIGENCE_UNAVAILABLE' }],
    [() => ({ status: 503, body: { error: { code: 'DATABASE_UNAVAILABLE', message: 'db down' } } }), { status: 503, code: 'INTELLIGENCE_UNAVAILABLE' }],
    [() => ({ body: '<html>' }), { status: 503, code: 'INVALID_INTELLIGENCE_RESPONSE' }],
    [() => ({ status: 405, body: '' }), { status: 503, code: 'INVALID_INTELLIGENCE_RESPONSE' }],
    [() => ({ status: 422, body: { error: { code: 'INVALID_REQUEST', message: 'Bad transfer.', details: { index: 0 } } } }), { status: 422, code: 'INVALID_REQUEST' }]
  ];
  for (const [handler, expected] of cases) {
    const url = handler ? (await startFakeIntelligence(t, handler)).url : stoppedUrl;
    const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: url, intelligenceTimeoutMs: 200 }, {});
    for (const run of [() => adapter.simulate(request), () => adapter.revalidatePlan(request), () => adapter.optimize({ destinationFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, horizonDays: 14 })]) {
      await assert.rejects(run(), (error) => {
        assert.deepEqual({ status: error.status, code: error.code }, expected);
        if (expected.code === 'INVALID_REQUEST') assert.deepEqual(error.details, { index: 0 });
        assert.doesNotMatch(error.message, /db down|<html>/);
        return true;
      });
    }
  }
});

test('plan revalidation requires route, batch and received-stock evidence', async (t) => {
  const request = {
    horizonDays: 14,
    transfers: [{ fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, batchId: 14, batchNo: 'TN-007-B01-26', departureDay: 1, arrivalDay: 1 }]
  };
  const removals = [
    (response) => { delete response.receivedStockCheck; },
    (response) => { response.receivedStockCheck.donors[0].passed = 'true'; },
    (response) => { delete response.maxTravelHours; },
    (response) => { delete response.modelVersion; },
    (response) => { delete response.dataContext; },
    (response) => { delete response.medicine.requiresColdChain; },
    (response) => { delete response.transferEvaluations[0].route; },
    (response) => { response.transferEvaluations[0].route = { distanceKm: 1 }; },
    (response) => { delete response.transferEvaluations[0].batches[0].batchId; },
    (response) => { response.transferEvaluations[0].index = 1; }
  ];
  for (const remove of removals) {
    const service = await startFakeIntelligence(t, ({ body }) => { const response = simulationResponse(body); remove(response); return { body: response }; });
    const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: service.url, intelligenceTimeoutMs: 1000 }, {});
    await assert.rejects(adapter.revalidatePlan(request), { status: 503, code: 'INVALID_INTELLIGENCE_RESPONSE' });
  }
  const service = await startFakeIntelligence(t, ({ body }) => ({ body: simulationResponse(body) }));
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: service.url, intelligenceTimeoutMs: 1000 }, {});
  const accepted = await adapter.revalidatePlan(request);
  assert.equal(accepted.source, 'INTELLIGENCE_SERVICE');
  assert.deepEqual(service.requests[0].body, request);
});

test('uses the intelligence optimizer plan without discarding batch persistence data', async (t) => {
  const service = await startFakeIntelligence(t, () => ({ body: planResponse() }));
  const adapter = createIntelligenceAdapter({ intelligenceServiceUrl: service.url, intelligenceTimeoutMs: 1000 }, {});

  const plan = await adapter.optimize({ destinationFacilityId: 'PHC-VLR-001', medicineId: '7', quantity: 300, horizonDays: 14 });

  assert.equal(plan.source, 'INTELLIGENCE_SERVICE');
  assert.equal(plan.id, VELLORE_PLAN_ID);
  assert.deepEqual(plan.transfers.map((transfer) => [transfer.batchId, transfer.batchNo]), [[14, 'TN-007-B01-26']]);
});
