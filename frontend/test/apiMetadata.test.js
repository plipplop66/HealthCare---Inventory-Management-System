import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fallbackForecast, forecast, inventory } from './support/apiFixtures.js';
import { closeRenderer, load, render, textOf } from './support/render.js';

after(closeRenderer);

function response(status, payload, requestId = 'header-id') {
  return { ok: status >= 200 && status < 300, status, json: async () => payload, headers: { get: (name) => (name === 'x-request-id' ? requestId : null) } };
}

test('the API helper keeps data and source, fallback, decision-support and request metadata', async () => {
  const { createApiClient } = await load('/src/services/apiClient.js');
  const calls = [];
  const request = createApiClient({
    baseUrl: 'http://127.0.0.1:3001/api/',
    tokenStore: { get: () => 'token-1' },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { data: { id: 'plan-1' }, meta: { source: 'INTELLIGENCE_SERVICE', fallback: false, decisionSupportOnly: true, requestId: 'req-7' } });
    },
  });
  const envelope = await request('/plans/optimize', { method: 'POST', body: { quantity: 300 } });
  assert.deepEqual(envelope, { data: { id: 'plan-1' }, meta: { source: 'INTELLIGENCE_SERVICE', fallback: false, decisionSupportOnly: true, requestId: 'req-7' } });
  assert.equal(calls[0].url, 'http://127.0.0.1:3001/api/plans/optimize');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer token-1');
  assert.equal(calls[0].options.body, JSON.stringify({ quantity: 300 }));

  const fallback = await createApiClient({ baseUrl: '/api', fetchImpl: async () => response(200, { data: {}, meta: { source: 'DATABASE_FALLBACK', fallback: true } }) })('/forecast');
  assert.deepEqual(fallback.meta, { source: 'DATABASE_FALLBACK', fallback: true, decisionSupportOnly: false, requestId: 'header-id' });
});

test('API errors keep status, code, details and request ID; network failures and timeouts are named', async () => {
  const { createApiClient } = await load('/src/services/apiClient.js');
  let unauthorized = 0;
  const failing = (status, payload) => createApiClient({ baseUrl: '', fetchImpl: async () => response(status, payload), onUnauthorized: () => { unauthorized += 1; } });
  const details = { planId: 'p', failedChecks: [{ name: 'COLD_CHAIN', detail: 'lost' }] };
  await assert.rejects(failing(409, { error: { code: 'PLAN_REVALIDATION_FAILED', message: 'No longer safe.', details }, meta: { requestId: 'req-409' } })('/plans/p/approve'), (error) => {
    assert.deepEqual([error.status, error.code, error.message, error.details, error.requestId], [409, 'PLAN_REVALIDATION_FAILED', 'No longer safe.', details, 'req-409']);
    return true;
  });
  await assert.rejects(failing(401, { error: { code: 'INVALID_SESSION', message: 'Expired.' } })('/audit'), { status: 401, code: 'INVALID_SESSION' });
  assert.equal(unauthorized, 1);
  await assert.rejects(failing(503, null)('/audit'), { status: 503, code: 'HTTP_ERROR' });
  await assert.rejects(failing(200, { unexpected: true })('/audit'), { code: 'INVALID_API_RESPONSE' });
  await assert.rejects(createApiClient({ baseUrl: '', fetchImpl: async () => { throw new TypeError('Failed to fetch'); } })('/audit'), { code: 'NETWORK_ERROR', status: 0 });
  await assert.rejects(createApiClient({ baseUrl: '', fetchImpl: async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); } })('/audit'), { code: 'REQUEST_TIMEOUT' });
});

test('source badges label simulated data, fallbacks, decision support and request IDs', async () => {
  const intelligence = textOf(await render('/src/components/ui.jsx', 'SourceBadge', { meta: { source: 'INTELLIGENCE_SERVICE', fallback: false, decisionSupportOnly: true, requestId: 'req-1' }, label: 'assessment' }));
  assert.equal(intelligence, 'assessment Intelligence service decision support only request req-1');
  const database = textOf(await render('/src/components/ui.jsx', 'SourceBadge', { meta: { source: 'POSTGRES', fallback: false, requestId: 'req-2' } }));
  assert.match(database, /Simulated database · PostgreSQL/);
  const fallbackHtml = await render('/src/components/ui.jsx', 'SourceBadge', { meta: { source: 'DATABASE_FALLBACK', fallback: true, requestId: 'req-3' } });
  assert.match(textOf(fallbackHtml), /Fallback forecast · intelligence service unavailable FALLBACK/);
  assert.match(fallbackHtml, /source-badge fallback/);
  assert.match(textOf(await render('/src/components/ui.jsx', 'SourceBadge', { meta: { source: 'MOCK_DATA', requestId: 'mock-1' } })), /MOCK DATA/);
});

test('a fallback forecast is labelled and has no projection chart', async () => {
  const { mapFacilityDetail } = await load('/src/services/viewModels.js');
  const data = mapFacilityDetail({ inventory, forecast: fallbackForecast, horizonDays: 14 });
  assert.equal(data.projection, null);
  assert.equal(data.forecast.isFallback, true);
  const text = textOf(await render('/src/pages/FacilityDetail.jsx', 'FacilityDetail', { data, onAssess() {} }));
  assert.match(text, /Fallback forecast The intelligence service did not answer \(INTELLIGENCE_UNAVAILABLE\)/);
  assert.match(text, /never used for approval/);
  assert.match(text, /Projection unavailable/);
  assert.match(text, /forecast Fallback forecast · intelligence service unavailable FALLBACK request req-fallback/);

  const live = mapFacilityDetail({ inventory, forecast, horizonDays: 14 });
  const liveText = textOf(await render('/src/pages/FacilityDetail.jsx', 'FacilityDetail', { data: live, onAssess() {} }));
  assert.doesNotMatch(liveText, /Projection unavailable|FALLBACK/);
  assert.match(liveText, /forecast Intelligence service request req-forecast/);
});
