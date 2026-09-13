"""POST /scenarios/simulate contract: validation, errors, read-only behaviour, determinism and forecast consistency."""

import inspect

import pytest
from fastapi.testclient import TestClient

from app import mysql_store
from app.data_store import SimulatedDataStore
from app.main import create_app
from app.mysql_store import MySQLDataSource
from tests.simulator_support import (
    SETTINGS,
    WRITE_KEYWORDS,
    FakeDatabase,
    facility,
    mysql_client,
    simulate,
    transfer,
    unavailable_connector,
)

FACILITY_FIELDS = {
    "facilityId", "facilityName", "effectiveStock", "protectedStock", "predictedDailyDemand", "daysRemaining", "stockoutDay",
    "shortageDays", "unmetDemand", "minimumProjectedStock", "riskScore", "riskLabel", "projectedDailyStock",
}
FIXTURE_IDS = ("facility-central-store", "facility-district-hospital", "facility-river-chc", "facility-navjeevan-phc")


@pytest.fixture()
def client():
    return mysql_client()[0]


@pytest.fixture()
def fixture_client():
    return TestClient(create_app(SimulatedDataStore.from_csv()))


def post(client, body):
    return client.post("/scenarios/simulate", json=body)


def error(response, status, code):
    assert response.status_code == status, response.text
    body = response.json()["error"]
    assert body["code"] == code
    return body["message"]


@pytest.mark.parametrize("horizon", [0, 10, 31, "14", 14.0, True, None])
def test_invalid_horizon_returns_422(client, horizon):
    message = error(post(client, {"horizonDays": horizon, "transfers": [transfer("WH-SIM-001", "PHC-SIM-001", 5)]}), 422, "INVALID_HORIZON")
    assert message == "horizonDays must be one of 7, 14 or 30."


def test_horizon_defaults_to_14(client):
    response = post(client, {"transfers": [transfer("WH-SIM-001", "PHC-SIM-001", 5)]})
    assert response.status_code == 200 and response.json()["horizonDays"] == 14


def test_transfers_are_required_and_not_empty(client):
    assert error(post(client, {"horizonDays": 14}), 422, "INVALID_REQUEST") == "transfers is required."
    assert "at least one transfer" in error(post(client, {"horizonDays": 14, "transfers": []}), 422, "INVALID_REQUEST")
    too_many = [transfer("WH-SIM-001", "PHC-SIM-001", 1)] * 51
    error(post(client, {"horizonDays": 14, "transfers": too_many}), 422, "INVALID_REQUEST")


@pytest.mark.parametrize("quantity", [0, -5, -0.01, "10", True, None, float("nan")])
def test_invalid_quantity_returns_422(client, quantity):
    body = {"horizonDays": 14, "transfers": [transfer("WH-SIM-001", "PHC-SIM-001", 5)]}
    body["transfers"][0]["quantity"] = quantity
    if quantity != quantity:  # NaN cannot be sent as JSON
        response = client.post("/scenarios/simulate", content='{"horizonDays": 14, "transfers": [{"fromFacilityId": "WH-SIM-001", '
                               '"toFacilityId": "PHC-SIM-001", "medicineId": "7", "quantity": NaN}]}', headers={"content-type": "application/json"})
        assert response.status_code == 422
        return
    message = error(post(client, body), 422, "INVALID_REQUEST")
    assert "transfers.0.quantity" in message


@pytest.mark.parametrize("arrival_day", [0, -1, 1.5, "1", True])
def test_invalid_arrival_day_returns_422(client, arrival_day):
    message = error(post(client, {"transfers": [transfer("WH-SIM-001", "PHC-SIM-001", 5, arrival_day=arrival_day)]}), 422, "INVALID_REQUEST")
    assert "arrivalDay" in message


def test_same_source_and_destination_returns_422(client):
    message = error(post(client, {"transfers": [transfer("PHC-SIM-001", "PHC-SIM-001", 5)]}), 422, "INVALID_REQUEST")
    assert "must be different" in message


def test_missing_transfer_fields_return_422(client):
    message = error(post(client, {"transfers": [{"fromFacilityId": "WH-SIM-001", "medicineId": "7", "quantity": 5}]}), 422, "INVALID_REQUEST")
    assert message == "transfers.0.toFacilityId is required."


def test_unknown_medicine_returns_404(client):
    message = error(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 5, medicine="999")), 404, "MEDICINE_NOT_FOUND")
    assert message == "Medicine '999' was not found in the MEDRIPPLE MySQL database."


def test_database_outage_returns_503_and_never_uses_the_fixture():
    app = create_app(data_source=MySQLDataSource(SETTINGS, connector=unavailable_connector()))
    client = TestClient(app)
    for body in (transfer("WH-SIM-001", "PHC-SIM-001", 5), transfer("facility-central-store", "facility-navjeevan-phc", 5, medicine="med-insulin-100iu-vial")):
        error(simulate(client, body), 503, "DATABASE_UNAVAILABLE")


def test_mysql_simulation_only_reads(client):
    client, database = mysql_client()
    assert simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 980), transfer("WH-SIM-001", "PHC-SIM-001", 600)).status_code == 200
    assert database.connections == 1
    assert database.queries and all(sql.strip().upper().startswith("SELECT") for sql, _ in database.queries)
    for name, value in vars(mysql_store).items():
        if name.endswith("_SQL"):
            assert not any(keyword in value.upper().split() for keyword in WRITE_KEYWORDS), name
    assert 'init_command="SET SESSION TRANSACTION READ ONLY"' in inspect.getsource(mysql_store.pymysql_connector)


def test_fixture_store_is_not_mutated_by_simulation(fixture_client):
    store = fixture_client.app.state.data_source.store
    inventory_before, routes_before = dict(store.inventory), dict(store.routes)
    forecast_before = fixture_client.post("/forecast", json={"facilityId": "facility-navjeevan-phc", "medicineId": "med-insulin-100iu-vial"}).json()
    for quantity in (45, 500):
        simulate(fixture_client, transfer("facility-central-store", "facility-navjeevan-phc", quantity, medicine="med-insulin-100iu-vial"))
    assert (store.inventory, store.routes) == (inventory_before, routes_before)
    assert fixture_client.post("/forecast", json={"facilityId": "facility-navjeevan-phc", "medicineId": "med-insulin-100iu-vial"}).json() == forecast_before
    assert forecast_before["forecast"]["dailyDemand"] == 8.06 and forecast_before["risk"]["score"] == 83


def test_identical_requests_return_identical_json(client, fixture_client):
    request = [transfer("DH-SIM-001", "PHC-SIM-001", 400.5), transfer("WH-SIM-001", "PHC-SIM-001", 250.25, arrival_day=2)]
    assert simulate(client, *request).content == simulate(client, *request).content
    fixture_request = transfer("facility-central-store", "facility-navjeevan-phc", 45, medicine="med-insulin-100iu-vial")
    assert simulate(fixture_client, fixture_request).content == simulate(fixture_client, fixture_request).content


def assert_baseline_matches_forecast(client, body, facility_ids, medicine_id, horizon):
    for facility_id in facility_ids:
        item = facility(body["baseline"], facility_id)
        forecast = client.post("/forecast", json={"facilityId": facility_id, "medicineId": medicine_id, "horizonDays": horizon}).json()
        assert item["predictedDailyDemand"] == forecast["forecast"]["dailyDemand"], facility_id
        assert (item["riskScore"], item["riskLabel"]) == (forecast["risk"]["score"], forecast["risk"]["label"]), facility_id
        assert (item["stockoutDay"], item["shortageDays"], item["unmetDemand"]) == (
            forecast["stockout"]["projectedStockoutDay"], forecast["stockout"]["totalShortageDays"], forecast["stockout"]["unmetDemand"],
        ), facility_id
        assert (item["effectiveStock"], item["protectedStock"], item["daysRemaining"]) == (
            forecast["inventory"]["effectiveStock"], forecast["inventory"]["protectedStock"], forecast["stockout"]["daysRemaining"],
        ), facility_id
        assert item["minimumProjectedStock"] == forecast["stockout"]["minimumProjectedStock"], facility_id
        assert [day["closingStock"] for day in item["projectedDailyStock"]] == [day["closingStock"] for day in forecast["projection"]], facility_id


@pytest.mark.parametrize("horizon", [7, 14, 30])
def test_fixture_baseline_matches_post_forecast(fixture_client, horizon):
    body = simulate(fixture_client, transfer("facility-central-store", "facility-navjeevan-phc", 45, medicine="med-insulin-100iu-vial"), horizon=horizon).json()
    assert_baseline_matches_forecast(fixture_client, body, FIXTURE_IDS, "med-insulin-100iu-vial", horizon)


@pytest.mark.parametrize("medicine_id", ["7", "1", "10"])
def test_mysql_baseline_matches_post_forecast(client, medicine_id):
    body = simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 5, medicine=medicine_id)).json()
    clinical = [item["facilityId"] for item in body["baseline"]["facilities"] if item["demandBasis"] == "FORECAST"]
    assert "PHC-SIM-001" in clinical and "WH-SIM-001" not in clinical
    assert_baseline_matches_forecast(client, body, clinical, medicine_id, 14)


def test_fixture_and_mysql_identifiers_stay_separate(client, fixture_client):
    error(simulate(fixture_client, transfer("WH-TN-001", "PHC-VLR-001", 5, medicine="7")), 404, "MEDICINE_NOT_FOUND")
    fixture_body = simulate(fixture_client, transfer("PHC-VLR-001", "facility-navjeevan-phc", 5, medicine="med-insulin-100iu-vial")).json()
    assert fixture_body["transferEvaluations"][0]["rejectionCodes"] == ["SOURCE_FACILITY_NOT_FOUND"]

    mysql_body = simulate(client, transfer("facility-central-store", "facility-navjeevan-phc", 5, medicine="med-insulin-100iu-vial")).json()
    assert mysql_body["transferEvaluations"][0]["rejectionCodes"] == ["SOURCE_FACILITY_NOT_FOUND", "DESTINATION_FACILITY_NOT_FOUND"]
    assert mysql_body["dataContext"]["dataSource"] == "MYSQL"
    assert not any(item["facilityId"].startswith("facility-") for item in mysql_body["baseline"]["facilities"])


def test_mysql_stores_never_carry_fixture_routes():
    source = MySQLDataSource(SETTINGS, connector=FakeDatabase().connect)
    assert source.store_for("PHC-SIM-001", "7").routes is None
    routes = source.regional_store_for(["7"]).routes
    assert routes and all(key[0].endswith("-SIM-001") and key[1].endswith("-SIM-001") for key in routes)


def test_response_contract_for_the_frontend_and_node(client):
    body = simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 980)).json()
    assert {"horizonDays", "medicine", "baseline", "intervention", "transferEvaluations", "comparison", "assumptions", "limitations",
            "decisionSupportOnly", "dataContext", "scenarioType", "medicineId"} <= body.keys()
    assert body["medicine"] == {"id": "7", "genericName": "Human Insulin", "strength": "100 IU/mL", "dosageForm": "Vial", "unit": "mL",
                                "criticality": "CRITICAL", "requiresColdChain": True}
    for block in (body["baseline"], body["intervention"]):
        assert {"criticalFacilityCount", "regionalShortageDays", "regionalUnmetDemand", "facilities"} <= block.keys()
        assert all(FACILITY_FIELDS <= item.keys() for item in block["facilities"])
    assert {"fromFacilityId", "toFacilityId", "medicineId", "quantity", "arrivalDay", "eligible", "rejectionReasons", "route"} <= body["transferEvaluations"][0].keys()
    assert {"recipientStockoutPrevented", "newRisks", "improvedFacilities", "worsenedFacilities", "shortageDaysPrevented",
            "unmetDemandReduced", "regionalRiskBefore", "regionalRiskAfter", "safeToRecommend", "newShortagesCreated"} <= body["comparison"].keys()
    assert body["decisionSupportOnly"] is True and body["scenarioType"] == "SIMULATED_DATABASE"
    assert (body["dataContext"]["dataSource"], body["dataContext"]["simulationDate"], body["dataContext"]["unit"]) == ("MYSQL", "2026-09-11", "mL")
    assert {"routes", "coldChain", "donorSafety"} <= {mapping["name"] for mapping in body["dataContext"]["mappings"]}
    assert any("approve every operational transfer" in text for text in body["assumptions"])
    assert any("never substitutes" in text for text in body["assumptions"])
    assert any("simulated" in text for text in body["assumptions"]) and body["limitations"]
