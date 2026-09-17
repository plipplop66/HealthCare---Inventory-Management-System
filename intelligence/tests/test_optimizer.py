"""Transfer optimizer scenarios on in-memory MySQL rows, the offline fixture and the CP-SAT model: no Docker, MySQL or network.

Expected numbers are hand-calculated from tests/optimizer_support.py and tests/simulator_support.py.
"""

from datetime import date

import pytest
from fastapi.testclient import TestClient

from app import optimizer as optimizer_module
from app.allocation_solver import DonorInput, DonorOption, RecipientInput, solve_allocation
from app.data_store import Facility, SimulatedDataStore
from app.main import create_app
from app.mysql_store import MySQLDataSource
from app.optimizer import OptimizerConfig
from tests.optimizer_support import (
    candidate,
    details,
    multi_source_tables,
    no_warehouse_route_tables,
    optimize,
    optimizer_client,
    replace_facility_rows,
    routes_without,
    split_batch_tables,
    with_batch_ids,
)
from tests.simulator_support import (
    ADRENALINE,
    FACILITY_ROWS,
    INSULIN,
    INVENTORY_ROWS,
    PHC,
    ROUTE_ROWS,
    SETTINGS,
    SUBCENTRE,
    WAREHOUSE,
    FakeDatabase,
    facility,
    facility_row,
    inventory_row,
    route_row,
    simulate,
    transfer,
)

FIXTURE_INSULIN = "med-insulin-100iu-vial"


@pytest.fixture()
def client():
    return optimizer_client()[0]


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def total(body):
    return round(sum(item["quantity"] for item in body["transfers"]), 2)


def summary(body):
    return [(item["fromFacilityId"], item["batchId"], item["batchNo"], item["quantity"]) for item in body["transfers"]]


# ---- Safe plans ----


def test_critical_phc_receives_a_safe_warehouse_plan(client):
    body = ok(optimize(client, "PHC-SIM-001", 600))
    assert (body["status"], body["requestedQuantity"], body["allocatedQuantity"], body["unit"]) == ("PROPOSED", 600.0, 600.0, "mL")
    assert body["transfers"] == [{
        "fromFacilityId": "WH-SIM-001", "fromFacilityName": "Sim Regional Warehouse", "toFacilityId": "PHC-SIM-001",
        "toFacilityName": "Sim Primary Health Centre", "medicineId": "7", "batchId": 14, "batchNo": "SIM-007-B02",
        "expiryDate": "2028-04-24", "quantity": 600.0, "unit": "mL", "departureDay": 1, "arrivalDay": 1, "arrivalDate": "2026-09-12",
        "distanceKm": 210.25, "travelHours": 5.1, "coldChainAvailable": True,
    }]
    solver = body["solver"]
    assert (solver["name"], solver["algorithm"], solver["status"], solver["quantityScale"], solver["objectiveValue"]) == ("OR-Tools", "CP-SAT", "OPTIMAL", 100, 0)
    recipient = body["recipient"]
    assert (recipient["stockoutDayBefore"], recipient["stockoutDayAfter"], recipient["stockoutPrevented"], recipient["quantityToAvoidShortage"]) == (1, None, True, 250.0)
    warehouse = candidate(body, "WH-SIM-001")
    assert (warehouse["status"], warehouse["safeCapacity"], warehouse["operationalReserve"], warehouse["retainedFloor"]) == ("SELECTED", 4500.0, 500.0, 500.0)
    assert body["simulation"]["comparison"]["safeToRecommend"] is True
    assert body["validation"]["passed"] is True and all(check["passed"] for check in body["validation"]["checks"])
    assert (body["decisionSupportOnly"], body["requiresHumanApproval"]) == (True, True)
    assert "avoids the stockout projected on day 1" in body["rationale"]


def test_multi_source_plan_when_one_donor_is_not_enough():
    client, _ = optimizer_client(**multi_source_tables())
    body = ok(optimize(client, "PHC-SIM-001", 800))
    assert summary(body) == [("DH-SIM-001", 13, "SIM-007-B01", 170.0), ("WH-SIM-001", 14, "SIM-007-B02", 630.0)]
    assert (candidate(body, "WH-SIM-001")["safeCapacity"], candidate(body, "DH-SIM-001")["safeCapacity"]) == (630.0, 188.5)
    # The warehouse keeps the least equity-weighted headroom cost, so it is used to its full safe capacity first.
    assert (candidate(body, "WH-SIM-001")["allocatedQuantity"], candidate(body, "DH-SIM-001")["retainedFloor"]) == (630.0, 111.5)
    assert total(body) == 800.0 and body["simulation"]["comparison"]["safeToRecommend"] is True
    assert "from 2 donors" in body["rationale"]


def test_unsafe_hospital_donor_is_excluded_even_with_visible_surplus(client):
    body = ok(optimize(client, "PHC-SIM-001", 600))
    hospital = candidate(body, "DH-SIM-001")
    assert (hospital["status"], hospital["rejectionCodes"], hospital["safeCapacity"]) == ("REJECTED", ["NO_SAFE_DONOR_CAPACITY"], 0.0)
    assert (hospital["effectiveStock"], hospital["protectedStock"], hospital["retainedFloor"]) == (1000.0, 700.0, 780.5)
    reason = hospital["rejectionReasons"][0]
    # Its 700 mL delivery on day 7 is not counted, so its stock falls to 300 mL by day 14.
    assert "lowest projected stock from day 1 is 300 mL on day 14" in reason
    assert "700 mL scheduled for day 7" in reason and "not counted toward donor capacity" in reason
    assert "Effective stock minus protected stock (300 mL) is not a safe capacity" in reason
    # The simulator agrees that sending that visible surplus would breach protected stock.
    assert simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 300)).json()["transferEvaluations"][0]["rejectionCodes"] == ["BELOW_PROTECTED_STOCK"]


def test_rural_subcentre_is_protected_by_the_equity_reserve():
    client, _ = optimizer_client(**no_warehouse_route_tables())
    info = details(optimize(client, "PHC-SIM-001", 50))
    assert (info["safeCapacity"], info["unmetQuantity"], info["solverStatus"]) == (1.63, 48.37, "INFEASIBLE")
    [subcentre] = info["eligibleCandidates"]
    assert (subcentre["facilityId"], subcentre["protectedStock"], subcentre["equityUplift"]) == ("SC-SIM-001", 147.0, 0.71)
    assert (subcentre["equityReserve"], subcentre["retainedFloor"], subcentre["safeCapacity"]) == (104.37, 251.37, 1.63)
    # Protected stock alone would allow 50 mL: the equity reserve is the stricter optimizer guardrail.
    assert simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 50)).json()["transferEvaluations"][0]["eligible"] is True
    body = ok(optimize(client, "PHC-SIM-001", 1.5))
    assert summary(body) == [("SC-SIM-001", 14, "SIM-007-B02", 1.5)]
    assert body["recipient"]["stockoutPrevented"] is False and "still runs short" in body["rationale"]


def test_remote_facilities_retain_more_than_warehouses_and_urban_hospitals():
    config = OptimizerConfig()
    uplift = lambda facility_type, remoteness: config.equity_uplift(Facility("F", "F", facility_type, "R", remoteness, None))  # noqa: E731
    assert uplift("Warehouse", 0.05) == 0.025
    assert uplift("DistrictHospital", 0.2) == uplift("DISTRICT_HOSPITAL", 0.2) == 0.1
    assert uplift("PHC", 0.4) == 0.45 and uplift("SubCentre", 0.72) == 0.71
    assert uplift("Clinic", 0.4) == 0.45  # unknown types are treated like a PHC
    assert uplift("SubCentre", 0.72) > uplift("PHC", 0.4) > uplift("DistrictHospital", 0.2) > uplift("Warehouse", 0.05)
    with pytest.raises(ValueError):
        OptimizerConfig(remoteness_weight=-0.1)
    with pytest.raises(ValueError):
        OptimizerConfig(warehouse_operational_reserve_share=1.0)


# ---- Hard candidate filters ----


def test_cold_chain_donor_and_destination_are_rejected(client):
    body = ok(optimize(client, "PHC-SIM-001", 600))
    chc = candidate(body, "CHC-SIM-001")
    assert "COLD_CHAIN_UNAVAILABLE" in chc["rejectionCodes"] and "not cold-chain capable" in chc["rejectionReasons"][0]
    info = details(optimize(client, "CHC-SIM-001", 10))
    assert info["safeCapacity"] == 0.0 and not info["eligibleCandidates"]
    assert "no cold-chain storage" in info["recommendedEscalation"][0]


def test_missing_route_is_rejected():
    client, _ = optimizer_client(**no_warehouse_route_tables())
    info = details(optimize(client, "PHC-SIM-001", 50))
    warehouse = next(item for item in info["rejectedCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert (warehouse["rejectionCodes"], warehouse["distanceKm"], warehouse["earliestArrivalDay"]) == (["ROUTE_NOT_FOUND"], None, None)
    assert "No transport route exists" in warehouse["rejectionReasons"][0]


@pytest.mark.parametrize(
    "unusable",
    [
        {"status": "EXPIRED", "expiry": date(2026, 9, 1)},
        {"status": "AVAILABLE", "expiry": date(2026, 9, 10)},
        {"quarantined": 1},
        {"status": "RESERVED"},
    ],
    ids=["expired-status", "expired-date", "quarantined", "reserved"],
)
def test_expired_quarantined_and_reserved_stock_is_never_counted_or_sent(unusable):
    rows = replace_facility_rows(
        INVENTORY_ROWS, WAREHOUSE, INSULIN,
        inventory_row(WAREHOUSE, INSULIN, "SIM-007-B07", "4000.00", **unusable),
        inventory_row(WAREHOUSE, INSULIN, "SIM-007-B02", "1000.00"),
    )
    client, _ = optimizer_client(inventory=rows)
    info = details(optimize(client, "PHC-SIM-001", 950))
    # Only the warehouse counts: the subcentre's route is over the 6-hour limit.
    assert info["safeCapacity"] == 900.0
    warehouse = next(item for item in info["eligibleCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert (warehouse["effectiveStock"], warehouse["safeCapacity"]) == (1000.0, 900.0)
    body = ok(optimize(client, "PHC-SIM-001", 900))
    assert summary(body) == [("WH-SIM-001", 14, "SIM-007-B02", 900.0)]


def test_batches_expiring_before_the_horizon_end_are_not_sent():
    rows = replace_facility_rows(
        INVENTORY_ROWS, WAREHOUSE, INSULIN,
        inventory_row(WAREHOUSE, INSULIN, "SIM-007-B06", "3000.00", expiry=date(2026, 9, 20)),
        inventory_row(WAREHOUSE, INSULIN, "SIM-007-B02", "1000.00"),
    )
    rows = replace_facility_rows(rows, SUBCENTRE, INSULIN, inventory_row(SUBCENTRE, INSULIN, "SIM-007-B06", "400.00", expiry=date(2026, 9, 20)))
    client, _ = optimizer_client(inventory=rows)
    body = ok(optimize(client, "PHC-SIM-001", 600))
    # FEFO picks the earliest expiry that stays in date until 2026-09-25, not the batch expiring on 2026-09-20.
    assert summary(body) == [("WH-SIM-001", 14, "SIM-007-B02", 600.0)]
    assert (candidate(body, "WH-SIM-001")["lastingBatchQuantity"], candidate(body, "WH-SIM-001")["safeCapacity"]) == (1000.0, 1000.0)
    assert "BATCH_EXPIRES_BEFORE_USE" in candidate(body, "SC-SIM-001")["rejectionCodes"]


def test_delivery_that_cannot_arrive_before_the_recipient_stockout_is_rejected():
    routes = routes_without(WAREHOUSE, PHC) + [route_row(WAREHOUSE, PHC, "1300.00", "30.00", True)]
    # A 48-hour limit keeps this 30-hour route inside the cap so the arrival-day rule is what rejects it.
    client, _ = optimizer_client(config=OptimizerConfig(max_travel_hours=48), routes=routes)
    info = details(optimize(client, "PHC-SIM-001", 600))
    warehouse = next(item for item in info["rejectedCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert warehouse["rejectionCodes"] == ["ARRIVES_AFTER_RECIPIENT_STOCKOUT"] and warehouse["earliestArrivalDay"] == 2


def test_long_route_sets_departure_and_arrival_days(client):
    # The only route to SC-SIM-001 takes 30 hours, over the default 6-hour cap, so there is no plan.
    info = details(optimize(client, "SC-SIM-001", 10))
    warehouse = next(item for item in info["rejectedCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert warehouse["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    # With a 48-hour limit the day arithmetic is unchanged: it leaves on day 1 and arrives on day 2.
    longer, _ = optimizer_client(config=OptimizerConfig(max_travel_hours=48))
    [item] = ok(optimize(longer, "SC-SIM-001", 10))["transfers"]
    assert (item["fromFacilityId"], item["departureDay"], item["arrivalDay"], item["arrivalDate"]) == ("WH-SIM-001", 1, 2, "2026-09-13")


# ---- Batches and quantities ----


def test_fefo_batch_is_chosen_first():
    client, _ = optimizer_client(**split_batch_tables())
    assert summary(ok(optimize(client, "PHC-SIM-001", 150))) == [("WH-SIM-001", 13, "SIM-007-B01", 150.0)]


def test_allocation_is_split_across_batches_with_decimals_preserved():
    client, _ = optimizer_client(**split_batch_tables())
    body = ok(optimize(client, "PHC-SIM-001", 600.25))
    assert summary(body) == [("WH-SIM-001", 13, "SIM-007-B01", 200.5), ("WH-SIM-001", 14, "SIM-007-B02", 399.75)]
    assert {(item["departureDay"], item["arrivalDay"]) for item in body["transfers"]} == {(1, 1)}
    assert (body["requestedQuantity"], body["allocatedQuantity"], total(body), body["solver"]["quantityScale"]) == (600.25, 600.25, 600.25, 100)
    assert [item["batches"] for item in body["simulation"]["transferEvaluations"]] == [
        [{"batchId": 13, "batchNo": "SIM-007-B01", "quantity": 200.5, "expiryDate": "2028-02-29"}],
        [{"batchId": 14, "batchNo": "SIM-007-B02", "quantity": 399.75, "expiryDate": "2028-04-24"}],
    ]


@pytest.mark.parametrize("quantity", [0.01, 250, 4500])
def test_exact_requested_quantity_is_supplied(client, quantity):
    body = ok(optimize(client, "PHC-SIM-001", quantity))
    assert body["requestedQuantity"] == body["allocatedQuantity"] == total(body) == quantity
    assert facility(body["simulation"]["intervention"], "PHC-SIM-001")["transferIn"] == quantity


@pytest.mark.parametrize(
    "medicine, quantity, unit, batch",
    [("1", 20000.5, "mg", (2, "SIM-001-B02")), ("7", 600, "mL", (14, "SIM-007-B02")), ("10", 5, "count", (20, "SIM-010-B02"))],
)
def test_every_base_unit_is_kept(client, medicine, quantity, unit, batch):
    body = ok(optimize(client, "PHC-SIM-001", quantity, medicine=medicine))
    assert (body["unit"], body["medicine"]["unit"], body["dataContext"]["unit"]) == (unit, unit, unit)
    assert summary(body) == [("WH-SIM-001", *batch, float(quantity))]
    assert f" {unit}s" not in body["rationale"]


def test_count_medicines_move_in_whole_units(client):
    response = optimize(client, "PHC-SIM-001", 2.5, medicine="10")
    assert (response.status_code, response.json()["error"]["code"]) == (422, "INVALID_QUANTITY_FOR_UNIT")
    info = details(optimize(client, "PHC-SIM-001", 271, medicine="10"))
    # Hospital capacity 0.78 of a pen rounds down to 0; the warehouse keeps 30 of 300.
    assert info["safeCapacity"] == 270.0
    assert next(item for item in info["rejectedCandidates"] if item["facilityId"] == "DH-SIM-001")["rejectionCodes"] == ["NO_SAFE_DONOR_CAPACITY"]


@pytest.mark.parametrize("horizon, shortage_days, needed", [(7, 7, 250.0), (14, 7, 250.0), (30, 15, 570.0)])
def test_every_horizon_is_planned_and_validated(client, horizon, shortage_days, needed):
    body = ok(optimize(client, "PHC-SIM-001", 600, horizon=horizon))
    assert (body["horizonDays"], body["simulation"]["horizonDays"]) == (horizon, horizon)
    recipient = body["recipient"]
    assert (recipient["shortageDaysBefore"], recipient["quantityToAvoidShortage"], recipient["stockoutDayAfter"]) == (shortage_days, needed, None)
    assert all(len(item["projectedDailyStock"]) == horizon for item in body["simulation"]["intervention"]["facilities"])
    assert body["simulation"]["comparison"]["safeToRecommend"] is True


# ---- Objective ----


def two_warehouse_client():
    second = 6
    return optimizer_client(
        facilities=FACILITY_ROWS + [facility_row(second, "WH-SIM-002", "Sim Second Warehouse", "Warehouse", "North", "0.50", True)],
        inventory=INVENTORY_ROWS + [inventory_row(second, INSULIN, "SIM-007-B02", "5000.00")],
        routes=ROUTE_ROWS + [route_row(second, PHC, "150.00", "3.50", True)],
    )[0]


def test_shorter_route_and_fewer_transfers_win_when_donor_protection_is_equal():
    body = ok(optimize(two_warehouse_client(), "PHC-SIM-001", 600))
    assert summary(body) == [("WH-SIM-002", 14, "SIM-007-B02", 600.0)]
    assert candidate(body, "WH-SIM-001")["status"] == "ELIGIBLE_NOT_SELECTED"


def test_recipient_shortage_outranks_donor_headroom():
    # Demand 100 a day from an empty recipient. The large donor keeps far more headroom but arrives on day 2.
    slow_large = DonorInput("slow", (1_000_000,), (DonorOption(2, 2, 1_000_000),), equity_index=0, distance_tenths_km=10)
    fast_small = DonorInput("fast", (30_000,), (DonorOption(1, 1, 30_000),), equity_index=80, distance_tenths_km=5000)
    recipient = RecipientInput(0, 10_000, {}, 3)
    alone = solve_allocation([slow_large], recipient, 30_000, 1)
    assert (alone.recipient_unmet_demand, alone.recipient_shortage_days) == (10_000, 1)
    result = solve_allocation([slow_large, fast_small], recipient, 30_000, 1)
    # The expensive fast donor covers exactly day 1, so no demand goes unmet; the rest comes from the donor with more headroom.
    assert sorted((item.key, item.arrival_day, item.total) for item in result.allocations) == [("fast", 1, 10_000), ("slow", 2, 20_000)]
    assert (result.recipient_unmet_demand, result.recipient_shortage_days, result.status) == (0, 0, "OPTIMAL")


def test_solver_uses_batches_first_expiry_first_in_whole_units_and_respects_forbidden_sets():
    donor = DonorInput("A", (500, 300), (DonorOption(1, 1, 800),), equity_index=0, distance_tenths_km=100)
    result = solve_allocation([donor], RecipientInput(0, 0, {}, 7), 600, 100)
    assert result.allocations[0].batch_quantities == (500, 100)
    assert solve_allocation([donor], RecipientInput(0, 0, {}, 7), 900, 100) is None
    twin = DonorInput("B", (800,), (DonorOption(1, 1, 800),), equity_index=0, distance_tenths_km=200)
    assert solve_allocation([donor, twin], RecipientInput(0, 0, {}, 7), 600, 1).allocations[0].key == "A"
    assert solve_allocation([donor, twin], RecipientInput(0, 0, {}, 7), 600, 1, [frozenset({"A"})]).allocations[0].key == "B"


# ---- Safety of the final plan ----


def test_donors_gain_no_stockout_no_critical_label_and_regional_shortage_does_not_worsen():
    client, _ = optimizer_client(**multi_source_tables())
    body = ok(optimize(client, "PHC-SIM-001", 800))
    simulation = body["simulation"]
    for donor in ("WH-SIM-001", "DH-SIM-001"):
        before, after = facility(simulation["baseline"], donor), facility(simulation["intervention"], donor)
        assert after["stockoutDay"] is None and after["shortageDays"] == before["shortageDays"] == 0
        assert after["riskLabel"] != "CRITICAL"
        assert after["minimumProjectedStock"] >= candidate(body, donor)["retainedFloor"]
    comparison = simulation["comparison"]
    assert (comparison["newShortagesCreated"], comparison["newCriticalFacilities"], comparison["newRisks"]) == ([], [], [])
    assert comparison["regionalShortageDaysAfter"] <= comparison["regionalShortageDaysBefore"]
    assert comparison["regionalUnmetDemandAfter"] <= comparison["regionalUnmetDemandBefore"]
    assert comparison["regionalOutcome"] in ("IMPROVED", "UNCHANGED")
    checks = {check["name"]: check["passed"] for check in body["validation"]["checks"]}
    assert checks == dict.fromkeys(
        ["ALL_TRANSFERS_ELIGIBLE", "NO_NEW_REGIONAL_RISK", "NO_DONOR_CRITICAL", "NO_NEW_STOCKOUT", "REQUESTED_QUANTITY_SUPPLIED",
         "REGIONAL_SHORTAGE_NOT_WORSE", "BATCH_ALLOCATION_MATCHES", "ROUTES_WITHIN_TRAVEL_LIMIT", "DONORS_SAFE_WITHOUT_FUTURE_SUPPLY",
         "SAFE_TO_RECOMMEND"], True,
    )


def test_final_plan_passes_the_ripple_simulator_when_resubmitted():
    client, _ = optimizer_client(**multi_source_tables())
    body = ok(optimize(client, "PHC-SIM-001", 800))
    proposed = [transfer(item["fromFacilityId"], item["toFacilityId"], item["quantity"], medicine=item["medicineId"], arrival_day=item["arrivalDay"]) for item in body["transfers"]]
    resimulated = simulate(client, *proposed).json()
    assert all(item["eligible"] for item in resimulated["transferEvaluations"])
    assert resimulated["comparison"] == body["simulation"]["comparison"] and resimulated["comparison"]["safeToRecommend"] is True


def test_capacity_limits_are_confirmed_by_the_simulator(monkeypatch):
    original = optimizer_module.arrival_options

    def inflated(scenario, candidate_record):
        if candidate_record.facility.id == "DH-SIM-001":
            # 900 mL: within its usable batches, but far below its 700 mL safety stock by day 6.
            return [DonorOption(1, 1, 90_000)]
        return original(scenario, candidate_record)

    monkeypatch.setattr(optimizer_module, "arrival_options", inflated)
    client, _ = optimizer_client()
    body = ok(optimize(client, "PHC-SIM-001", 300))
    hospital = candidate(body, "DH-SIM-001")
    assert hospital["rejectionCodes"] == ["CAPACITY_NOT_VERIFIED"] and "protected safety stock" in hospital["rejectionReasons"][0]
    assert summary(body) == [("WH-SIM-001", 14, "SIM-007-B02", 300.0)]


def test_plan_rejected_by_the_simulator_is_never_returned_and_the_next_plan_is_tried(monkeypatch):
    original = optimizer_module.arrival_options
    monkeypatch.setattr(
        optimizer_module, "arrival_options",
        lambda scenario, record: [DonorOption(1, 1, 9_000_000)] if record.facility.id == "DH-SIM-001" else original(scenario, record),
    )
    monkeypatch.setattr(optimizer_module, "verify_capacity", lambda scenario, record: None)
    client, _ = optimizer_client()
    body = ok(optimize(client, "PHC-SIM-001", 300))
    assert body["solver"]["attempts"] == 2
    assert summary(body) == [("WH-SIM-001", 14, "SIM-007-B02", 300.0)]
    hospital = candidate(body, "DH-SIM-001")
    assert hospital["rejectionCodes"] == ["SIMULATION_REJECTED"]
    assert "rejected the combined plan" in hospital["rejectionReasons"][0] and "protected safety stock" in hospital["rejectionReasons"][0]

    database = FakeDatabase(inventory=with_batch_ids(INVENTORY_ROWS))
    single = TestClient(create_app(data_source=MySQLDataSource(SETTINGS, connector=database.connect), optimizer_config=OptimizerConfig(max_attempts=1)))
    info = details(optimize(single, "PHC-SIM-001", 300))
    assert (info["solverStatus"], info["attempts"], info["unmetQuantity"]) == ("VALIDATION_FAILED", 1, 0.0)
    assert "rejected every plan" in info["explanation"]


# ---- Infeasible requests ----


def test_insufficient_regional_supply_returns_no_safe_plan_without_creating_stock(client):
    info = details(optimize(client, "PHC-SIM-001", 100000))
    # Only the warehouse counts: the subcentre's 1.63 mL sits behind a route over the 6-hour limit.
    assert (info["requestedQuantity"], info["safeCapacity"], info["unmetQuantity"], info["unit"]) == (100000.0, 4500.0, 95500.0, "mL")
    assert round(sum(item["safeCapacity"] for item in info["eligibleCandidates"]), 2) == info["safeCapacity"]
    assert info["candidatesConsidered"] == 4 and all(item["rejectionReasons"] for item in info["rejectedCandidates"])
    assert any("up to 4500 mL" in item for item in info["recommendedEscalation"])
    assert any("expedite the delayed replenishment of 600 mL" in item for item in info["recommendedEscalation"])
    # Exactly the reported safe capacity can be planned, and nothing more.
    body = ok(optimize(client, "PHC-SIM-001", 4500))
    assert summary(body) == [("WH-SIM-001", 14, "SIM-007-B02", 4500.0)]
    details(optimize(client, "PHC-SIM-001", 4500.01))


# ---- Offline fixture ----


def test_fixture_mode_plans_navjeevan_from_the_central_store():
    client = TestClient(create_app(SimulatedDataStore.from_csv()))
    body = ok(client.post("/plans/optimize", json={"destinationFacilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN, "quantity": 45}))
    assert body["dataContext"]["dataSource"] == "FIXTURE" and body["unit"] == "vial"
    assert summary(body) == [("facility-central-store", "INS-CS-2401", "INS-CS-2401", 45.0)]
    assert (body["recipient"]["stockoutDayBefore"], body["recipient"]["stockoutDayAfter"]) == (3, None)
    store = candidate(body, "facility-central-store")
    assert (store["safeCapacity"], store["retainedFloor"]) == (333.0, 287.0)
    assert "DONOR_AT_RISK" in candidate(body, "facility-district-hospital")["rejectionCodes"]
    assert "DONOR_AT_RISK" in candidate(body, "facility-river-chc")["rejectionCodes"]
    assert body["simulation"]["comparison"]["safeToRecommend"] is True
