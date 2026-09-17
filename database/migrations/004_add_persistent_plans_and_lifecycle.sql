-- Production plan persistence, lifecycle, and audit linkage.
-- Safe for both a fresh schema.sql bootstrap and an existing MEDRIPPLE volume.
USE medripple;

CREATE TABLE IF NOT EXISTS plans (
    plan_id                VARCHAR(64) PRIMARY KEY,
    destination_facility_id INT NOT NULL,
    medicine_id            INT NOT NULL,
    requested_quantity     DECIMAL(12,2) NOT NULL,
    horizon_days           TINYINT UNSIGNED NOT NULL,
    status                 ENUM('PROPOSED','APPROVED','RESERVED','IN_TRANSIT','DELIVERED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PROPOSED',
    rationale              TEXT NOT NULL,
    plan_json              JSON NOT NULL,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    decided_at             TIMESTAMP NULL,
    decided_by             VARCHAR(120),
    CONSTRAINT chk_plan_quantity_positive CHECK (requested_quantity > 0),
    CONSTRAINT chk_plan_horizon CHECK (horizon_days IN (7, 14, 30)),
    CONSTRAINT fk_plan_destination FOREIGN KEY (destination_facility_id) REFERENCES facilities(facility_id),
    CONSTRAINT fk_plan_medicine FOREIGN KEY (medicine_id) REFERENCES medicines(medicine_id),
    INDEX idx_plans_status_created (status, created_at)
);

ALTER TABLE inventory
  MODIFY status ENUM('AVAILABLE','RESERVED','IN_TRANSIT','QUARANTINED','EXPIRED')
  NOT NULL DEFAULT 'AVAILABLE';

SELECT COUNT(*) INTO @has_inventory_status_key
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'inventory'
  AND index_name = 'uq_inventory_facility_batch_status';
SET @add_inventory_status_key = IF(
  @has_inventory_status_key = 0,
  'ALTER TABLE inventory ADD UNIQUE KEY uq_inventory_facility_batch_status (facility_id, batch_id, status)',
  'SELECT 1'
);
PREPARE add_inventory_status_key_statement FROM @add_inventory_status_key;
EXECUTE add_inventory_status_key_statement;
DEALLOCATE PREPARE add_inventory_status_key_statement;

ALTER TABLE transfers
  MODIFY status ENUM('PROPOSED','REJECTED_UNSAFE','REJECTED','APPROVED','RESERVED','IN_TRANSIT','DELIVERED','CANCELLED','COMPLETED')
  NOT NULL DEFAULT 'PROPOSED';

-- Preserve legacy completed transfer history under the final lifecycle name.
UPDATE transfers SET status = 'DELIVERED' WHERE status = 'COMPLETED';

ALTER TABLE transfers
  MODIFY status ENUM('PROPOSED','REJECTED_UNSAFE','REJECTED','APPROVED','RESERVED','IN_TRANSIT','DELIVERED','CANCELLED')
  NOT NULL DEFAULT 'PROPOSED';

ALTER TABLE audit_events
  MODIFY entity_id VARCHAR(64) NOT NULL;

SELECT COUNT(*) INTO @has_plan_id
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'transfers' AND column_name = 'plan_id';
SET @add_plan_id = IF(
  @has_plan_id = 0,
  'ALTER TABLE transfers ADD COLUMN plan_id VARCHAR(64) NULL AFTER transfer_id',
  'SELECT 1'
);
PREPARE add_plan_id_statement FROM @add_plan_id;
EXECUTE add_plan_id_statement;
DEALLOCATE PREPARE add_plan_id_statement;

SELECT COUNT(*) INTO @has_dispatch_columns
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'transfers' AND column_name = 'dispatched_at';
SET @add_dispatch_columns = IF(
  @has_dispatch_columns = 0,
  'ALTER TABLE transfers ADD COLUMN dispatched_at TIMESTAMP NULL AFTER approved_at, ADD COLUMN delivered_at TIMESTAMP NULL AFTER dispatched_at, ADD COLUMN cancelled_at TIMESTAMP NULL AFTER delivered_at',
  'SELECT 1'
);
PREPARE add_dispatch_columns_statement FROM @add_dispatch_columns;
EXECUTE add_dispatch_columns_statement;
DEALLOCATE PREPARE add_dispatch_columns_statement;

-- Legacy transfers were created before optimiser plans were persisted. Give
-- each one a deterministic, explicitly simulated historical plan. This only
-- links existing history: it does not reserve inventory or create approvals.
INSERT INTO plans (
  plan_id, destination_facility_id, medicine_id, requested_quantity,
  horizon_days, status, rationale, plan_json, created_at, decided_at, decided_by
)
SELECT
  CONCAT('simulated-history-transfer-', LPAD(t.transfer_id, 10, '0')),
  t.destination_facility_id,
  t.medicine_id,
  t.quantity,
  14,
  CASE
    WHEN t.status IN ('REJECTED_UNSAFE', 'REJECTED') THEN 'REJECTED'
    ELSE t.status
  END,
  CONCAT(
    'Simulated historical record backfilled from legacy transfer ',
    t.transfer_id,
    ': ',
    COALESCE(t.note, 'No legacy note recorded.')
  ),
  JSON_OBJECT(
    'id', CONCAT('simulated-history-transfer-', LPAD(t.transfer_id, 10, '0')),
    'simulatedHistoricalRecord', TRUE,
    'source', 'MYSQL_LIFECYCLE_MIGRATION',
    'sourceTransferId', t.transfer_id,
    'destinationFacilityId', t.destination_facility_id,
    'medicineId', t.medicine_id,
    'requestedQuantity', t.quantity,
    'horizonDays', 14,
    'status', CASE WHEN t.status IN ('REJECTED_UNSAFE', 'REJECTED') THEN 'REJECTED' ELSE t.status END,
    'note', t.note
  ),
  t.requested_at,
  CASE WHEN t.status = 'PROPOSED' THEN NULL ELSE COALESCE(t.approved_at, t.requested_at) END,
  CASE
    WHEN t.status = 'PROPOSED' THEN NULL
    ELSE COALESCE(t.approved_by, 'MEDRIPPLE Feasibility Engine')
  END
FROM transfers t
WHERE t.plan_id IS NULL
ON DUPLICATE KEY UPDATE plan_id = VALUES(plan_id);

UPDATE transfers
SET plan_id = CONCAT('simulated-history-transfer-', LPAD(transfer_id, 10, '0'))
WHERE plan_id IS NULL;

ALTER TABLE transfers
  MODIFY plan_id VARCHAR(64) NOT NULL;

SELECT COUNT(*) INTO @has_plan_fk
FROM information_schema.table_constraints
WHERE table_schema = DATABASE() AND table_name = 'transfers'
  AND constraint_type = 'FOREIGN KEY' AND constraint_name = 'fk_tr_plan';
SET @add_plan_fk = IF(
  @has_plan_fk = 0,
  'ALTER TABLE transfers ADD CONSTRAINT fk_tr_plan FOREIGN KEY (plan_id) REFERENCES plans(plan_id)',
  'SELECT 1'
);
PREPARE add_plan_fk_statement FROM @add_plan_fk;
EXECUTE add_plan_fk_statement;
DEALLOCATE PREPARE add_plan_fk_statement;
