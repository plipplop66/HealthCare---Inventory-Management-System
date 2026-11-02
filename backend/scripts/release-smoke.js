// Read-only release smoke test (docs/release-checklist.md). It never signs up, signs in, optimizes through the API,
// approves or moves stock, and it prints no token or credential.
//
//   SMOKE_BACKEND_URL       Express origin, e.g. https://<backend>.vercel.app
//   SMOKE_INTELLIGENCE_URL  intelligence service origin
//   SMOKE_FRONTEND_URL      frontend origin
//   SMOKE_TOKEN             optional: bearer token of an existing account, for the authenticated reads
//   SMOKE_EXPECT_FACILITIES optional: expected facility count on the insulin dashboard (default 16)
//
// Only HTTPS URLs are accepted, except http://127.0.0.1 and http://localhost for a local rehearsal. Requests:
//   backend       GET /health; GET /api/facilities without a token (401); CORS preflights
//   intelligence  GET /health; POST /forecast, /scenarios/simulate, /plans/optimize (the service only reads the database)
//   frontend      GET / and its JavaScript bundle (the API URL is present, no database URL is)
//   with a token  GET /api/auth/me, /api/region/summary, /api/facilities, /api/medicines, /api/facilities/PHC-VLR-001/inventory, /api/audit
const INSULIN = 'med-insulin-100iu-vial';
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SUMMARY_FIELDS = ['alerts', 'criticalFacilityCount', 'dataFreshness', 'earliestStockout', 'resilienceScore'];

function origin(name) {
  const value = (process.env[name] || '').replace(/\/+$/, '');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Set ${name} to the service origin.`);
  }
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !local) throw new Error(`${name} must use HTTPS (or http://127.0.0.1 for a local rehearsal).`);
  return value;
}

async function request(url, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: response.status, headers: response.headers, text, json };
}

const transfers = (plan) => (plan?.transfers || []).map((transfer) => `${transfer.fromFacilityId} ${transfer.batchNo} ${transfer.quantity}`);

async function main() {
  const backend = origin('SMOKE_BACKEND_URL');
  const intelligence = origin('SMOKE_INTELLIGENCE_URL');
  const frontend = origin('SMOKE_FRONTEND_URL');
  const token = process.env.SMOKE_TOKEN || '';
  const expectedFacilities = Number(process.env.SMOKE_EXPECT_FACILITIES || 16);
  const results = [];
  const check = async (name, run) => {
    try {
      const detail = await run();
      results.push({ name, ok: true, detail: detail || '' });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
    const last = results.at(-1);
    console.log(`${last.ok ? 'PASS' : 'FAIL'} ${name}${last.detail ? ` - ${last.detail}` : ''}`);
  };
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  const service = (path, body) => request(`${intelligence}${path}`, { method: 'POST', body });

  await check('backend health', async () => {
    const { status, json } = await request(`${backend}/health`);
    expect(status === 200 && json?.data?.status === 'ok', `status ${status}`);
    expect(json.data.dataSource === 'POSTGRES' && json.data.database?.connected === true, `data source ${json.data.dataSource}`);
    return `${json.data.environment}, ${json.data.dataSource}, database connected`;
  });
  await check('workspace routes need a session', async () => {
    const { status, json } = await request(`${backend}/api/facilities`);
    expect(status === 401 && json?.error?.code === 'AUTH_REQUIRED', `status ${status} ${json?.error?.code || ''}`);
    return '401 AUTH_REQUIRED';
  });
  await check('CORS allows only the frontend origin', async () => {
    const preflight = (from) => request(`${backend}/api/region/summary`, {
      method: 'OPTIONS', headers: { origin: from, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' }
    });
    const allowed = (await preflight(frontend)).headers.get('access-control-allow-origin');
    const other = (await preflight('https://unlisted-origin.example')).headers.get('access-control-allow-origin');
    expect(allowed === frontend, `frontend origin answered with ${allowed}`);
    expect(!other, `an unlisted origin was allowed (${other})`);
    return frontend;
  });
  await check('intelligence health', async () => {
    const { status, json } = await request(`${intelligence}/health`);
    expect(status === 200 && json?.status === 'ok' && json.service === 'medripple-intelligence', `status ${status}`);
    return json.service;
  });
  await check('Vellore insulin forecast is CRITICAL from PostgreSQL', async () => {
    const { status, json } = await service('/forecast', { facilityId: 'PHC-VLR-001', medicineId: INSULIN, horizonDays: 14 });
    expect(status === 200, `status ${status} ${json?.error?.code || ''}`);
    expect(json.risk?.label === 'CRITICAL' && json.dataContext?.dataSource === 'POSTGRES', `${json.risk?.label} ${json.dataContext?.dataSource}`);
    return `${json.modelVersion}, daily demand ${json.forecast?.dailyDemand} ${json.forecast?.unit}`;
  });
  await check('Vellore 300 mL plan uses the Chennai warehouse batch', async () => {
    const { status, json } = await service('/plans/optimize', { destinationFacilityId: 'PHC-VLR-001', medicineId: INSULIN, quantity: 300, horizonDays: 14 });
    expect(status === 200 && json.status === 'PROPOSED' && json.requiresHumanApproval === true, `status ${status} ${json?.status || json?.error?.code}`);
    expect(transfers(json).join('; ') === 'WH-TN-001 TN-007-B01-26 300', transfers(json).join('; '));
    return `${json.modelVersion}; ${transfers(json).join('; ')} (not saved: the service does not persist plans)`;
  });
  await check('Karur 800 mL plan uses two donors', async () => {
    const { status, json } = await service('/plans/optimize', { destinationFacilityId: 'PHC-KRR-001', medicineId: INSULIN, quantity: 800, horizonDays: 14 });
    expect(status === 200 && json.status === 'PROPOSED', `status ${status} ${json?.status || json?.error?.code}`);
    const actual = transfers(json).sort().join('; ');
    expect(actual === 'DH-CBE-001 TN-007-B01-26 167.59; DH-MDU-001 TN-007-B01-26 632.41', actual);
    return actual;
  });
  await check('Karur 1300 mL has no safe plan', async () => {
    const { status, json } = await service('/plans/optimize', { destinationFacilityId: 'PHC-KRR-001', medicineId: INSULIN, quantity: 1300, horizonDays: 14 });
    const details = json?.error?.details || {};
    expect(status === 422 && json.error.code === 'NO_SAFE_PLAN', `status ${status} ${json?.error?.code || ''}`);
    expect(details.safeCapacity === 1236.9 && details.unmetQuantity === 63.1, `safe capacity ${details.safeCapacity}, unmet ${details.unmetQuantity}`);
    return 'NO_SAFE_PLAN, safe capacity 1236.9 mL';
  });
  await check('cold-chain and six-hour routes are rejected', async () => {
    const { status, json } = await service('/scenarios/simulate', {
      horizonDays: 14,
      transfers: [
        { fromFacilityId: 'PHC-TNJ-001', toFacilityId: 'PHC-KRR-001', medicineId: INSULIN, quantity: 50, arrivalDay: 1 },
        { fromFacilityId: 'WH-TN-001', toFacilityId: 'PHC-KRR-001', medicineId: INSULIN, quantity: 50, arrivalDay: 1 }
      ]
    });
    expect(status === 200, `status ${status} ${json?.error?.code || ''}`);
    const codes = json.transferEvaluations.map((item) => `${item.eligible ? 'eligible' : (item.rejectionCodes || []).join('+')}`);
    expect(codes.join(' ') === 'COLD_CHAIN_UNAVAILABLE TRAVEL_TIME_LIMIT_EXCEEDED' && json.comparison?.safeToRecommend === false, codes.join(' '));
    return codes.join(', ');
  });
  await check('frontend serves the app without database settings', async () => {
    const page = await request(`${frontend}/`);
    expect(page.status === 200 && /<div id="root">/.test(page.text), `status ${page.status}`);
    const scripts = [...page.text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => new URL(match[1], `${frontend}/`).href);
    expect(scripts.length > 0, 'no script bundle found');
    const bundle = (await Promise.all(scripts.map(async (url) => (await request(url)).text))).join('\n');
    expect(bundle.includes(`${backend}/api`), 'the bundle does not use this backend API');
    expect(!/postgres(ql)?:\/\/|DATABASE_URL|AUTH_JWT_SECRET/i.test(bundle), 'the bundle contains database or secret settings');
    expect(!bundle.includes(intelligence), 'the bundle calls the intelligence service directly');
    return `${scripts.length} bundle(s)`;
  });

  if (!token) {
    console.log('SKIP authenticated reads - set SMOKE_TOKEN to an existing account\'s session token.');
  } else {
    const read = async (path) => {
      const { status, json } = await request(`${backend}/api${path}`, { headers: { authorization: `Bearer ${token}` } });
      expect(status === 200, `${path}: status ${status} ${json?.error?.code || ''}`);
      return json;
    };
    await check('session is valid', async () => {
      const { data } = await read('/auth/me');
      expect(data.user?.role, 'no user');
      return `${data.user.role} account`;
    });
    await check('region summary has no patient-impact metric', async () => {
      const { data, meta } = await read('/region/summary');
      expect(JSON.stringify(Object.keys(data).sort()) === JSON.stringify(SUMMARY_FIELDS), Object.keys(data).sort().join(','));
      expect(meta.source === 'POSTGRES' && data.dataFreshness === 'SIMULATED DATABASE', `${meta.source} ${data.dataFreshness}`);
      return `resilience ${data.resilienceScore}, ${data.criticalFacilityCount} critical`;
    });
    await check('dashboard facilities are the insulin view', async () => {
      const { data } = await read('/facilities');
      expect(data.length === expectedFacilities, `${data.length} facilities, expected ${expectedFacilities}`);
      const medicines = [...new Set(data.map((row) => row.medicine?.genericName))];
      expect(medicines.length === 1 && medicines[0] === 'Human Insulin', medicines.join(', '));
      return `${data.length} facilities, ${medicines[0]}`;
    });
    await check('medicine catalogue', async () => {
      const { data } = await read('/medicines');
      expect(data.length >= 12, `${data.length} medicines`);
      return `${data.length} medicines`;
    });
    await check('Vellore insulin inventory', async () => {
      const { data } = await read(`/facilities/PHC-VLR-001/inventory?medicineId=${INSULIN}`);
      expect(data.facility?.id === 'PHC-VLR-001' && data.batches.some((batch) => /^TN-007-/.test(batch.batchNo)), 'unexpected inventory');
      return `effective stock ${data.effectiveStock} ${data.medicine.unit}`;
    });
    await check('audit timestamps are UTC instants', async () => {
      const { data } = await read('/audit');
      const invalid = data.filter((event) => !ISO_INSTANT.test(event.timestamp || ''));
      expect(invalid.length === 0, `${invalid.length} events without an ISO-8601 UTC timestamp`);
      return `${data.length} events`;
    });
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`${results.length - failed.length}/${results.length} checks passed${token ? '' : ' (authenticated reads skipped)'}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
