const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { promisify } = require('node:util');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'release-smoke.js');
const TOKEN = 'smoke-token-must-never-be-printed';
const INSULIN = 'med-insulin-100iu-vial';

const transfer = (fromFacilityId, quantity) => ({ fromFacilityId, toFacilityId: 'X', batchNo: 'TN-007-B01-26', quantity });
const facility = (id) => ({ facilityId: id, medicine: { genericName: 'Human Insulin' } });
const summary = { resilienceScore: 67, earliestStockout: null, criticalFacilityCount: 3, alerts: [], dataFreshness: 'SIMULATED DATABASE' };

// Fake backend, intelligence service and frontend that answer like the release candidate and record every request.
async function startFakes(t, { summaryData = summary } = {}) {
  const requests = [];
  const listen = async (name, handler) => {
    const server = http.createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        requests.push({ service: name, method: request.method, url: request.url, authorization: request.headers.authorization || '', body: body ? JSON.parse(body) : null });
        const [status, payload, headers = {}] = handler(request, body ? JSON.parse(body) : null);
        response.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/html' : 'application/json', ...headers });
        response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}`;
  };
  const urls = {};
  urls.frontend = await listen('frontend', (request) => {
    if (request.url === '/') return [200, '<!doctype html><div id="root"></div><script type="module" crossorigin src="/assets/app.js"></script>'];
    if (request.url === '/assets/app.js') return [200, `const api="${urls.backend}/api";`];
    return [404, { error: { code: 'NOT_FOUND' } }];
  });
  urls.intelligence = await listen('intelligence', (request, body) => {
    if (request.method === 'GET' && request.url === '/health') return [200, { status: 'ok', service: 'medripple-intelligence' }];
    if (request.url === '/forecast') return [200, { risk: { label: 'CRITICAL' }, forecast: { dailyDemand: 38.88, unit: 'mL' }, dataContext: { dataSource: 'POSTGRES' }, modelVersion: 'aiml-step1-wma-v1' }];
    if (request.url === '/plans/optimize' && body.destinationFacilityId === 'PHC-VLR-001') {
      return [200, { status: 'PROPOSED', requiresHumanApproval: true, modelVersion: 'aiml-transfer-optimizer-v2', transfers: [transfer('WH-TN-001', 300)] }];
    }
    if (request.url === '/plans/optimize' && body.quantity === 800) {
      return [200, { status: 'PROPOSED', requiresHumanApproval: true, transfers: [transfer('DH-MDU-001', 632.41), transfer('DH-CBE-001', 167.59)] }];
    }
    if (request.url === '/plans/optimize') return [422, { error: { code: 'NO_SAFE_PLAN', details: { safeCapacity: 1236.9, unmetQuantity: 63.1 } } }];
    if (request.url === '/scenarios/simulate') {
      return [200, {
        transferEvaluations: [{ eligible: false, rejectionCodes: ['COLD_CHAIN_UNAVAILABLE'] }, { eligible: false, rejectionCodes: ['TRAVEL_TIME_LIMIT_EXCEEDED'] }],
        comparison: { safeToRecommend: false }
      }];
    }
    return [404, { error: { code: 'NOT_FOUND' } }];
  });
  urls.backend = await listen('backend', (request) => {
    const allowed = request.headers.origin === urls.frontend ? { 'access-control-allow-origin': urls.frontend } : {};
    if (request.method === 'OPTIONS') return [allowed['access-control-allow-origin'] ? 204 : 403, '', allowed];
    if (request.url === '/health') return [200, { data: { status: 'ok', environment: 'production', dataSource: 'POSTGRES', database: { connected: true } } }];
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return [401, { error: { code: 'AUTH_REQUIRED' } }];
    const data = {
      '/api/auth/me': { user: { role: 'OPERATOR' } },
      '/api/region/summary': summaryData,
      '/api/facilities': Array.from({ length: 16 }, (_, index) => facility(`F-${index}`)),
      '/api/medicines': Array.from({ length: 12 }, (_, index) => ({ id: String(index) })),
      [`/api/facilities/PHC-VLR-001/inventory?medicineId=${INSULIN}`]: { facility: { id: 'PHC-VLR-001' }, medicine: { unit: 'mL' }, effectiveStock: 34, batches: [{ batchNo: 'TN-007-B01-26' }] },
      '/api/audit': [{ timestamp: '2026-09-17T16:16:25.935Z' }]
    }[request.url];
    return data ? [200, { data, meta: { source: 'POSTGRES' } }] : [404, { error: { code: 'NOT_FOUND' } }];
  });
  return { urls, requests };
}

async function runSmoke(urls, extraEnv = {}) {
  const env = {
    ...process.env, SMOKE_BACKEND_URL: urls.backend, SMOKE_INTELLIGENCE_URL: urls.intelligence, SMOKE_FRONTEND_URL: urls.frontend, SMOKE_TOKEN: TOKEN, ...extraEnv
  };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [SCRIPT], { env });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    return { code: error.code, output: (error.stdout || '') + (error.stderr || '') };
  }
}

test('the release smoke test passes against a release-candidate stack and only reads', async (t) => {
  const { urls, requests } = await startFakes(t);
  const { code, output } = await runSmoke(urls);
  assert.equal(code, 0, output);
  assert.match(output, /16\/16 checks passed/);
  assert.ok(!output.includes(TOKEN), 'the token is never printed');
  const calls = requests.map((request) => `${request.service} ${request.method} ${request.url}`);
  assert.deepEqual(calls.filter((call) => call.startsWith('backend ') && !/^backend (GET|OPTIONS) /.test(call)), [], 'the API only receives GET and preflight requests');
  assert.deepEqual([...new Set(calls.filter((call) => call.startsWith('intelligence POST')))].sort(), [
    'intelligence POST /forecast', 'intelligence POST /plans/optimize', 'intelligence POST /scenarios/simulate'
  ]);
  assert.deepEqual(calls.filter((call) => call.startsWith('backend GET')).sort(), [
    'backend GET /api/audit', 'backend GET /api/auth/me', 'backend GET /api/facilities', 'backend GET /api/facilities',
    `backend GET /api/facilities/PHC-VLR-001/inventory?medicineId=${INSULIN}`, 'backend GET /api/medicines', 'backend GET /api/region/summary', 'backend GET /health'
  ]);
  const unauthenticated = requests.find((request) => request.service === 'backend' && request.url === '/api/facilities' && !request.authorization);
  assert.ok(unauthenticated, 'the 401 check sends no token');
  assert.ok(requests.filter((request) => request.service !== 'backend').every((request) => !request.authorization), 'the token only goes to the API');
});

test('the release smoke test fails when a patient-impact field returns', async (t) => {
  const { urls } = await startFakes(t, { summaryData: { ...summary, patientDaysAtRisk: 505 } });
  const { code, output } = await runSmoke(urls);
  assert.equal(code, 1);
  assert.match(output, /FAIL region summary has no patient-impact metric/);
  assert.match(output, /15\/16 checks passed/);
});

test('without a token the authenticated reads are skipped', async (t) => {
  const { urls, requests } = await startFakes(t);
  const { code, output } = await runSmoke(urls, { SMOKE_TOKEN: '' });
  assert.equal(code, 0, output);
  assert.match(output, /10\/10 checks passed \(authenticated reads skipped\)/);
  assert.ok(requests.every((request) => !request.authorization));
});

test('the release smoke test refuses plain HTTP outside the local machine', async () => {
  const { code, output } = await runSmoke({ backend: 'http://api.example.test', intelligence: 'https://ai.example.test', frontend: 'https://web.example.test' });
  assert.equal(code, 1);
  assert.match(output, /SMOKE_BACKEND_URL must use HTTPS/);
});
