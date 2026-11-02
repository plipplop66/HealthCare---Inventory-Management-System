"""POST /plans/optimize contract: validation, errors, read-only behaviour, determinism and data-source separation."""

import inspect
import json
import re
import sys

import pytest
from fastapi.testclient import TestClient

from app import allocation_solver, optimizer
from app.data_store import SimulatedDataStore
from app.main import create_app
from app.mysql_store import MySQLDataSource
from tests.optimizer_support import candidate, details, optimize, optimizer_client
from tests.simulator_support import SETTINGS, WRITE_KEYWORDS, simulate, transfer, unavailable_connector

FIXTURE_INSULIN = "med-insulin-100iu-vial"


@pytest.fixture()
def client():
    return optimizer_client()[0]


@pytest.fixture()
def fixture_client():
    return TestClient(create_app(SimulatedDataStore.from_csv()))


def post(client, body):
    return client.post("/plans/optimize", json=body)


def request_body(**overrides):
    return {"destinationFacilityId": "PHC-SIM-001", "medicineId": "7", "quantity": 600, "horizonDays": 14, **overrides}


def error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()["error"]
    assert body["code"] == code
    return body["message"]


# ---- Validation ----


@pytest.mark.parametrize("horizon", [0, 10, 31, "14", 14.0, True, None])
def test_invalid_horizon_returns_422(client, horizon):
    assert error(post(client, request_body(horizonDays=horizon)), 422, "INVALID_HORIZON") == "horizonDays must be one of 7, 14 or 30."


def test_horizon_defaults_to_14(client):
    body = request_body()
    del body["horizonDays"]
    response = post(client, body)
    assert response.status_code == 200 and response.json()["horizonDays"] == 14


@pytest.mark.parametrize("quantity", [0, -5, -0.01, "10", True, None, 600.255, 1e11])
def test_invalid_quantity_returns_422(client, quantity):
    assert "quantity" in error(post(client, request_body(quantity=quantity)), 422, "INVALID_REQUEST")


def test_quantity_with_more_than_two_decimals_is_refused_not_rounded(client):
    message = error(post(client, request_body(quantity=600.255)), 422, "INVALID_REQUEST")
    assert "at most 2 decimal places" in message
    nan = client.post("/plans/optimize", content='{"destinationFacilityId": "PHC-SIM-001", "medicineId": "7", "quantity": NaN}', headers={"content-type": "application/json"})
    assert nan.status_code == 422


@pytest.mark.parametrize("field", ["destinationFacilityId", "medicineId", "quantity"])
def test_required_fields_return_422(client, field):
    body = request_body()
    del body[field]
    assert error(post(client, body), 422, "INVALID_REQUEST") == f"{field} is required."


def test_blank_identifiers_return_422(client):
    error(post(client, request_body(destinationFacilityId="   ")), 422, "INVALID_REQUEST")
    error(post(client, request_body(medicineId="")), 422, "INVALID_REQUEST")


def test_unknown_destination_medicine_and_target_return_404(client):
    assert error(post(client, request_body(destinationFacilityId="PHC-NOPE-001")), 404, "FACILITY_NOT_FOUND") == (
        "Destination facility 'PHC-NOPE-001' was not found in the MEDRIPPLE MySQL database."
    )
    assert error(post(client, request_body(medicineId="999")), 404, "MEDICINE_NOT_FOUND") == "Medicine '999' was not found in the MEDRIPPLE MySQL database."
    assert "no inventory record" in error(post(client, request_body(destinationFacilityId="CHC-SIM-001", medicineId="1")), 404, "OPTIMIZATION_TARGET_NOT_FOUND")


def test_database_outage_returns_503_and_never_uses_the_fixture():
    client = TestClient(create_app(data_source=MySQLDataSource(SETTINGS, connector=unavailable_connector())))
    error(post(client, request_body()), 503, "DATABASE_UNAVAILABLE")
    error(post(client, request_body(destinationFacilityId="facility-navjeevan-phc", medicineId=FIXTURE_INSULIN, quantity=45)), 503, "DATABASE_UNAVAILABLE")


def test_missing_or_tools_returns_503(client, monkeypatch):
    monkeypatch.setitem(sys.modules, "ortools.sat.python", None)
    assert "OR-Tools is not installed" in error(post(client, request_body()), 503, "OPTIMIZER_UNAVAILABLE")


# ---- Read-only and deterministic ----


def test_mysql_optimization_only_reads():
    client, database = optimizer_client()
    assert post(client, request_body()).status_code == 200
    assert post(client, request_body(quantity=100000)).status_code == 422
    assert database.connections == 2
    assert database.queries and all(sql.strip().upper().startswith("SELECT") for sql, _ in database.queries)
    for module in (optimizer, allocation_solver):
        source = inspect.getsource(module)
        assert "pymysql" not in source and "cursor" not in source
        assert not any(re.search(rf"\b{keyword}\s+(INTO|TABLE|FROM|\w+\s+SET)\b", source) for keyword in WRITE_KEYWORDS)


def test_fixture_store_forecast_and_simulation_are_unchanged_by_optimization(fixture_client):
    store = fixture_client.app.state.data_source.store
    inventory_before, routes_before = dict(store.inventory), dict(store.routes)
    forecast = {"facilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN}
    scenario = transfer("facility-central-store", "facility-navjeevan-phc", 45, medicine=FIXTURE_INSULIN)
    forecast_before, simulation_before = fixture_client.post("/forecast", json=forecast).content, simulate(fixture_client, scenario).content
    for quantity in (45, 300, 5000):
        post(fixture_client, {"destinationFacilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN, "quantity": quantity})
    assert (store.inventory, store.routes) == (inventory_before, routes_before)
    assert fixture_client.post("/forecast", json=forecast).content == forecast_before
    assert simulate(fixture_client, scenario).content == simulation_before
    assert json.loads(forecast_before)["risk"]["score"] == 83


def test_identical_requests_return_identical_json(client, fixture_client):
    assert post(client, request_body(quantity=600.25)).content == post(client, request_body(quantity=600.25)).content
    assert post(client, request_body(quantity=100000)).content == post(client, request_body(quantity=100000)).content
    fixture = {"destinationFacilityId": "facility-navjeevan-phc", "medicineId": FIXTURE_INSULIN, "quantity": 45}
    assert post(fixture_client, fixture).content == post(fixture_client, fixture).content


def test_plan_id_is_deterministic_and_depends_on_the_plan():
    first, second = optimizer_client()[0], optimizer_client()[0]
    plan_id = post(first, request_body()).json()["id"]
    assert re.fullmatch(r"plan-[0-9a-f]{32}", plan_id)
    assert post(second, request_body()).json()["id"] == plan_id
    # The numeric database ID of the same destination is the same request.
    assert post(second, request_body(destinationFacilityId="3")).json()["id"] == plan_id
    assert post(second, request_body(quantity=601)).json()["id"] != plan_id
    assert post(second, request_body(horizonDays=7)).json()["id"] != plan_id


# ---- Data sources ----


def test_fixture_and_mysql_identifiers_stay_separate(client, fixture_client):
    error(post(client, request_body(destinationFacilityId="facility-navjeevan-phc", medicineId=FIXTURE_INSULIN)), 404, "FACILITY_NOT_FOUND")
    error(post(fixture_client, request_body(destinationFacilityId="PHC-VLR-001")), 404, "FACILITY_NOT_FOUND")
    error(post(fixture_client, request_body(destinationFacilityId="facility-navjeevan-phc", medicineId="7")), 404, "MEDICINE_NOT_FOUND")
    body = post(client, request_body(medicineId=FIXTURE_INSULIN)).json()
    assert body["medicine"]["id"] == "7" and body["dataContext"]["dataSource"] == "MYSQL"
    assert all(item["facilityId"].endswith("-SIM-001") for item in body["candidates"])
    assert all(item["fromFacilityId"].endswith("-SIM-001") and isinstance(item["batchId"], int) for item in body["transfers"])


# ---- Contract ----


def test_plan_response_contract_for_node(client):
    body = post(client, request_body()).json()
    assert {"id", "status", "medicine", "destinationFacilityId", "requestedQuantity", "allocatedQuantity", "horizonDays", "solver", "transfers",
            "rationale", "assumptions", "limitations", "simulation", "decisionSupportOnly", "requiresHumanApproval", "dataContext"} <= body.keys()
    assert body["medicine"] == {"id": "7", "genericName": "Human Insulin", "strength": "100 IU/mL", "dosageForm": "Vial", "unit": "mL",
                                "criticality": "CRITICAL", "requiresColdChain": True}
    assert {"name", "status", "quantityScale", "objectiveValue", "objectiveStages", "hardConstraints"} <= body["solver"].keys()
    assert [stage["name"] for stage in body["solver"]["objectiveStages"]] == ["RECIPIENT_SHORTAGE", "DONOR_PROTECTION", "LOGISTICS"]
    assert {"fromFacilityId", "toFacilityId", "medicineId", "batchId", "batchNo", "quantity", "unit", "departureDay", "arrivalDay",
            "distanceKm", "travelHours"} <= body["transfers"][0].keys()
    assert body["simulation"]["scenarioType"] == "SIMULATED_DATABASE"
    assert (body["dataContext"]["dataSource"], body["dataContext"]["simulationDate"]) == ("MYSQL", "2026-09-11")
    mapping_names = {item["name"] for item in body["dataContext"]["mappings"]}
    assert {"equityReserve", "travelTimeLimit", "donorReceivedStockOnly", "batchIdentity", "quantityScale", "routes", "coldChain"} <= mapping_names
    guardrail = body["equityGuardrail"]
    assert (guardrail["status"], guardrail["reviewOwner"], guardrail["maxTravelHours"], guardrail["donorCapacityBasis"]) == (
        "APPROVED_FOR_HACKATHON_PROTOTYPE", "Aaryan", 6.0, "RECEIVED_STOCK_ONLY",
    )
    assumptions = " ".join(body["assumptions"])
    for phrase in ("simulated", "OR-Tools CP-SAT", "never substitutes", "approve every operational transfer", "hundredths", "at most 6 hours", "stock already received"):
        assert phrase in assumptions
    assert any("not clinically validated" in item for item in body["limitations"])
    assert any("clinical, regulatory and operational validation" in item for item in body["limitations"])
    assert any("Nothing is written" in item for item in body["limitations"])
    assert "confidence" not in json.dumps({key: value for key, value in body.items() if key != "simulation"}).lower()


def test_no_safe_plan_contract(client):
    response = post(client, request_body(quantity=100000))
    assert error(response, 422, "NO_SAFE_PLAN") == "No safe regional redistribution plan can satisfy the requested quantity."
    info = details(response)
    assert {"requestedQuantity", "safeCapacity", "unmetQuantity", "candidatesConsidered", "eligibleCandidates", "rejectedCandidates",
            "recommendedEscalation", "explanation", "solverStatus", "attempts", "dataContext"} <= info.keys()
    assert info["solverStatus"] == "INFEASIBLE" and info["decisionSupportOnly"] is True
    rejected = {item["facilityId"]: item["rejectionCodes"] for item in info["rejectedCandidates"]}
    assert rejected == {
        "CHC-SIM-001": ["COLD_CHAIN_UNAVAILABLE", "NO_SAFE_DONOR_CAPACITY"],
        "DH-SIM-001": ["NO_SAFE_DONOR_CAPACITY"],
        "SC-SIM-001": ["TRAVEL_TIME_LIMIT_EXCEEDED"],
    }
    assert info["equityGuardrail"]["maxTravelHours"] == 6.0
    assert "transfers" not in response.json()


def test_destination_is_listed_but_never_a_donor(client):
    body = post(client, request_body()).json()
    destination = candidate(body, "PHC-SIM-001")
    assert (destination["status"], destination["rejectionCodes"]) == ("REJECTED", ["DESTINATION_FACILITY"])
    assert all(item["fromFacilityId"] != "PHC-SIM-001" for item in body["transfers"])
