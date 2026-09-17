// Run by postgres-timestamps.test.js in a child process with TZ set. The PostgreSQL stores read from a fake pool that
// answers with what PostgreSQL would send for each selected column, parsed by the store's own type parsers, once for a
// database session in UTC and once for a session in Asia/Kolkata. Prints the API-visible timestamps as JSON. Helper, not a test.
const { createPostgresAuthStore } = require('../../src/postgres-auth-store');
const { PostgresInventoryStore, postgresTypes } = require('../../src/postgres-store');

const TIMESTAMP_OID = 1114;
const TIMESTAMPTZ_OID = 1184;
// Stored UTC wall-clock values, as the columns hold them.
const STORED = {
  created_at: '2026-09-17 04:45:12.345',
  decided_at: '2026-09-17 23:40:09.5',
  event_timestamp: '2026-09-17 23:40:09.5'
};
const SESSION_OFFSET_MINUTES = { UTC: 0, 'Asia/Kolkata': 330 };

// How PostgreSQL prints a TIMESTAMPTZ in the session's time zone, e.g. 2026-09-18 05:10:09.5+05:30.
function timestamptzText(stored, sessionZone) {
  const offset = SESSION_OFFSET_MINUTES[sessionZone];
  const local = new Date(Date.parse(`${stored.replace(' ', 'T')}Z`) + offset * 60000).toISOString().replace('T', ' ').replace(/Z$/, '');
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = Math.abs(offset) % 60;
  return `${local}${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

function selected(sql, column, alias, sessionZone) {
  const parse = (oid, text) => postgresTypes.getTypeParser(oid, 'text')(text);
  if (sql.includes(`(${column} AT TIME ZONE 'UTC') AS ${alias}`)) return parse(TIMESTAMPTZ_OID, timestamptzText(STORED[column], sessionZone));
  const plain = alias === column ? `\\b${column}\\b` : `\\b${column} AS ${alias}`;
  if (new RegExp(plain).test(sql)) return parse(TIMESTAMP_OID, STORED[column]);
  throw new Error(`${column} is not selected as ${alias}`);
}

function fakePool(sessionZone) {
  return {
    async query(sql) {
      if (sql.includes('FROM plans')) {
        return { rows: [{
          id: 'plan-time-001', status: 'RESERVED', planJson: { id: 'plan-time-001', transfers: [] }, decidedBy: 'Approver <approver@example.test>',
          createdAt: selected(sql, 'created_at', '"createdAt"', sessionZone), decidedAt: selected(sql, 'decided_at', '"decidedAt"', sessionZone)
        }] };
      }
      if (sql.includes('FROM audit_events')) {
        return { rows: [{
          id: 101, entityType: 'plan', entityId: 'plan-time-001', action: 'RESERVE', actor: 'Approver <approver@example.test>', note: 'Reserve.',
          beforeState: { status: 'PROPOSED' }, afterState: { status: 'RESERVED' }, timestamp: selected(sql, 'event_timestamp', 'timestamp', sessionZone)
        }] };
      }
      if (sql.includes('FROM app_users')) {
        return { rows: [{
          user_id: 'user-time-001', full_name: 'Approver', email: 'approver@example.test', password_hash: 'unused', role: 'APPROVER', is_active: true,
          created_at: selected(sql, 'created_at', 'created_at', sessionZone)
        }] };
      }
      throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    },
    async end() {}
  };
}

async function apiTimestamps(sessionZone) {
  const config = { databaseUrl: 'postgresql://not-used-in-tests', environment: 'test', simulationDate: '2026-09-11' };
  const store = new PostgresInventoryStore(config, { pool: fakePool(sessionZone) });
  const authStore = createPostgresAuthStore(config, { pool: fakePool(sessionZone) });
  const read = async (load) => {
    try {
      // Express serialises responses with JSON.stringify.
      return JSON.parse(JSON.stringify(await load()));
    } catch (error) {
      return { error: error.message };
    }
  };
  return {
    plan: await read(async () => {
      const plan = await store.getPlan('plan-time-001');
      return { createdAt: plan.createdAt, decidedAt: plan.decidedAt };
    }),
    audit: await read(async () => (await store.listAuditEvents()).map((event) => event.timestamp)),
    user: await read(async () => ({ createdAt: (await authStore.findByEmail('approver@example.test')).createdAt }))
  };
}

async function main() {
  const sessions = {};
  for (const sessionZone of Object.keys(SESSION_OFFSET_MINUTES)) sessions[sessionZone] = await apiTimestamps(sessionZone);
  process.stdout.write(JSON.stringify({
    tz: process.env.TZ,
    offsetMinutes: new Date(Date.UTC(2026, 8, 17)).getTimezoneOffset(),
    sessions
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
