const mysql = require('mysql2/promise');
const { AppError } = require('./errors');
const { assertReservable, donorCodes, normaliseDonorRows, planMedicineId } = require('./reservation-guard');

const DEFAULT_FIXTURE_MEDICINE_ID = 'med-insulin-100iu-vial';
// Every inventory row of the plan's donors for its medicine; FOR UPDATE OF i locks only inventory rows.
const DONOR_STOCK_SQL = `
  SELECT i.inventory_id AS inventoryId, source.facility_code AS facilityCode, i.batch_id AS batchId,
         b.batch_number AS batchNo, i.status, b.quarantined, b.expiry_date AS expiryDate, i.quantity_on_hand AS quantity
  FROM inventory i
  JOIN facilities source ON source.facility_id = i.facility_id
  JOIN batches b ON b.batch_id = i.batch_id
  WHERE source.facility_code IN (?) AND CAST(b.medicine_id AS CHAR) = ?
  ORDER BY i.inventory_id`;

function asNumber(value) {
  return Number(value || 0);
}

function riskForDays(daysRemaining) {
  if (daysRemaining <= 3) return { label: 'CRITICAL', score: 92 };
  if (daysRemaining <= 7) return { label: 'HIGH', score: 72 };
  if (daysRemaining <= 14) return { label: 'MEDIUM', score: 43 };
  return { label: 'LOW', score: 14 };
}

function project(row) {
  const effectiveStock = asNumber(row.effectiveStock);
  const dailyDemand = asNumber(row.dailyDemand);
  const protectedStock = asNumber(row.protectedStock);
  const daysRemaining = dailyDemand > 0 ? Number((effectiveStock / dailyDemand).toFixed(1)) : null;
  const risk = daysRemaining === null ? { label: 'LOW', score: 0 } : riskForDays(daysRemaining);

  return {
    effectiveStock,
    dailyDemand,
    daysRemaining,
    protectedStock,
    safeSurplus: Math.max(0, Number((effectiveStock - protectedStock).toFixed(2))),
    riskLabel: risk.label,
    riskScore: risk.score
  };
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function toScenarioProfile(row) {
  return {
    facilityId: row.facilityCode,
    facilityName: row.facilityName,
    medicineId: String(row.medicineId),
    medicine: {
      id: String(row.medicineId),
      genericName: row.genericName,
      strength: `${row.strengthValue} ${row.strengthUnit}`,
      dosageForm: row.form,
      unit: row.unit,
      criticality: row.criticality,
      requiresColdChain: Number(row.requiresColdChain) === 1
    },
    ...project(row),
    hasColdChain: Number(row.hasColdChain) === 1,
    requiresColdChain: Number(row.requiresColdChain) === 1,
    incomingSupply: asNumber(row.incomingSupply),
    incomingArrivalDay: row.incomingArrivalDay === null ? null : Number(row.incomingArrivalDay)
  };
}

function createPoolOptions(config) {
  if (config.databaseUrl) return config.databaseUrl;
  return {
    host: config.databaseHost,
    port: config.databasePort,
    database: config.databaseName,
    user: config.databaseUser,
    password: config.databasePassword,
    waitForConnections: true,
    connectionLimit: 10,
    decimalNumbers: true,
    dateStrings: ['DATE'],
    ...(config.databaseSsl ? { ssl: { rejectUnauthorized: config.databaseSslRejectUnauthorized } } : {})
  };
}

function createMysqlStore(config, dependencies = {}) {
  const pool = dependencies.pool || mysql.createPool(createPoolOptions(config));

  async function query(sql, values = []) {
    try {
      const [rows] = await pool.query(sql, values);
      return rows;
    } catch (error) {
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE database is unavailable. Check the MySQL connection and run the database seed.', {
        databaseCode: error.code
      });
    }
  }

  async function resolveFacility(facilityId) {
    const rows = await query(
      `SELECT facility_id AS id, facility_code AS code, name, facility_type AS type
       FROM facilities
       WHERE facility_code = ? OR CAST(facility_id AS CHAR) = ?
       LIMIT 1`,
      [facilityId, facilityId]
    );
    return rows[0] || null;
  }

  async function resolveMedicine(medicineId) {
    const requestedId = String(medicineId);
    const rows = await query(
      `SELECT medicine_id AS id, generic_name AS genericName, strength_value AS strengthValue,
              strength_unit AS strengthUnit, form, base_unit AS unit,
              criticality_level AS criticality, storage_temp_min_c AS storageMinC,
              storage_temp_max_c AS storageMaxC, requires_cold_chain AS requiresColdChain
       FROM medicines
       WHERE CAST(medicine_id AS CHAR) = ?
          OR (generic_name = 'Human Insulin' AND ? = ?)
       LIMIT 1`,
      [requestedId, requestedId, DEFAULT_FIXTURE_MEDICINE_ID]
    );
    return rows[0] || null;
  }

  async function listFacilityMedicineRows(medicine) {
    return query(
      `SELECT
          f.facility_id AS facilityId,
          f.facility_code AS facilityCode,
          f.name AS facilityName,
          f.facility_type AS facilityType,
          f.region,
          f.latitude,
          f.longitude,
          f.population_served AS populationServed,
          f.remoteness_score AS remotenessScore,
          f.has_cold_chain AS hasColdChain,
          m.medicine_id AS medicineId,
          m.generic_name AS genericName,
          m.strength_value AS strengthValue,
          m.strength_unit AS strengthUnit,
          m.form,
          m.base_unit AS unit,
          m.criticality_level AS criticality,
          m.requires_cold_chain AS requiresColdChain,
          COALESCE(stock.effective_stock, 0) AS effectiveStock,
          COALESCE(stock.recorded_stock, 0) AS recordedStock,
          COALESCE(demand.daily_demand, 0) AS dailyDemand,
          COALESCE(safety.safety_stock_qty, 0) AS protectedStock,
          COALESCE(incoming.quantity, 0) AS incomingSupply,
          incoming.expected_arrival_date AS incomingDate,
          DATEDIFF(incoming.expected_arrival_date, ?) AS incomingArrivalDay
       FROM facilities f
       CROSS JOIN medicines m
       LEFT JOIN (
          SELECT i.facility_id, b.medicine_id,
                 SUM(CASE WHEN i.status = 'AVAILABLE' AND b.quarantined = FALSE AND b.expiry_date >= ? THEN i.quantity_on_hand ELSE 0 END) AS effective_stock,
                 SUM(i.quantity_on_hand) AS recorded_stock
          FROM inventory i
          JOIN batches b ON b.batch_id = i.batch_id
          GROUP BY i.facility_id, b.medicine_id
       ) stock ON stock.facility_id = f.facility_id AND stock.medicine_id = m.medicine_id
       LEFT JOIN (
          SELECT facility_id, medicine_id, AVG(quantity_consumed) AS daily_demand
          FROM consumption
          WHERE consumption_date BETWEEN DATE_SUB(?, INTERVAL 13 DAY) AND ?
          GROUP BY facility_id, medicine_id
       ) demand ON demand.facility_id = f.facility_id AND demand.medicine_id = m.medicine_id
       LEFT JOIN facility_safety_stock safety
         ON safety.facility_id = f.facility_id AND safety.medicine_id = m.medicine_id
       LEFT JOIN (
          SELECT r.facility_id, r.medicine_id, r.quantity, r.expected_arrival_date
          FROM replenishments r
          JOIN (
            SELECT facility_id, medicine_id, MIN(expected_arrival_date) AS next_arrival
            FROM replenishments
            WHERE status IN ('SCHEDULED', 'DELAYED') AND expected_arrival_date >= ?
            GROUP BY facility_id, medicine_id
          ) next_r ON next_r.facility_id = r.facility_id
              AND next_r.medicine_id = r.medicine_id
              AND next_r.next_arrival = r.expected_arrival_date
       ) incoming ON incoming.facility_id = f.facility_id AND incoming.medicine_id = m.medicine_id
       WHERE m.medicine_id = ?
       ORDER BY f.facility_id`,
      [config.simulationDate, config.simulationDate, config.simulationDate, config.simulationDate, config.simulationDate, medicine.id]
    );
  }

  async function getPersistedPlan(planId) {
    const rows = await query(
      `SELECT plan_id AS id, status, plan_json AS planJson,
              created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy
       FROM plans WHERE plan_id = ? LIMIT 1`,
      [planId]
    );
    const row = rows[0];
    if (!row) return null;
    const plan = parseJson(row.planJson, {});
    return {
      ...plan,
      id: row.id,
      status: row.status,
      createdAt: row.createdAt,
      ...(row.decidedAt ? { decidedAt: row.decidedAt, decidedBy: row.decidedBy } : {})
    };
  }

  async function assertQuantityPrecision(medicineId, quantity) {
    const medicine = await resolveMedicine(medicineId);
    if (!medicine) return;
    const scaled = Number(quantity) * 100;
    if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
      throw new AppError(400, 'INVALID_QUANTITY_PRECISION', 'quantity must use no more than two decimal places.');
    }
    if (medicine.unit === 'count' && !Number.isInteger(Number(quantity))) {
      throw new AppError(400, 'INVALID_QUANTITY_PRECISION', 'quantity must be a whole number for a count-based medicine.');
    }
  }

  return {
    source: 'MYSQL',
    async getHealth() {
      await query('SELECT 1 AS connected');
      return { connected: true, mode: 'mysql' };
    },
    async listFacilities() {
      const medicine = await resolveMedicine(DEFAULT_FIXTURE_MEDICINE_ID);
      if (!medicine) return [];
      const rows = await listFacilityMedicineRows(medicine);
      return rows.map((row) => ({
        id: row.facilityCode,
        facilityId: row.facilityCode,
        name: row.facilityName,
        type: row.facilityType,
        district: row.region,
        latitude: asNumber(row.latitude),
        longitude: asNumber(row.longitude),
        populationServed: asNumber(row.populationServed),
        remotenessScore: asNumber(row.remotenessScore),
        medicineId: String(row.medicineId),
        medicine: {
          id: String(row.medicineId),
          genericName: row.genericName,
          strength: `${row.strengthValue} ${row.strengthUnit}`,
          dosageForm: row.form,
          unit: row.unit,
          criticality: row.criticality
        },
        ...project(row),
        incomingSupply: asNumber(row.incomingSupply),
        incomingDate: row.incomingDate || null,
        dataFreshness: `SIMULATED DATABASE AS OF ${config.simulationDate}`
      }));
    },
    async getScenarioProfile(facilityId, medicineId) {
      const medicine = await resolveMedicine(medicineId);
      if (!medicine) return null;
      const rows = await listFacilityMedicineRows(medicine);
      const row = rows.find((item) => item.facilityCode === facilityId || String(item.facilityId) === String(facilityId));
      return row ? toScenarioProfile(row) : null;
    },
    async listScenarioProfiles(medicineId) {
      const medicine = await resolveMedicine(medicineId);
      if (!medicine) return [];
      const rows = await listFacilityMedicineRows(medicine);
      return rows.map(toScenarioProfile);
    },
    async getRoute(fromFacilityId, toFacilityId) {
      const [source, destination] = await Promise.all([resolveFacility(fromFacilityId), resolveFacility(toFacilityId)]);
      if (!source || !destination) return null;
      const rows = await query(
        `SELECT distance_km AS distanceKm, transport_time_hours AS travelHours,
                cold_chain_capable AS coldChainAvailable
         FROM routes WHERE origin_facility_id = ? AND destination_facility_id = ? LIMIT 1`,
        [source.id, destination.id]
      );
      return rows[0] ? { ...rows[0], coldChainAvailable: Number(rows[0].coldChainAvailable) === 1 } : null;
    },
    async selectTransferBatch(facilityId, medicineId, horizonDays = 14) {
      const [facility, medicine] = await Promise.all([resolveFacility(facilityId), resolveMedicine(medicineId)]);
      if (!facility || !medicine) return null;
      const rows = await query(
        `SELECT b.batch_id AS batchId, b.batch_number AS batchNo
         FROM inventory i JOIN batches b ON b.batch_id = i.batch_id
         WHERE i.facility_id = ? AND b.medicine_id = ?
           AND i.status = 'AVAILABLE' AND b.quarantined = FALSE
           AND b.expiry_date >= DATE_ADD(?, INTERVAL ? DAY)
         ORDER BY b.expiry_date ASC, b.batch_id ASC LIMIT 1`,
        [facility.id, medicine.id, config.simulationDate, horizonDays - 1]
      );
      return rows[0] || null;
    },
    async persistPlan(plan) {
      const [destination, medicine] = await Promise.all([
        resolveFacility(plan.destinationFacilityId),
        resolveMedicine(plan.medicine?.id || plan.transfers?.[0]?.medicineId)
      ]);
      if (!destination || !medicine) {
        throw new AppError(422, 'PLAN_PERSISTENCE_FAILED', 'The plan cannot be mapped to a database facility and medicine.');
      }
      const requestedQuantity = Number(plan.requestedQuantity
        || plan.transfers.reduce((total, transfer) => total + Number(transfer.quantity), 0));
      const transferQuantity = plan.transfers.reduce((total, transfer) => total + Number(transfer.quantity), 0);
      if (Math.abs(requestedQuantity - transferQuantity) > 0.00001) {
        throw new AppError(422, 'PLAN_QUANTITY_MISMATCH', 'The optimiser plan transfer quantities do not equal the requested quantity.');
      }
      await query(
        `INSERT INTO plans (
          plan_id, destination_facility_id, medicine_id, requested_quantity, horizon_days,
          status, rationale, plan_json
        ) VALUES (?, ?, ?, ?, ?, 'PROPOSED', ?, ?)
        ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id)`,
        [
          plan.id, destination.id, medicine.id, requestedQuantity, plan.horizonDays,
          plan.rationale || 'A human review is required before any stock movement.', JSON.stringify(plan)
        ]
      );
      return { plan: await getPersistedPlan(plan.id) };
    },
    async getPlan(planId) {
      return getPersistedPlan(planId);
    },
    async assertQuantityPrecision(medicineId, quantity) {
      await assertQuantityPrecision(medicineId, quantity);
    },
    // The donor rows read before the intelligence service revalidates a plan; approval requires them unchanged.
    async readDonorStock(plan) {
      return normaliseDonorRows(await query(DONOR_STOCK_SQL, [donorCodes(plan), planMedicineId(plan)]));
    },
    async recordPlanDecision({ plan, decision, actor, note, beforeState, afterState, expectedDonorStock }) {
      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const planStatus = decision === 'APPROVE' ? 'RESERVED' : 'REJECTED';
        const [planResult] = await connection.query(
          `UPDATE plans
           SET status = ?, decided_at = CURRENT_TIMESTAMP, decided_by = ?
           WHERE plan_id = ? AND status = 'PROPOSED'`,
          [planStatus, actor, plan.id]
        );
        if (planResult.affectedRows !== 1) {
          throw new AppError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.');
        }

        if (decision === 'APPROVE') {
          const donors = donorCodes(plan);
          const medicineId = planMedicineId(plan);
          const [lockedRows] = await connection.query(`${DONOR_STOCK_SQL} FOR UPDATE OF i`, [donors, medicineId]);
          const [safetyRows] = await connection.query(
            `SELECT source.facility_code AS facilityCode, safety.safety_stock_qty AS safetyStock
             FROM facility_safety_stock safety JOIN facilities source ON source.facility_id = safety.facility_id
             WHERE source.facility_code IN (?) AND CAST(safety.medicine_id AS CHAR) = ?
             FOR SHARE OF safety`,
            [donors, medicineId]
          );
          assertReservable({
            plan,
            rows: lockedRows,
            safetyStock: new Map(safetyRows.map((row) => [row.facilityCode, row.safetyStock])),
            simulationDate: config.simulationDate,
            expectedRows: expectedDonorStock
          });
          for (const transfer of plan.transfers) {
            // The same row conditions again, so a reservation can never succeed on a row the checks did not see.
            const [stockResult] = await connection.query(
              `UPDATE inventory i
               JOIN facilities source ON source.facility_id = i.facility_id
               JOIN batches b ON b.batch_id = i.batch_id
               SET i.quantity_on_hand = i.quantity_on_hand - ?
               WHERE source.facility_code = ?
                 AND i.batch_id = ?
                 AND b.batch_number = ?
                 AND CAST(b.medicine_id AS CHAR) = ?
                 AND i.status = 'AVAILABLE'
                 AND b.quarantined = FALSE
                 AND b.expiry_date >= DATE_ADD(?, INTERVAL ? DAY)
                 AND i.quantity_on_hand >= ?`,
              [
                transfer.quantity, transfer.fromFacilityId, transfer.batchId, transfer.batchNo, medicineId,
                config.simulationDate, plan.horizonDays, transfer.quantity
              ]
            );
            if (stockResult.affectedRows !== 1) {
              throw new AppError(409, 'PLAN_STOCK_CHANGED', 'The donor stock changed after this plan was generated. Nothing was reserved; re-run the optimizer and review the new conditions.', {
                planId: plan.id, failures: [{ fromFacilityId: transfer.fromFacilityId, batchId: transfer.batchId, reason: 'RESERVATION_ROW_CHANGED' }]
              });
            }
          }
        }

        const transferIds = [];
        for (const transfer of plan.transfers) {
          const [transferResult] = await connection.query(
            `INSERT INTO transfers (
              plan_id, origin_facility_id, destination_facility_id, medicine_id, batch_id, quantity,
              status, rejection_reason, approved_at, approved_by, note
            )
            SELECT ?, source.facility_id, destination.facility_id, ?, ?, ?, ?, ?,
                   CASE WHEN ? = 'RESERVED' THEN CURRENT_TIMESTAMP ELSE NULL END,
                   CASE WHEN ? = 'RESERVED' THEN ? ELSE NULL END, ?
            FROM facilities source CROSS JOIN facilities destination
            WHERE source.facility_code = ? AND destination.facility_code = ?`,
            [
              plan.id, transfer.medicineId, transfer.batchId, transfer.quantity, planStatus,
              decision === 'REJECT' ? note : null, planStatus, planStatus, actor, note,
              transfer.fromFacilityId, transfer.toFacilityId
            ]
          );
          if (transferResult.affectedRows !== 1) {
            throw new AppError(422, 'TRANSFER_PERSISTENCE_FAILED', 'A plan transfer could not be mapped to database facilities.');
          }
          transferIds.push(transferResult.insertId);
        }

        const [auditResult] = await connection.query(
          `INSERT INTO audit_events (
            entity_type, entity_id, action, actor, note, before_state_json, after_state_json
          ) VALUES ('plan', ?, ?, ?, ?, ?, ?)`,
          [
            plan.id, decision === 'APPROVE' ? 'RESERVE' : 'REJECT', actor, note,
            JSON.stringify(beforeState), JSON.stringify(afterState)
          ]
        );
        await connection.commit();
        return { storage: 'MYSQL', planStatus, auditId: auditResult.insertId, transferIds };
      } catch (error) {
        if (connection) await connection.rollback();
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE database could not store the plan decision.', { databaseCode: error.code });
      } finally {
        connection?.release();
      }
    },
    async transitionPlan({ plan, action, actor, note, beforeState }) {
      const transition = {
        DISPATCH: { from: 'RESERVED', to: 'IN_TRANSIT', transferFrom: 'RESERVED', transferTo: 'IN_TRANSIT', action: 'DISPATCH' },
        DELIVER: { from: 'IN_TRANSIT', to: 'DELIVERED', transferFrom: 'IN_TRANSIT', transferTo: 'DELIVERED', action: 'DELIVER' },
        CANCEL: { from: 'RESERVED', to: 'CANCELLED', transferFrom: 'RESERVED', transferTo: 'CANCELLED', action: 'CANCEL' }
      }[action];
      if (!transition) throw new AppError(400, 'INVALID_PLAN_TRANSITION', 'action must be DISPATCH, DELIVER, or CANCEL.');

      let connection;
      try {
        connection = await pool.getConnection();
        await connection.beginTransaction();
        const [planResult] = await connection.query(
          `UPDATE plans SET status = ?, decided_at = CURRENT_TIMESTAMP, decided_by = ?
           WHERE plan_id = ? AND status = ?`,
          [transition.to, actor, plan.id, transition.from]
        );
        if (planResult.affectedRows !== 1) {
          throw new AppError(409, 'INVALID_PLAN_TRANSITION', `A ${transition.from} plan is required for ${action.toLowerCase()}.`);
        }
        const [transfers] = await connection.query(
          `SELECT transfer_id AS id, origin_facility_id AS originFacilityId,
                  destination_facility_id AS destinationFacilityId, batch_id AS batchId, quantity
           FROM transfers WHERE plan_id = ? AND status = ? FOR UPDATE`,
          [plan.id, transition.transferFrom]
        );
        if (transfers.length !== plan.transfers.length) {
          throw new AppError(409, 'PLAN_STATE_CHANGED', 'The stored transfer state no longer matches the plan. Refresh before continuing.');
        }

        if (action === 'DELIVER') {
          for (const transfer of transfers) {
            await connection.query(
              `INSERT INTO inventory (facility_id, batch_id, quantity_on_hand, status)
               VALUES (?, ?, ?, 'AVAILABLE')
               ON DUPLICATE KEY UPDATE quantity_on_hand = quantity_on_hand + VALUES(quantity_on_hand)`,
              [transfer.destinationFacilityId, transfer.batchId, transfer.quantity]
            );
          }
        }
        if (action === 'CANCEL') {
          for (const transfer of transfers) {
            const [restoreResult] = await connection.query(
              `UPDATE inventory SET quantity_on_hand = quantity_on_hand + ?
               WHERE facility_id = ? AND batch_id = ? AND status = 'AVAILABLE'`,
              [transfer.quantity, transfer.originFacilityId, transfer.batchId]
            );
            if (restoreResult.affectedRows !== 1) {
              throw new AppError(409, 'PLAN_STOCK_CHANGED', 'The donor inventory cannot be safely released because its available row changed.');
            }
          }
        }

        const timestampColumn = action === 'DISPATCH' ? 'dispatched_at' : action === 'DELIVER' ? 'delivered_at' : 'cancelled_at';
        await connection.query(
          `UPDATE transfers SET status = ?, ${timestampColumn} = CURRENT_TIMESTAMP
           WHERE plan_id = ? AND status = ?`,
          [transition.transferTo, plan.id, transition.transferFrom]
        );
        const [auditResult] = await connection.query(
          `INSERT INTO audit_events (
            entity_type, entity_id, action, actor, note, before_state_json, after_state_json
          ) VALUES ('plan', ?, ?, ?, ?, ?, ?)`,
          [
            plan.id, transition.action, actor, note, JSON.stringify(beforeState),
            JSON.stringify({ status: transition.to, action })
          ]
        );
        await connection.commit();
        return { storage: 'MYSQL', planStatus: transition.to, auditId: auditResult.insertId };
      } catch (error) {
        if (connection) await connection.rollback();
        if (error instanceof AppError) throw error;
        throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE database could not transition the plan.', { databaseCode: error.code });
      } finally {
        connection?.release();
      }
    },
    async listAuditEvents() {
      return query(
        `SELECT audit_id AS id, entity_type AS entityType, CAST(entity_id AS CHAR) AS entityId, action,
                actor, note, before_state_json AS beforeState, after_state_json AS afterState,
                event_timestamp AS timestamp
         FROM audit_events ORDER BY event_timestamp DESC, audit_id DESC LIMIT 100`
      );
    },
    async getInventory(facilityId, medicineId = DEFAULT_FIXTURE_MEDICINE_ID) {
      const [facility, medicine] = await Promise.all([resolveFacility(facilityId), resolveMedicine(medicineId)]);
      if (!facility || !medicine) return null;

      const [batches, stockRows, demandRows, replenishmentRows] = await Promise.all([
        query(
          `SELECT b.batch_id AS batchId, b.batch_number AS batchNo, i.quantity_on_hand AS quantity,
                  b.expiry_date AS expiryDate,
                  CASE WHEN b.quarantined = TRUE OR i.status = 'QUARANTINED' THEN 'QUARANTINED'
                       WHEN i.status = 'EXPIRED' OR b.expiry_date < ? THEN 'EXPIRED'
                       ELSE i.status END AS status
           FROM inventory i
           JOIN batches b ON b.batch_id = i.batch_id
           WHERE i.facility_id = ? AND b.medicine_id = ?
           ORDER BY b.expiry_date ASC, b.batch_id ASC`,
          [config.simulationDate, facility.id, medicine.id]
        ),
        query(
          `SELECT
             COALESCE(SUM(i.quantity_on_hand), 0) AS recordedStock,
             COALESCE(SUM(CASE WHEN i.status = 'AVAILABLE' AND b.quarantined = FALSE AND b.expiry_date >= ? THEN i.quantity_on_hand ELSE 0 END), 0) AS effectiveStock
           FROM inventory i
           JOIN batches b ON b.batch_id = i.batch_id
           WHERE i.facility_id = ? AND b.medicine_id = ?`,
          [config.simulationDate, facility.id, medicine.id]
        ),
        query(
          `SELECT COALESCE(AVG(quantity_consumed), 0) AS dailyConsumption
           FROM consumption
           WHERE facility_id = ? AND medicine_id = ?
             AND consumption_date BETWEEN DATE_SUB(?, INTERVAL 13 DAY) AND ?`,
          [facility.id, medicine.id, config.simulationDate, config.simulationDate]
        ),
        query(
          `SELECT quantity, expected_arrival_date AS expectedArrivalDate, status
           FROM replenishments
           WHERE facility_id = ? AND medicine_id = ?
             AND status IN ('SCHEDULED', 'DELAYED') AND expected_arrival_date >= ?
           ORDER BY expected_arrival_date ASC
           LIMIT 1`,
          [facility.id, medicine.id, config.simulationDate]
        )
      ]);
      const stock = stockRows[0] || {};
      const replenishment = replenishmentRows[0] || null;
      const recordedStock = asNumber(stock.recordedStock);
      const effectiveStock = asNumber(stock.effectiveStock);

      return {
        facility: { id: facility.code, name: facility.name, type: facility.type },
        medicine: {
          id: String(medicine.id), genericName: medicine.genericName,
          strength: `${medicine.strengthValue} ${medicine.strengthUnit}`,
          dosageForm: medicine.form, unit: medicine.unit, criticality: medicine.criticality,
          storage: `${medicine.storageMinC}-${medicine.storageMaxC} C`
        },
        recordedStock,
        effectiveStock,
        excludedStock: Math.max(0, Number((recordedStock - effectiveStock).toFixed(2))),
        dailyConsumption: asNumber(demandRows[0]?.dailyConsumption),
        incomingReplenishment: replenishment
          ? { quantity: asNumber(replenishment.quantity), expectedArrivalDate: replenishment.expectedArrivalDate, status: replenishment.status }
          : null,
        batches: batches.map((batch) => ({ ...batch, quantity: asNumber(batch.quantity) })),
        fixtureAssumptions: [`All quantities are stored in ${medicine.unit}.`, `Database simulation date: ${config.simulationDate}.`]
      };
    },
    async listMedicines() {
      const rows = await query(
        `SELECT medicine_id AS id, generic_name AS genericName, strength_value AS strengthValue,
                strength_unit AS strengthUnit, form AS dosageForm, base_unit AS unit,
                criticality_level AS criticality, storage_temp_min_c AS storageMinC,
                storage_temp_max_c AS storageMaxC, requires_cold_chain AS requiresColdChain
         FROM medicines ORDER BY medicine_id`
      );
      return rows.map((medicine) => ({
        ...medicine,
        id: String(medicine.id),
        strength: `${medicine.strengthValue} ${medicine.strengthUnit}`,
        storage: `${medicine.storageMinC}-${medicine.storageMaxC} C`,
        requiresColdChain: Number(medicine.requiresColdChain) === 1
      }));
    },
    async close() {
      await pool.end();
    }
  };
}

module.exports = { createMysqlStore, createPoolOptions, project, riskForDays };
