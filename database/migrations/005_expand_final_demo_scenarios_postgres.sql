-- =====================================================================
-- Migration 005 (PostgreSQL): expand an existing database to the final
-- MEDRIPPLE demo dataset.
--
-- SIMULATED PROTOTYPE DATA ONLY. No real patient, facility, stock or supply
-- record is included, and no patient counts or patient-impact values exist.
-- Reference date: SIMULATION_DATE = 2026-09-11.
--
-- For a local development database already created with
-- database/schema-postgres.sql (with or without an earlier seed):
--   psql "<local database URL>" -v ON_ERROR_STOP=1 -f database/migrations/005_expand_final_demo_scenarios_postgres.sql
-- Applying it to a shared or deployed database is a separate, owner-approved
-- change.
--
-- It adds the same rows as database/seed-postgres.sql sections 1 and 2:
-- Dhiren's MySQL dataset and the final demo scenarios. It is safe to rerun:
-- - one transaction; any failure leaves the database unchanged;
-- - insert-only: rows are matched on natural keys (facility_code, medicine
--   identity, medicine and batch_number, and so on) and never updated;
-- - no DELETE, TRUNCATE, DROP or sequence reset; accounts, plans, transfers,
--   audit events and stock changed by approvals are not touched;
-- - a rerun inserts nothing and consumes no sequence values.
--
-- IDs: rows added here take the next free IDs. On a database that already
-- held the earlier four-facility dataset, Human Insulin keeps its existing ID
-- and TN-007-B01-26 is not batch 14, so request insulin by the alias
-- med-insulin-100iu-vial or by the reported ID. The closing notice reports
-- both IDs; only a fresh install (seed-postgres.sql) guarantees 7 and 14.
-- =====================================================================

BEGIN;

-- >>> BEGIN SHARED FINAL DEMO REFERENCE DATA >>>
-- Keep this section identical in database/seed-postgres.sql and
-- database/migrations/005_expand_final_demo_scenarios_postgres.sql (a test checks it).
--
-- canonical_no is the row's ID in Dhiren's MySQL dataset (database/schema.sql plus
-- database/golden-scenario.sql), or 11-12 and 25 for the demo additions. Generated values
-- depend on these numbers, never on the IDs a particular database assigns.

CREATE TEMP TABLE demo_facility (
    canonical_no        INT PRIMARY KEY,
    facility_code       VARCHAR(20) NOT NULL UNIQUE,
    name                VARCHAR(120) NOT NULL,
    facility_type       facility_type_enum NOT NULL,
    region              VARCHAR(80) NOT NULL,
    latitude            DECIMAL(9,6) NOT NULL,
    longitude           DECIMAL(9,6) NOT NULL,
    population_served   INT NOT NULL,
    remoteness_score    DECIMAL(4,2) NOT NULL,
    storage_capacity_ml INT NOT NULL,
    has_cold_chain      BOOLEAN NOT NULL,
    origin              VARCHAR(10) NOT NULL
) ON COMMIT DROP;

-- DHIREN: database/schema.sql. DEMO: two simulated PHCs added for the reviewed-rule scenarios.
INSERT INTO demo_facility VALUES
    (1, 'WH-TN-001', 'Chennai Regional Medical Warehouse', 'Warehouse', 'Chennai', 13.082680, 80.270718, 0, 0.50, 850000, TRUE, 'DHIREN'),
    (2, 'DH-CBE-001', 'Coimbatore District Hospital', 'DistrictHospital', 'Coimbatore', 11.016844, 76.955833, 485000, 2.00, 220000, TRUE, 'DHIREN'),
    (3, 'DH-MDU-001', 'Madurai District Hospital', 'DistrictHospital', 'Madurai', 9.925201, 78.119774, 440000, 2.30, 210000, TRUE, 'DHIREN'),
    (4, 'CHC-TRY-001', 'Tiruchirappalli Community Health Centre', 'CHC', 'Tiruchirappalli', 10.790483, 78.704674, 185000, 3.10, 125000, TRUE, 'DHIREN'),
    (5, 'CHC-SLM-001', 'Salem Community Health Centre', 'CHC', 'Salem', 11.664325, 78.146011, 170000, 3.40, 115000, TRUE, 'DHIREN'),
    (6, 'PHC-VLR-001', 'Vellore Primary Health Centre', 'PHC', 'Vellore', 12.916517, 79.132500, 78000, 4.00, 62000, TRUE, 'DHIREN'),
    (7, 'PHC-TNJ-001', 'Thanjavur Primary Health Centre', 'PHC', 'Thanjavur', 10.786999, 79.137825, 69000, 4.30, 52000, FALSE, 'DHIREN'),
    (8, 'PHC-TNV-001', 'Tirunelveli Primary Health Centre', 'PHC', 'Tirunelveli', 8.713913, 77.756653, 74000, 4.80, 55000, FALSE, 'DHIREN'),
    (9, 'SC-DPI-001', 'Dharmapuri Rural SubCentre', 'SubCentre', 'Dharmapuri', 12.121099, 78.158218, 28000, 7.20, 18000, FALSE, 'DHIREN'),
    (10, 'SC-RMD-001', 'Ramanathapuram Coastal SubCentre', 'SubCentre', 'Ramanathapuram', 9.363936, 78.839481, 24000, 7.80, 16000, FALSE, 'DHIREN'),
    (11, 'PHC-KRR-001', 'Karur Primary Health Centre', 'PHC', 'Karur', 10.960100, 78.076600, 72000, 3.60, 58000, TRUE, 'DEMO'),
    (12, 'PHC-HSR-001', 'Hosur Primary Health Centre', 'PHC', 'Hosur', 12.740900, 77.825300, 86000, 1.50, 60000, TRUE, 'DEMO');

CREATE TEMP TABLE demo_medicine (
    canonical_no        INT PRIMARY KEY,
    generic_name        VARCHAR(120) NOT NULL,
    strength_value      DECIMAL(10,3) NOT NULL,
    strength_unit       VARCHAR(20) NOT NULL,
    form                VARCHAR(40) NOT NULL,
    base_unit           base_unit_enum NOT NULL,
    storage_temp_min_c  DECIMAL(4,1) NOT NULL,
    storage_temp_max_c  DECIMAL(4,1) NOT NULL,
    requires_cold_chain BOOLEAN NOT NULL,
    criticality_level   criticality_enum NOT NULL,
    shelf_life_days     INT NOT NULL
) ON COMMIT DROP;

-- Quantities are stored only in each medicine's base unit (mg, mL or count).
INSERT INTO demo_medicine VALUES
    (1, 'Paracetamol', 500.000, 'mg', 'Tablet', 'mg', 15.0, 30.0, FALSE, 'MEDIUM', 730),
    (2, 'Amoxicillin', 500.000, 'mg', 'Capsule', 'mg', 15.0, 25.0, FALSE, 'HIGH', 730),
    (3, 'Azithromycin', 500.000, 'mg', 'Tablet', 'mg', 15.0, 30.0, FALSE, 'HIGH', 730),
    (4, 'Metformin', 500.000, 'mg', 'Tablet', 'mg', 15.0, 30.0, FALSE, 'HIGH', 1095),
    (5, 'Amlodipine', 5.000, 'mg', 'Tablet', 'mg', 15.0, 30.0, FALSE, 'HIGH', 1095),
    (6, 'Oral Rehydration Salts', 20500.000, 'mg', 'Powder', 'mg', 15.0, 30.0, FALSE, 'CRITICAL', 730),
    (7, 'Human Insulin', 100.000, 'IU/mL', 'Vial', 'mL', 2.0, 8.0, TRUE, 'CRITICAL', 730),
    (8, 'Oxytocin', 10.000, 'IU/mL', 'Ampoule', 'mL', 2.0, 8.0, TRUE, 'CRITICAL', 730),
    (9, 'Rabies Vaccine', 2.500, 'IU/mL', 'Vial', 'mL', 2.0, 8.0, TRUE, 'CRITICAL', 730),
    (10, 'Adrenaline Auto-Injector', 1.000, 'mg', 'PreFilledPen', 'count', 15.0, 25.0, FALSE, 'CRITICAL', 540),
    (11, 'Salbutamol', 2.000, 'mg/5mL', 'Syrup', 'mL', 15.0, 30.0, FALSE, 'HIGH', 730),
    (12, 'Ceftriaxone', 1000.000, 'mg', 'Vial', 'mg', 15.0, 25.0, FALSE, 'CRITICAL', 730);

CREATE TEMP TABLE demo_batch (
    canonical_no        INT PRIMARY KEY,
    medicine_no         INT NOT NULL,
    batch_number        VARCHAR(40) NOT NULL UNIQUE,
    manufacture_date    DATE NOT NULL,
    expiry_date         DATE NOT NULL,
    quantity_received   DECIMAL(12,2) NOT NULL,
    supplier_name       VARCHAR(120),
    quarantined         BOOLEAN NOT NULL,
    quarantine_reason   VARCHAR(200),
    origin              VARCHAR(10) NOT NULL
) ON COMMIT DROP;

-- Two lots per medicine (Dhiren's IDs: the B02 lot has the odd ID, the B01 lot the even ID, so
-- TN-007-B01-26 is batch 14). TN-007-B03-26 is a demo insulin lot already received by two hospitals.
INSERT INTO demo_batch VALUES
    (1, 1, 'TN-001-B02-26', DATE '2026-04-25', DATE '2028-04-24', 31750000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (2, 1, 'TN-001-B01-26', DATE '2026-03-01', DATE '2028-02-29', 31750000.00, 'Chennai Essential Pharma Supply', FALSE, NULL, 'DHIREN'),
    (3, 2, 'TN-002-B02-26', DATE '2026-04-25', DATE '2028-04-24', 33500000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (4, 2, 'TN-002-B01-26', DATE '2026-03-01', DATE '2028-02-29', 33500000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (5, 3, 'TN-003-B02-26', DATE '2026-04-25', DATE '2028-04-24', 35250000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (6, 3, 'TN-003-B01-26', DATE '2026-03-01', DATE '2028-02-29', 35250000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (7, 4, 'TN-004-B02-26', DATE '2026-04-25', DATE '2029-04-24', 37000000.00, 'Chennai Essential Pharma Supply', FALSE, NULL, 'DHIREN'),
    (8, 4, 'TN-004-B01-26', DATE '2026-03-01', DATE '2029-02-28', 37000000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (9, 5, 'TN-005-B02-26', DATE '2026-04-25', DATE '2029-04-24', 38750000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (10, 5, 'TN-005-B01-26', DATE '2026-03-01', DATE '2029-02-28', 38750000.00, 'Chennai Essential Pharma Supply', FALSE, NULL, 'DHIREN'),
    (11, 6, 'TN-006-B02-26', DATE '2026-04-25', DATE '2028-04-24', 40500000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (12, 6, 'TN-006-B01-26', DATE '2026-03-01', DATE '2028-02-29', 40500000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (13, 7, 'TN-007-B02-26', DATE '2026-04-25', DATE '2028-04-24', 284000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (14, 7, 'TN-007-B01-26', DATE '2026-03-01', DATE '2028-02-29', 284000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (15, 8, 'TN-008-B02-26', DATE '2026-04-25', DATE '2028-04-24', 296000.00, 'Chennai Essential Pharma Supply', FALSE, NULL, 'DHIREN'),
    (16, 8, 'TN-008-B01-26', DATE '2026-03-01', DATE '2028-02-29', 296000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (17, 9, 'TN-009-B02-26', DATE '2026-04-25', DATE '2028-04-24', 308000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (18, 9, 'TN-009-B01-26', DATE '2026-03-01', DATE '2028-02-29', 308000.00, 'Chennai Essential Pharma Supply', TRUE, 'Simulated cold-chain temperature excursion during transport', 'DHIREN'),
    (19, 10, 'TN-010-B02-26', DATE '2026-04-25', DATE '2027-10-17', 30000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (20, 10, 'TN-010-B01-26', DATE '2026-03-01', DATE '2027-08-23', 30000.00, 'Coimbatore Regional Medical Logistics', FALSE, NULL, 'DHIREN'),
    (21, 11, 'TN-011-B02-26', DATE '2026-04-25', DATE '2028-04-24', 332000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (22, 11, 'TN-011-B01-26', DATE '2026-03-01', DATE '2028-02-29', 332000.00, 'South India Public Health Supplies', FALSE, NULL, 'DHIREN'),
    (23, 12, 'TN-012-B02-26', DATE '2026-04-25', DATE '2028-04-24', 51000000.00, 'Chennai Essential Pharma Supply', FALSE, NULL, 'DHIREN'),
    (24, 12, 'TN-012-B01-26', DATE '2026-03-01', DATE '2028-02-29', 51000000.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DHIREN'),
    (25, 7, 'TN-007-B03-26', DATE '2026-07-20', DATE '2028-07-19', 1700.00, 'Tamil Nadu Medical Services Corporation', FALSE, NULL, 'DEMO');

CREATE TEMP TABLE demo_route (
    origin_code          VARCHAR(20) NOT NULL,
    destination_code     VARCHAR(20) NOT NULL,
    distance_km          DECIMAL(8,2) NOT NULL,
    transport_time_hours DECIMAL(6,2) NOT NULL,
    cold_chain_capable   BOOLEAN NOT NULL,
    PRIMARY KEY (origin_code, destination_code)
) ON COMMIT DROP;

-- Directed routes. Dhiren's 90 rows are copied from the seeded MySQL database. Every route to or
-- from a demo PHC uses the same rule as database/schema.sql: Haversine distance, time =
-- distance / 46 + destination remoteness x 0.12, and a cold chain only when both ends have one.
-- WH-TN-001 -> PHC-HSR-001 comes out at exactly 6.00 h, the inclusive route-limit boundary.
INSERT INTO demo_route VALUES
    ('SC-RMD-001', 'WH-TN-001', 441.98, 9.67, FALSE),
    ('SC-DPI-001', 'WH-TN-001', 252.95, 5.56, FALSE),
    ('PHC-TNV-001', 'WH-TN-001', 557.94, 12.19, FALSE),
    ('PHC-TNJ-001', 'WH-TN-001', 283.46, 6.22, FALSE),
    ('PHC-VLR-001', 'WH-TN-001', 124.70, 2.77, TRUE),
    ('CHC-SLM-001', 'WH-TN-001', 279.51, 6.14, TRUE),
    ('CHC-TRY-001', 'WH-TN-001', 306.57, 6.72, TRUE),
    ('DH-MDU-001', 'WH-TN-001', 422.12, 9.24, TRUE),
    ('DH-CBE-001', 'WH-TN-001', 427.43, 9.35, TRUE),
    ('SC-RMD-001', 'DH-CBE-001', 276.18, 6.24, FALSE),
    ('SC-DPI-001', 'DH-CBE-001', 179.53, 4.14, FALSE),
    ('PHC-TNV-001', 'DH-CBE-001', 270.68, 6.12, FALSE),
    ('PHC-TNJ-001', 'DH-CBE-001', 239.61, 5.45, FALSE),
    ('PHC-VLR-001', 'DH-CBE-001', 317.29, 7.14, TRUE),
    ('CHC-SLM-001', 'DH-CBE-001', 148.39, 3.47, TRUE),
    ('CHC-TRY-001', 'DH-CBE-001', 192.60, 4.43, TRUE),
    ('DH-MDU-001', 'DH-CBE-001', 175.87, 4.06, TRUE),
    ('WH-TN-001', 'DH-CBE-001', 427.43, 9.53, TRUE),
    ('SC-RMD-001', 'DH-MDU-001', 100.60, 2.46, FALSE),
    ('SC-DPI-001', 'DH-MDU-001', 244.21, 5.58, FALSE),
    ('PHC-TNV-001', 'DH-MDU-001', 140.46, 3.33, FALSE),
    ('PHC-TNJ-001', 'DH-MDU-001', 146.91, 3.47, FALSE),
    ('PHC-VLR-001', 'DH-MDU-001', 350.45, 7.89, TRUE),
    ('CHC-SLM-001', 'DH-MDU-001', 193.40, 4.48, TRUE),
    ('CHC-TRY-001', 'DH-MDU-001', 115.54, 2.79, TRUE),
    ('DH-CBE-001', 'DH-MDU-001', 175.87, 4.10, TRUE),
    ('WH-TN-001', 'DH-MDU-001', 422.12, 9.45, TRUE),
    ('SC-RMD-001', 'CHC-TRY-001', 159.31, 3.84, FALSE),
    ('SC-DPI-001', 'CHC-TRY-001', 159.49, 3.84, FALSE),
    ('PHC-TNV-001', 'CHC-TRY-001', 253.20, 5.88, FALSE),
    ('PHC-TNJ-001', 'CHC-TRY-001', 47.31, 1.40, FALSE),
    ('PHC-VLR-001', 'CHC-TRY-001', 240.94, 5.61, TRUE),
    ('CHC-SLM-001', 'CHC-TRY-001', 114.69, 2.87, TRUE),
    ('DH-MDU-001', 'CHC-TRY-001', 115.54, 2.88, TRUE),
    ('DH-CBE-001', 'CHC-TRY-001', 192.60, 4.56, TRUE),
    ('WH-TN-001', 'CHC-TRY-001', 306.57, 7.04, TRUE),
    ('SC-RMD-001', 'CHC-SLM-001', 266.79, 6.21, FALSE),
    ('SC-DPI-001', 'CHC-SLM-001', 50.81, 1.51, FALSE),
    ('PHC-TNV-001', 'CHC-SLM-001', 330.83, 7.60, FALSE),
    ('PHC-TNJ-001', 'CHC-SLM-001', 145.67, 3.57, FALSE),
    ('PHC-VLR-001', 'CHC-SLM-001', 175.71, 4.23, TRUE),
    ('CHC-TRY-001', 'CHC-SLM-001', 114.69, 2.90, TRUE),
    ('DH-MDU-001', 'CHC-SLM-001', 193.40, 4.61, TRUE),
    ('DH-CBE-001', 'CHC-SLM-001', 148.39, 3.63, TRUE),
    ('WH-TN-001', 'CHC-SLM-001', 279.51, 6.48, TRUE),
    ('SC-RMD-001', 'PHC-VLR-001', 396.32, 9.10, FALSE),
    ('SC-DPI-001', 'PHC-VLR-001', 137.87, 3.48, FALSE),
    ('PHC-TNV-001', 'PHC-VLR-001', 490.86, 11.15, FALSE),
    ('PHC-TNJ-001', 'PHC-VLR-001', 236.79, 5.63, FALSE),
    ('CHC-SLM-001', 'PHC-VLR-001', 175.71, 4.30, TRUE),
    ('CHC-TRY-001', 'PHC-VLR-001', 240.94, 5.72, TRUE),
    ('DH-MDU-001', 'PHC-VLR-001', 350.45, 8.10, TRUE),
    ('DH-CBE-001', 'PHC-VLR-001', 317.29, 7.38, TRUE),
    ('WH-TN-001', 'PHC-VLR-001', 124.70, 3.19, TRUE),
    ('SC-RMD-001', 'PHC-TNJ-001', 161.57, 4.03, FALSE),
    ('SC-DPI-001', 'PHC-TNJ-001', 182.76, 4.49, FALSE),
    ('PHC-TNV-001', 'PHC-TNJ-001', 275.76, 6.51, FALSE),
    ('PHC-VLR-001', 'PHC-TNJ-001', 236.79, 5.66, FALSE),
    ('CHC-SLM-001', 'PHC-TNJ-001', 145.67, 3.68, FALSE),
    ('CHC-TRY-001', 'PHC-TNJ-001', 47.31, 1.54, FALSE),
    ('DH-MDU-001', 'PHC-TNJ-001', 146.91, 3.71, FALSE),
    ('DH-CBE-001', 'PHC-TNJ-001', 239.61, 5.72, FALSE),
    ('WH-TN-001', 'PHC-TNJ-001', 283.46, 6.68, FALSE),
    ('SC-RMD-001', 'PHC-TNV-001', 139.15, 3.60, FALSE),
    ('SC-DPI-001', 'PHC-TNV-001', 381.40, 8.87, FALSE),
    ('PHC-TNJ-001', 'PHC-TNV-001', 275.76, 6.57, FALSE),
    ('PHC-VLR-001', 'PHC-TNV-001', 490.86, 11.25, FALSE),
    ('CHC-SLM-001', 'PHC-TNV-001', 330.83, 7.77, FALSE),
    ('CHC-TRY-001', 'PHC-TNV-001', 253.20, 6.08, FALSE),
    ('DH-MDU-001', 'PHC-TNV-001', 140.46, 3.63, FALSE),
    ('DH-CBE-001', 'PHC-TNV-001', 270.68, 6.46, FALSE),
    ('WH-TN-001', 'PHC-TNV-001', 557.94, 12.71, FALSE),
    ('SC-RMD-001', 'SC-DPI-001', 315.49, 7.72, FALSE),
    ('PHC-TNV-001', 'SC-DPI-001', 381.40, 9.16, FALSE),
    ('PHC-TNJ-001', 'SC-DPI-001', 182.76, 4.84, FALSE),
    ('PHC-VLR-001', 'SC-DPI-001', 137.87, 3.86, FALSE),
    ('CHC-SLM-001', 'SC-DPI-001', 50.81, 1.97, FALSE),
    ('CHC-TRY-001', 'SC-DPI-001', 159.49, 4.33, FALSE),
    ('DH-MDU-001', 'SC-DPI-001', 244.21, 6.17, FALSE),
    ('DH-CBE-001', 'SC-DPI-001', 179.53, 4.77, FALSE),
    ('WH-TN-001', 'SC-DPI-001', 252.95, 6.36, FALSE),
    ('SC-DPI-001', 'SC-RMD-001', 315.49, 7.79, FALSE),
    ('PHC-TNV-001', 'SC-RMD-001', 139.15, 3.96, FALSE),
    ('PHC-TNJ-001', 'SC-RMD-001', 161.57, 4.45, FALSE),
    ('PHC-VLR-001', 'SC-RMD-001', 396.32, 9.55, FALSE),
    ('CHC-SLM-001', 'SC-RMD-001', 266.79, 6.74, FALSE),
    ('CHC-TRY-001', 'SC-RMD-001', 159.31, 4.40, FALSE),
    ('DH-MDU-001', 'SC-RMD-001', 100.60, 3.12, FALSE),
    ('DH-CBE-001', 'SC-RMD-001', 276.18, 6.94, FALSE),
    ('WH-TN-001', 'SC-RMD-001', 441.98, 10.54, FALSE),
    ('WH-TN-001', 'PHC-KRR-001', 335.62, 7.73, TRUE),
    ('PHC-KRR-001', 'WH-TN-001', 335.62, 7.36, TRUE),
    ('DH-CBE-001', 'PHC-KRR-001', 122.50, 3.10, TRUE),
    ('PHC-KRR-001', 'DH-CBE-001', 122.50, 2.90, TRUE),
    ('DH-MDU-001', 'PHC-KRR-001', 115.17, 2.94, TRUE),
    ('PHC-KRR-001', 'DH-MDU-001', 115.17, 2.78, TRUE),
    ('CHC-TRY-001', 'PHC-KRR-001', 71.13, 1.98, TRUE),
    ('PHC-KRR-001', 'CHC-TRY-001', 71.13, 1.92, TRUE),
    ('CHC-SLM-001', 'PHC-KRR-001', 78.67, 2.14, TRUE),
    ('PHC-KRR-001', 'CHC-SLM-001', 78.67, 2.12, TRUE),
    ('PHC-VLR-001', 'PHC-KRR-001', 246.01, 5.78, TRUE),
    ('PHC-KRR-001', 'PHC-VLR-001', 246.01, 5.83, TRUE),
    ('PHC-TNJ-001', 'PHC-KRR-001', 117.47, 2.99, FALSE),
    ('PHC-KRR-001', 'PHC-TNJ-001', 117.47, 3.07, FALSE),
    ('PHC-TNV-001', 'PHC-KRR-001', 252.21, 5.91, FALSE),
    ('PHC-KRR-001', 'PHC-TNV-001', 252.21, 6.06, FALSE),
    ('SC-DPI-001', 'PHC-KRR-001', 129.40, 3.25, FALSE),
    ('PHC-KRR-001', 'SC-DPI-001', 129.40, 3.68, FALSE),
    ('SC-RMD-001', 'PHC-KRR-001', 196.14, 4.70, FALSE),
    ('PHC-KRR-001', 'SC-RMD-001', 196.14, 5.20, FALSE),
    ('PHC-HSR-001', 'PHC-KRR-001', 199.90, 4.78, TRUE),
    ('PHC-KRR-001', 'PHC-HSR-001', 199.90, 4.53, TRUE),
    ('WH-TN-001', 'PHC-HSR-001', 267.75, 6.00, TRUE),
    ('PHC-HSR-001', 'WH-TN-001', 267.75, 5.88, TRUE),
    ('DH-CBE-001', 'PHC-HSR-001', 213.78, 4.83, TRUE),
    ('PHC-HSR-001', 'DH-CBE-001', 213.78, 4.89, TRUE),
    ('DH-MDU-001', 'PHC-HSR-001', 314.73, 7.02, TRUE),
    ('PHC-HSR-001', 'DH-MDU-001', 314.73, 7.12, TRUE),
    ('CHC-TRY-001', 'PHC-HSR-001', 237.06, 5.33, TRUE),
    ('PHC-HSR-001', 'CHC-TRY-001', 237.06, 5.53, TRUE),
    ('CHC-SLM-001', 'PHC-HSR-001', 124.68, 2.89, TRUE),
    ('PHC-HSR-001', 'CHC-SLM-001', 124.68, 3.12, TRUE),
    ('PHC-VLR-001', 'PHC-HSR-001', 143.06, 3.29, TRUE),
    ('PHC-HSR-001', 'PHC-VLR-001', 143.06, 3.59, TRUE),
    ('PHC-TNJ-001', 'PHC-HSR-001', 260.03, 5.83, FALSE),
    ('PHC-HSR-001', 'PHC-TNJ-001', 260.03, 6.17, FALSE),
    ('PHC-TNV-001', 'PHC-HSR-001', 447.84, 9.92, FALSE),
    ('PHC-HSR-001', 'PHC-TNV-001', 447.84, 10.31, FALSE),
    ('SC-DPI-001', 'PHC-HSR-001', 77.82, 1.87, FALSE),
    ('PHC-HSR-001', 'SC-DPI-001', 77.82, 2.56, FALSE),
    ('SC-RMD-001', 'PHC-HSR-001', 391.47, 8.69, FALSE),
    ('PHC-HSR-001', 'SC-RMD-001', 391.47, 9.45, FALSE);

CREATE TEMP TABLE demo_inventory_override (
    facility_code       VARCHAR(20) NOT NULL,
    batch_number        VARCHAR(40) NOT NULL,
    quantity_on_hand    DECIMAL(12,2) NOT NULL,
    note                VARCHAR(200) NOT NULL,
    PRIMARY KEY (facility_code, batch_number)
) ON COMMIT DROP;

-- Replaces the generated clinical stock for these rows.
INSERT INTO demo_inventory_override VALUES
    ('PHC-VLR-001', 'TN-007-B01-26', 12.00, 'Golden Vellore shortage (database/golden-scenario.sql)'),
    ('PHC-VLR-001', 'TN-007-B02-26', 22.00, 'Golden Vellore shortage (database/golden-scenario.sql)'),
    ('PHC-KRR-001', 'TN-007-B01-26', 15.00, 'Karur insulin shortage: two-donor plan'),
    ('PHC-KRR-001', 'TN-007-B02-26', 25.00, 'Karur insulin shortage: two-donor plan'),
    ('PHC-HSR-001', 'TN-007-B01-26', 120.00, 'Hosur insulin top-up: exactly six-hour warehouse route'),
    ('PHC-HSR-001', 'TN-007-B02-26', 220.00, 'Hosur insulin top-up: exactly six-hour warehouse route');

CREATE TEMP TABLE demo_inventory_extra (
    facility_code       VARCHAR(20) NOT NULL,
    batch_number        VARCHAR(40) NOT NULL,
    quantity_on_hand    DECIMAL(12,2) NOT NULL,
    status              inventory_status_enum NOT NULL,
    PRIMARY KEY (facility_code, batch_number, status)
) ON COMMIT DROP;

-- Additional stock already received (see demo_replenishment_extra).
INSERT INTO demo_inventory_extra VALUES
    ('DH-CBE-001', 'TN-007-B03-26', 800.00, 'AVAILABLE'),
    ('DH-MDU-001', 'TN-007-B03-26', 900.00, 'AVAILABLE');

CREATE TEMP TABLE demo_replenishment_override (
    facility_code         VARCHAR(20) NOT NULL,
    medicine_no           INT NOT NULL,
    expected_arrival_date DATE NOT NULL,
    status                replenishment_status_enum NOT NULL,
    note                  VARCHAR(200) NOT NULL,
    PRIMARY KEY (facility_code, medicine_no)
) ON COMMIT DROP;

-- Replaces the date and status of the generated current order for these facilities.
INSERT INTO demo_replenishment_override VALUES
    ('PHC-VLR-001', 7, DATE '2026-09-19', 'DELAYED', 'Golden Vellore shortage: current order delayed to day 8'),
    ('PHC-KRR-001', 7, DATE '2026-09-20', 'DELAYED', 'Karur: current order delayed to day 9'),
    ('PHC-HSR-001', 7, DATE '2026-09-21', 'DELAYED', 'Hosur: current order delayed to day 10');

CREATE TEMP TABLE demo_replenishment_extra (
    facility_code              VARCHAR(20) NOT NULL,
    medicine_no                INT NOT NULL,
    batch_number               VARCHAR(40) NOT NULL,
    expected_arrival_date      DATE NOT NULL,
    actual_arrival_date        DATE NOT NULL,
    quantity                   DECIMAL(12,2) NOT NULL,
    supplier_reliability_score DECIMAL(4,2) NOT NULL,
    status                     replenishment_status_enum NOT NULL,
    PRIMARY KEY (facility_code, batch_number)
) ON COMMIT DROP;

-- Deliveries that have already arrived: this stock is in inventory and is never projected again.
INSERT INTO demo_replenishment_extra VALUES
    ('DH-CBE-001', 7, 'TN-007-B03-26', DATE '2026-09-08', DATE '2026-09-08', 800.00, 0.92, 'ARRIVED'),
    ('DH-MDU-001', 7, 'TN-007-B03-26', DATE '2026-09-09', DATE '2026-09-09', 900.00, 0.90, 'ARRIVED');
-- <<< END SHARED FINAL DEMO REFERENCE DATA <<<

-- >>> BEGIN SHARED FINAL DEMO INSERTS >>>
-- Keep this section identical in database/seed-postgres.sql and
-- database/migrations/005_expand_final_demo_scenarios_postgres.sql (a test checks it).
--
-- Insert-only. Existing rows are matched on their natural keys and are never updated, so
-- stock changed by approvals, accounts, plans, transfers and audit history are left alone.
-- NOT EXISTS filters keep a rerun from consuming sequence values.

-- 1. Facilities, medicines, batches and routes.
INSERT INTO facilities (facility_code, name, facility_type, region, latitude, longitude,
                        population_served, remoteness_score, storage_capacity_ml, has_cold_chain)
SELECT d.facility_code, d.name, d.facility_type, d.region, d.latitude, d.longitude,
       d.population_served, d.remoteness_score, d.storage_capacity_ml, d.has_cold_chain
FROM demo_facility d
WHERE NOT EXISTS (SELECT 1 FROM facilities x WHERE x.facility_code = d.facility_code)
ORDER BY d.canonical_no
ON CONFLICT (facility_code) DO NOTHING;

INSERT INTO medicines (generic_name, strength_value, strength_unit, form, base_unit,
                       storage_temp_min_c, storage_temp_max_c, requires_cold_chain,
                       criticality_level, shelf_life_days)
SELECT d.generic_name, d.strength_value, d.strength_unit, d.form, d.base_unit,
       d.storage_temp_min_c, d.storage_temp_max_c, d.requires_cold_chain,
       d.criticality_level, d.shelf_life_days
FROM demo_medicine d
WHERE NOT EXISTS (
    SELECT 1 FROM medicines x
    WHERE x.generic_name = d.generic_name AND x.strength_value = d.strength_value
      AND x.strength_unit = d.strength_unit AND x.form = d.form
)
ORDER BY d.canonical_no
ON CONFLICT (generic_name, strength_value, strength_unit, form) DO NOTHING;

CREATE TEMP TABLE demo_facility_id ON COMMIT DROP AS
SELECT d.*, f.facility_id
FROM demo_facility d
JOIN facilities f ON f.facility_code = d.facility_code;

CREATE TEMP TABLE demo_medicine_id ON COMMIT DROP AS
SELECT d.*, m.medicine_id
FROM demo_medicine d
JOIN medicines m
  ON m.generic_name = d.generic_name AND m.strength_value = d.strength_value
 AND m.strength_unit = d.strength_unit AND m.form = d.form;

INSERT INTO batches (medicine_id, batch_number, manufacture_date, expiry_date,
                     quantity_received, supplier_name, quarantined, quarantine_reason)
SELECT m.medicine_id, b.batch_number, b.manufacture_date, b.expiry_date,
       b.quantity_received, b.supplier_name, b.quarantined, b.quarantine_reason
FROM demo_batch b
JOIN demo_medicine_id m ON m.canonical_no = b.medicine_no
WHERE NOT EXISTS (
    SELECT 1 FROM batches x WHERE x.medicine_id = m.medicine_id AND x.batch_number = b.batch_number
)
ORDER BY b.canonical_no;

CREATE TEMP TABLE demo_batch_id ON COMMIT DROP AS
SELECT b.*, x.batch_id
FROM demo_batch b
JOIN demo_medicine_id m ON m.canonical_no = b.medicine_no
JOIN batches x ON x.medicine_id = m.medicine_id AND x.batch_number = b.batch_number;

INSERT INTO routes (origin_facility_id, destination_facility_id, distance_km,
                    transport_time_hours, cold_chain_capable)
SELECT o.facility_id, d.facility_id, r.distance_km, r.transport_time_hours, r.cold_chain_capable
FROM demo_route r
JOIN demo_facility_id o ON o.facility_code = r.origin_code
JOIN demo_facility_id d ON d.facility_code = r.destination_code
WHERE NOT EXISTS (
    SELECT 1 FROM routes x
    WHERE x.origin_facility_id = o.facility_id AND x.destination_facility_id = d.facility_id
)
ORDER BY o.canonical_no, d.canonical_no
ON CONFLICT (origin_facility_id, destination_facility_id) DO NOTHING;

-- 2. Daily consumption, 2026-06-29 to 2026-09-11 (75 days), with Dhiren's formula: facility
-- size, medicine-specific demand, a deterministic daily variation and lower weekend use.
-- Warehouses dispatch stock rather than consume it, so they have no consumption rows.
CREATE TEMP TABLE demo_consumption ON COMMIT DROP AS
SELECT f.canonical_no AS facility_no,
       m.canonical_no AS medicine_no,
       DATE '2026-06-29' + day_offset AS consumption_date,
       ROUND(
           CASE m.base_unit
               WHEN 'mg' THEN 4500 + f.population_served * 0.018 + m.canonical_no * 525
               WHEN 'mL' THEN 20 + f.population_served * 0.00012 + m.canonical_no * 1.70
               ELSE 1 + f.population_served * 0.000018
           END
           * (0.88 + ((day_offset * 7 + f.canonical_no * 11 + m.canonical_no * 13) % 25) / 100.0)
           * CASE WHEN EXTRACT(ISODOW FROM DATE '2026-06-29' + day_offset) IN (6, 7) THEN 0.82 ELSE 1.00 END,
           CASE WHEN m.base_unit = 'count' THEN 0 ELSE 2 END
       ) AS quantity_consumed
FROM demo_facility f
CROSS JOIN demo_medicine m
CROSS JOIN generate_series(0, 74) AS day_offset
WHERE f.facility_type <> 'Warehouse';

INSERT INTO consumption (facility_id, medicine_id, consumption_date, quantity_consumed)
SELECT f.facility_id, m.medicine_id, c.consumption_date, c.quantity_consumed
FROM demo_consumption c
JOIN demo_facility_id f ON f.canonical_no = c.facility_no
JOIN demo_medicine_id m ON m.canonical_no = c.medicine_no
WHERE NOT EXISTS (
    SELECT 1 FROM consumption x
    WHERE x.facility_id = f.facility_id AND x.medicine_id = m.medicine_id
      AND x.consumption_date = c.consumption_date
)
ORDER BY c.facility_no, c.medicine_no, c.consumption_date
ON CONFLICT (facility_id, medicine_id, consumption_date) DO NOTHING;

-- Average daily consumption, kept to 4 decimals as in database/schema.sql.
CREATE TEMP TABLE demo_average ON COMMIT DROP AS
SELECT facility_no, medicine_no, ROUND(AVG(quantity_consumed), 4) AS average_daily_consumption
FROM demo_consumption
GROUP BY facility_no, medicine_no;

-- 3. Draft safety stock: coverage days grow with remoteness; pending clinical confirmation.
INSERT INTO facility_safety_stock (facility_id, medicine_id, safety_stock_qty, basis, confirmed_by_aaryan)
SELECT f.facility_id, m.medicine_id,
       ROUND(a.average_daily_consumption * (10 + CEIL(f.remoteness_score)), 2),
       'Simulated average daily consumption multiplied by ' || (10 + CEIL(f.remoteness_score))::INT
           || ' coverage days; pending clinical confirmation',
       FALSE
FROM demo_average a
JOIN demo_facility_id f ON f.canonical_no = a.facility_no
JOIN demo_medicine_id m ON m.canonical_no = a.medicine_no
WHERE NOT EXISTS (
    SELECT 1 FROM facility_safety_stock x WHERE x.facility_id = f.facility_id AND x.medicine_id = m.medicine_id
)
ORDER BY a.facility_no, a.medicine_no
ON CONFLICT (facility_id, medicine_id) DO NOTHING;

-- 4. Inventory at the end-of-day snapshot (2026-09-11 18:00). Clinical facilities hold 9 days
-- of average use in the B01 lot and 16 days in the B02 lot; the warehouse holds 18% of each lot.
CREATE TEMP TABLE demo_inventory ON COMMIT DROP AS
SELECT f.canonical_no AS facility_no, b.canonical_no AS batch_no, f.facility_id, b.batch_id,
       COALESCE(o.quantity_on_hand,
                ROUND(a.average_daily_consumption
                      * CASE WHEN b.batch_number LIKE '%-B01-26' THEN 9 ELSE 16 END, 2)) AS quantity_on_hand,
       (CASE WHEN b.quarantined THEN 'QUARANTINED'
             WHEN b.expiry_date < DATE '2026-09-11' THEN 'EXPIRED'
             ELSE 'AVAILABLE' END)::inventory_status_enum AS status
FROM demo_average a
JOIN demo_facility_id f ON f.canonical_no = a.facility_no
JOIN demo_batch_id b ON b.medicine_no = a.medicine_no AND b.origin = 'DHIREN'
LEFT JOIN demo_inventory_override o ON o.facility_code = f.facility_code AND o.batch_number = b.batch_number
UNION ALL
SELECT f.canonical_no, b.canonical_no, f.facility_id, b.batch_id,
       ROUND(b.quantity_received * 0.18, 2),
       (CASE WHEN b.quarantined THEN 'QUARANTINED'
             WHEN b.expiry_date < DATE '2026-09-11' THEN 'EXPIRED'
             ELSE 'AVAILABLE' END)::inventory_status_enum
FROM demo_facility_id f
CROSS JOIN demo_batch_id b
WHERE f.facility_type = 'Warehouse' AND b.origin = 'DHIREN'
UNION ALL
SELECT f.canonical_no, b.canonical_no, f.facility_id, b.batch_id, e.quantity_on_hand, e.status
FROM demo_inventory_extra e
JOIN demo_facility_id f ON f.facility_code = e.facility_code
JOIN demo_batch_id b ON b.batch_number = e.batch_number;

INSERT INTO inventory (facility_id, batch_id, quantity_on_hand, status, last_updated)
SELECT i.facility_id, i.batch_id, i.quantity_on_hand, i.status, TIMESTAMP '2026-09-11 18:00:00'
FROM demo_inventory i
WHERE NOT EXISTS (
    SELECT 1 FROM inventory x
    WHERE x.facility_id = i.facility_id AND x.batch_id = i.batch_id AND x.status = i.status
)
ORDER BY i.facility_no, i.batch_no
ON CONFLICT (facility_id, batch_id, status) DO NOTHING;

-- 5. Replenishments: one historical arrival (recorded against the B01 lot) and one current
-- order per clinical facility and medicine, plus the demo deliveries already received.
CREATE TEMP TABLE demo_replenishment ON COMMIT DROP AS
SELECT a.facility_no, a.medicine_no, 1 AS kind, f.facility_id, m.medicine_id, b.batch_id,
       DATE '2026-06-29' + (22 + (a.facility_no + a.medicine_no) % 19) AS expected_arrival_date,
       DATE '2026-06-29' + (22 + (a.facility_no + a.medicine_no) % 19
                            + (a.facility_no * a.medicine_no) % 4) AS actual_arrival_date,
       ROUND(a.average_daily_consumption * 28, 2) AS quantity,
       ROUND(0.78 + ((a.facility_no * 5 + a.medicine_no * 3) % 20) / 100.0, 2) AS supplier_reliability_score,
       'ARRIVED'::replenishment_status_enum AS status
FROM demo_average a
JOIN demo_facility_id f ON f.canonical_no = a.facility_no
JOIN demo_medicine_id m ON m.canonical_no = a.medicine_no
JOIN demo_batch_id b
  ON b.canonical_no = (SELECT MAX(x.canonical_no) FROM demo_batch x
                       WHERE x.medicine_no = a.medicine_no AND x.origin = 'DHIREN')
UNION ALL
SELECT a.facility_no, a.medicine_no, 2, f.facility_id, m.medicine_id, NULL::INT,
       COALESCE(o.expected_arrival_date,
                DATE '2026-09-11' + (3 + (a.facility_no + a.medicine_no) % 12)),
       NULL::DATE,
       ROUND(a.average_daily_consumption * 35, 2),
       ROUND(0.76 + ((a.facility_no * 7 + a.medicine_no * 5) % 22) / 100.0, 2),
       COALESCE(o.status,
                (CASE WHEN (a.facility_no + a.medicine_no) % 17 = 0 THEN 'CANCELLED'
                      WHEN (a.facility_no + a.medicine_no) % 7 = 0 THEN 'DELAYED'
                      ELSE 'SCHEDULED' END)::replenishment_status_enum)
FROM demo_average a
JOIN demo_facility_id f ON f.canonical_no = a.facility_no
JOIN demo_medicine_id m ON m.canonical_no = a.medicine_no
LEFT JOIN demo_replenishment_override o ON o.facility_code = f.facility_code AND o.medicine_no = a.medicine_no
UNION ALL
SELECT f.canonical_no, e.medicine_no, 3, f.facility_id, m.medicine_id, b.batch_id,
       e.expected_arrival_date, e.actual_arrival_date, e.quantity, e.supplier_reliability_score, e.status
FROM demo_replenishment_extra e
JOIN demo_facility_id f ON f.facility_code = e.facility_code
JOIN demo_medicine_id m ON m.canonical_no = e.medicine_no
JOIN demo_batch_id b ON b.batch_number = e.batch_number;

INSERT INTO replenishments (facility_id, medicine_id, batch_id, expected_arrival_date, actual_arrival_date,
                            quantity, supplier_reliability_score, status)
SELECT r.facility_id, r.medicine_id, r.batch_id, r.expected_arrival_date, r.actual_arrival_date,
       r.quantity, r.supplier_reliability_score, r.status
FROM demo_replenishment r
WHERE NOT EXISTS (
    SELECT 1 FROM replenishments x
    WHERE x.facility_id = r.facility_id AND x.medicine_id = r.medicine_id AND x.status = r.status
      AND x.expected_arrival_date = r.expected_arrival_date AND x.quantity = r.quantity
      AND x.batch_id IS NOT DISTINCT FROM r.batch_id
)
ORDER BY r.facility_no, r.medicine_no, r.kind;

-- 6. Verify that every demo row is present exactly once, then report the IDs this database uses.
DO $$
DECLARE
    insulin_id INT;
    golden_batch_id INT;
    problem TEXT;
BEGIN
    SELECT CASE
        WHEN (SELECT COUNT(*) FROM demo_facility_id) <> (SELECT COUNT(*) FROM demo_facility) THEN 'facilities'
        WHEN (SELECT COUNT(*) FROM demo_medicine_id) <> (SELECT COUNT(*) FROM demo_medicine) THEN 'medicines'
        WHEN (SELECT COUNT(*) FROM demo_batch_id) <> (SELECT COUNT(*) FROM demo_batch) THEN 'batches (missing or duplicated)'
        WHEN EXISTS (
            SELECT 1 FROM demo_route r
            JOIN demo_facility_id o ON o.facility_code = r.origin_code
            JOIN demo_facility_id d ON d.facility_code = r.destination_code
            WHERE NOT EXISTS (SELECT 1 FROM routes x WHERE x.origin_facility_id = o.facility_id
                                                     AND x.destination_facility_id = d.facility_id)) THEN 'routes'
        WHEN EXISTS (
            SELECT 1 FROM demo_consumption c
            JOIN demo_facility_id f ON f.canonical_no = c.facility_no
            JOIN demo_medicine_id m ON m.canonical_no = c.medicine_no
            WHERE NOT EXISTS (SELECT 1 FROM consumption x WHERE x.facility_id = f.facility_id
                                                          AND x.medicine_id = m.medicine_id
                                                          AND x.consumption_date = c.consumption_date)) THEN 'consumption'
        WHEN EXISTS (
            SELECT 1 FROM demo_average a
            JOIN demo_facility_id f ON f.canonical_no = a.facility_no
            JOIN demo_medicine_id m ON m.canonical_no = a.medicine_no
            WHERE NOT EXISTS (SELECT 1 FROM facility_safety_stock x WHERE x.facility_id = f.facility_id
                                                                    AND x.medicine_id = m.medicine_id)) THEN 'safety stock'
        WHEN EXISTS (
            SELECT 1 FROM demo_inventory i
            WHERE NOT EXISTS (SELECT 1 FROM inventory x WHERE x.facility_id = i.facility_id
                                                        AND x.batch_id = i.batch_id AND x.status = i.status)) THEN 'inventory'
        WHEN EXISTS (
            SELECT 1 FROM demo_replenishment r
            WHERE (SELECT COUNT(*) FROM replenishments x
                   WHERE x.facility_id = r.facility_id AND x.medicine_id = r.medicine_id AND x.status = r.status
                     AND x.expected_arrival_date = r.expected_arrival_date AND x.quantity = r.quantity
                     AND x.batch_id IS NOT DISTINCT FROM r.batch_id) <> 1) THEN 'replenishments (missing or duplicated)'
    END INTO problem;
    IF problem IS NOT NULL THEN
        RAISE EXCEPTION 'MEDRIPPLE final demo dataset is incomplete: %', problem;
    END IF;

    SELECT medicine_id INTO insulin_id FROM demo_medicine_id WHERE canonical_no = 7;
    SELECT batch_id INTO golden_batch_id FROM demo_batch_id WHERE batch_number = 'TN-007-B01-26';
    RAISE NOTICE 'MEDRIPPLE final demo dataset present: Human Insulin medicine_id %, TN-007-B01-26 batch_id % (a fresh install uses 7 and 14).',
        insulin_id, golden_batch_id;
END
$$;
-- <<< END SHARED FINAL DEMO INSERTS <<<

COMMIT;
