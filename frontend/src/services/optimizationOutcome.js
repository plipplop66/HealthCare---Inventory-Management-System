// A safety rejection is a completed decision-support result, not an outage. It keeps the exact request that was
// assessed and the optimizer's own diagnostics.
export function noSafePlanOutcome(error, request) {
  if (error?.status !== 422 || error?.code !== 'NO_SAFE_PLAN') throw error;
  return {
    noSafePlan: true,
    request,
    message: error.message,
    details: error.details || {},
    requestId: error.requestId || '',
  };
}
