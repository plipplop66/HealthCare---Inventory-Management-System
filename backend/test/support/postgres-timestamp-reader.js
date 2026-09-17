// Run by postgres-timestamps-live.test.js in a child process with TZ and PGOPTIONS (the database session TimeZone) set.
// Reads plan, audit and account timestamps through the API and prints them as JSON. Helper, not a test.
const { createApp } = require('../../src/app');
const { createPostgresAuthStore } = require('../../src/postgres-auth-store');
const { PostgresInventoryStore } = require('../../src/postgres-store');

const RESULT_MARKER = 'TIMESTAMP_RESULT ';

async function main() {
  const planIds = JSON.parse(process.env.TIMESTAMP_PLAN_IDS);
  const config = {
    environment: 'test', dataSource: 'postgres', databaseUrl: process.env.DATABASE_URL, databaseSsl: process.env.DATABASE_SSL === 'true',
    simulationDate: process.env.SIMULATION_DATE || '2026-09-11', corsOrigins: [], intelligenceServiceUrl: process.env.INTELLIGENCE_SERVICE_URL
  };
  const inventoryStore = new PostgresInventoryStore(config);
  const authStore = createPostgresAuthStore(config);
  const server = createApp(config, { inventoryStore, authStore }).listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api`;
    const call = async (path, { token, body } = {}) => {
      const response = await fetch(`${base}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!response.ok) throw new Error(`${path} returned ${response.status}`);
      return (await response.json()).data;
    };
    const { token } = await call('/auth/login', { body: { email: process.env.TIMESTAMP_EMAIL, password: process.env.TIMESTAMP_PASSWORD } });
    const [session] = await inventoryStore.query('SHOW TimeZone');
    const plans = {};
    for (const planId of planIds) {
      const plan = await call(`/plans/${planId}`, { token });
      plans[planId] = { status: plan.status, createdAt: plan.createdAt, decidedAt: plan.decidedAt };
    }
    const audit = (await call('/audit', { token }))
      .filter((event) => planIds.includes(event.entityId))
      .map((event) => ({ id: event.id, action: event.action, timestamp: event.timestamp }));
    const me = await call('/auth/me', { token });
    // The app logs requests to stdout, so the result is the line after RESULT_MARKER.
    process.stdout.write(`\n${RESULT_MARKER}${JSON.stringify({
      tz: process.env.TZ,
      offsetMinutes: new Date(Date.UTC(2026, 8, 17)).getTimezoneOffset(),
      sessionTimeZone: session.TimeZone,
      api: { plans, audit, userCreatedAt: me.user.createdAt }
    })}\n`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await Promise.all([inventoryStore.close(), authStore.close()]);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
