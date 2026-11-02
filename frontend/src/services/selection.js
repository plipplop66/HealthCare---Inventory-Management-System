// The shared assessment selection: facility, medicine, quantity and horizon. It is kept for the browser session so
// it survives navigation and refresh. Quantity rules mirror the API: whole numbers for medicines counted in
// `count`, otherwise at most two decimal places.

export const HORIZONS = [7, 14, 30];
const KEY = 'medripple.selection';
const EMPTY = { facilityId: '', medicineId: '', quantity: '', horizonDays: 14 };

export function isCountUnit(unit) {
  return unit === 'count';
}

export function validateQuantity(raw, unit) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, message: 'Enter the quantity to transfer.' };
  const counted = isCountUnit(unit);
  const pattern = counted ? /^\d+$/ : /^\d+(\.\d{1,2})?$/;
  if (!pattern.test(text)) {
    return { ok: false, message: counted ? 'This medicine is counted in whole units; enter a whole number.' : `Enter a number${unit ? ` in ${unit}` : ''} with at most two decimal places.` };
  }
  const value = Number(text);
  if (!(value > 0)) return { ok: false, message: 'The quantity must be greater than zero.' };
  return { ok: true, value };
}

function clean(value) {
  const horizonDays = HORIZONS.includes(Number(value?.horizonDays)) ? Number(value.horizonDays) : EMPTY.horizonDays;
  return {
    facilityId: typeof value?.facilityId === 'string' ? value.facilityId : '',
    medicineId: typeof value?.medicineId === 'string' ? value.medicineId : '',
    quantity: typeof value?.quantity === 'string' ? value.quantity : '',
    horizonDays,
  };
}

export function createSelectionStore(storage) {
  let current;
  try { current = clean(JSON.parse(storage?.getItem(KEY) || 'null')); } catch { current = { ...EMPTY }; }
  return {
    get: () => ({ ...current }),
    set(patch) {
      current = clean({ ...current, ...patch });
      try { storage?.setItem(KEY, JSON.stringify(current)); } catch { /* Keep the in-memory selection. */ }
      return { ...current };
    },
    clear() {
      current = { ...EMPTY };
      try { storage?.removeItem(KEY); } catch { /* Nothing stored. */ }
    },
  };
}

// Fills a missing or no-longer-valid facility or medicine from API data only: the earliest projected stockout (or
// the first facility) and the medicine the API lists for that facility.
export function completeSelection(selection, catalog, dashboard) {
  const facilities = catalog?.facilities || [];
  const medicines = catalog?.medicines || [];
  const next = { ...selection };
  if (!facilities.some((facility) => facility.id === next.facilityId)) {
    next.facilityId = dashboard?.earliestStockout?.facilityId && facilities.some((facility) => facility.id === dashboard.earliestStockout.facilityId)
      ? dashboard.earliestStockout.facilityId
      : facilities[0]?.id || '';
  }
  if (!medicines.some((medicine) => medicine.id === next.medicineId)) {
    const listed = facilities.find((facility) => facility.id === next.facilityId)?.medicineId;
    next.medicineId = medicines.some((medicine) => medicine.id === listed) ? listed : medicines[0]?.id || '';
  }
  return next;
}
