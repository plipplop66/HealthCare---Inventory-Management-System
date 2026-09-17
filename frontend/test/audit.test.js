import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { KARUR_PLAN_ID, auditEvents } from './support/apiFixtures.js';
import { closeRenderer, load, render, textOf } from './support/render.js';
import { setupWorkspace } from './support/workspace.js';

after(closeRenderer);

test('the audit trail maps only the API lifecycle events', async () => {
  const { workspace, fake } = await setupWorkspace();
  const audit = await workspace.loadAudit();
  assert.deepEqual(fake.calls.map((call) => `${call.method} ${call.path}`), ['GET /audit']);
  assert.deepEqual(audit.rows.map((row) => [row.id, row.action, row.planId, row.status]), [
    ['6', 'CANCEL', KARUR_PLAN_ID, 'CANCELLED'],
    ['5', 'DELIVER', 'plan-2', 'DELIVERED'],
    ['4', 'DISPATCH', 'plan-2', 'IN_TRANSIT'],
    ['3', 'REJECT', 'plan-3', 'REJECTED'],
    ['2', 'RESERVE', KARUR_PLAN_ID, 'RESERVED'],
  ]);
  assert.equal(audit.hidden, 1, 'the fixture PLAN_APPROVED event is not presented as a reservation');
  assert.deepEqual([audit.rows[4].revalidated, audit.rows[4].revalidationModel], [true, 'aiml-ripple-simulator-v1']);
  assert.equal(audit.rows.filter((row) => row.revalidated).length, 1);

  const text = textOf(await render('/src/pages/AuditTrail.jsx', 'AuditTrail', { data: audit }));
  assert.match(text, /audit records Simulated database · PostgreSQL request req-postgres/);
  assert.match(text, /5 events/);
  assert.match(text, new RegExp(`Plan approved and donor stock reserved Reviewed\\. plan ${KARUR_PLAN_ID} · revalidated by aiml-ripple-simulator-v1 Approver <a@x\\.test> status after: RESERVED`));
  assert.match(text, /Transfer dispatched Left the warehouse\. plan plan-2/);
  assert.match(text, /1 recorded event\(s\) of other types are not shown/);
  for (const invented of ['Simulation simulated', 'Alert overridden', 'Inventory logged', 'Replenishment delayed', 'Sensor', 'IoT', 'Scenario engine']) {
    assert.doesNotMatch(text, new RegExp(invented, 'i'));
  }
});

test('fixture lifecycle names map to the same five actions and an empty trail says so', async () => {
  const { mapAudit } = await load('/src/services/viewModels.js');
  const fixture = mapAudit({ data: [
    { id: 'audit-3', planId: 'p', action: 'PLAN_DELIVERED', actor: 'A', note: 'n', afterState: { status: 'DELIVERED' }, timestamp: 'bad date' },
    { id: 'audit-2', planId: 'p', action: 'PLAN_IN_TRANSIT', actor: 'A', note: 'n', afterState: { status: 'IN_TRANSIT' } },
    { id: 'audit-1', planId: 'p', action: 'PLAN_REJECTED', actor: 'A', note: 'n', afterState: { status: 'REJECTED' } },
    { id: 'audit-0', planId: 'q', action: 'PLAN_CANCELLED', actor: 'A', note: 'n', afterState: { status: 'CANCELLED' } },
  ], meta: { source: 'FIXTURE_STORE' } });
  assert.deepEqual(fixture.rows.map((row) => row.action), ['DELIVER', 'DISPATCH', 'REJECT', 'CANCEL']);
  assert.deepEqual([fixture.rows[0].at, fixture.rows[1].at], ['bad date', 'Time not recorded']);
  const empty = textOf(await render('/src/pages/AuditTrail.jsx', 'AuditTrail', { data: mapAudit({ data: [], meta: { source: 'POSTGRES' } }) }));
  assert.match(empty, /0 events no decisions recorded yet/);
});
