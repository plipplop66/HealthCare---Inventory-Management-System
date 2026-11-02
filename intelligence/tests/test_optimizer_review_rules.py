"""Rules settled by the biomedical (Aaryan) and database (Dhiren) reviews.

Covers the six-hour donor route cap (in the optimizer and the Ripple Simulator), donor capacity from received stock
only, FEFO tie-breaking by batch ID, the approved guardrail values and mapping statuses, exact medicine identity, cold
chain, NO_SAFE_PLAN, determinism and response wording, also through the PostgreSQL data source. In-memory rows and the
fixture; no database server.
"""

import json
import math
from dataclasses import replace
from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.config import POSTGRES
from app.data_store import Batch, SimulatedDataStore
from app.main import create_app
from app.optimizer import DEFAULT_OPTIMIZER_CONFIG, OptimizerConfig
from app.postgres_store import PostgreSQLDataSource
from app.simulator import PATIENT_IMPACT_LIMITATION, PROTOTYPE_VALIDATION_LIMITATION
from tests.optimizer_support import (
    arrived_replenishment_tables,
    candidate,
    details,
    future_supply_donor_tables,
    high_risk_subcentre_tables,
    multi_source_tables,
    optimize,
    optimizer_client,
    replace_facility_rows,
    replenishment_status_tables,
    routes_with,
    with_batch_ids,
)
from tests.simulator_support import (
    HOSPITAL,
    INSULIN,
    INVENTORY_ROWS,
    PHC,
    SETTINGS,
    WAREHOUSE,
    FakeDatabase,
    facility,
    inventory_row,
    simulate,
    transfer,
)

FIXTURE_INSULIN = "med-insulin-100iu-vial"
APPROVED = "APPROVED_FOR_HACKATHON_PROTOTYPE"


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def checks(body):
    return {item["name"]: item["passed"] for item in body["validation"]["checks"]}


# ---- Six-hour donor route cap ----


@pytest.mark.parametrize("hours", ["5.10", "6.00"])
def test_donor_route_at_or_below_six_hours_stays_eligible(hours):
    client, _ = optimizer_client(routes=routes_with(WAREHOUSE, PHC, hours, "210.25"))
    body = ok(optimize(client, "PHC-SIM-001", 600))
    warehouse = candidate(body, "WH-SIM-001")
    assert (warehouse["status"], warehouse["travelHours"], warehouse["rejectionCodes"]) == ("SELECTED", float(hours), [])
    assert body["transfers"][0]["travelHours"] == float(hours)
    assert checks(body)["ROUTES_WITHIN_TRAVEL_LIMIT"] is True


def test_donor_route_above_six_hours_is_rejected_with_actual_and_maximum_time():
    client, _ = optimizer_client(routes=routes_with(WAREHOUSE, PHC, "6.01", "210.25"))
    info = details(optimize(client, "PHC-SIM-001", 600))
    warehouse = next(item for item in info["rejectedCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert warehouse["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    reason = warehouse["rejectionReasons"][0]
    for phrase in ("Sim Regional Warehouse (WH-SIM-001)", "6.01 hours", "configured 6-hour maximum donor travel time", "prototype transfer limit"):
        assert phrase in reason
    assert (warehouse["travelHours"], info["equityGuardrail"]["maxTravelHours"], info["safeCapacity"]) == (6.01, 6.0, 0.0)


def test_default_subcentre_route_of_7_6_hours_is_rejected():
    body = ok(optimize(optimizer_client()[0], "PHC-SIM-001", 600))
    subcentre = candidate(body, "SC-SIM-001")
    assert subcentre["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"] and "takes 7.6 hours" in subcentre["rejectionReasons"][0]
    assert body["equityGuardrail"]["maxTravelHours"] == 6.0
    assert any("at most 6 hours" in item for item in body["assumptions"])


def test_travel_limit_is_configurable():
    client, _ = optimizer_client(config=OptimizerConfig(max_travel_hours=8))
    body = ok(optimize(client, "PHC-SIM-001", 600))
    assert candidate(body, "SC-SIM-001")["status"] == "ELIGIBLE_NOT_SELECTED"
    assert body["equityGuardrail"]["maxTravelHours"] == 8.0


@pytest.mark.parametrize("value", [0, -1, math.nan, math.inf, True, "6"])
def test_invalid_travel_limit_configuration_is_rejected(value):
    with pytest.raises(ValueError, match="max_travel_hours"):
        OptimizerConfig(max_travel_hours=value)


# ---- Donor capacity counts only received stock ----


@pytest.mark.parametrize("status", ["SCHEDULED", "DELAYED"])
def test_donor_safe_only_because_of_future_stock_is_rejected(status):
    client, _ = optimizer_client(**future_supply_donor_tables(status))
    info = details(optimize(client, "PHC-SIM-001", 100))
    hospital = next(item for item in info["rejectedCandidates"] if item["facilityId"] == "DH-SIM-001")
    assert hospital["rejectionCodes"] == ["NO_SAFE_DONOR_CAPACITY"]
    assert (hospital["safeCapacity"], hospital["futureReplenishmentExcluded"]) == (0.0, 1000.0)
    reason = hospital["rejectionReasons"][0]
    for phrase in ("80 mL on day 14", f"1000 mL {status.lower()} for day 7", "not counted toward donor capacity", "only because of that future supply"):
        assert phrase in reason
    assert info["equityGuardrail"]["donorCapacityBasis"] == "RECEIVED_STOCK_ONLY"
    # The subcentre is also beyond the route limit, so only the hospital is named as worth reassessing after its delivery.
    escalation = info["recommendedEscalation"]
    assert any(item.startswith("DH-SIM-001 could be reassessed after") for item in escalation)
    assert any(item.startswith("SC-SIM-001 is beyond the 6-hour route limit") for item in escalation)
    # The Ripple Simulator counts the delivery, which is the only reason the hospital looked like a safe donor.
    assert simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 100)).json()["transferEvaluations"][0]["eligible"] is True


@pytest.mark.parametrize("status", ["SCHEDULED", "DELAYED"])
def test_future_stock_does_not_increase_donor_capacity(status):
    tables = {**multi_source_tables(), **replenishment_status_tables(HOSPITAL, status)}
    body = ok(optimize(optimizer_client(**tables)[0], "PHC-SIM-001", 800))
    hospital = candidate(body, "DH-SIM-001")
    # Counting its 700 mL delivery on day 7 the hospital could send 588.5 mL; counting received stock only, 188.5 mL.
    assert (hospital["safeCapacity"], hospital["futureReplenishmentExcluded"], hospital["allocatedQuantity"]) == (188.5, 700.0, 170.0)
    assert f"700 mL {status.lower()} for day 7" in hospital["explanation"]
    assert checks(body)["DONORS_SAFE_WITHOUT_FUTURE_SUPPLY"] is True


@pytest.mark.parametrize("status", ["SCHEDULED", "DELAYED"])
def test_recipient_forecast_and_plan_still_count_future_replenishment(status):
    client, _ = optimizer_client(**replenishment_status_tables(PHC, status))
    forecast = client.post("/forecast", json={"facilityId": "PHC-SIM-001", "medicineId": "7"}).json()
    assert forecast["inventory"]["nextReplenishment"] == {"quantity": 600.0, "arrivalDay": 8, "arrivalDate": "2026-09-19", "status": status}
    assert (forecast["projection"][7]["replenishment"], forecast["stockout"]["totalShortageDays"]) == (600.0, 7)
    body = ok(optimize(client, "PHC-SIM-001", 250))
    # 250 mL on day 1 covers the recipient only because its own 600 mL still arrives on day 8.
    assert facility(body["simulation"]["intervention"], "PHC-SIM-001")["projectedDailyStock"][7]["scheduledReplenishment"] == 600.0
    assert (body["recipient"]["stockoutDayAfter"], body["recipient"]["quantityToAvoidShortage"]) == (None, 250.0)


def test_arrived_replenishment_is_not_counted_again():
    default, arrived = optimizer_client()[0], optimizer_client(**arrived_replenishment_tables())[0]
    request = {"facilityId": "PHC-SIM-001", "medicineId": "7", "horizonDays": 14}
    assert arrived.post("/forecast", json=request).content == default.post("/forecast", json=request).content
    assert optimize(arrived, "PHC-SIM-001", 600).content == optimize(default, "PHC-SIM-001", 600).content


# ---- Approved guardrails are unchanged ----


def test_high_and_critical_donors_remain_excluded():
    high = ok(optimize(optimizer_client(**high_risk_subcentre_tables())[0], "PHC-SIM-001", 600))
    subcentre = candidate(high, "SC-SIM-001")
    assert subcentre["baselineRiskLabel"] == "HIGH" and "DONOR_AT_RISK" in subcentre["rejectionCodes"]
    critical = ok(optimize(optimizer_client()[0], "DH-SIM-001", 10))
    phc = candidate(critical, "PHC-SIM-001")
    assert phc["baselineRiskLabel"] == "CRITICAL" and "DONOR_AT_RISK" in phc["rejectionCodes"]


def test_approved_guardrail_values_and_status():
    config = DEFAULT_OPTIMIZER_CONFIG
    uplifts = {"WAREHOUSE": 0.0, "DISTRICTHOSPITAL": 0.0, "CHC": 0.10, "PHC": 0.25, "SUBCENTRE": 0.35}
    assert dict(config.facility_type_uplift) == uplifts
    assert (config.remoteness_weight, config.warehouse_operational_reserve_share, config.excluded_donor_risk_labels, config.max_travel_hours) == (
        0.5, 0.10, ("HIGH", "CRITICAL"), 6.0,
    )
    body = ok(optimize(optimizer_client()[0], "PHC-SIM-001", 600))
    guardrail = body["equityGuardrail"]
    assert (guardrail["facilityTypeUplift"], guardrail["remotenessWeight"], guardrail["warehouseOperationalReserveShare"]) == (uplifts, 0.5, 0.1)
    assert (guardrail["status"], guardrail["reviewOwner"], guardrail["validationNote"]) == (APPROVED, "Aaryan", PROTOTYPE_VALIDATION_LIMITATION)
    warehouse = candidate(body, "WH-SIM-001")
    assert (warehouse["operationalReserve"], warehouse["retainedFloor"], warehouse["safeCapacity"]) == (500.0, 500.0, 4500.0)
    mappings = {item["name"]: item["status"] for item in body["dataContext"]["mappings"]}
    approved = ("effectiveStock", "coldChain", "equityReserve", "travelTimeLimit", "donorReceivedStockOnly", "quantityScale", "batchIdentity")
    assert {name: mappings[name] for name in approved} == dict.fromkeys(approved, APPROVED)
    # Mappings nobody explicitly reviewed stay provisional; units is database policy.
    provisional = ("routes", "donorSafety", "protectedStock", "asOfDate")
    assert {name: mappings[name] for name in provisional} == dict.fromkeys(provisional, "PROVISIONAL")
    assert mappings["units"] == "DATABASE_POLICY"
    assert all(status == "PROVISIONAL" for name, status in mappings.items() if name not in (*approved, "units"))
    text = json.dumps([body["assumptions"], body["limitations"], guardrail]).lower()
    assert "await" not in text and "provisional equity" not in text and "clinically validated" not in text.replace("not clinically validated", "")


# ---- Exact identity and cold chain ----


def test_medicine_mismatch_stays_rejected_whatever_the_request_claims():
    client, _ = optimizer_client()
    claims = {"emergency": True, "branchManagerApproval": True, "allowSubstitution": True, "overrideIdentity": True}
    body = client.post("/scenarios/simulate", json={"horizonDays": 14, **claims, "transfers": [
        transfer("WH-SIM-001", "PHC-SIM-001", 600), {**transfer("WH-SIM-001", "PHC-SIM-001", 10, medicine="8"), **claims},
    ]}).json()
    mismatch = body["transferEvaluations"][1]
    assert (mismatch["rejectionCodes"], mismatch["eligible"], mismatch["applied"]) == (["MEDICINE_IDENTITY_MISMATCH"], False, False)
    assert "Manual pharmacist or qualified clinical review is required" in mismatch["rejectionReasons"][0]
    assert "remains rejected" in mismatch["rejectionReasons"][0]
    plain = optimize(client, "PHC-SIM-001", 600).content
    claimed = client.post("/plans/optimize", json={"destinationFacilityId": "PHC-SIM-001", "medicineId": "7", "quantity": 600, "horizonDays": 14, **claims})
    assert claimed.content == plain
    other_medicine = optimize(client, "PHC-SIM-001", 10, medicine="8")
    assert (other_medicine.status_code, other_medicine.json()["error"]["code"]) == (404, "OPTIMIZATION_TARGET_NOT_FOUND")


def test_cold_chain_rules_are_unchanged():
    client, _ = optimizer_client()
    assert "COLD_CHAIN_UNAVAILABLE" in candidate(ok(optimize(client, "PHC-SIM-001", 600)), "CHC-SIM-001")["rejectionCodes"]
    info = details(optimize(client, "CHC-SIM-001", 10))
    rejected = {item["facilityId"]: item["rejectionCodes"] for item in info["rejectedCandidates"]}
    assert info["safeCapacity"] == 0.0
    assert "COLD_CHAIN_UNAVAILABLE" in rejected["WH-SIM-001"] and "COLD_CHAIN_UNAVAILABLE" in rejected["DH-SIM-001"]


# ---- NO_SAFE_PLAN, determinism and wording ----


def test_no_safe_plan_is_structured_and_never_relaxes_a_rule():
    client, _ = optimizer_client()
    response = optimize(client, "PHC-SIM-001", 4500.01)
    info = details(response)
    assert (info["safeCapacity"], info["unmetQuantity"], info["solverStatus"]) == (4500.0, 0.01, "INFEASIBLE")
    rejected = {item["facilityId"]: item["rejectionCodes"] for item in info["rejectedCandidates"]}
    # The subcentre's 1.63 mL is not borrowed across the 6-hour limit to close a 0.01 mL gap.
    assert rejected["SC-SIM-001"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    assert info["equityGuardrail"]["maxTravelHours"] == 6.0 and "transfers" not in response.json()
    assert ok(optimize(client, "PHC-SIM-001", 4500))["allocatedQuantity"] == 4500.0


def test_identical_requests_are_byte_identical_with_the_same_plan_id():
    first, second = optimize(optimizer_client()[0], "PHC-SIM-001", 600.25), optimize(optimizer_client()[0], "PHC-SIM-001", 600.25)
    assert first.status_code == 200 and first.content == second.content and first.json()["id"] == second.json()["id"]
    fixture = TestClient(create_app(SimulatedDataStore.from_csv()))
    request = {"destinationFacilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN, "quantity": 45}
    assert fixture.post("/plans/optimize", json=request).content == fixture.post("/plans/optimize", json=request).content


def all_keys(value):
    if isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from all_keys(item)
    elif isinstance(value, list):
        for item in value:
            yield from all_keys(item)


def test_no_patient_impact_metric_is_calculated():
    client, _ = optimizer_client()
    forecast = client.post("/forecast", json={"facilityId": "PHC-SIM-001", "medicineId": "7"}).json()
    simulation = simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)).json()
    plan = optimize(client, "PHC-SIM-001", 600).json()
    no_plan = optimize(client, "PHC-SIM-001", 100000).json()
    for body in (forecast, simulation, plan, no_plan):
        assert not any("patient" in key.lower() for key in all_keys(body))
        assert "patient-day" not in json.dumps(body).lower() and "patient day" not in json.dumps(body).lower()
    assert PATIENT_IMPACT_LIMITATION in simulation["limitations"] and PATIENT_IMPACT_LIMITATION in plan["limitations"]


def test_transfer_responses_state_the_prototype_boundary():
    client, _ = optimizer_client()
    plan = ok(optimize(client, "PHC-SIM-001", 600))
    simulation = simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)).json()
    for body in (plan, simulation):
        assert PROTOTYPE_VALIDATION_LIMITATION in body["limitations"]
        assert any("simulated" in item.lower() for item in body["assumptions"])
        assert any("approve every operational transfer" in item for item in body["assumptions"])
    assert (plan["decisionSupportOnly"], plan["requiresHumanApproval"]) == (True, True)


# ---- Where the reviewed rules do not apply nothing changes ----


def test_fixture_forecast_and_plan_are_unchanged():
    client = TestClient(create_app(SimulatedDataStore.from_csv()))
    forecast = client.post("/forecast", json={"facilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN}).json()
    assert (forecast["forecast"]["dailyDemand"], forecast["risk"]["score"], forecast["risk"]["label"]) == (8.06, 83, "CRITICAL")
    assert (forecast["stockout"]["projectedStockoutDate"], forecast["stockout"]["shortageGapDays"], forecast["cause"]) == ("2026-09-03", 5, "SUPPLY_DELAY")
    plan = ok(client.post("/plans/optimize", json={"destinationFacilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN, "quantity": 45}))
    assert [(t["fromFacilityId"], t["batchNo"], t["quantity"], t["travelHours"]) for t in plan["transfers"]] == [("facility-central-store", "INS-CS-2401", 45.0, 1.2)]
    assert plan["validation"]["passed"] and plan["simulation"]["comparison"]["safeToRecommend"]
    assert candidate(plan, "facility-central-store")["safeCapacity"] == 333.0


# ---- The Ripple Simulator applies the same route cap ----


def test_simulator_marks_a_route_over_six_hours_ineligible_but_still_shows_its_effect():
    client, _ = optimizer_client()
    body = simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 1)).json()
    item = body["transferEvaluations"][0]
    assert (item["eligible"], item["applied"], item["rejectionCodes"]) == (False, True, ["TRAVEL_TIME_LIMIT_EXCEEDED"])
    assert "takes 7.6 hours" in item["rejectionReasons"][0] and "configured 6-hour maximum donor travel time" in item["rejectionReasons"][0]
    assert body["comparison"]["safeToRecommend"] is False
    # What would theoretically happen to stock is still shown.
    assert facility(body["intervention"], "PHC-SIM-001")["transferIn"] == 1.0
    assert any("at most 6 hours" in text for text in body["assumptions"])


def test_simulator_and_optimizer_agree_on_the_same_route():
    client, _ = optimizer_client(routes=routes_with(WAREHOUSE, PHC, "6.01", "210.25"))
    evaluation = simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)).json()["transferEvaluations"][0]
    rejected = next(item for item in details(optimize(client, "PHC-SIM-001", 600))["rejectedCandidates"] if item["facilityId"] == "WH-SIM-001")
    assert evaluation["rejectionCodes"] == rejected["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    assert evaluation["rejectionReasons"] == rejected["rejectionReasons"]
    at_limit = optimizer_client(routes=routes_with(WAREHOUSE, PHC, "6.00", "210.25"))[0]
    assert simulate(at_limit, transfer("WH-SIM-001", "PHC-SIM-001", 600)).json()["comparison"]["safeToRecommend"] is True


def test_simulator_uses_the_configured_limit():
    client, _ = optimizer_client(config=OptimizerConfig(max_travel_hours=8))
    body = simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 1)).json()
    assert body["transferEvaluations"][0]["eligible"] is True
    assert any("at most 8 hours" in text for text in body["assumptions"])


# ---- FEFO ties are broken by the database batch ID ----


def test_same_expiry_batches_are_used_in_batch_id_order_not_batch_number_order():
    same_expiry = date(2028, 4, 24)
    rows = replace_facility_rows(
        INVENTORY_ROWS, WAREHOUSE, INSULIN,
        {**inventory_row(WAREHOUSE, INSULIN, "SIM-007-A-LOT", "4700.00", expiry=same_expiry), "batch_id": 9},
        {**inventory_row(WAREHOUSE, INSULIN, "SIM-007-Z-LOT", "300.00", expiry=same_expiry), "batch_id": 5},
    )
    client, _ = optimizer_client(inventory=rows)
    body = ok(optimize(client, "PHC-SIM-001", 400))
    # Batch number order would send all 400 from SIM-007-A-LOT; batch_id 5 is used first instead.
    assert [(item["batchId"], item["batchNo"], item["quantity"]) for item in body["transfers"]] == [(5, "SIM-007-Z-LOT", 300.0), (9, "SIM-007-A-LOT", 100.0)]
    evaluation = simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 400)).json()["transferEvaluations"][0]
    assert [(batch["batchNo"], batch["quantity"]) for batch in evaluation["batches"]] == [("SIM-007-Z-LOT", 300.0), ("SIM-007-A-LOT", 100.0)]


def test_fefo_key_falls_back_to_batch_number_only_without_database_ids():
    same_expiry = date(2027, 1, 31)
    database = [Batch("B", 1, same_expiry, "USABLE", batch_id=2), Batch("A", 1, same_expiry, "USABLE", batch_id=7), Batch("Z", 1, date(2026, 12, 1), "USABLE", batch_id=9)]
    assert [batch.batch_no for batch in sorted(database, key=lambda batch: batch.fefo_key)] == ["Z", "B", "A"]
    fixture = [Batch("INS-2", 1, same_expiry, "USABLE"), Batch("INS-1", 1, same_expiry, "USABLE")]
    assert [batch.batch_no for batch in sorted(fixture, key=lambda batch: batch.fefo_key)] == ["INS-1", "INS-2"]


# ---- PostgreSQL mode applies the same reviewed rules ----


def postgres_client():
    """The optimizer's in-memory rows served through the PostgreSQL data source, which shares the MySQL queries."""
    settings = replace(SETTINGS, data_source=POSTGRES, database_url="postgresql://unused/test")
    database = FakeDatabase(inventory=with_batch_ids(INVENTORY_ROWS))
    return TestClient(create_app(data_source=PostgreSQLDataSource(settings, database.connect)))


def test_postgres_plans_use_the_reviewed_rules_and_approved_mappings():
    body = ok(optimize(postgres_client(), "PHC-SIM-001", 600))
    assert (body["dataContext"]["dataSource"], body["modelVersion"], body["requiresHumanApproval"]) == ("POSTGRES", "aiml-transfer-optimizer-v2", True)
    assert [(item["fromFacilityId"], item["batchId"], item["quantity"]) for item in body["transfers"]] == [("WH-SIM-001", 14, 600.0)]
    guardrail = body["equityGuardrail"]
    assert (guardrail["maxTravelHours"], guardrail["donorCapacityBasis"], guardrail["status"]) == (6.0, "RECEIVED_STOCK_ONLY", APPROVED)
    assert candidate(body, "SC-SIM-001")["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    assert candidate(body, "DH-SIM-001")["futureReplenishmentExcluded"] == 700.0
    mappings = {item["name"]: item for item in body["dataContext"]["mappings"]}
    approved = ("effectiveStock", "coldChain", "equityReserve", "travelTimeLimit", "donorReceivedStockOnly", "quantityScale", "batchIdentity")
    assert all(mappings[name]["status"] == APPROVED for name in approved)
    assert "then by batches.batch_id" in mappings["batchIdentity"]["rule"]
    assert checks(body)["ROUTES_WITHIN_TRAVEL_LIMIT"] and checks(body)["DONORS_SAFE_WITHOUT_FUTURE_SUPPLY"]


def test_postgres_simulator_and_optimizer_agree_on_a_route_over_six_hours():
    client = postgres_client()
    simulation = simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 1)).json()
    item = simulation["transferEvaluations"][0]
    assert (simulation["scenarioType"], simulation["dataContext"]["dataSource"]) == ("SIMULATED_DATABASE", "POSTGRES")
    assert (item["eligible"], item["applied"], item["rejectionCodes"]) == (False, True, ["TRAVEL_TIME_LIMIT_EXCEEDED"])
    assert simulation["comparison"]["safeToRecommend"] is False
    assert item["rejectionReasons"] == candidate(ok(optimize(client, "PHC-SIM-001", 600)), "SC-SIM-001")["rejectionReasons"]
