// Plain-language guidance for every error the API can return. The API's own message and details are always kept.

const GUIDANCE = {
  NO_SAFE_PLAN: ['No safe plan for this request', 'The optimizer could not meet the request without breaking a donor safety rule. Nothing was proposed or reserved.'],
  PLAN_REVALIDATION_FAILED: ['Approval stopped: the plan is no longer safe', 'The intelligence service re-checked the exact transfers before reservation and at least one safety check failed. Nothing was reserved. Run a new assessment.'],
  PLAN_STOCK_CHANGED: ['Approval stopped: donor stock changed', 'Donor stock changed while the plan was being approved, so the database refused the reservation and rolled everything back. Nothing was reserved. Run a new assessment.'],
  PLAN_ALREADY_DECIDED: ['This plan was already decided', 'Another decision was recorded first. The current status is shown below.'],
  INVALID_PLAN_TRANSITION: ['This action is not allowed now', 'The plan is not in the state this action needs. The current status is shown below.'],
  PLAN_STATE_CHANGED: ['The plan changed', 'The stored transfers no longer match the plan. Refresh before continuing.'],
  PLAN_NOT_FOUND: ['Plan not found', 'The plan is no longer available. Run a new assessment.'],
  INTELLIGENCE_UNAVAILABLE: ['Intelligence service unavailable', 'No safety result was produced and nothing was saved or reserved. Try again when the service is available.'],
  INTELLIGENCE_TIMEOUT: ['Intelligence service timed out', 'The safety check did not finish in time. Nothing was saved or reserved. Try again.'],
  INVALID_INTELLIGENCE_RESPONSE: ['Intelligence service returned an unusable result', 'The result was missing required safety evidence, so it was not used. Nothing was saved or reserved.'],
  INSUFFICIENT_ROLE: ['Approver role required', 'Only APPROVER or ADMIN accounts can approve, reject, dispatch, deliver or cancel a plan.'],
  AUTH_REQUIRED: ['Please sign in', 'Your session is missing or has expired.'],
  INVALID_SESSION: ['Please sign in again', 'Your session is no longer valid.'],
  INVALID_CREDENTIALS: ['Sign-in failed', 'Check the email address and password.'],
  DATABASE_UNAVAILABLE: ['Database unavailable', 'The MEDRIPPLE database could not be reached. Nothing was changed. Try again later.'],
  NETWORK_ERROR: ['Cannot reach the MEDRIPPLE API', 'Check your connection or the API address, then try again.'],
  REQUEST_TIMEOUT: ['The MEDRIPPLE API did not respond in time', 'The request may not have completed. Refresh to see the current state before trying again.'],
  INVALID_API_RESPONSE: ['Unreadable API response', 'The API returned something the workspace cannot read. Nothing was assumed.'],
  INVALID_QUANTITY_PRECISION: ['Check the quantity', 'Use whole numbers for counted medicines and at most two decimal places otherwise.'],
  INVALID_QUANTITY_INPUT: ['Check the quantity', ''],
  INVALID_QUANTITY_FOR_UNIT: ['Check the quantity', 'This medicine is counted in whole units.'],
  INVALID_REQUEST: ['Check the request', ''],
  INVALID_HORIZON: ['Check the horizon', 'Choose 7, 14 or 30 days.'],
  NOTE_REQUIRED: ['A note is required', 'Record why you are making this decision.'],
  UNEXPECTED_DECISION_RESULT: ['Decision not confirmed', 'The API response did not confirm the expected status, so no success is shown. Refresh to see the current state.'],
};

export function describeError(error) {
  const code = error?.code || (error?.status === 401 ? 'AUTH_REQUIRED' : error?.status === 403 ? 'INSUFFICIENT_ROLE' : '');
  const [title, guidance] = GUIDANCE[code] || [error?.status >= 500 ? 'The MEDRIPPLE API reported a problem' : 'The request could not be completed', ''];
  return {
    code: code || 'UNKNOWN_ERROR',
    status: error?.status ?? 0,
    title,
    guidance,
    message: error?.message || '',
    details: error?.details ?? null,
    requestId: error?.requestId || '',
  };
}
