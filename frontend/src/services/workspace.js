// Screen-level workflow over the Node API client. Plain JavaScript so it can be tested without a browser.
// It only requests, stores and maps API results; every safety decision comes from the API.
import { ApiError } from './apiClient';
import { noSafePlanOutcome } from './optimizationOutcome';
import { createPlanSelection, loadSelectedPlan } from './planSelection';
import { createSelectionStore, validateQuantity } from './selection';
import { catalogFromEnvelopes, mapAudit, mapDashboard, mapFacilityDetail } from './viewModels';

export function createWorkspace({ api, storage }) {
  const selection = createSelectionStore(storage);
  const assessment = createPlanSelection(storage);
  let catalog = null;
  let facilityRows = [];

  const recordAction = async (planId, note, send, confirmed) => {
    if (!String(note || '').trim()) {
      return { ok: false, error: new ApiError('Enter a note before recording this decision.', { code: 'NOTE_REQUIRED' }), plan: null };
    }
    let response;
    try {
      response = await send();
    } catch (error) {
      if (error.status === 401) throw error;
      let plan = null;
      try { plan = await api.plan(planId); } catch { /* Keep the original error visible. */ }
      return { ok: false, error, plan };
    }
    const plan = await api.plan(planId).catch(() => null);
    if (!confirmed(response.data)) {
      return { ok: false, error: new ApiError(`The API answered, but the plan is ${response.data?.plan?.status || 'in an unknown state'}.`, { code: 'UNEXPECTED_DECISION_RESULT', requestId: response.meta.requestId }), plan };
    }
    return { ok: true, response, plan };
  };

  const toAssessment = (stored, plan) => (stored.noSafePlan
    ? { kind: 'NO_SAFE_PLAN', request: stored.request, message: stored.message, details: stored.details || {}, requestId: stored.requestId || '' }
    : { kind: 'PLAN', request: stored.request, plan });

  // The latest assessment after navigation or refresh: a stored plan is re-read by ID, never re-optimized.
  const loadAssessment = async () => {
    const stored = assessment.get();
    const result = await loadSelectedPlan(assessment, (id) => api.plan(id));
    if (result.noSelectedPlan) return result.missingPlan ? { kind: 'MISSING' } : null;
    if (result.noSafePlan) return toAssessment(result);
    return toAssessment(stored, result);
  };

  return {
    selection,

    async loadDashboard() {
      const [summary, facilities, medicines] = await Promise.all([api.regionSummary(), api.facilities(), api.medicines()]);
      facilityRows = facilities.data || [];
      catalog = catalogFromEnvelopes(facilities, medicines);
      return { dashboard: mapDashboard(summary, facilities, medicines), catalog };
    },

    catalog: () => catalog,

    async loadFacility({ facilityId, medicineId, horizonDays }) {
      const inventory = await api.inventory(facilityId, medicineId);
      let forecast = null;
      let forecastError = null;
      try {
        forecast = await api.forecast({ facilityId, medicineId, horizonDays });
      } catch (error) {
        if (error.status === 401) throw error;
        forecastError = error;
      }
      const listingRow = facilityRows.find((row) => String(row.facilityId ?? row.id) === facilityId) || null;
      return mapFacilityDetail({ inventory, forecast, forecastError, listingRow, horizonDays });
    },

    // Submits the shared selection to the optimizer. The previous assessment is cleared first, so a failed or unsafe
    // new assessment can never leave an older plan selected for review.
    async runAssessment(current, unit) {
      const check = validateQuantity(current.quantity, unit);
      if (!check.ok) throw new ApiError(check.message, { code: 'INVALID_QUANTITY_INPUT' });
      if (!current.facilityId || !current.medicineId) throw new ApiError('Select a facility and a medicine.', { code: 'INVALID_SELECTION' });
      const request = { destinationFacilityId: current.facilityId, medicineId: current.medicineId, quantity: check.value, horizonDays: current.horizonDays };
      assessment.set(null);
      try {
        const plan = await api.optimize(request);
        assessment.set({ planId: plan.data.id, request });
        return toAssessment({ request }, plan);
      } catch (error) {
        const outcome = noSafePlanOutcome(error, request);
        assessment.set(outcome);
        return toAssessment(outcome);
      }
    },

    hasAssessment: () => assessment.get() !== null,

    clearAssessment() { assessment.set(null); },

    loadAssessment,

    // Plan review: the selected plan re-read by ID, plus the recorded decision evidence for a decided plan.
    async loadPlanReview() {
      const selected = await loadAssessment();
      if (selected?.kind !== 'PLAN' || selected.plan.data.status === 'PROPOSED') return { assessment: selected, decisionEvent: null };
      const envelope = await api.audit();
      const raw = (envelope.data || []).find((item) => String(item.entityId ?? item.planId) === selected.plan.data.id && ['RESERVE', 'REJECT'].includes(item.action));
      const event = raw ? mapAudit({ ...envelope, data: [raw] }).rows[0] : null;
      return { assessment: selected, decisionEvent: event ? { ...event, revalidation: raw.afterState?.revalidation || null } : null };
    },

    // Records a human decision. Success is reported only when the API confirms the expected status:
    // RESERVED after a revalidated database approval, APPROVED for a fixture approval, REJECTED for a rejection.
    // Any failure re-reads the plan so the screen shows its real, unchanged status.
    async decide(planId, decision, note) {
      return recordAction(planId, note, () => api.decide(planId, decision, note.trim()), (data) => {
        if (decision === 'REJECT') return data.plan?.status === 'REJECTED';
        if (data.plan?.status === 'RESERVED') return data.revalidation?.performed === true && data.revalidation?.passed === true;
        return data.plan?.status === 'APPROVED' && data.revalidation?.performed === false;
      });
    },

    async transition(planId, action, note) {
      const expected = { DISPATCH: 'IN_TRANSIT', DELIVER: 'DELIVERED', CANCEL: 'CANCELLED' }[action];
      return recordAction(planId, note, () => api.transition(planId, action, note.trim()), (data) => data.plan?.status === expected);
    },

    async loadAudit() {
      return mapAudit(await api.audit());
    },

    reset() {
      assessment.set(null);
      selection.clear();
      catalog = null;
      facilityRows = [];
    },
  };
}
