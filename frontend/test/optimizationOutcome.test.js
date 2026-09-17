import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noSafePlanOutcome } from '../src/services/optimizationOutcome.js';

const request = { destinationFacilityId: 'PHC-KRR-001', medicineId: '7', quantity: 1300, horizonDays: 14 };

test('safety rejection keeps the exact request and the optimizer diagnostics', () => {
  const details = { safeCapacity: 1236.9, unmetQuantity: 63.1, unit: 'mL' };
  const result = noSafePlanOutcome({ status: 422, code: 'NO_SAFE_PLAN', message: 'No safe plan', details, requestId: 'req-1' }, request);
  assert.deepEqual(result, { noSafePlan: true, request, message: 'No safe plan', details, requestId: 'req-1' });
  assert.equal(result.plan, undefined); // Never invent a successful recommendation.
});

test('a rejection without diagnostics still produces a usable safety state', () => {
  assert.deepEqual(noSafePlanOutcome({ status: 422, code: 'NO_SAFE_PLAN' }, request).details, {});
});

test('network, service, and other validation failures remain errors', () => {
  for (const error of [new TypeError('Failed to fetch'), { status: 503, code: 'INTELLIGENCE_UNAVAILABLE' }, { status: 422, code: 'INVALID_QUANTITY' }]) {
    assert.throws(() => noSafePlanOutcome(error, request), (thrown) => thrown === error);
  }
});
