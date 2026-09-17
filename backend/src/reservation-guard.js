// Final database checks before stock is reserved, shared by the MySQL and PostgreSQL stores. The intelligence service
// decides whether a plan is safe; these checks only guard against stock that changed underneath an approved plan.
const { AppError } = require('./errors');

const hundredths = (value) => Math.round(Number(value) * 100);

function isoDate(value) {
  if (value instanceof Date) {
    const pad = (number) => String(number).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(`${isoDate(date)}T00:00:00Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

function planMedicineId(plan) {
  return String(plan.medicine?.id ?? plan.transfers[0]?.medicineId);
}

function donorCodes(plan) {
  return [...new Set(plan.transfers.map((transfer) => String(transfer.fromFacilityId)))].sort();
}

// Every inventory row of the plan's donors for the plan's medicine, in a comparable form.
function normaliseDonorRows(rows) {
  return rows.map((row) => ({
    inventoryId: String(row.inventoryId),
    facilityCode: String(row.facilityCode),
    batchId: String(row.batchId),
    batchNo: String(row.batchNo),
    status: String(row.status),
    quarantined: row.quarantined === true || Number(row.quarantined) === 1,
    expiryDate: isoDate(row.expiryDate),
    quantity: hundredths(row.quantity)
  })).sort((left, right) => Number(left.inventoryId) - Number(right.inventoryId));
}

/**
 * Throws PLAN_STOCK_CHANGED unless every transfer can still be reserved from the locked rows:
 * - the donor rows are exactly those read before the intelligence service revalidated the plan (when given);
 * - each transfer's facility, batch ID, batch number and medicine name an AVAILABLE, non-quarantined row that lasts
 *   through the horizon and holds the quantity (summed when two transfers use one row);
 * - each donor's usable stock of the medicine, less everything it sends, stays at or above its safety stock.
 * Dates follow the intelligence service: projection day 1 is the day after SIMULATION_DATE, so stock is usable from
 * that day and must not expire before SIMULATION_DATE + horizonDays.
 */
function assertReservable({ plan, rows, safetyStock, simulationDate, expectedRows }) {
  const locked = normaliseDonorRows(rows);
  const failures = [];
  if (expectedRows && JSON.stringify(expectedRows) !== JSON.stringify(locked)) {
    failures.push({
      reason: 'DONOR_STOCK_CHANGED_DURING_REVALIDATION',
      detail: 'Donor inventory changed while the plan was being revalidated.'
    });
  }
  const usableFrom = addDays(simulationDate, 1);
  const useBy = addDays(simulationDate, plan.horizonDays);
  const medicineId = planMedicineId(plan);
  const takenByRow = new Map();
  const sentByDonor = new Map();
  plan.transfers.forEach((transfer, index) => {
    const at = { index, fromFacilityId: transfer.fromFacilityId, batchId: transfer.batchId, batchNo: transfer.batchNo };
    if (String(transfer.medicineId) !== medicineId) {
      failures.push({ ...at, reason: 'MEDICINE_MISMATCH' });
      return;
    }
    const row = locked.find((item) => item.facilityCode === String(transfer.fromFacilityId)
      && item.batchId === String(transfer.batchId) && item.status === 'AVAILABLE');
    if (!row) {
      failures.push({ ...at, reason: 'BATCH_NOT_AVAILABLE' });
      return;
    }
    if (row.batchNo !== String(transfer.batchNo)) failures.push({ ...at, reason: 'BATCH_NUMBER_MISMATCH' });
    if (row.quarantined) failures.push({ ...at, reason: 'BATCH_QUARANTINED' });
    if (row.expiryDate < useBy) failures.push({ ...at, reason: 'BATCH_EXPIRES_BEFORE_HORIZON_END', expiryDate: row.expiryDate, useBy });
    const taken = (takenByRow.get(row.inventoryId) || 0) + hundredths(transfer.quantity);
    takenByRow.set(row.inventoryId, taken);
    if (taken > row.quantity) failures.push({ ...at, reason: 'INSUFFICIENT_BATCH_QUANTITY', available: row.quantity / 100 });
    sentByDonor.set(row.facilityCode, (sentByDonor.get(row.facilityCode) || 0) + hundredths(transfer.quantity));
  });
  for (const [facilityCode, sent] of sentByDonor) {
    const usable = locked
      .filter((row) => row.facilityCode === facilityCode && row.status === 'AVAILABLE' && !row.quarantined && row.expiryDate >= usableFrom)
      .reduce((total, row) => total + row.quantity, 0);
    const protectedStock = hundredths(safetyStock.get(facilityCode) || 0);
    if (usable - sent < protectedStock) {
      failures.push({
        fromFacilityId: facilityCode, reason: 'DONOR_BELOW_PROTECTED_STOCK',
        usableStock: usable / 100, sent: sent / 100, protectedStock: protectedStock / 100
      });
    }
  }
  if (failures.length > 0) {
    throw new AppError(409, 'PLAN_STOCK_CHANGED',
      'The donor stock changed after this plan was generated. Nothing was reserved; re-run the optimizer and review the new conditions.',
      { planId: plan.id, failures });
  }
}

module.exports = { addDays, assertReservable, donorCodes, normaliseDonorRows, planMedicineId };
