-- =====================================================================
-- Read-only checks for migration 005 (PostgreSQL). Run before and after
-- database/migrations/005_expand_final_demo_scenarios_postgres.sql and
-- compare the two outputs (docs/release-checklist.md lists the expected
-- results):
--   psql "<connection>" -v ON_ERROR_STOP=1 -X -f database/verify-005-postgres.sql
--
-- Everything runs in one READ ONLY transaction that is rolled back, so the
-- script cannot change the database. It prints no credentials or password
-- hashes: account, plan, transfer and audit rows are summarised as counts
-- and MD5 digests only.
-- =====================================================================

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

\echo '1. Server, database and session time zone (TIMESTAMP columns hold UTC; expect UTC)'
SELECT current_database() AS database, current_setting('server_version') AS server_version,
       current_setting('TimeZone') AS session_time_zone,
       (SELECT reset_val FROM pg_settings WHERE name = 'TimeZone') AS default_time_zone;

\echo '2. Row counts'
SELECT 'facilities' AS table_name, COUNT(*) AS row_count FROM facilities
UNION ALL SELECT 'medicines', COUNT(*) FROM medicines
UNION ALL SELECT 'batches', COUNT(*) FROM batches
UNION ALL SELECT 'inventory', COUNT(*) FROM inventory
UNION ALL SELECT 'consumption', COUNT(*) FROM consumption
UNION ALL SELECT 'replenishments', COUNT(*) FROM replenishments
UNION ALL SELECT 'routes', COUNT(*) FROM routes
UNION ALL SELECT 'facility_safety_stock', COUNT(*) FROM facility_safety_stock
UNION ALL SELECT 'app_users', COUNT(*) FROM app_users
UNION ALL SELECT 'plans', COUNT(*) FROM plans
UNION ALL SELECT 'transfers', COUNT(*) FROM transfers
UNION ALL SELECT 'audit_events', COUNT(*) FROM audit_events
ORDER BY table_name;

\echo '3. Tables migration 005 must not change (digests must be identical before and after)'
SELECT 'app_users' AS table_name, COUNT(*) AS row_count, md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), '')) AS digest FROM app_users t
UNION ALL SELECT 'plans', COUNT(*), md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), '')) FROM plans t
UNION ALL SELECT 'transfers', COUNT(*), md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), '')) FROM transfers t
UNION ALL SELECT 'audit_events', COUNT(*), md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), '')) FROM audit_events t
ORDER BY table_name;

\echo '4. Rows that existed before the migration (compare each digest before and after)'
SELECT 'facilities' AS table_name, md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), '')) AS digest
FROM facilities t WHERE facility_code IN ('WH-CENTRAL-001', 'DH-CENTRAL-001', 'CHC-RIVER-001', 'PHC-NAV-001')
UNION ALL
SELECT 'inventory of those facilities', md5(COALESCE(string_agg(t::TEXT, '|' ORDER BY t::TEXT), ''))
FROM inventory t JOIN facilities f ON f.facility_id = t.facility_id
WHERE f.facility_code IN ('WH-CENTRAL-001', 'DH-CENTRAL-001', 'CHC-RIVER-001', 'PHC-NAV-001');

\echo '5. Final demo facilities (after: 12 rows, each code once)'
SELECT facility_code, facility_type, has_cold_chain, COUNT(*) OVER (PARTITION BY facility_code) AS copies
FROM facilities
WHERE facility_code IN ('WH-TN-001', 'DH-CBE-001', 'DH-MDU-001', 'CHC-TRY-001', 'CHC-SLM-001', 'PHC-VLR-001',
                        'PHC-TNJ-001', 'PHC-TNV-001', 'SC-DPI-001', 'SC-RMD-001', 'PHC-KRR-001', 'PHC-HSR-001')
ORDER BY facility_code;

\echo '6. Duplicate natural keys (expect no rows)'
SELECT 'facility' AS kind, facility_code AS natural_key, COUNT(*) AS copies FROM facilities GROUP BY facility_code HAVING COUNT(*) > 1
UNION ALL
SELECT 'medicine', CONCAT_WS(' ', generic_name, strength_value, strength_unit, form), COUNT(*)
FROM medicines GROUP BY generic_name, strength_value, strength_unit, form HAVING COUNT(*) > 1
UNION ALL
SELECT 'batch', CONCAT_WS(' ', medicine_id, batch_number), COUNT(*) FROM batches GROUP BY medicine_id, batch_number HAVING COUNT(*) > 1
UNION ALL
SELECT 'route', CONCAT_WS(' ', origin_facility_id, destination_facility_id), COUNT(*)
FROM routes GROUP BY origin_facility_id, destination_facility_id HAVING COUNT(*) > 1;

\echo '7. IDs this database uses for the release scenarios (record them; the API also accepts med-insulin-100iu-vial)'
SELECT m.medicine_id AS insulin_medicine_id, m.criticality_level, b.batch_number, b.batch_id
FROM medicines m JOIN batches b ON b.medicine_id = m.medicine_id
WHERE m.generic_name = 'Human Insulin' AND b.batch_number IN ('TN-007-B01-26', 'TN-007-B03-26')
ORDER BY b.batch_number;

\echo '8. Scenario routes'
SELECT o.facility_code AS origin, d.facility_code AS destination, r.distance_km, r.transport_time_hours, r.cold_chain_capable
FROM routes r
JOIN facilities o ON o.facility_id = r.origin_facility_id
JOIN facilities d ON d.facility_id = r.destination_facility_id
WHERE (o.facility_code, d.facility_code) IN (('WH-TN-001', 'PHC-VLR-001'), ('DH-CBE-001', 'PHC-KRR-001'), ('DH-MDU-001', 'PHC-KRR-001'),
                                             ('WH-TN-001', 'PHC-KRR-001'), ('WH-TN-001', 'PHC-HSR-001'), ('PHC-TNJ-001', 'PHC-KRR-001'))
ORDER BY origin, destination;

\echo '9. Routes to and from Karur and Hosur (expect 42)'
SELECT COUNT(*) AS karur_hosur_routes
FROM routes r
JOIN facilities o ON o.facility_id = r.origin_facility_id
JOIN facilities d ON d.facility_id = r.destination_facility_id
WHERE o.facility_code IN ('PHC-KRR-001', 'PHC-HSR-001') OR d.facility_code IN ('PHC-KRR-001', 'PHC-HSR-001');

\echo '10. Insulin at the scenario facilities on 2026-09-11 (usable stock and the next open order)'
SELECT f.facility_code,
       (SELECT COALESCE(SUM(i.quantity_on_hand), 0) FROM inventory i JOIN batches b ON b.batch_id = i.batch_id
        WHERE i.facility_id = f.facility_id AND b.medicine_id = m.medicine_id AND i.status = 'AVAILABLE'
          AND b.quarantined = FALSE AND b.expiry_date >= DATE '2026-09-11') AS usable_stock,
       (SELECT CONCAT_WS(' ', r.status, r.expected_arrival_date, r.quantity) FROM replenishments r
        WHERE r.facility_id = f.facility_id AND r.medicine_id = m.medicine_id AND r.status IN ('SCHEDULED', 'DELAYED')
          AND r.expected_arrival_date >= DATE '2026-09-11'
        ORDER BY r.expected_arrival_date LIMIT 1) AS next_open_order
FROM facilities f
CROSS JOIN (SELECT medicine_id FROM medicines WHERE generic_name = 'Human Insulin' ORDER BY medicine_id LIMIT 1) m
WHERE f.facility_code IN ('PHC-VLR-001', 'PHC-KRR-001', 'PHC-HSR-001', 'DH-CBE-001', 'DH-MDU-001')
ORDER BY f.facility_code;

ROLLBACK;
