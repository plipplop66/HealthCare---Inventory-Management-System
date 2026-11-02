import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
  KARUR_PLAN_ID, apiError, approvalResponse, noSafePlanError, revalidation, revalidationFailedError, stockChangedError, storedPlan,
} from './support/apiFixtures.js';
import { closeRenderer, memoryStorage, render, textOf } from './support/render.js';
import { setupWorkspace } from './support/workspace.js';

after(closeRenderer);

const selection = { facilityId: 'PHC-KRR-001', medicineId: '7', quantity: '800', horizonDays: 14 };
const approvePath = `/plans/${KARUR_PLAN_ID}/approve`;

// A workspace with the Karur plan selected; the stored plan status follows the approval handler.
async function selectedPlan(approve) {
  let status = 'PROPOSED';
  const context = await setupWorkspace({
    [`GET /plans/${KARUR_PLAN_ID}`]: () => storedPlan(status, status === 'PROPOSED' ? {} : { decidedBy: 'Approver <a@x.test>', decidedAt: '2026-09-17T10:00:00.000Z' }),
    [`POST ${approvePath}`]: (call) => {
      const result = approve(call);
      status = result.data.plan.status;
      return result;
    },
  }, memoryStorage());
  await context.workspace.runAssessment(selection, 'mL');
  return context;
}

function reviewText(props) {
  return render('/src/pages/PlanReview.jsx', 'PlanReview', {
    role: 'APPROVER', busy: false, outcome: null, decisionEvent: null, onDecision() {}, onLifecycle() {}, onOpenSimulator() {}, ...props,
  }).then(textOf);
}

test('plan review explains revalidation, shows exact transfers and evidence, and requires a note', async () => {
  const html = await render('/src/pages/PlanReview.jsx', 'PlanReview', { plan: storedPlan(), role: 'APPROVER', busy: false, outcome: null, decisionEvent: null, onDecision() {}, onLifecycle() {}, onOpenSimulator() {} });
  const text = textOf(html);
  for (const expected of [
    `Plan ${KARUR_PLAN_ID}`, 'Karur Primary Health Centre (PHC-KRR-001) · Human Insulin · 100.000 IU/mL · Vial · 14-day horizon', 'PROPOSED',
    'plan record Simulated database · PostgreSQL request req-plan', 'plan produced by INTELLIGENCE_SERVICE data POSTGRES',
    'Approval re-checks safety before any stock is reserved Approving sends these exact transfers, batches and quantities back to the intelligence service',
    'human approval required', 'operational note required for every decision', 'Enter a note to enable the actions.',
    'Coimbatore District Hospital DH-CBE-001 → PHC-KRR-001 TN-007-B01-26 batch ID 14 · expires 2028-02-29 167.59 mL',
    'PASSED SAFE_TO_RECOMMEND', 'donor safety on stock already received PASSED',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.match(html, /<button type="button" class="mr-button primary "[^>]*disabled=""[^>]*>approve and reserve stock<\/button>/);
});

test('approval success: revalidated, RESERVED, evidence and audit shown; the plan is re-read', async () => {
  const { workspace, fake } = await selectedPlan(() => approvalResponse());
  const noNote = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', '  ');
  assert.deepEqual([noNote.ok, noNote.error.code, noNote.plan], [false, 'NOTE_REQUIRED', null]);
  assert.equal(fake.count('POST', approvePath), 0, 'no request without a note');

  const result = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', '  Reviewed the Karur plan.  ');
  assert.equal(result.ok, true);
  assert.deepEqual(fake.calls.find((call) => call.path === approvePath).body, { decision: 'APPROVE', note: 'Reviewed the Karur plan.' });
  assert.equal(result.plan.data.status, 'RESERVED');
  assert.equal(fake.count('POST', '/plans/optimize'), 1, 'approval never optimizes again');

  const review = await workspace.loadPlanReview();
  assert.equal(review.decisionEvent.action, 'RESERVE');
  assert.deepEqual(review.decisionEvent.revalidation, revalidation);

  const text = await reviewText({ plan: review.assessment.plan, decisionEvent: review.decisionEvent, outcome: { planId: KARUR_PLAN_ID, action: 'APPROVE', ...result } });
  for (const expected of [
    'RESERVED', 'Revalidated and reserved: plan is RESERVED Audit event 2 was recorded (request req-approve).',
    'revalidation before reservation aiml-ripple-simulator-v1 · data POSTGRES', 'route limit 6 h', 'ALL CHECKS PASSED',
    'TRANSFERS_UNCHANGED', 'BATCHES_UNCHANGED', 'DONORS_SAFE_ON_RECEIVED_STOCK', 'COLD_CHAIN',
    'DH-MDU-001 → PHC-KRR-001: 632.41 mL · batch TN-007-B01-26 (14) · day 1→1 · 3.49 h · cold chain available',
    'donors on stock already received · passed', 'DH-CBE-001: sends 167.59 mL · retained floor 1,130.82 mL',
    'decided by Approver <a@x.test>', 'confirm dispatch', 'cancel and release stock',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /approve and reserve stock|re-checks safety before any stock/);

  // After a refresh, the recorded audit evidence is shown without the one-off success banner.
  const refreshed = await reviewText({ plan: review.assessment.plan, decisionEvent: review.decisionEvent });
  assert.match(refreshed, /revalidation before reservation/);
  assert.match(refreshed, /Recorded decision: RESERVE by Approver <a@x\.test>/);
  assert.doesNotMatch(refreshed, /Revalidated and reserved/);
});

test('a revalidation failure shows the API details, keeps the plan PROPOSED and never shows success', async () => {
  const { workspace, fake } = await selectedPlan(() => { throw revalidationFailedError; });
  const result = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', 'Reviewed.');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PLAN_REVALIDATION_FAILED');
  assert.equal(result.plan.data.status, 'PROPOSED');
  assert.equal(fake.count('GET', `/plans/${KARUR_PLAN_ID}`), 1, 'the plan is re-read after the failure');
  const text = await reviewText({ plan: result.plan, outcome: { planId: KARUR_PLAN_ID, action: 'APPROVE', ...result } });
  for (const expected of [
    'PLAN_REVALIDATION_FAILED · HTTP 409 Approval stopped: the plan is no longer safe', 'Nothing was reserved. Run a new assessment.',
    'failed checks ALL_TRANSFERS_ELIGIBLE transfer 0', 'ROUTES_WITHIN_TRAVEL_LIMIT Missing or too long (limit 6 h)', 'DONORS_SAFE_ON_RECEIVED_STOCK Donors not safe',
    'rejected transfers transfer 0: DH-CBE-001 → PHC-KRR-001, batch TN-007-B01-26 (14), 167.59 mL TRAVEL_TIME_LIMIT_EXCEEDED The route now takes 6.5 hours.',
    'donors not safe on received stock DH-MDU-001 BELOW_RETAINED_FLOOR · retained floor 1,155.4 mL · lowest projected 1,067.72 mL · future supply excluded 2,827.9 mL',
    'New shortages: CHC-TRY-001', 'New risks: CHC-TRY-001 New stockout',
    'No stock was reserved. Re-run the optimizer for current conditions and review the new plan.', 'request req-revalidation', 'run a new assessment',
    'PROPOSED', 'approve and reserve stock',
  ]) {
    assert.ok(text.includes(expected), expected);
  }
  assert.doesNotMatch(text, /Revalidated and reserved|revalidation before reservation|ALL CHECKS PASSED/);
});

test('stock changes, service outages, bad responses and database errors never show success', async () => {
  const cases = [
    [stockChangedError, /PLAN_STOCK_CHANGED · HTTP 409 Approval stopped: donor stock changed[^]*reservation checks that failed DONOR_STOCK_CHANGED_DURING_REVALIDATION[^]*INSUFFICIENT_BATCH_QUANTITY DH-MDU-001 batch TN-007-B01-26/],
    [apiError(503, 'INTELLIGENCE_UNAVAILABLE', 'The intelligence service could not be reached for the plan revalidation.', { reason: 'CONNECTION_FAILED' }), /INTELLIGENCE_UNAVAILABLE · HTTP 503 Intelligence service unavailable No safety result was produced and nothing was saved or reserved/],
    [apiError(503, 'INTELLIGENCE_TIMEOUT', 'The intelligence service did not complete the plan revalidation within 2500 ms.'), /INTELLIGENCE_TIMEOUT · HTTP 503 Intelligence service timed out/],
    [apiError(503, 'INVALID_INTELLIGENCE_RESPONSE', 'The intelligence service returned an unusable plan revalidation response.'), /INVALID_INTELLIGENCE_RESPONSE · HTTP 503 Intelligence service returned an unusable result/],
    [apiError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE PostgreSQL database could not store the plan decision.'), /DATABASE_UNAVAILABLE · HTTP 503 Database unavailable/],
    [apiError(403, 'INSUFFICIENT_ROLE', 'This account cannot approve plans.'), /INSUFFICIENT_ROLE · HTTP 403 Approver role required/],
    [apiError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.', { status: 'RESERVED' }), /PLAN_ALREADY_DECIDED · HTTP 409 This plan was already decided/],
    [apiError(0, 'NETWORK_ERROR', 'The MEDRIPPLE API could not be reached.'), /NETWORK_ERROR Cannot reach the MEDRIPPLE API/],
    [noSafePlanError, /NO_SAFE_PLAN · HTTP 422 No safe plan for this request/],
  ];
  for (const [error, expected] of cases) {
    const { workspace } = await selectedPlan(() => { throw error; });
    const result = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', 'Reviewed.');
    assert.equal(result.ok, false, error.code);
    const text = await reviewText({ plan: result.plan, outcome: { planId: KARUR_PLAN_ID, action: 'APPROVE', ...result } });
    assert.match(text, expected);
    assert.doesNotMatch(text, /Revalidated and reserved|Recorded:/, error.code);
  }
  // An expired session is not shown as a plan error; the app returns to sign-in.
  const { workspace } = await selectedPlan(() => { throw apiError(401, 'INVALID_SESSION', 'Expired.'); });
  await assert.rejects(workspace.decide(KARUR_PLAN_ID, 'APPROVE', 'Reviewed.'), { status: 401 });
});

test('a 2xx answer that does not confirm a revalidated reservation is not a success', async () => {
  const unconfirmed = [
    approvalResponse({ plan: { ...storedPlan().data, status: 'PROPOSED' } }),
    approvalResponse({ revalidation: { ...revalidation, passed: false } }),
    approvalResponse({ revalidation: undefined }),
  ];
  for (const response of unconfirmed) {
    const { workspace } = await selectedPlan(() => response);
    const result = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', 'Reviewed.');
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'UNEXPECTED_DECISION_RESULT');
    const text = await reviewText({ plan: result.plan, outcome: { planId: KARUR_PLAN_ID, action: 'APPROVE', ...result } });
    assert.match(text, /UNEXPECTED_DECISION_RESULT Decision not confirmed/);
    assert.doesNotMatch(text, /Revalidated and reserved/);
  }
});

test('a fixture approval is labelled as reserving nothing', async () => {
  const fixture = { performed: false, reason: 'FIXTURE_MODE', detail: 'Fixture approvals reserve no stock; the intelligence service is not consulted and this is not proof of production safety.' };
  const { workspace } = await selectedPlan(() => approvalResponse({ plan: { ...storedPlan().data, status: 'APPROVED' }, persistence: { storage: 'MEMORY' }, revalidation: fixture }));
  const result = await workspace.decide(KARUR_PLAN_ID, 'APPROVE', 'Fixture.');
  assert.equal(result.ok, true);
  const text = await reviewText({ plan: result.plan, outcome: { planId: KARUR_PLAN_ID, action: 'APPROVE', ...result } });
  assert.match(text, /Fixture approval recorded: plan is APPROVED/);
  assert.match(text, /Fixture approval: no stock reserved Fixture approvals reserve no stock/);
  assert.doesNotMatch(text, /Revalidated and reserved|ALL CHECKS PASSED/);
});

test('a rejection is recorded without revalidation; lifecycle actions need the matching status', async () => {
  const { workspace, fake } = await selectedPlan(({ body }) => {
    assert.equal(body.decision, 'REJECT');
    return approvalResponse({ plan: { ...storedPlan().data, status: 'REJECTED' }, persistence: { storage: 'POSTGRES', planStatus: 'REJECTED' }, revalidation: undefined });
  });
  const result = await workspace.decide(KARUR_PLAN_ID, 'REJECT', 'Not needed.');
  assert.equal(result.ok, true);
  const text = await reviewText({ plan: result.plan, outcome: { planId: KARUR_PLAN_ID, action: 'REJECT', ...result } });
  assert.match(text, /Recorded: plan is REJECTED/);
  assert.match(text, /No further action is available for a REJECTED plan/);
  assert.doesNotMatch(text, /revalidation before reservation/);

  const lifecycle = await setupWorkspace({
    [`POST /plans/${KARUR_PLAN_ID}/dispatch`]: ({ body }) => ({ data: { plan: { ...storedPlan().data, status: 'IN_TRANSIT' }, audit: { id: 3 }, persistence: { planStatus: 'IN_TRANSIT' } }, meta: { source: 'POSTGRES', requestId: `req-dispatch-${body.note.length}` } }),
    [`POST /plans/${KARUR_PLAN_ID}/cancel`]: () => { throw apiError(409, 'INVALID_PLAN_TRANSITION', 'A RESERVED plan is required for cancel.'); },
  });
  assert.equal((await lifecycle.workspace.transition(KARUR_PLAN_ID, 'DISPATCH', 'Left the depot.')).ok, true);
  const cancel = await lifecycle.workspace.transition(KARUR_PLAN_ID, 'CANCEL', 'Cancel.');
  assert.deepEqual([cancel.ok, cancel.error.code], [false, 'INVALID_PLAN_TRANSITION']);
  assert.equal(fake.count('POST', '/plans/optimize'), 1);
});

test('only APPROVER and ADMIN accounts see decision controls', async () => {
  for (const role of ['OPERATOR', 'VIEWER', undefined]) {
    const html = await render('/src/pages/PlanReview.jsx', 'PlanReview', { plan: storedPlan(), role, busy: false, outcome: null, decisionEvent: null, onDecision() {}, onLifecycle() {}, onOpenSimulator() {} });
    const text = textOf(html);
    assert.match(text, /approver role required/, String(role));
    assert.doesNotMatch(html, /<textarea|approve and reserve stock|>reject</, String(role));
  }
  for (const role of ['APPROVER', 'ADMIN']) {
    const html = await render('/src/pages/PlanReview.jsx', 'PlanReview', { plan: storedPlan(), role, busy: false, outcome: null, decisionEvent: null, onDecision() {}, onLifecycle() {}, onOpenSimulator() {} });
    assert.match(html, /<textarea/);
    assert.match(html, /approve and reserve stock/);
    assert.doesNotMatch(textOf(html), /approver role required/);
  }
  const reserved = textOf(await render('/src/pages/PlanReview.jsx', 'PlanReview', { plan: storedPlan('RESERVED'), role: 'OPERATOR', busy: false, outcome: null, decisionEvent: null, onDecision() {}, onLifecycle() {}, onOpenSimulator() {} }));
  assert.doesNotMatch(reserved, /confirm dispatch|cancel and release stock/);
});
