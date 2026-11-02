"""Received-stock donor evidence in POST /scenarios/simulate (receivedStockCheck, maxTravelHours, batch IDs).

The backend re-simulates a plan's exact transfers before reserving stock and requires this evidence to pass. It applies
the optimizer's donor rules (retained floor from stock already received, recorded safety stock, no HIGH or CRITICAL
donor) and never changes transfer eligibility or safeToRecommend. In-memory rows; no database server.
"""

from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from app.config import POSTGRES
from app.main import create_app
from app.optimizer import OptimizerConfig
from app.postgres_store import PostgreSQLDataSource
from tests.optimizer_support import (
    future_supply_donor_tables,
    high_risk_subcentre_tables,
    multi_source_tables,
    optimize,
    optimizer_client,
    with_batch_ids,
    without_pair,
)
from tests.simulator_support import HOSPITAL, INSULIN, INVENTORY_ROWS, SAFETY_ROWS, SETTINGS, FakeDatabase, simulate, transfer


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def donor(body, facility_id):
    return next(item for item in body["receivedStockCheck"]["donors"] if item["facilityId"] == facility_id)


def test_safe_transfer_carries_passing_evidence_route_limit_and_batch_id():
    body = ok(simulate(optimizer_client()[0], transfer("WH-SIM-001", "PHC-SIM-001", 600)))
    check = body["receivedStockCheck"]
    assert (check["basis"], check["passed"], body["maxTravelHours"], body["comparison"]["safeToRecommend"]) == ("RECEIVED_STOCK_ONLY", True, 6.0, True)
    assert donor(body, "WH-SIM-001") == {
        "facilityId": "WH-SIM-001", "facilityName": "Sim Regional Warehouse", "totalSent": 600.0, "retainedFloor": 500.0,
        "lowestProjectedStock": 4400.0, "lowestProjectedDay": 1, "futureReplenishmentExcluded": 0.0, "passed": True, "failureCodes": [],
        "explanation": "Counting only stock already received, Sim Regional Warehouse keeps its retained floor of 500 mL after sending "
        "600 mL: its lowest projected stock from day 1 is 4400 mL on day 1.",
    }
    assert body["transferEvaluations"][0]["batches"] == [{"batchId": 14, "batchNo": "SIM-007-B02", "quantity": 600.0, "expiryDate": "2028-04-24"}]


@pytest.mark.parametrize("status", ["SCHEDULED", "DELAYED"])
def test_donor_safe_only_because_of_future_supply_fails_the_evidence_without_changing_eligibility(status):
    body = ok(simulate(optimizer_client(**future_supply_donor_tables(status))[0], transfer("DH-SIM-001", "PHC-SIM-001", 100)))
    # The simulator counts the 1000 mL delivery on day 7, so the transfer itself stays eligible and safe to recommend.
    evaluation = body["transferEvaluations"][0]
    assert (evaluation["eligible"], evaluation["applied"], body["comparison"]["safeToRecommend"]) == (True, True, True)
    hospital = donor(body, "DH-SIM-001")
    assert body["receivedStockCheck"]["passed"] is False
    assert (hospital["passed"], hospital["failureCodes"], hospital["retainedFloor"]) == (False, ["BELOW_RETAINED_FLOOR"], 111.5)
    assert (hospital["lowestProjectedStock"], hospital["lowestProjectedDay"], hospital["futureReplenishmentExcluded"]) == (0.0, 14, 1000.0)
    assert "below its retained floor of 111.5 mL" in hospital["explanation"]
    assert "Future supply of 1000 mL due within the horizon is not counted." in hospital["explanation"]


def test_withdrawal_that_needs_future_supply_is_reported():
    # By day 8 the simulator counts the 1000 mL delivery, so 400 mL of the 500 mL batch can leave; received stock alone is 290 mL.
    body = ok(simulate(optimizer_client(**future_supply_donor_tables("SCHEDULED"))[0], transfer("DH-SIM-001", "PHC-SIM-001", 400, arrival_day=8)))
    assert body["transferEvaluations"][0]["applied"] is True
    hospital = donor(body, "DH-SIM-001")
    assert hospital["failureCodes"][0] == "WITHDRAWAL_EXCEEDS_RECEIVED_STOCK"
    assert "does not hold 110 mL" in hospital["explanation"]


def test_plan_and_its_resimulation_carry_the_same_passing_evidence():
    client, _ = optimizer_client(**multi_source_tables())
    plan = ok(optimize(client, "PHC-SIM-001", 800))
    evidence = plan["simulation"]["receivedStockCheck"]
    assert evidence["passed"] is True
    selected = {item["facilityId"]: item for item in plan["candidates"] if item["status"] == "SELECTED"}
    assert {item["facilityId"]: (item["retainedFloor"], item["totalSent"]) for item in evidence["donors"]} == {
        facility_id: (item["retainedFloor"], item["allocatedQuantity"]) for facility_id, item in selected.items()
    }
    # What the backend sends at approval: the plan's exact transfers with their arrival days.
    transfers = [transfer(item["fromFacilityId"], item["toFacilityId"], item["quantity"], arrival_day=item["arrivalDay"]) for item in plan["transfers"]]
    again = ok(simulate(client, *transfers))
    assert again["receivedStockCheck"] == evidence
    assert [
        [(batch["batchId"], batch["batchNo"], batch["quantity"]) for batch in item["batches"]] for item in again["transferEvaluations"]
    ] == [[(item["batchId"], item["batchNo"], item["quantity"])] for item in plan["transfers"]]


def test_high_risk_donor_fails_the_evidence():
    body = ok(simulate(optimizer_client(**high_risk_subcentre_tables())[0], transfer("SC-SIM-001", "PHC-SIM-001", 1)))
    subcentre = donor(body, "SC-SIM-001")
    assert "DONOR_AT_RISK" in subcentre["failureCodes"] and "already HIGH risk" in subcentre["explanation"]


def test_forecast_donor_without_recorded_safety_stock_fails_the_evidence():
    client, _ = optimizer_client(safety=without_pair(SAFETY_ROWS, HOSPITAL, INSULIN))
    body = ok(simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 10)))
    assert body["transferEvaluations"][0]["eligible"] is True
    assert donor(body, "DH-SIM-001")["failureCodes"] == ["SAFETY_STOCK_NOT_RECORDED"]


def test_no_applied_transfer_means_no_passing_evidence():
    body = ok(simulate(optimizer_client()[0], transfer("CHC-SIM-001", "PHC-SIM-001", 10)))
    assert body["transferEvaluations"][0]["rejectionCodes"] == ["COLD_CHAIN_UNAVAILABLE"]
    assert (body["receivedStockCheck"]["passed"], body["receivedStockCheck"]["donors"]) == (False, [])


def test_route_limit_in_the_response_follows_the_configuration():
    client, _ = optimizer_client(config=OptimizerConfig(max_travel_hours=8))
    assert ok(simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 1)))["maxTravelHours"] == 8.0


def test_postgres_simulation_carries_the_same_evidence():
    settings = replace(SETTINGS, data_source=POSTGRES, database_url="postgresql://unused/test")
    client = TestClient(create_app(data_source=PostgreSQLDataSource(settings, FakeDatabase(inventory=with_batch_ids(INVENTORY_ROWS)).connect)))
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)))
    assert (body["dataContext"]["dataSource"], body["receivedStockCheck"]["passed"], body["maxTravelHours"]) == ("POSTGRES", True, 6.0)
    assert body["transferEvaluations"][0]["batches"][0]["batchId"] == 14
