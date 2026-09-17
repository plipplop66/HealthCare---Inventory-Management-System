import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { KARUR_PLAN_ID, apiError, createFakeRequest, defaultRoutes } from './support/apiFixtures.js';
import { closeRenderer, load, memoryStorage } from './support/render.js';

after(closeRenderer);

const selection = { facilityId: 'PHC-KRR-001', medicineId: '7', quantity: '800', horizonDays: 14 };

// As in App.jsx: the session token lives in localStorage, the selection and selected plan in sessionStorage.
async function openWorkspace(routes, localStore, sessionStore) {
  const { createMedrippleClient, createTokenStore } = await load('/src/services/medrippleClient.js');
  const { createWorkspace } = await load('/src/services/workspace.js');
  const fake = createFakeRequest(defaultRoutes(routes));
  const tokens = createTokenStore(localStore);
  const api = createMedrippleClient(fake.request, tokens);
  return { fake, tokens, api, workspace: createWorkspace({ api, storage: sessionStore }) };
}

const loginRoute = { 'POST /auth/login': () => ({ data: { token: 'session-token', user: { id: 'u1', name: 'Approver', email: 'a@x.test', role: 'APPROVER' } }, meta: {} }) };

test('a refresh restores the session, the selection and the selected plan', async () => {
  const localStore = memoryStorage();
  const sessionStore = memoryStorage();
  const first = await openWorkspace(loginRoute, localStore, sessionStore);
  await first.api.login({ email: 'a@x.test', password: 'unused-in-fake' });
  first.workspace.selection.set(selection);
  await first.workspace.runAssessment(selection, 'mL');

  const refreshed = await openWorkspace({}, localStore, sessionStore);
  assert.equal((await refreshed.api.restoreSession()).role, 'APPROVER');
  assert.deepEqual(refreshed.workspace.selection.get(), selection);
  assert.equal((await refreshed.workspace.loadPlanReview()).assessment.plan.data.id, KARUR_PLAN_ID);
  assert.equal(refreshed.fake.count('POST', '/plans/optimize'), 0);
});

test('signing out clears the token, the selection and the selected plan, even if the API call fails', async () => {
  const localStore = memoryStorage();
  const sessionStore = memoryStorage();
  const signedIn = await openWorkspace({
    ...loginRoute,
    'POST /auth/logout': () => { throw apiError(503, 'NETWORK_ERROR', 'offline'); },
  }, localStore, sessionStore);
  await signedIn.api.login({ email: 'a@x.test', password: 'unused-in-fake' });
  signedIn.workspace.selection.set(selection);
  await signedIn.workspace.runAssessment(selection, 'mL');
  assert.ok(localStore.getItem('medripple.session'));
  assert.ok(sessionStore.getItem('medripple.selectedPlan'));

  // App.jsx onSignOut: logout, then reset the workspace.
  await signedIn.api.logout();
  signedIn.workspace.reset();
  assert.equal(signedIn.fake.count('POST', '/auth/logout'), 1);
  for (const [store, key] of [[localStore, 'medripple.session'], [sessionStore, 'medripple.selection'], [sessionStore, 'medripple.selectedPlan']]) {
    assert.equal(store.getItem(key), null, key);
  }

  // After a refresh nothing is restored and no request is made.
  const refreshed = await openWorkspace({}, localStore, sessionStore);
  assert.equal(await refreshed.api.restoreSession(), null);
  assert.equal(refreshed.workspace.hasAssessment(), false);
  assert.deepEqual(await refreshed.workspace.loadPlanReview(), { assessment: null, decisionEvent: null });
  assert.equal(refreshed.fake.calls.length, 0);
});

test('a session the API no longer accepts is removed', async () => {
  const localStore = memoryStorage();
  localStore.setItem('medripple.session', 'expired-token');
  const { api, tokens, fake } = await openWorkspace({
    'GET /auth/me': () => { throw apiError(401, 'INVALID_SESSION', 'Your session is invalid or expired. Sign in again.'); },
  }, localStore, memoryStorage());
  assert.equal(await api.restoreSession(), null);
  assert.equal(tokens.get(), '');
  assert.equal(localStore.getItem('medripple.session'), null);
  assert.equal(fake.count('GET', '/auth/me'), 1);
});
