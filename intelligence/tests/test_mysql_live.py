"""Opt-in tests against the real seeded MySQL database. Skipped unless MEDRIPPLE_LIVE_MYSQL=1.

PowerShell example, with the Compose MySQL published on 127.0.0.1:3307:
    $env:MEDRIPPLE_LIVE_MYSQL = "1"; $env:DATABASE_PORT = "3307"; $env:DATABASE_PASSWORD = "medripple_dev_only"
    .\\.venv\\Scripts\\python -m pytest tests/test_mysql_live.py
"""

import os

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import build_data_source, create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("MEDRIPPLE_LIVE_MYSQL") != "1",
    reason="Set MEDRIPPLE_LIVE_MYSQL=1 and DATABASE_* to test against the seeded MySQL database.",
)


@pytest.fixture(scope="module")
def client():
    # conftest.py pins DATA_SOURCE=fixture for the ordinary suite; this module opts into MySQL explicitly.
    settings = load_settings({**os.environ, "DATA_SOURCE": "mysql"})
    return TestClient(create_app(data_source=build_data_source(settings)))


def post_forecast(client, facility_id, medicine_id, horizon=14):
    return client.post("/forecast", json={"facilityId": facility_id, "medicineId": medicine_id, "horizonDays": horizon})


def test_vellore_phc_insulin_uses_database_units_and_dates(client):
    response = post_forecast(client, "PHC-VLR-001", "7")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["forecast"]["unit"] == "mL"
    assert (body["inventory"]["effectiveStock"], body["inventory"]["protectedStock"]) == (34.0, 548.8)
    assert body["inventory"]["nextReplenishment"] == {"quantity": 1372.0, "arrivalDay": 8, "arrivalDate": "2026-09-19", "status": "DELAYED"}
    context = body["dataContext"]
    assert (context["dataSource"], context["simulationDate"], context["asOfDate"]) == ("MYSQL", "2026-09-11", "2026-09-12")
    assert body["stockout"]["projectedStockoutDay"] == 1
    assert (body["risk"]["label"], body["cause"]) == ("CRITICAL", "SUPPLY_DELAY")


def test_another_clinical_facility_and_medicine_use_the_same_code_path(client):
    response = post_forecast(client, "CHC-TRY-001", "1")
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["facility"]["id"], body["medicine"]["id"], body["forecast"]["unit"]) == ("CHC-TRY-001", "1", "mg")
    assert body["inventory"]["protectedStockSource"] == "FACILITY_SAFETY_STOCK"
    assert body["dataContext"]["dataSource"] == "MYSQL"


def test_warehouse_without_consumption_reports_no_consumption_history(client):
    response = post_forecast(client, "WH-TN-001", "7")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "NO_CONSUMPTION_HISTORY"


def test_fixture_identifiers_are_not_served_from_mysql(client):
    response = post_forecast(client, "facility-navjeevan-phc", "med-insulin-100iu-vial")
    assert (response.status_code, response.json()["error"]["code"]) == (404, "FACILITY_NOT_FOUND")
