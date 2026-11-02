// A stand-in for the Node API used only when VITE_USE_MOCKS=true or no API URL is configured. It answers the same
// routes with the same envelope, labels every response MOCK_DATA, and returns canned results without calculating.
import { ApiError } from './apiClient';
import {
  MOCK_SOURCE, mockFacilities, mockForecast, mockInventory, mockMedicines, mockNoSafePlan, mockPlan, mockPlanRequest, mockSummary, mockUsers,
} from '../data/mockData';

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createMockTransport() {
  let sequence = 0;
  let user = null;
  const plans = new Map();
  const audit = [];
  const envelope = (data, meta = {}) => ({ data: clone(data), meta: { source: MOCK_SOURCE, mock: true, fallback: false, decisionSupportOnly: true, requestId: `mock-${++sequence}`, ...meta } });
  const fail = (status, code, message, details = null) => { throw new ApiError(message, { status, code, details, requestId: `mock-${++sequence}` }); };
  const record = (plan, action, note, status, extra = {}) => {
    const event = { id: `mock-audit-${audit.length + 1}`, entityType: 'plan', entityId: plan.id, action, actor: `${user.name} <${user.email}>`, note, beforeState: {}, afterState: { status, ...extra }, timestamp: new Date().toISOString() };
    audit.unshift(event);
    return event;
  };

  return async function request(path, { method = 'GET', body } = {}) {
    const [route, query = ''] = path.split('?');
    const params = new URLSearchParams(query);
    if (route === '/auth/login' || route === '/auth/signup') {
      user = mockUsers[body?.email] || { id: 'mock-operator', name: body?.name || 'Mock Operator', email: body?.email || 'mock.operator@medripple.demo', role: 'OPERATOR' };
      return envelope({ user, token: `mock-session-${user.id}` }, { authentication: true });
    }
    if (route === '/auth/logout') { user = null; return envelope({ loggedOut: true }); }
    if (!user) fail(401, 'AUTH_REQUIRED', 'MOCK DATA: sign in with any email; mock.approver@medripple.demo has the approver role.');
    if (route === '/auth/me') return envelope({ user });
    if (route === '/region/summary') return envelope(mockSummary);
    if (route === '/facilities') return envelope(mockFacilities);
    if (route === '/medicines') return envelope(mockMedicines);
    const inventoryRoute = route.match(/^\/facilities\/([^/]+)\/inventory$/);
    if (inventoryRoute) {
      const inventory = mockInventory(decodeURIComponent(inventoryRoute[1]), params.get('medicineId'));
      return inventory ? envelope(inventory) : fail(404, 'FACILITY_NOT_FOUND', 'MOCK DATA: facility or medicine not found.');
    }
    if (route === '/forecast') {
      if (body.facilityId !== mockPlanRequest.destinationFacilityId || body.medicineId !== mockPlanRequest.medicineId) {
        fail(422, 'NO_CONSUMPTION_HISTORY', 'MOCK DATA: only Mock Primary Health Centre has a sample forecast.');
      }
      return envelope({ ...mockForecast, forecast: { ...mockForecast.forecast, horizonDays: body.horizonDays } }, { source: MOCK_SOURCE });
    }
    if (route === '/plans/optimize') {
      const matches = Object.entries(mockPlanRequest).every(([key, value]) => body[key] === value);
      if (!matches) fail(422, mockNoSafePlan.code, mockNoSafePlan.message, { ...mockNoSafePlan.details, requestedQuantity: body.quantity });
      if (!plans.has(mockPlan.id)) plans.set(mockPlan.id, clone(mockPlan));
      return envelope(plans.get(mockPlan.id));
    }
    const planRoute = route.match(/^\/plans\/([^/]+)(?:\/(approve|dispatch|deliver|cancel))?$/);
    if (planRoute) {
      const plan = plans.get(decodeURIComponent(planRoute[1]));
      if (!plan) fail(404, 'PLAN_NOT_FOUND', 'MOCK DATA: the requested plan was not found.');
      const action = planRoute[2];
      if (!action) return envelope(plan);
      if (!['APPROVER', 'ADMIN'].includes(user.role)) fail(403, 'INSUFFICIENT_ROLE', 'MOCK DATA: this account cannot approve or change plans.');
      if (!body?.note?.trim()) fail(400, 'INVALID_REQUEST', 'note is required.');
      if (action === 'approve') {
        if (plan.status !== 'PROPOSED') fail(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.', { planId: plan.id, status: plan.status });
        if (body.decision === 'REJECT') {
          plan.status = 'REJECTED';
          const event = record(plan, 'REJECT', body.note, 'REJECTED');
          return envelope({ plan, audit: event, persistence: { storage: 'MOCK', planStatus: 'REJECTED' } });
        }
        const revalidation = {
          performed: true, passed: true, source: MOCK_SOURCE, modelVersion: 'mock-simulator', dataSource: MOCK_SOURCE, checkedAt: new Date().toISOString(),
          checks: ['MOCK_DATA_ONLY'], transfers: plan.transfers.map((transfer, index) => ({ index, ...transfer })),
          receivedStockCheck: { basis: 'RECEIVED_STOCK_ONLY', passed: true, donors: plan.simulation.receivedStockCheck.donors },
        };
        plan.status = 'RESERVED';
        const event = record(plan, 'RESERVE', body.note, 'RESERVED', { revalidation });
        return envelope({ plan, audit: event, persistence: { storage: 'MOCK', planStatus: 'RESERVED' }, revalidation });
      }
      const transitions = { dispatch: ['RESERVED', 'IN_TRANSIT', 'DISPATCH'], deliver: ['IN_TRANSIT', 'DELIVERED', 'DELIVER'], cancel: ['RESERVED', 'CANCELLED', 'CANCEL'] };
      const [from, to, auditAction] = transitions[action];
      if (plan.status !== from) fail(409, 'INVALID_PLAN_TRANSITION', `A ${from} plan is required for ${action}.`);
      plan.status = to;
      const event = record(plan, auditAction, body.note, to);
      return envelope({ plan, audit: event, persistence: { storage: 'MOCK', planStatus: to } });
    }
    if (route === '/audit') return envelope(audit);
    return fail(404, 'NOT_FOUND', `MOCK DATA: ${method} ${route} is not available.`);
  };
}
