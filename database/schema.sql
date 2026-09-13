-- =====================================================================
-- MEDRIPPLE DATABASE SCHEMA
-- Owner: Dhiren (Chemical Engineer & Data Owner)
-- Unit policy: ALL quantities stored in BASE UNITS ONLY.
--   Allowed base_unit values: 'mg' (solid mass), 'mL' (liquid volume),
--   'count' (discrete non-divisible items, e.g. auto-injector pens).
--   No tablets/vials/packs anywhere in stored data — conversion to a
--   human-readable "presentation" (e.g. "10 tablets") happens ONLY in
--   the frontend/API layer, never in the database.
-- =====================================================================

CREATE DATABASE IF NOT EXISTS medripple;
USE medripple;

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS audit_events;
DROP TABLE IF EXISTS transfers;
DROP TABLE IF EXISTS routes;
DROP TABLE IF EXISTS replenishments;
DROP TABLE IF EXISTS inventory;
DROP TABLE IF EXISTS facility_safety_stock;
DROP TABLE IF EXISTS consumption;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS medicines;
DROP TABLE IF EXISTS facilities;

-- ---------------------------------------------------------------------
-- FACILITIES
-- ---------------------------------------------------------------------
CREATE TABLE facilities (
    facility_id         INT PRIMARY KEY AUTO_INCREMENT,
    facility_code       VARCHAR(20) NOT NULL UNIQUE,       -- e.g. 'PHC-001'
    name                VARCHAR(120) NOT NULL,
    facility_type       ENUM('PHC','CHC','DistrictHospital','SubCentre','Warehouse') NOT NULL,
    region              VARCHAR(80) NOT NULL,
    latitude            DECIMAL(9,6) NOT NULL,
    longitude           DECIMAL(9,6) NOT NULL,
    population_served   INT NOT NULL,
    remoteness_score    DECIMAL(4,2) NOT NULL,             -- 0 (urban) - 10 (very remote)
    storage_capacity_ml INT NOT NULL,                      -- total cold storage volume available
    has_cold_chain      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- MEDICINES  (10-15 essential medicines, exact presentation)
-- ---------------------------------------------------------------------
CREATE TABLE medicines (
    medicine_id         INT PRIMARY KEY AUTO_INCREMENT,
    generic_name        VARCHAR(120) NOT NULL,
    strength_value       DECIMAL(10,3) NOT NULL,           -- e.g. 100
    strength_unit        VARCHAR(20) NOT NULL,             -- e.g. 'IU/mL', 'mg', 'mg/mL'
    form                VARCHAR(40) NOT NULL,              -- e.g. 'Vial','Tablet','PreFilledPen','Syrup'
    base_unit           ENUM('mg','mL','count') NOT NULL,  -- unit ALL quantities are stored in
    storage_temp_min_c  DECIMAL(4,1) NOT NULL,
    storage_temp_max_c  DECIMAL(4,1) NOT NULL,
    requires_cold_chain BOOLEAN NOT NULL DEFAULT FALSE,
    criticality_level   ENUM('LOW','MEDIUM','HIGH','CRITICAL') NOT NULL,  -- set with Aaryan
    shelf_life_days     INT NOT NULL,
    UNIQUE KEY uq_medicine_identity (generic_name, strength_value, strength_unit, form)
);

-- ---------------------------------------------------------------------
-- BATCHES  (a specific manufactured lot of a medicine)
-- ---------------------------------------------------------------------
CREATE TABLE batches (
    batch_id            INT PRIMARY KEY AUTO_INCREMENT,
    medicine_id         INT NOT NULL,
    batch_number        VARCHAR(40) NOT NULL,
    manufacture_date    DATE NOT NULL,
    expiry_date         DATE NOT NULL,
    quantity_received   DECIMAL(12,2) NOT NULL,            -- in medicine.base_unit
    supplier_name       VARCHAR(120),
    quarantined         BOOLEAN NOT NULL DEFAULT FALSE,
    quarantine_reason   VARCHAR(200),
    CONSTRAINT fk_batch_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id),
    CONSTRAINT chk_expiry_after_manufacture CHECK (expiry_date > manufacture_date)
);

-- ---------------------------------------------------------------------
-- INVENTORY  (current stock of a batch at a facility)
-- ---------------------------------------------------------------------
CREATE TABLE inventory (
    inventory_id        INT PRIMARY KEY AUTO_INCREMENT,
    facility_id         INT NOT NULL,
    batch_id            INT NOT NULL,
    quantity_on_hand    DECIMAL(12,2) NOT NULL,            -- in medicine.base_unit
    status              ENUM('AVAILABLE','QUARANTINED','EXPIRED','RESERVED') NOT NULL DEFAULT 'AVAILABLE',
    last_updated        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_inv_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_inv_batch FOREIGN KEY (batch_id) REFERENCES batches(batch_id),
    CONSTRAINT chk_qty_non_negative CHECK (quantity_on_hand >= 0)
);

-- ---------------------------------------------------------------------
-- CONSUMPTION  (daily usage history — feeds Druv's forecast)
-- ---------------------------------------------------------------------
CREATE TABLE consumption (
    consumption_id      INT PRIMARY KEY AUTO_INCREMENT,
    facility_id         INT NOT NULL,
    medicine_id         INT NOT NULL,
    consumption_date    DATE NOT NULL,
    quantity_consumed   DECIMAL(12,2) NOT NULL,            -- in medicine.base_unit
    CONSTRAINT fk_cons_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_cons_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id),
    UNIQUE KEY uq_facility_medicine_date (facility_id, medicine_id, consumption_date)
);

-- ---------------------------------------------------------------------
-- REPLENISHMENTS  (expected/actual incoming supply)
-- ---------------------------------------------------------------------
CREATE TABLE replenishments (
    replenishment_id     INT PRIMARY KEY AUTO_INCREMENT,
    facility_id          INT NOT NULL,
    medicine_id          INT NOT NULL,
    batch_id             INT,                              -- NULL until batch is actually assigned
    expected_arrival_date DATE NOT NULL,
    actual_arrival_date   DATE,
    quantity             DECIMAL(12,2) NOT NULL,           -- in medicine.base_unit
    supplier_reliability_score DECIMAL(4,2) NOT NULL,      -- 0-1, historical on-time rate
    status               ENUM('SCHEDULED','DELAYED','ARRIVED','CANCELLED') NOT NULL DEFAULT 'SCHEDULED',
    CONSTRAINT fk_rep_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_rep_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id),
    CONSTRAINT fk_rep_batch FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
);

-- ---------------------------------------------------------------------
-- ROUTES  (transport feasibility between facility pairs)
-- ---------------------------------------------------------------------
CREATE TABLE routes (
    route_id             INT PRIMARY KEY AUTO_INCREMENT,
    origin_facility_id   INT NOT NULL,
    destination_facility_id INT NOT NULL,
    distance_km          DECIMAL(8,2) NOT NULL,
    transport_time_hours DECIMAL(6,2) NOT NULL,
    cold_chain_capable   BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_route_origin FOREIGN KEY (origin_facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_route_dest FOREIGN KEY (destination_facility_id) REFERENCES facilities(facility_id),
    UNIQUE KEY uq_route_pair (origin_facility_id, destination_facility_id)
);

-- ---------------------------------------------------------------------
-- TRANSFERS  (proposed/approved donor -> receiver movements)
-- ---------------------------------------------------------------------
CREATE TABLE transfers (
    transfer_id          INT PRIMARY KEY AUTO_INCREMENT,
    origin_facility_id   INT NOT NULL,
    destination_facility_id INT NOT NULL,
    medicine_id          INT NOT NULL,
    batch_id             INT NOT NULL,
    quantity             DECIMAL(12,2) NOT NULL,           -- in medicine.base_unit
    status               ENUM('PROPOSED','REJECTED_UNSAFE','APPROVED','COMPLETED') NOT NULL DEFAULT 'PROPOSED',
    rejection_reason     VARCHAR(200),
    requested_at         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    approved_at          TIMESTAMP NULL,
    approved_by          VARCHAR(120),
    note                 VARCHAR(500),
    CONSTRAINT fk_tr_origin FOREIGN KEY (origin_facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_tr_dest FOREIGN KEY (destination_facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_tr_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id),
    CONSTRAINT fk_tr_batch FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
);

-- ---------------------------------------------------------------------
-- AUDIT EVENTS  (every approval/rejection decision, before/after state)
-- ---------------------------------------------------------------------
CREATE TABLE audit_events (
    audit_id             INT PRIMARY KEY AUTO_INCREMENT,
    entity_type          VARCHAR(40) NOT NULL,             -- 'transfer', 'plan', etc.
    entity_id            INT NOT NULL,
    action               VARCHAR(40) NOT NULL,             -- 'APPROVE','REJECT','SIMULATE'
    actor                VARCHAR(120) NOT NULL,
    note                 VARCHAR(500),
    before_state_json    JSON,
    after_state_json     JSON,
    event_timestamp      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ---------------------------------------------------------------------
-- FACILITY_SAFETY_STOCK  (protected minimum coverage per facility+medicine)
-- Values here are DRAFT until confirmed_by_aaryan = TRUE. This is the
-- number the feasibility gate checks: "donor falls below protected safety
-- stock during the horizon" -> reject the transfer.
-- ---------------------------------------------------------------------
CREATE TABLE facility_safety_stock (
    facility_id          INT NOT NULL,
    medicine_id          INT NOT NULL,
    safety_stock_qty     DECIMAL(12,2) NOT NULL,          -- in medicine.base_unit
    basis                VARCHAR(200),                     -- how this number was derived
    confirmed_by_aaryan  BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (facility_id, medicine_id),
    CONSTRAINT fk_fss_facility FOREIGN KEY (facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_fss_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id)
);

SET FOREIGN_KEY_CHECKS = 1;

SET @history_start = DATE('2026-06-29');
SET @history_end   = DATE('2026-09-11');

SET FOREIGN_KEY_CHECKS = 0;

START TRANSACTION;

-- ---------------------------------------------------------------------
-- RESET EXISTING SIMULATION DATA
-- Remove this section if the target database already contains data
-- that must be retained.
-- ---------------------------------------------------------------------

DELETE FROM audit_events;
DELETE FROM transfers;
DELETE FROM routes;
DELETE FROM replenishments;
DELETE FROM inventory;
DELETE FROM facility_safety_stock;
DELETE FROM consumption;
DELETE FROM batches;
DELETE FROM medicines;
DELETE FROM facilities;

ALTER TABLE audit_events AUTO_INCREMENT = 1;
ALTER TABLE transfers AUTO_INCREMENT = 1;
ALTER TABLE routes AUTO_INCREMENT = 1;
ALTER TABLE replenishments AUTO_INCREMENT = 1;
ALTER TABLE inventory AUTO_INCREMENT = 1;
ALTER TABLE consumption AUTO_INCREMENT = 1;
ALTER TABLE batches AUTO_INCREMENT = 1;
ALTER TABLE medicines AUTO_INCREMENT = 1;
ALTER TABLE facilities AUTO_INCREMENT = 1;

-- ---------------------------------------------------------------------
-- FACILITIES
-- Coordinates are approximate city-level locations.
-- Facility identities and operational values are synthetic.
-- ---------------------------------------------------------------------

INSERT INTO facilities (
    facility_code,
    name,
    facility_type,
    region,
    latitude,
    longitude,
    population_served,
    remoteness_score,
    storage_capacity_ml,
    has_cold_chain
) VALUES
('WH-TN-001',  'Chennai Regional Medical Warehouse', 'Warehouse',
 'Chennai',      13.082680, 80.270718, 0,      0.50, 850000, TRUE),

('DH-CBE-001',  'Coimbatore District Hospital', 'DistrictHospital',
 'Coimbatore',   11.016844, 76.955833, 485000, 2.00, 220000, TRUE),

('DH-MDU-001',  'Madurai District Hospital', 'DistrictHospital',
 'Madurai',       9.925201, 78.119774, 440000, 2.30, 210000, TRUE),

('CHC-TRY-001', 'Tiruchirappalli Community Health Centre', 'CHC',
 'Tiruchirappalli', 10.790483, 78.704674, 185000, 3.10, 125000, TRUE),

('CHC-SLM-001', 'Salem Community Health Centre', 'CHC',
 'Salem',        11.664325, 78.146011, 170000, 3.40, 115000, TRUE),

('PHC-VLR-001', 'Vellore Primary Health Centre', 'PHC',
 'Vellore',      12.916517, 79.132500, 78000,  4.00, 62000, TRUE),

('PHC-TNJ-001', 'Thanjavur Primary Health Centre', 'PHC',
 'Thanjavur',    10.786999, 79.137825, 69000,  4.30, 52000, FALSE),

('PHC-TNV-001', 'Tirunelveli Primary Health Centre', 'PHC',
 'Tirunelveli',   8.713913, 77.756653, 74000,  4.80, 55000, FALSE),

('SC-DPI-001',  'Dharmapuri Rural SubCentre', 'SubCentre',
 'Dharmapuri',   12.121099, 78.158218, 28000,  7.20, 18000, FALSE),

('SC-RMD-001',  'Ramanathapuram Coastal SubCentre', 'SubCentre',
 'Ramanathapuram', 9.363936, 78.839481, 24000, 7.80, 16000, FALSE);

-- ---------------------------------------------------------------------
-- MEDICINES
-- Quantities are stored only in base units.
-- ---------------------------------------------------------------------

INSERT INTO medicines (
    generic_name,
    strength_value,
    strength_unit,
    form,
    base_unit,
    storage_temp_min_c,
    storage_temp_max_c,
    requires_cold_chain,
    criticality_level,
    shelf_life_days
) VALUES
('Paracetamol',            500.000, 'mg',       'Tablet',       'mg',    15.0, 30.0, FALSE, 'MEDIUM',   730),
('Amoxicillin',            500.000, 'mg',       'Capsule',      'mg',    15.0, 25.0, FALSE, 'HIGH',     730),
('Azithromycin',           500.000, 'mg',       'Tablet',       'mg',    15.0, 30.0, FALSE, 'HIGH',     730),
('Metformin',              500.000, 'mg',       'Tablet',       'mg',    15.0, 30.0, FALSE, 'HIGH',    1095),
('Amlodipine',               5.000, 'mg',       'Tablet',       'mg',    15.0, 30.0, FALSE, 'HIGH',    1095),
('Oral Rehydration Salts',20500.000, 'mg',      'Powder',       'mg',    15.0, 30.0, FALSE, 'CRITICAL', 730),
('Human Insulin',          100.000, 'IU/mL',    'Vial',         'mL',     2.0,  8.0, TRUE,  'CRITICAL', 730),
('Oxytocin',                10.000, 'IU/mL',    'Ampoule',      'mL',     2.0,  8.0, TRUE,  'CRITICAL', 730),
('Rabies Vaccine',           2.500, 'IU/mL',    'Vial',         'mL',     2.0,  8.0, TRUE,  'CRITICAL', 730),
('Adrenaline Auto-Injector', 1.000, 'mg',       'PreFilledPen', 'count', 15.0, 25.0, FALSE, 'CRITICAL', 540),
('Salbutamol',               2.000, 'mg/5mL',   'Syrup',        'mL',    15.0, 30.0, FALSE, 'HIGH',     730),
('Ceftriaxone',           1000.000, 'mg',       'Vial',         'mg',    15.0, 25.0, FALSE, 'CRITICAL', 730);

-- ---------------------------------------------------------------------
-- NUMBER TABLES FOR DETERMINISTIC DATA GENERATION
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS sim_digits_ones;
DROP TEMPORARY TABLE IF EXISTS sim_digits;
CREATE TEMPORARY TABLE sim_digits (n INT PRIMARY KEY);

INSERT INTO sim_digits (n)
VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);

CREATE TEMPORARY TABLE sim_digits_ones AS
SELECT n FROM sim_digits;

DROP TEMPORARY TABLE IF EXISTS sim_days;
CREATE TEMPORARY TABLE sim_days AS
SELECT
    (tens.n * 10 + ones.n) AS day_offset,
    DATE_ADD(@history_start, INTERVAL (tens.n * 10 + ones.n) DAY)
        AS consumption_date
FROM sim_digits tens
CROSS JOIN sim_digits_ones ones
WHERE (tens.n * 10 + ones.n) BETWEEN 0 AND 74;

ALTER TABLE sim_days ADD PRIMARY KEY (day_offset);

-- ---------------------------------------------------------------------
-- BATCHES
-- Two lots per medicine.
-- ---------------------------------------------------------------------

INSERT INTO batches (
    medicine_id,
    batch_number,
    manufacture_date,
    expiry_date,
    quantity_received,
    supplier_name,
    quarantined,
    quarantine_reason
)
SELECT
    m.medicine_id,
    CONCAT(
        'TN-',
        LPAD(m.medicine_id, 3, '0'),
        '-B',
        LPAD(lot.n + 1, 2, '0'),
        '-26'
    ),
    DATE_SUB(@history_start, INTERVAL (120 - lot.n * 55) DAY),
    DATE_ADD(
        DATE_SUB(@history_start, INTERVAL (120 - lot.n * 55) DAY),
        INTERVAL m.shelf_life_days DAY
    ),
    CASE m.base_unit
        WHEN 'mg' THEN 30000000 + (m.medicine_id * 1750000)
        WHEN 'mL' THEN 200000 + (m.medicine_id * 12000)
        WHEN 'count' THEN 30000
    END,
    CASE MOD(m.medicine_id + lot.n, 4)
        WHEN 0 THEN 'Tamil Nadu Medical Services Corporation'
        WHEN 1 THEN 'Chennai Essential Pharma Supply'
        WHEN 2 THEN 'Coimbatore Regional Medical Logistics'
        ELSE 'South India Public Health Supplies'
    END,
    FALSE,
    NULL
FROM medicines m
JOIN sim_digits lot ON lot.n < 2;

-- Simulated cold-chain excursion affecting one rabies-vaccine batch.

UPDATE batches
SET
    quarantined = TRUE,
    quarantine_reason =
        'Simulated cold-chain temperature excursion during transport'
WHERE medicine_id = 9
  AND batch_number LIKE '%-B01-26';

-- ---------------------------------------------------------------------
-- DAILY CONSUMPTION
-- Warehouse is excluded because stock dispatched by a warehouse is not
-- treated as clinical consumption.
--
-- The formula includes:
--   * facility size
--   * medicine-specific demand
--   * deterministic daily variation
--   * lower weekend utilization
-- ---------------------------------------------------------------------

INSERT INTO consumption (
    facility_id,
    medicine_id,
    consumption_date,
    quantity_consumed
)
SELECT
    f.facility_id,
    m.medicine_id,
    d.consumption_date,
    ROUND(
        CASE m.base_unit
            WHEN 'mg' THEN
                (
                    4500
                    + f.population_served * 0.018
                    + m.medicine_id * 525
                )
            WHEN 'mL' THEN
                (
                    20
                    + f.population_served * 0.00012
                    + m.medicine_id * 1.70
                )
            WHEN 'count' THEN
                (
                    1
                    + f.population_served * 0.000018
                )
        END
        *
        (
            0.88
            + MOD(
                d.day_offset * 7
                + f.facility_id * 11
                + m.medicine_id * 13,
                25
            ) / 100
        )
        *
        CASE
            WHEN DAYOFWEEK(d.consumption_date) IN (1,7) THEN 0.82
            ELSE 1.00
        END,
        CASE WHEN m.base_unit = 'count' THEN 0 ELSE 2 END
    )
FROM facilities f
CROSS JOIN medicines m
CROSS JOIN sim_days d
WHERE f.facility_type <> 'Warehouse';

-- ---------------------------------------------------------------------
-- AVERAGE DAILY CONSUMPTION
-- Used to create safety-stock and current-inventory values.
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS sim_daily_average;
CREATE TEMPORARY TABLE sim_daily_average AS
SELECT
    facility_id,
    medicine_id,
    AVG(quantity_consumed) AS average_daily_consumption
FROM consumption
GROUP BY facility_id, medicine_id;

ALTER TABLE sim_daily_average
ADD PRIMARY KEY (facility_id, medicine_id);

-- ---------------------------------------------------------------------
-- FACILITY SAFETY STOCK
-- Coverage increases with facility remoteness.
-- These values remain drafts until confirmed by Aaryan.
-- ---------------------------------------------------------------------

INSERT INTO facility_safety_stock (
    facility_id,
    medicine_id,
    safety_stock_qty,
    basis,
    confirmed_by_aaryan
)
SELECT
    a.facility_id,
    a.medicine_id,
    ROUND(
        a.average_daily_consumption
        * (10 + CEIL(f.remoteness_score)),
        2
    ),
    CONCAT(
        'Simulated average daily consumption multiplied by ',
        10 + CEIL(f.remoteness_score),
        ' coverage days; pending clinical confirmation'
    ),
    FALSE
FROM sim_daily_average a
JOIN facilities f
  ON f.facility_id = a.facility_id;

-- ---------------------------------------------------------------------
-- CURRENT INVENTORY AT CLINICAL FACILITIES
-- Newer batches carry more of the current stock.
-- ---------------------------------------------------------------------

INSERT INTO inventory (
    facility_id,
    batch_id,
    quantity_on_hand,
    status,
    last_updated
)
SELECT
    a.facility_id,
    b.batch_id,
    ROUND(
        a.average_daily_consumption
        * CASE
            WHEN b.batch_number LIKE '%-B01-26' THEN 9
            ELSE 16
          END,
        2
    ),
    CASE
        WHEN b.quarantined = TRUE THEN 'QUARANTINED'
        ELSE 'AVAILABLE'
    END,
    TIMESTAMP(@history_end, '18:00:00')
FROM sim_daily_average a
JOIN batches b
  ON b.medicine_id = a.medicine_id;

-- Warehouse inventory.

INSERT INTO inventory (
    facility_id,
    batch_id,
    quantity_on_hand,
    status,
    last_updated
)
SELECT
    1,
    b.batch_id,
    ROUND(b.quantity_received * 0.18, 2),
    CASE
        WHEN b.quarantined = TRUE THEN 'QUARANTINED'
        ELSE 'AVAILABLE'
    END,
    TIMESTAMP(@history_end, '18:00:00')
FROM batches b;

-- ---------------------------------------------------------------------
-- REPLENISHMENTS
-- One historical arrival and one current/future order for each
-- clinical facility and medicine.
-- ---------------------------------------------------------------------

INSERT INTO replenishments (
    facility_id,
    medicine_id,
    batch_id,
    expected_arrival_date,
    actual_arrival_date,
    quantity,
    supplier_reliability_score,
    status
)
SELECT
    a.facility_id,
    a.medicine_id,
    MAX(b.batch_id),
    DATE_ADD(
        @history_start,
        INTERVAL (22 + MOD(a.facility_id + a.medicine_id, 19)) DAY
    ),
    DATE_ADD(
        @history_start,
        INTERVAL (
            22
            + MOD(a.facility_id + a.medicine_id, 19)
            + MOD(a.facility_id * a.medicine_id, 4)
        ) DAY
    ),
    ROUND(a.average_daily_consumption * 28, 2),
    ROUND(
        0.78 + MOD(a.facility_id * 5 + a.medicine_id * 3, 20) / 100,
        2
    ),
    'ARRIVED'
FROM sim_daily_average a
JOIN batches b
  ON b.medicine_id = a.medicine_id
GROUP BY
    a.facility_id,
    a.medicine_id,
    a.average_daily_consumption;

INSERT INTO replenishments (
    facility_id,
    medicine_id,
    batch_id,
    expected_arrival_date,
    actual_arrival_date,
    quantity,
    supplier_reliability_score,
    status
)
SELECT
    a.facility_id,
    a.medicine_id,
    NULL,
    DATE_ADD(
        @history_end,
        INTERVAL (3 + MOD(a.facility_id + a.medicine_id, 12)) DAY
    ),
    NULL,
    ROUND(a.average_daily_consumption * 35, 2),
    ROUND(
        0.76 + MOD(a.facility_id * 7 + a.medicine_id * 5, 22) / 100,
        2
    ),
    CASE
        WHEN MOD(a.facility_id + a.medicine_id, 17) = 0
            THEN 'CANCELLED'
        WHEN MOD(a.facility_id + a.medicine_id, 7) = 0
            THEN 'DELAYED'
        ELSE 'SCHEDULED'
    END
FROM sim_daily_average a;

-- ---------------------------------------------------------------------
-- ROUTES
-- Generates directed routes between every distinct facility pair.
-- Distance uses the Haversine formula.
-- ---------------------------------------------------------------------

INSERT INTO routes (
    origin_facility_id,
    destination_facility_id,
    distance_km,
    transport_time_hours,
    cold_chain_capable
)
SELECT
    r.origin_facility_id,
    r.destination_facility_id,
    r.distance_km,
    ROUND(
        r.distance_km / 46
        + r.destination_remoteness * 0.12,
        2
    ),
    CASE
        WHEN r.origin_cold_chain = TRUE
         AND r.destination_cold_chain = TRUE
        THEN TRUE
        ELSE FALSE
    END
FROM (
    SELECT
        o.facility_id AS origin_facility_id,
        d.facility_id AS destination_facility_id,
        d.remoteness_score AS destination_remoteness,
        o.has_cold_chain AS origin_cold_chain,
        d.has_cold_chain AS destination_cold_chain,
        ROUND(
            6371 * 2 * ASIN(
                SQRT(
                    POWER(
                        SIN(RADIANS(d.latitude - o.latitude) / 2),
                        2
                    )
                    +
                    COS(RADIANS(o.latitude))
                    * COS(RADIANS(d.latitude))
                    * POWER(
                        SIN(RADIANS(d.longitude - o.longitude) / 2),
                        2
                    )
                )
            ),
            2
        ) AS distance_km
    FROM facilities o
    CROSS JOIN facilities d
    WHERE o.facility_id <> d.facility_id
) r;

-- ---------------------------------------------------------------------
-- TRANSFERS
-- Includes completed, approved, proposed, and rejected examples.
-- ---------------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS sim_transfer_requests;
CREATE TEMPORARY TABLE sim_transfer_requests (
    origin_facility_id INT,
    destination_facility_id INT,
    medicine_id INT,
    quantity DECIMAL(12,2),
    status VARCHAR(30),
    rejection_reason VARCHAR(200),
    days_ago INT,
    approved_by VARCHAR(120),
    note VARCHAR(500)
);

INSERT INTO sim_transfer_requests VALUES
(1, 2, 7,  420.00,  'COMPLETED',       NULL, 48, 'Regional Supply Officer',
 'Emergency insulin redistribution from the regional warehouse'),

(1, 3, 2,  850000.00, 'COMPLETED',     NULL, 41, 'Regional Supply Officer',
 'Routine redistribution after demand increase'),

(2, 6, 8,  180.00,  'APPROVED',        NULL, 26, 'District Pharmacist',
 'Approved cold-chain transfer'),

(3, 8, 9,  95.00,   'REJECTED_UNSAFE',
 'Destination has no validated cold-chain storage', 21, NULL,
 'Rejected by automated cold-chain feasibility gate'),

(4, 7, 6,  410000.00, 'COMPLETED',     NULL, 17, 'District Pharmacist',
 'ORS transferred in response to seasonal demand'),

(5, 10, 10, 30.00,  'APPROVED',        NULL, 12, 'Regional Medical Officer',
 'Emergency adrenaline stock balancing'),

(6, 9, 1,  190000.00, 'PROPOSED',      NULL, 7, NULL,
 'Awaiting donor safety-stock review'),

(7, 4, 4,  275000.00, 'REJECTED_UNSAFE',
 'Projected donor stock would fall below protected safety stock', 4, NULL,
 'Rejected by donor safety-stock feasibility gate');

INSERT INTO transfers (
    origin_facility_id,
    destination_facility_id,
    medicine_id,
    batch_id,
    quantity,
    status,
    rejection_reason,
    requested_at,
    approved_at,
    approved_by,
    note
)
SELECT
    t.origin_facility_id,
    t.destination_facility_id,
    t.medicine_id,
    MAX(b.batch_id),
    t.quantity,
    t.status,
    t.rejection_reason,
    TIMESTAMP(
        DATE_SUB(@history_end, INTERVAL t.days_ago DAY),
        '09:30:00'
    ),
    CASE
        WHEN t.status IN ('APPROVED','COMPLETED') THEN
            TIMESTAMP(
                DATE_SUB(@history_end, INTERVAL t.days_ago DAY),
                '13:30:00'
            )
        ELSE NULL
    END,
    t.approved_by,
    t.note
FROM sim_transfer_requests t
JOIN batches b
  ON b.medicine_id = t.medicine_id
GROUP BY
    t.origin_facility_id,
    t.destination_facility_id,
    t.medicine_id,
    t.quantity,
    t.status,
    t.rejection_reason,
    t.days_ago,
    t.approved_by,
    t.note;

-- ---------------------------------------------------------------------
-- AUDIT EVENTS
-- One decision event for every simulated transfer.
-- ---------------------------------------------------------------------

INSERT INTO audit_events (
    entity_type,
    entity_id,
    action,
    actor,
    note,
    before_state_json,
    after_state_json,
    event_timestamp
)
SELECT
    'transfer',
    t.transfer_id,
    CASE
        WHEN t.status = 'REJECTED_UNSAFE' THEN 'REJECT'
        WHEN t.status IN ('APPROVED','COMPLETED') THEN 'APPROVE'
        ELSE 'SIMULATE'
    END,
    COALESCE(t.approved_by, 'MEDRIPPLE Feasibility Engine'),
    COALESCE(t.rejection_reason, t.note),
    JSON_OBJECT(
        'status', 'PROPOSED',
        'origin_facility_id', t.origin_facility_id,
        'destination_facility_id', t.destination_facility_id,
        'medicine_id', t.medicine_id,
        'batch_id', t.batch_id,
        'quantity', t.quantity
    ),
    JSON_OBJECT(
        'status', t.status,
        'origin_facility_id', t.origin_facility_id,
        'destination_facility_id', t.destination_facility_id,
        'medicine_id', t.medicine_id,
        'batch_id', t.batch_id,
        'quantity', t.quantity,
        'rejection_reason', t.rejection_reason
    ),
    DATE_ADD(t.requested_at, INTERVAL 4 HOUR)
FROM transfers t;

DROP TEMPORARY TABLE IF EXISTS sim_transfer_requests;
DROP TEMPORARY TABLE IF EXISTS sim_daily_average;
DROP TEMPORARY TABLE IF EXISTS sim_days;
DROP TEMPORARY TABLE IF EXISTS sim_digits_ones;
DROP TEMPORARY TABLE IF EXISTS sim_digits;

COMMIT;

SET FOREIGN_KEY_CHECKS = 1;

START TRANSACTION;

-- Remove partial generated data.
DELETE FROM replenishments;
DELETE FROM inventory;
DELETE FROM facility_safety_stock;
DELETE FROM consumption;

ALTER TABLE replenishments AUTO_INCREMENT = 1;
ALTER TABLE inventory AUTO_INCREMENT = 1;
ALTER TABLE consumption AUTO_INCREMENT = 1;

-- ------------------------------------------------------------
-- BUILD 75 CALENDAR DAYS: 2026-06-29 through 2026-09-11
-- ------------------------------------------------------------

DROP TEMPORARY TABLE IF EXISTS sim_digits;
DROP TEMPORARY TABLE IF EXISTS sim_digits_ones;
DROP TEMPORARY TABLE IF EXISTS sim_days;
DROP TEMPORARY TABLE IF EXISTS sim_daily_average;

CREATE TEMPORARY TABLE sim_digits (
    n INT PRIMARY KEY
);

INSERT INTO sim_digits (n)
VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9);

CREATE TEMPORARY TABLE sim_digits_ones AS
SELECT n FROM sim_digits;

CREATE TEMPORARY TABLE sim_days (
    day_offset INT PRIMARY KEY,
    consumption_date DATE NOT NULL
);

INSERT INTO sim_days (day_offset, consumption_date)
SELECT
    numbers.day_offset,
    DATE_ADD(
        DATE('2026-06-29'),
        INTERVAL numbers.day_offset DAY
    )
FROM (
    SELECT (tens.n * 10 + ones.n) AS day_offset
    FROM sim_digits AS tens
    CROSS JOIN sim_digits_ones AS ones
) AS numbers
WHERE numbers.day_offset BETWEEN 0 AND 74;

-- This should return 75.
SELECT COUNT(*) AS generated_days
FROM sim_days;

-- ------------------------------------------------------------
-- DAILY CONSUMPTION
--
-- 9 clinical facilities × 12 medicines × 75 days
-- Expected: 8,100 rows
-- ------------------------------------------------------------

INSERT INTO consumption (
    facility_id,
    medicine_id,
    consumption_date,
    quantity_consumed
)
SELECT
    f.facility_id,
    m.medicine_id,
    d.consumption_date,

    ROUND(
        CASE
            WHEN m.base_unit = 'mg' THEN
                4500
                + (f.population_served * 0.018)
                + (m.medicine_id * 525)

            WHEN m.base_unit = 'mL' THEN
                20
                + (f.population_served * 0.00012)
                + (m.medicine_id * 1.70)

            WHEN m.base_unit = 'count' THEN
                1
                + (f.population_served * 0.000018)
        END

        * (
            0.88
            + MOD(
                d.day_offset * 7
                + f.facility_id * 11
                + m.medicine_id * 13,
                25
            ) / 100
        )

        * CASE
            WHEN DAYOFWEEK(d.consumption_date) IN (1, 7)
                THEN 0.82
            ELSE 1.00
          END,

        CASE
            WHEN m.base_unit = 'count' THEN 0
            ELSE 2
        END
    ) AS quantity_consumed

FROM facilities AS f
CROSS JOIN medicines AS m
CROSS JOIN sim_days AS d
WHERE f.facility_type <> 'Warehouse';

-- Stop here automatically if the generated count is wrong.
SET @consumption_count = (
    SELECT COUNT(*)
    FROM consumption
);

-- ------------------------------------------------------------
-- AVERAGE DAILY CONSUMPTION
-- ------------------------------------------------------------

CREATE TEMPORARY TABLE sim_daily_average (
    facility_id INT NOT NULL,
    medicine_id INT NOT NULL,
    average_daily_consumption DECIMAL(18,4) NOT NULL,
    PRIMARY KEY (facility_id, medicine_id)
);

INSERT INTO sim_daily_average (
    facility_id,
    medicine_id,
    average_daily_consumption
)
SELECT
    facility_id,
    medicine_id,
    AVG(quantity_consumed)
FROM consumption
GROUP BY facility_id, medicine_id;

-- Expected: 108 rows.
SELECT COUNT(*) AS facility_medicine_pairs
FROM sim_daily_average;

-- ------------------------------------------------------------
-- FACILITY SAFETY STOCK
-- Expected: 108 rows
-- ------------------------------------------------------------

INSERT INTO facility_safety_stock (
    facility_id,
    medicine_id,
    safety_stock_qty,
    basis,
    confirmed_by_aaryan
)
SELECT
    a.facility_id,
    a.medicine_id,

    ROUND(
        a.average_daily_consumption
        * (10 + CEIL(f.remoteness_score)),
        2
    ),

    CONCAT(
        'Simulated average daily consumption multiplied by ',
        10 + CEIL(f.remoteness_score),
        ' coverage days; pending clinical confirmation'
    ),

    FALSE
FROM sim_daily_average AS a
JOIN facilities AS f
    ON f.facility_id = a.facility_id;

-- ------------------------------------------------------------
-- CLINICAL FACILITY INVENTORY
--
-- 9 facilities × 12 medicines × 2 batches
-- Expected: 216 rows
-- ------------------------------------------------------------

INSERT INTO inventory (
    facility_id,
    batch_id,
    quantity_on_hand,
    status,
    last_updated
)
SELECT
    a.facility_id,
    b.batch_id,

    ROUND(
        a.average_daily_consumption
        * CASE
            WHEN b.batch_number LIKE '%-B01-26' THEN 9
            ELSE 16
          END,
        2
    ),

    CASE
        WHEN b.quarantined = TRUE THEN 'QUARANTINED'
        WHEN b.expiry_date < DATE('2026-09-11') THEN 'EXPIRED'
        ELSE 'AVAILABLE'
    END,

    TIMESTAMP('2026-09-11 18:00:00')

FROM sim_daily_average AS a
JOIN batches AS b
    ON b.medicine_id = a.medicine_id;

-- ------------------------------------------------------------
-- WAREHOUSE INVENTORY
--
-- 12 medicines × 2 batches
-- Expected: 24 rows
-- ------------------------------------------------------------

INSERT INTO inventory (
    facility_id,
    batch_id,
    quantity_on_hand,
    status,
    last_updated
)
SELECT
    f.facility_id,
    b.batch_id,
    ROUND(b.quantity_received * 0.18, 2),

    CASE
        WHEN b.quarantined = TRUE THEN 'QUARANTINED'
        WHEN b.expiry_date < DATE('2026-09-11') THEN 'EXPIRED'
        ELSE 'AVAILABLE'
    END,

    TIMESTAMP('2026-09-11 18:00:00')

FROM facilities AS f
CROSS JOIN batches AS b
WHERE f.facility_type = 'Warehouse';

-- ------------------------------------------------------------
-- HISTORICAL REPLENISHMENTS
--
-- One arrived replenishment per facility/medicine.
-- Expected: 108 rows
-- ------------------------------------------------------------

INSERT INTO replenishments (
    facility_id,
    medicine_id,
    batch_id,
    expected_arrival_date,
    actual_arrival_date,
    quantity,
    supplier_reliability_score,
    status
)
SELECT
    a.facility_id,
    a.medicine_id,
    MAX(b.batch_id),

    DATE_ADD(
        DATE('2026-06-29'),
        INTERVAL (
            22 + MOD(a.facility_id + a.medicine_id, 19)
        ) DAY
    ),

    DATE_ADD(
        DATE('2026-06-29'),
        INTERVAL (
            22
            + MOD(a.facility_id + a.medicine_id, 19)
            + MOD(a.facility_id * a.medicine_id, 4)
        ) DAY
    ),

    ROUND(a.average_daily_consumption * 28, 2),

    ROUND(
        0.78
        + MOD(
            a.facility_id * 5
            + a.medicine_id * 3,
            20
        ) / 100,
        2
    ),

    'ARRIVED'

FROM sim_daily_average AS a
JOIN batches AS b
    ON b.medicine_id = a.medicine_id
GROUP BY
    a.facility_id,
    a.medicine_id,
    a.average_daily_consumption;

-- ------------------------------------------------------------
-- CURRENT/FUTURE REPLENISHMENTS
--
-- One replenishment per facility/medicine.
-- Expected: another 108 rows
-- ------------------------------------------------------------

INSERT INTO replenishments (
    facility_id,
    medicine_id,
    batch_id,
    expected_arrival_date,
    actual_arrival_date,
    quantity,
    supplier_reliability_score,
    status
)
SELECT
    a.facility_id,
    a.medicine_id,
    NULL,

    DATE_ADD(
        DATE('2026-09-11'),
        INTERVAL (
            3 + MOD(a.facility_id + a.medicine_id, 12)
        ) DAY
    ),

    NULL,

    ROUND(a.average_daily_consumption * 35, 2),

    ROUND(
        0.76
        + MOD(
            a.facility_id * 7
            + a.medicine_id * 5,
            22
        ) / 100,
        2
    ),

    CASE
        WHEN MOD(a.facility_id + a.medicine_id, 17) = 0
            THEN 'CANCELLED'
        WHEN MOD(a.facility_id + a.medicine_id, 7) = 0
            THEN 'DELAYED'
        ELSE 'SCHEDULED'
    END

FROM sim_daily_average AS a;

DROP TEMPORARY TABLE IF EXISTS sim_daily_average;
DROP TEMPORARY TABLE IF EXISTS sim_days;
DROP TEMPORARY TABLE IF EXISTS sim_digits_ones;
DROP TEMPORARY TABLE IF EXISTS sim_digits;

COMMIT;

-- ============================================================
-- FINAL VALIDATION
-- ============================================================

SELECT 'audit_events' AS table_name, FORMAT(COUNT(*), 0) AS row_count
FROM audit_events

UNION ALL
SELECT 'batches', FORMAT(COUNT(*), 0) FROM batches

UNION ALL
SELECT 'consumption', FORMAT(COUNT(*), 0) FROM consumption

UNION ALL
SELECT 'facilities', FORMAT(COUNT(*), 0) FROM facilities

UNION ALL
SELECT 'facility_safety_stock', FORMAT(COUNT(*), 0)
FROM facility_safety_stock

UNION ALL
SELECT 'inventory', FORMAT(COUNT(*), 0) FROM inventory

UNION ALL
SELECT 'medicines', FORMAT(COUNT(*), 0) FROM medicines

UNION ALL
SELECT 'replenishments', FORMAT(COUNT(*), 0) FROM replenishments

UNION ALL
SELECT 'routes', FORMAT(COUNT(*), 0) FROM routes

UNION ALL
SELECT 'transfers', FORMAT(COUNT(*), 0) FROM transfers

ORDER BY table_name;