// Pure mappers from API envelopes to what the screens show. They only rename and select API fields; they never
// forecast, project stock or decide donor safety. Risk labels are shown exactly as the API returns them.

export const RISK_LABELS = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

const SOURCE_TEXT = {
  INTELLIGENCE_SERVICE: 'Intelligence service',
  POSTGRES: 'Simulated database · PostgreSQL',
  MYSQL: 'Simulated database · MySQL',
  FIXTURE_STORE: 'Simulated fixture data',
  MEMORY: 'Simulated fixture data',
  FIXTURE_FALLBACK: 'Fixture fallback · local development rules',
  DATABASE_FALLBACK: 'Fallback forecast · intelligence service unavailable',
  MOCK_DATA: 'MOCK DATA',
};

export function sourceText(source) {
  return SOURCE_TEXT[source] || source || 'Unknown source';
}

// A CSS modifier only; the visible text is always the exact label.
export function riskTone(label) {
  return { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' }[label] || 'unknown';
}

// A missing label means the API did not rate the facility (for example a store with no consumption).
// Already-mapped text is returned unchanged, so mapping twice gives the same result.
export function riskText(label) {
  if (label === null || label === undefined || label === '') return 'NOT RATED';
  return [...RISK_LABELS, 'NOT RATED', 'UNAVAILABLE'].includes(label) ? label : 'UNAVAILABLE';
}

export function formatNumber(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
  return Number(value).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

export function formatQuantity(value, unit) {
  const number = formatNumber(value);
  return number === '—' ? 'Unavailable' : `${number} ${unit || ''}`.trim();
}

export function formatDays(value) {
  return Number.isFinite(Number(value)) && value !== null ? `${formatNumber(value)} days` : 'Unavailable';
}

export function formatCover(value) {
  return Number.isFinite(Number(value)) && value !== null ? `${formatNumber(value)} days of cover` : 'cover not projected';
}

export function humanise(code = '') {
  const text = String(code).toLowerCase().replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatTimestamp(value) {
  if (!value) return 'Time not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function medicineName(medicine) {
  if (!medicine) return 'Unknown medicine';
  return [medicine.genericName, medicine.strength, medicine.dosageForm].filter(Boolean).join(' · ');
}

export function facilityCode(row) {
  return String(row?.facilityId ?? row?.id ?? '');
}

export function catalogFromEnvelopes(facilities, medicines) {
  const medicineRows = (medicines?.data || []).map((medicine) => ({ ...medicine, id: String(medicine.id) }));
  const facilityRows = (facilities?.data || []).map((row) => ({
    id: facilityCode(row),
    name: row.name || row.facilityName || facilityCode(row),
    type: row.type || '',
    district: row.district || '',
    medicineId: row.medicineId === undefined ? '' : String(row.medicineId),
  }));
  return { facilities: facilityRows, medicines: medicineRows, facilitiesMeta: facilities?.meta, medicinesMeta: medicines?.meta };
}

export function mapDashboard(summary, facilities, medicines) {
  const medicineById = new Map((medicines?.data || []).map((medicine) => [String(medicine.id), medicine]));
  const rows = (facilities.data || []).map((row) => {
    const medicine = row.medicine || medicineById.get(String(row.medicineId));
    return {
      id: facilityCode(row),
      name: row.name || row.facilityName || facilityCode(row),
      type: row.type || '',
      district: row.district || '',
      medicineId: row.medicineId === undefined ? '' : String(row.medicineId),
      medicine: medicineName(medicine),
      unit: medicine?.unit || '',
      effectiveStock: row.effectiveStock,
      daysRemaining: row.daysRemaining,
      riskLabel: riskText(row.riskLabel),
      riskScore: row.riskScore,
    };
  });
  const names = new Map(rows.map((row) => [row.id, row.name]));
  const data = summary.data;
  return {
    meta: summary.meta,
    facilitiesMeta: facilities.meta,
    dataFreshness: data.dataFreshness || '',
    resilienceScore: data.resilienceScore,
    earliestStockout: data.earliestStockout
      ? { facilityId: data.earliestStockout.facilityId, facilityName: data.earliestStockout.facilityName || names.get(data.earliestStockout.facilityId) || data.earliestStockout.facilityId, daysRemaining: data.earliestStockout.daysRemaining }
      : null,
    criticalCount: data.criticalFacilityCount,
    facilitiesMonitored: rows.length,
    medicines: [...new Set(rows.map((row) => row.medicine))],
    rows,
    alerts: (data.alerts || []).map((alert) => ({
      facilityId: alert.facilityId,
      facilityName: names.get(alert.facilityId) || alert.facilityId,
      riskLabel: riskText(alert.riskLabel),
      daysRemaining: alert.daysRemaining,
      cause: humanise(alert.cause),
    })),
  };
}

function replenishmentOf(forecast, inventory) {
  const next = forecast?.stockout?.nextReplenishment || forecast?.inventory?.nextReplenishment;
  if (next) return { quantity: next.quantity, date: next.arrivalDate || null, day: next.arrivalDay ?? null, status: next.status, timing: forecast?.stockout?.replenishmentTiming || '' };
  const incoming = inventory?.incomingReplenishment;
  if (incoming) return { quantity: incoming.quantity, date: incoming.expectedArrivalDate || null, day: incoming.expectedInDays ?? null, status: incoming.status, timing: '' };
  return null;
}

// forecast is an envelope or null; forecastError is the ApiError when the forecast request failed.
export function mapFacilityDetail({ inventory, forecast = null, forecastError = null, listingRow = null, horizonDays }) {
  const stock = inventory.data;
  const medicine = stock.medicine || {};
  const result = forecast?.data || null;
  const listingProtected = listingRow && String(listingRow.medicineId) === String(medicine.id) ? listingRow.protectedStock : undefined;
  const protectedStock = result?.inventory?.protectedStock ?? listingProtected ?? null;
  const projection = Array.isArray(result?.projection) && result.projection.length > 0 ? result.projection : null;
  return {
    inventoryMeta: inventory.meta,
    forecastMeta: forecast?.meta || null,
    horizonDays,
    facility: { id: stock.facility?.id, name: stock.facility?.name, type: stock.facility?.type || '' },
    medicine: { id: String(medicine.id ?? ''), name: medicineName(medicine), unit: medicine.unit || '', criticality: medicine.criticality || '', storage: medicine.storage || '' },
    stock: {
      recorded: stock.recordedStock,
      effective: stock.effectiveStock,
      excluded: stock.excludedStock,
      protected: protectedStock,
      protectedSource: result?.inventory?.protectedStock !== undefined ? result.inventory.protectedStockSource || 'Intelligence forecast' : listingProtected !== undefined ? 'Database safety stock' : '',
    },
    batches: (stock.batches || []).map((batch) => ({
      batchId: batch.batchId ?? batch.batchNo,
      batchNo: batch.batchNo,
      quantity: batch.quantity,
      expiryDate: batch.expiryDate,
      status: batch.status,
    })),
    forecast: result ? {
      source: result.source || forecast.meta.source,
      isFallback: result.isFallback === true || forecast.meta.fallback,
      fallbackReason: result.fallbackReason || '',
      modelVersion: result.modelVersion || '',
      dataLabel: result.dataLabel || '',
      dailyDemand: result.forecast?.dailyDemand,
      lowerBound: result.forecast?.lowerBound,
      upperBound: result.forecast?.upperBound,
      method: result.forecast?.method || '',
      riskLabel: riskText(result.risk?.label),
      riskScore: result.risk?.score,
      daysRemaining: result.stockout?.daysRemaining ?? null,
      stockoutDay: result.stockout?.projectedStockoutDay ?? null,
      stockoutDate: result.stockout?.projectedStockoutDate ?? null,
      withinHorizon: result.stockout?.projectedWithinHorizon ?? null,
      cause: result.cause ? humanise(result.cause) : 'Unavailable',
      confidence: result.confidence ? `${result.confidence.label}` : 'Unavailable',
      confidenceReason: result.confidence?.reason || '',
      explanation: result.explanation || '',
    } : null,
    forecastError: forecastError ? { code: forecastError.code, message: forecastError.message } : null,
    replenishment: replenishmentOf(result, stock),
    projection: projection ? projection.map((day) => ({ day: day.day, date: day.date, closingStock: day.closingStock, unmetDemand: day.unmetDemand })) : null,
  };
}

// Human lifecycle events recorded by the API. Anything else is left out of the trail.
const AUDIT_ACTIONS = {
  RESERVE: ['RESERVE', 'Plan approved and donor stock reserved'],
  REJECT: ['REJECT', 'Plan rejected'],
  DISPATCH: ['DISPATCH', 'Transfer dispatched'],
  DELIVER: ['DELIVER', 'Transfer delivered'],
  CANCEL: ['CANCEL', 'Reservation cancelled and stock released'],
  // The fixture's in-memory plan store names the same lifecycle events differently.
  PLAN_REJECTED: ['REJECT', 'Plan rejected'],
  PLAN_IN_TRANSIT: ['DISPATCH', 'Transfer dispatched'],
  PLAN_DELIVERED: ['DELIVER', 'Transfer delivered'],
  PLAN_CANCELLED: ['CANCEL', 'Reservation cancelled and stock released'],
};

export function mapAudit(envelope) {
  const events = envelope.data || [];
  const rows = [];
  let hidden = 0;
  for (const event of events) {
    const mapped = AUDIT_ACTIONS[event.action];
    if (!mapped) { hidden += 1; continue; }
    const after = event.afterState || {};
    rows.push({
      id: String(event.id),
      action: mapped[0],
      title: mapped[1],
      planId: event.entityId || event.planId || '',
      actor: event.actor || 'Unknown actor',
      note: event.note || '',
      at: formatTimestamp(event.timestamp),
      status: after.status || '',
      revalidated: after.revalidation?.performed === true,
      revalidationModel: after.revalidation?.modelVersion || '',
    });
  }
  return { meta: envelope.meta, rows, hidden };
}
