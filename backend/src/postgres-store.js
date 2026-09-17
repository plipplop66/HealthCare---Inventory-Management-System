const { Pool, types } = require('pg');
const { AppError } = require('./errors');
const { postgresTls } = require('./postgres-tls');
const { assertReservable, donorCodes, normaliseDonorRows, planMedicineId } = require('./reservation-guard');

const DEFAULT_FIXTURE_MEDICINE_ID = 'med-insulin-100iu-vial';
const DATE_OID = 1082;
// Every inventory row of the plan's donors for its medicine; FOR UPDATE takes the row locks in inventory_id order.
const DONOR_STOCK_SQL = `
  SELECT i.inventory_id AS "inventoryId", source.facility_code AS "facilityCode", i.batch_id AS "batchId",
         b.batch_number AS "batchNo", i.status, b.quarantined, b.expiry_date AS "expiryDate", i.quantity_on_hand AS quantity
  FROM inventory i
  JOIN facilities source ON source.facility_id = i.facility_id
  JOIN batches b ON b.batch_id = i.batch_id
  WHERE source.facility_code = ANY($1::TEXT[]) AND b.medicine_id::TEXT = $2
  ORDER BY i.inventory_id`;
// DATE columns stay as their stored YYYY-MM-DD text, as mysql2's dateStrings: ['DATE'] does for the MySQL
// store. pg would otherwise build a local-midnight Date, which serialises as the previous day east of UTC.
const postgresTypes = {
  getTypeParser(oid, format) {
    return oid === DATE_OID && format !== 'binary' ? (value) => value : types.getTypeParser(oid, format);
  }
};
let sharedPool = null;

function asNumber(value) { return Number(value || 0); }

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
    effectiveStock, dailyDemand, daysRemaining, protectedStock,
    safeSurplus: Math.max(0, Number((effectiveStock - protectedStock).toFixed(2))),
    riskLabel: risk.label, riskScore: risk.score
  };
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function toScenarioProfile(row) {
  return {
    facilityId: row.facilityCode,
    facilityName: row.facilityName,
    medicineId: String(row.medicineId),
    medicine: {
      id: String(row.medicineId), genericName: row.genericName,
      strength: `${row.strengthValue} ${row.strengthUnit}`,
      dosageForm: row.form, unit: row.unit, criticality: row.criticality,
      requiresColdChain: Boolean(row.requiresColdChain)
    },
    ...project(row),
    hasColdChain: Boolean(row.hasColdChain),
    requiresColdChain: Boolean(row.requiresColdChain),
    incomingSupply: asNumber(row.incomingSupply),
    incomingArrivalDay: row.incomingArrivalDay === null ? null : Number(row.incomingArrivalDay)
  };
}

function createPool(config) {
  if (sharedPool) return sharedPool;
  if (!config.databaseUrl) throw new Error('DATABASE_URL environment variable is required');
  sharedPool = new Pool({
    connectionString: config.databaseUrl,
    ssl: postgresTls(config),
    types: postgresTypes,
    // Vercel functions are short lived; a small pool prevents exhausting the
    // Supabase connection allowance when multiple functions warm concurrently.
    max: 3,
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000
  });
  sharedPool.on('error', (error) => console.error('Unexpected PostgreSQL pool error:', error));
  return sharedPool;
}

class PostgresInventoryStore {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.pool = dependencies.pool || createPool(config);
    this.source = 'POSTGRES';
  }

  async query(sql, values = []) {
    try {
      const result = await this.pool.query(sql, values);
      return result.rows;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE PostgreSQL database is unavailable. Check DATABASE_URL and run the schema and seed scripts.', { databaseCode: error.code });
    }
  }

  async resolveFacility(facilityId) {
    const rows = await this.query(
      `SELECT facility_id AS id, facility_code AS code, name, facility_type AS type
       FROM facilities WHERE facility_code = $1 OR facility_id::TEXT = $1 LIMIT 1`,
      [String(facilityId)]
    );
    return rows[0] || null;
  }

  async resolveMedicine(medicineId) {
    const requestedId = String(medicineId);
    const rows = await this.query(
      `SELECT medicine_id AS id, generic_name AS "genericName", strength_value AS "strengthValue",
              strength_unit AS "strengthUnit", form, base_unit AS unit,
              criticality_level AS criticality, storage_temp_min_c AS "storageMinC",
              storage_temp_max_c AS "storageMaxC", requires_cold_chain AS "requiresColdChain"
       FROM medicines
       WHERE medicine_id::TEXT = $1 OR (generic_name = 'Human Insulin' AND $1 = $2)
       LIMIT 1`,
      [requestedId, DEFAULT_FIXTURE_MEDICINE_ID]
    );
    return rows[0] || null;
  }

  async listFacilityMedicineRows(medicine) {
    return this.query(
      `WITH stock AS (
         SELECT i.facility_id, b.medicine_id,
           SUM(CASE WHEN i.status = 'AVAILABLE' AND b.quarantined = FALSE AND b.expiry_date >= $1::DATE THEN i.quantity_on_hand ELSE 0 END) AS effective_stock,
           SUM(i.quantity_on_hand) AS recorded_stock
         FROM inventory i JOIN batches b ON b.batch_id = i.batch_id GROUP BY i.facility_id, b.medicine_id
       ), demand AS (
         SELECT facility_id, medicine_id, AVG(quantity_consumed) AS daily_demand
         FROM consumption WHERE consumption_date BETWEEN ($1::DATE - INTERVAL '13 days') AND $1::DATE
         GROUP BY facility_id, medicine_id
       ), incoming AS (
         SELECT DISTINCT ON (facility_id, medicine_id) facility_id, medicine_id, quantity, expected_arrival_date
         FROM replenishments WHERE status IN ('SCHEDULED', 'DELAYED') AND expected_arrival_date >= $1::DATE
         ORDER BY facility_id, medicine_id, expected_arrival_date
       )
       SELECT f.facility_id AS "facilityId", f.facility_code AS "facilityCode", f.name AS "facilityName",
              f.facility_type AS "facilityType", f.region, f.latitude, f.longitude,
              f.population_served AS "populationServed", f.remoteness_score AS "remotenessScore",
              f.has_cold_chain AS "hasColdChain", m.medicine_id AS "medicineId",
              m.generic_name AS "genericName", m.strength_value AS "strengthValue",
              m.strength_unit AS "strengthUnit", m.form, m.base_unit AS unit,
              m.criticality_level AS criticality, m.requires_cold_chain AS "requiresColdChain",
              COALESCE(stock.effective_stock, 0) AS "effectiveStock",
              COALESCE(stock.recorded_stock, 0) AS "recordedStock",
              COALESCE(demand.daily_demand, 0) AS "dailyDemand",
              COALESCE(safety.safety_stock_qty, 0) AS "protectedStock",
              COALESCE(incoming.quantity, 0) AS "incomingSupply",
              incoming.expected_arrival_date AS "incomingDate",
              (incoming.expected_arrival_date - $1::DATE) AS "incomingArrivalDay"
       FROM facilities f CROSS JOIN medicines m
       LEFT JOIN stock ON stock.facility_id = f.facility_id AND stock.medicine_id = m.medicine_id
       LEFT JOIN demand ON demand.facility_id = f.facility_id AND demand.medicine_id = m.medicine_id
       LEFT JOIN facility_safety_stock safety ON safety.facility_id = f.facility_id AND safety.medicine_id = m.medicine_id
       LEFT JOIN incoming ON incoming.facility_id = f.facility_id AND incoming.medicine_id = m.medicine_id
       WHERE m.medicine_id = $2 ORDER BY f.facility_id`,
      [this.config.simulationDate, medicine.id]
    );
  }

  async getPersistedPlan(planId) {
    const rows = await this.query(
      `SELECT plan_id AS id, status, plan_json AS "planJson", created_at AS "createdAt",
              decided_at AS "decidedAt", decided_by AS "decidedBy"
       FROM plans WHERE plan_id = $1 LIMIT 1`, [planId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...parseJson(row.planJson, {}), id: row.id, status: row.status, createdAt: row.createdAt,
      ...(row.decidedAt ? { decidedAt: row.decidedAt, decidedBy: row.decidedBy } : {})
    };
  }

  async getHealth() {
    await this.query('SELECT 1 AS connected');
    return { connected: true, mode: 'postgres' };
  }

  async listFacilities() {
    const medicine = await this.resolveMedicine(DEFAULT_FIXTURE_MEDICINE_ID);
    if (!medicine) return [];
    const rows = await this.listFacilityMedicineRows(medicine);
    return rows.map((row) => ({
      id: row.facilityCode, facilityId: row.facilityCode, name: row.facilityName, type: row.facilityType,
      district: row.region, latitude: asNumber(row.latitude), longitude: asNumber(row.longitude),
      populationServed: asNumber(row.populationServed), remotenessScore: asNumber(row.remotenessScore),
      medicineId: String(row.medicineId),
      medicine: {
        id: String(row.medicineId), genericName: row.genericName,
        strength: `${row.strengthValue} ${row.strengthUnit}`, dosageForm: row.form,
        unit: row.unit, criticality: row.criticality
      },
      ...project(row), incomingSupply: asNumber(row.incomingSupply), incomingDate: row.incomingDate || null,
      dataFreshness: `SIMULATED DATABASE AS OF ${this.config.simulationDate}`
    }));
  }

  async getScenarioProfile(facilityId, medicineId) {
    const medicine = await this.resolveMedicine(medicineId);
    if (!medicine) return null;
    const rows = await this.listFacilityMedicineRows(medicine);
    const row = rows.find((item) => item.facilityCode === facilityId || String(item.facilityId) === String(facilityId));
    return row ? toScenarioProfile(row) : null;
  }

  async listScenarioProfiles(medicineId) {
    const medicine = await this.resolveMedicine(medicineId);
    if (!medicine) return [];
    return (await this.listFacilityMedicineRows(medicine)).map(toScenarioProfile);
  }

  async getRoute(fromFacilityId, toFacilityId) {
    const [source, destination] = await Promise.all([this.resolveFacility(fromFacilityId), this.resolveFacility(toFacilityId)]);
    if (!source || !destination) return null;
    const rows = await this.query(
      `SELECT distance_km AS "distanceKm", transport_time_hours AS "travelHours",
              cold_chain_capable AS "coldChainAvailable"
       FROM routes WHERE origin_facility_id = $1 AND destination_facility_id = $2 LIMIT 1`,
      [source.id, destination.id]
    );
    return rows[0] || null;
  }

  async selectTransferBatch(facilityId, medicineId, horizonDays = 14) {
    const [facility, medicine] = await Promise.all([this.resolveFacility(facilityId), this.resolveMedicine(medicineId)]);
    if (!facility || !medicine) return null;
    const rows = await this.query(
      `SELECT b.batch_id AS "batchId", b.batch_number AS "batchNo"
       FROM inventory i JOIN batches b ON b.batch_id = i.batch_id
       WHERE i.facility_id = $1 AND b.medicine_id = $2 AND i.status = 'AVAILABLE'
         AND b.quarantined = FALSE AND b.expiry_date >= ($3::DATE + ($4::INTEGER - 1))
       ORDER BY b.expiry_date ASC, b.batch_id ASC LIMIT 1`,
      [facility.id, medicine.id, this.config.simulationDate, horizonDays]
    );
    return rows[0] || null;
  }

  async persistPlan(plan) {
    const [destination, medicine] = await Promise.all([
      this.resolveFacility(plan.destinationFacilityId),
      this.resolveMedicine(plan.medicine?.id || plan.transfers?.[0]?.medicineId)
    ]);
    if (!destination || !medicine) throw new AppError(422, 'PLAN_PERSISTENCE_FAILED', 'The plan cannot be mapped to a database facility and medicine.');
    const requestedQuantity = Number(plan.requestedQuantity || plan.transfers.reduce((total, transfer) => total + Number(transfer.quantity), 0));
    const transferQuantity = plan.transfers.reduce((total, transfer) => total + Number(transfer.quantity), 0);
    if (Math.abs(requestedQuantity - transferQuantity) > 0.00001) throw new AppError(422, 'PLAN_QUANTITY_MISMATCH', 'The optimiser plan transfer quantities do not equal the requested quantity.');
    await this.query(
      `INSERT INTO plans (plan_id, destination_facility_id, medicine_id, requested_quantity, horizon_days, status, rationale, plan_json)
       VALUES ($1, $2, $3, $4, $5, 'PROPOSED', $6, $7::JSONB) ON CONFLICT (plan_id) DO NOTHING`,
      [plan.id, destination.id, medicine.id, requestedQuantity, plan.horizonDays,
        plan.rationale || 'A human review is required before any stock movement.', JSON.stringify(plan)]
    );
    return { plan: await this.getPersistedPlan(plan.id) };
  }

  async getPlan(planId) { return this.getPersistedPlan(planId); }

  async assertQuantityPrecision(medicineId, quantity) {
    const medicine = await this.resolveMedicine(medicineId);
    if (!medicine) return;
    const numericQuantity = Number(quantity);
    if (!Number.isFinite(numericQuantity) || Math.abs((numericQuantity * 100) - Math.round(numericQuantity * 100)) > 1e-9) {
      throw new AppError(400, 'INVALID_QUANTITY_PRECISION', 'quantity must use no more than two decimal places.');
    }
    if (medicine.unit === 'count' && !Number.isInteger(numericQuantity)) {
      throw new AppError(400, 'INVALID_QUANTITY_PRECISION', 'quantity must be a whole number for a count-based medicine.');
    }
  }

  // The donor rows read before the intelligence service revalidates a plan; approval requires them unchanged.
  async readDonorStock(plan) {
    return normaliseDonorRows(await this.query(DONOR_STOCK_SQL, [donorCodes(plan), planMedicineId(plan)]));
  }

  async reserveStock(client, plan, expectedDonorStock) {
    const donors = donorCodes(plan);
    const medicineId = planMedicineId(plan);
    const locked = await client.query(`${DONOR_STOCK_SQL} FOR UPDATE OF i`, [donors, medicineId]);
    const safety = await client.query(
      `SELECT source.facility_code AS "facilityCode", safety.safety_stock_qty AS "safetyStock"
       FROM facility_safety_stock safety JOIN facilities source ON source.facility_id = safety.facility_id
       WHERE source.facility_code = ANY($1::TEXT[]) AND safety.medicine_id::TEXT = $2
       FOR SHARE OF safety`, [donors, medicineId]
    );
    assertReservable({
      plan,
      rows: locked.rows,
      safetyStock: new Map(safety.rows.map((row) => [row.facilityCode, row.safetyStock])),
      simulationDate: this.config.simulationDate,
      expectedRows: expectedDonorStock
    });
    for (const transfer of plan.transfers) {
      // The same row conditions again, so a reservation can never succeed on a row the checks did not see.
      const stockResult = await client.query(
        `UPDATE inventory i SET quantity_on_hand = i.quantity_on_hand - $1, last_updated = CURRENT_TIMESTAMP
         FROM facilities source, batches b
         WHERE source.facility_id = i.facility_id AND source.facility_code = $2 AND i.batch_id = $3 AND b.batch_id = i.batch_id
           AND b.batch_number = $4 AND b.medicine_id::TEXT = $5 AND i.status = 'AVAILABLE' AND b.quarantined = FALSE
           AND b.expiry_date >= ($6::DATE + $7::INTEGER) AND i.quantity_on_hand >= $1
         RETURNING i.inventory_id`,
        [transfer.quantity, transfer.fromFacilityId, transfer.batchId, transfer.batchNo, medicineId, this.config.simulationDate, plan.horizonDays]
      );
      if (stockResult.rowCount !== 1) {
        throw new AppError(409, 'PLAN_STOCK_CHANGED', 'The donor stock changed after this plan was generated. Nothing was reserved; re-run the optimizer and review the new conditions.', {
          planId: plan.id, failures: [{ fromFacilityId: transfer.fromFacilityId, batchId: transfer.batchId, reason: 'RESERVATION_ROW_CHANGED' }]
        });
      }
    }
  }

  async recordPlanDecision({ plan, decision, actor, note, beforeState, afterState, expectedDonorStock }) {
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const planStatus = decision === 'APPROVE' ? 'RESERVED' : 'REJECTED';
      const planResult = await client.query(
        `UPDATE plans SET status = $1::plan_status_enum, decided_at = CURRENT_TIMESTAMP, decided_by = $2
         WHERE plan_id = $3 AND status = 'PROPOSED' RETURNING plan_id`, [planStatus, actor, plan.id]
      );
      if (planResult.rowCount !== 1) throw new AppError(409, 'PLAN_ALREADY_DECIDED', 'Only a proposed plan can be approved or rejected.');
      if (decision === 'APPROVE') await this.reserveStock(client, plan, expectedDonorStock);
      const transferIds = [];
      for (const transfer of plan.transfers) {
        const transferResult = await client.query(
          `INSERT INTO transfers (plan_id, origin_facility_id, destination_facility_id, medicine_id, batch_id, quantity,
                                  status, rejection_reason, approved_at, approved_by, note)
           SELECT $1, source.facility_id, destination.facility_id, $2, $3, $4, $5::transfer_status_enum, $6,
                  CASE WHEN $5 = 'RESERVED' THEN CURRENT_TIMESTAMP ELSE NULL END,
                  CASE WHEN $5 = 'RESERVED' THEN $7 ELSE NULL END, $8
           FROM facilities source CROSS JOIN facilities destination
           WHERE source.facility_code = $9 AND destination.facility_code = $10 RETURNING transfer_id`,
          [plan.id, transfer.medicineId, transfer.batchId, transfer.quantity, planStatus,
            decision === 'REJECT' ? note : null, actor, note, transfer.fromFacilityId, transfer.toFacilityId]
        );
        if (transferResult.rowCount !== 1) throw new AppError(422, 'TRANSFER_PERSISTENCE_FAILED', 'A plan transfer could not be mapped to database facilities.');
        transferIds.push(transferResult.rows[0].transfer_id);
      }
      const auditResult = await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, note, before_state_json, after_state_json)
         VALUES ('plan', $1, $2, $3, $4, $5::JSONB, $6::JSONB) RETURNING audit_id`,
        [plan.id, decision === 'APPROVE' ? 'RESERVE' : 'REJECT', actor, note, JSON.stringify(beforeState), JSON.stringify(afterState)]
      );
      await client.query('COMMIT');
      return { storage: 'POSTGRES', planStatus, auditId: auditResult.rows[0].audit_id, transferIds };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE PostgreSQL database could not store the plan decision.', { databaseCode: error.code });
    } finally { client?.release(); }
  }

  async transitionPlan({ plan, action, actor, note, beforeState }) {
    const transition = {
      DISPATCH: { from: 'RESERVED', to: 'IN_TRANSIT', transferFrom: 'RESERVED', transferTo: 'IN_TRANSIT', action: 'DISPATCH' },
      DELIVER: { from: 'IN_TRANSIT', to: 'DELIVERED', transferFrom: 'IN_TRANSIT', transferTo: 'DELIVERED', action: 'DELIVER' },
      CANCEL: { from: 'RESERVED', to: 'CANCELLED', transferFrom: 'RESERVED', transferTo: 'CANCELLED', action: 'CANCEL' }
    }[action];
    if (!transition) throw new AppError(400, 'INVALID_PLAN_TRANSITION', 'action must be DISPATCH, DELIVER, or CANCEL.');
    let client;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      const planResult = await client.query(
        `UPDATE plans SET status = $1::plan_status_enum, decided_at = CURRENT_TIMESTAMP, decided_by = $2
         WHERE plan_id = $3 AND status = $4::plan_status_enum RETURNING plan_id`,
        [transition.to, actor, plan.id, transition.from]
      );
      if (planResult.rowCount !== 1) throw new AppError(409, 'INVALID_PLAN_TRANSITION', `A ${transition.from} plan is required for ${action.toLowerCase()}.`);
      const transferResult = await client.query(
        `SELECT transfer_id AS id, origin_facility_id AS "originFacilityId", destination_facility_id AS "destinationFacilityId",
                batch_id AS "batchId", quantity FROM transfers
         WHERE plan_id = $1 AND status = $2::transfer_status_enum FOR UPDATE`, [plan.id, transition.transferFrom]
      );
      const transfers = transferResult.rows;
      if (transfers.length !== plan.transfers.length) throw new AppError(409, 'PLAN_STATE_CHANGED', 'The stored transfer state no longer matches the plan. Refresh before continuing.');
      if (action === 'DELIVER') {
        for (const transfer of transfers) {
          await client.query(
            `INSERT INTO inventory (facility_id, batch_id, quantity_on_hand, status) VALUES ($1, $2, $3, 'AVAILABLE')
             ON CONFLICT (facility_id, batch_id, status) DO UPDATE SET quantity_on_hand = inventory.quantity_on_hand + EXCLUDED.quantity_on_hand, last_updated = CURRENT_TIMESTAMP`,
            [transfer.destinationFacilityId, transfer.batchId, transfer.quantity]
          );
        }
      }
      if (action === 'CANCEL') {
        for (const transfer of transfers) {
          const restoreResult = await client.query(
            `UPDATE inventory SET quantity_on_hand = quantity_on_hand + $1, last_updated = CURRENT_TIMESTAMP
             WHERE facility_id = $2 AND batch_id = $3 AND status = 'AVAILABLE' RETURNING inventory_id`,
            [transfer.quantity, transfer.originFacilityId, transfer.batchId]
          );
          if (restoreResult.rowCount !== 1) throw new AppError(409, 'PLAN_STOCK_CHANGED', 'The donor inventory cannot be safely released because its available row changed.');
        }
      }
      const timestampColumn = action === 'DISPATCH' ? 'dispatched_at' : action === 'DELIVER' ? 'delivered_at' : 'cancelled_at';
      await client.query(
        `UPDATE transfers SET status = $1::transfer_status_enum, ${timestampColumn} = CURRENT_TIMESTAMP
         WHERE plan_id = $2 AND status = $3::transfer_status_enum`, [transition.transferTo, plan.id, transition.transferFrom]
      );
      const auditResult = await client.query(
        `INSERT INTO audit_events (entity_type, entity_id, action, actor, note, before_state_json, after_state_json)
         VALUES ('plan', $1, $2, $3, $4, $5::JSONB, $6::JSONB) RETURNING audit_id`,
        [plan.id, transition.action, actor, note, JSON.stringify(beforeState), JSON.stringify({ status: transition.to, action })]
      );
      await client.query('COMMIT');
      return { storage: 'POSTGRES', planStatus: transition.to, auditId: auditResult.rows[0].audit_id };
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The MEDRIPPLE PostgreSQL database could not transition the plan.', { databaseCode: error.code });
    } finally { client?.release(); }
  }

  async listAuditEvents() {
    return this.query(
      `SELECT audit_id AS id, entity_type AS "entityType", entity_id AS "entityId", action, actor, note,
              before_state_json AS "beforeState", after_state_json AS "afterState", event_timestamp AS timestamp
       FROM audit_events ORDER BY event_timestamp DESC, audit_id DESC LIMIT 100`
    );
  }

  async getInventory(facilityId, medicineId = DEFAULT_FIXTURE_MEDICINE_ID) {
    const [facility, medicine] = await Promise.all([this.resolveFacility(facilityId), this.resolveMedicine(medicineId)]);
    if (!facility || !medicine) return null;
    const [batches, stockRows, demandRows, replenishmentRows] = await Promise.all([
      this.query(
        `SELECT b.batch_id AS "batchId", b.batch_number AS "batchNo", i.quantity_on_hand AS quantity, b.expiry_date AS "expiryDate",
                CASE WHEN b.quarantined = TRUE OR i.status = 'QUARANTINED' THEN 'QUARANTINED'
                     WHEN i.status = 'EXPIRED' OR b.expiry_date < $1::DATE THEN 'EXPIRED' ELSE i.status::TEXT END AS status
         FROM inventory i JOIN batches b ON b.batch_id = i.batch_id
         WHERE i.facility_id = $2 AND b.medicine_id = $3 ORDER BY b.expiry_date ASC, b.batch_id ASC`,
        [this.config.simulationDate, facility.id, medicine.id]
      ),
      this.query(
        `SELECT COALESCE(SUM(i.quantity_on_hand), 0) AS "recordedStock",
                COALESCE(SUM(CASE WHEN i.status = 'AVAILABLE' AND b.quarantined = FALSE AND b.expiry_date >= $1::DATE THEN i.quantity_on_hand ELSE 0 END), 0) AS "effectiveStock"
         FROM inventory i JOIN batches b ON b.batch_id = i.batch_id WHERE i.facility_id = $2 AND b.medicine_id = $3`,
        [this.config.simulationDate, facility.id, medicine.id]
      ),
      this.query(
        `SELECT COALESCE(AVG(quantity_consumed), 0) AS "dailyConsumption" FROM consumption
         WHERE facility_id = $1 AND medicine_id = $2 AND consumption_date BETWEEN ($3::DATE - INTERVAL '13 days') AND $3::DATE`,
        [facility.id, medicine.id, this.config.simulationDate]
      ),
      this.query(
        `SELECT quantity, expected_arrival_date AS "expectedArrivalDate", status::TEXT AS status FROM replenishments
         WHERE facility_id = $1 AND medicine_id = $2 AND status IN ('SCHEDULED', 'DELAYED') AND expected_arrival_date >= $3::DATE
         ORDER BY expected_arrival_date ASC LIMIT 1`, [facility.id, medicine.id, this.config.simulationDate]
      )
    ]);
    const stock = stockRows[0] || {};
    const replenishment = replenishmentRows[0] || null;
    const recordedStock = asNumber(stock.recordedStock);
    const effectiveStock = asNumber(stock.effectiveStock);
    return {
      facility: { id: facility.code, name: facility.name, type: facility.type },
      medicine: { id: String(medicine.id), genericName: medicine.genericName, strength: `${medicine.strengthValue} ${medicine.strengthUnit}`,
        dosageForm: medicine.form, unit: medicine.unit, criticality: medicine.criticality, storage: `${medicine.storageMinC}-${medicine.storageMaxC} C` },
      recordedStock, effectiveStock, excludedStock: Math.max(0, Number((recordedStock - effectiveStock).toFixed(2))),
      dailyConsumption: asNumber(demandRows[0]?.dailyConsumption),
      incomingReplenishment: replenishment ? { quantity: asNumber(replenishment.quantity), expectedArrivalDate: replenishment.expectedArrivalDate, status: replenishment.status } : null,
      batches: batches.map((batch) => ({ ...batch, quantity: asNumber(batch.quantity) })),
      fixtureAssumptions: [`All quantities are stored in ${medicine.unit}.`, `Database simulation date: ${this.config.simulationDate}.`]
    };
  }

  async listMedicines() {
    const rows = await this.query(
      `SELECT medicine_id AS id, generic_name AS "genericName", strength_value AS "strengthValue", strength_unit AS "strengthUnit",
              form AS "dosageForm", base_unit AS unit, criticality_level AS criticality,
              storage_temp_min_c AS "storageMinC", storage_temp_max_c AS "storageMaxC", requires_cold_chain AS "requiresColdChain"
       FROM medicines ORDER BY medicine_id`
    );
    return rows.map((medicine) => ({
      ...medicine, id: String(medicine.id), strength: `${medicine.strengthValue} ${medicine.strengthUnit}`,
      storage: `${medicine.storageMinC}-${medicine.storageMaxC} C`, requiresColdChain: Boolean(medicine.requiresColdChain)
    }));
  }

  async close() {
    if (this.pool === sharedPool && sharedPool) {
      await sharedPool.end();
      sharedPool = null;
    } else {
      await this.pool.end();
    }
  }
}

module.exports = { PostgresInventoryStore, project, riskForDays, postgresTypes };
