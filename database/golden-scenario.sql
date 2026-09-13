USE medripple;

-- Deterministic MEDRIPPLE golden flow. Vellore PHC has less than one day of
-- simulated insulin coverage while its replenishment is delayed to day 8.
SET @scenario_date = DATE('2026-09-11');
SET @insulin_id = (
  SELECT medicine_id FROM medicines
  WHERE generic_name = 'Human Insulin' AND strength_value = 100 AND form = 'Vial'
  LIMIT 1
);
SET @vellore_phc_id = (
  SELECT facility_id FROM facilities WHERE facility_code = 'PHC-VLR-001' LIMIT 1
);

UPDATE inventory i
JOIN batches b ON b.batch_id = i.batch_id
SET i.quantity_on_hand = CASE
  WHEN b.batch_number LIKE '%-B01-26' THEN 12
  ELSE 22
END,
    i.status = 'AVAILABLE'
WHERE i.facility_id = @vellore_phc_id
  AND b.medicine_id = @insulin_id;

UPDATE replenishments
SET expected_arrival_date = DATE_ADD(@scenario_date, INTERVAL 8 DAY),
    actual_arrival_date = NULL,
    status = 'DELAYED'
WHERE facility_id = @vellore_phc_id
  AND medicine_id = @insulin_id
  AND expected_arrival_date >= @scenario_date;

