"""Opt-in Ripple Simulator tests against the real seeded MySQL database. Skipped unless MEDRIPPLE_LIVE_MYSQL=1.

PowerShell example, with the Compose MySQL published on 127.0.0.1:3307:
    $env:MEDRIPPLE_LIVE_MYSQL = "1"; $env:DATABASE_PORT = "3307"; $env:DATABASE_PASSWORD = "medripple_dev_only"
    .\\.venv\\Scripts\\python -m pytest tests/test_simulator_live.py
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
def settings():
    return load_settings({**os.environ, "DATA_SOURCE": "mysql"})


@pytest.fixture(scope="module")
def client(settings):
    return TestClient(create_app(data_source=build_data_source(settings)))


def simulate(client, *transfers, horizon=14):
    return client.post("/scenarios/simulate", json={"horizonDays": horizon, "transfers": list(transfers)})


def transfer(source, destination, quantity, medicine="7", arrival_day=1):
    return {"fromFacilityId": source, "toFacilityId": destination, "medicineId": medicine, "quantity": quantity, "arrivalDay": arrival_day}


def facility(block, facility_id):
    return next(item for item in block["facilities"] if item["facilityId"] == facility_id)


def table_state(settings):
    import pymysql

    connection = pymysql.connect(
        host=settings.database_host, port=settings.database_port, user=settings.database_user,
        password=settings.database_password, database=settings.database_name, init_command="SET SESSION TRANSACTION READ ONLY",
    )
    try:
        with connection.cursor() as cursor:
            state = {}
            for table in ("inventory", "batches", "replenishments", "transfers", "audit_events"):
                cursor.execute(f"SELECT COUNT(*) FROM {table}")
                state[table] = cursor.fetchone()[0]
            cursor.execute("SELECT COALESCE(SUM(quantity_on_hand), 0) FROM inventory")
            state["inventory_quantity"] = cursor.fetchone()[0]
            return state
    finally:
        connection.close()


def test_vellore_is_critical_and_a_warehouse_transfer_prevents_its_stockout(client):
    response = simulate(client, transfer("WH-TN-001", "PHC-VLR-001", 300))
    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["medicine"]["unit"], body["dataContext"]["dataSource"], body["dataContext"]["simulationDate"]) == ("mL", "MYSQL", "2026-09-11")
    before, after = facility(body["baseline"], "PHC-VLR-001"), facility(body["intervention"], "PHC-VLR-001")
    assert (before["stockoutDay"], before["riskLabel"]) == (1, "CRITICAL")
    assert after["stockoutDay"] is None and after["transferIn"] == 300.0
    assert body["transferEvaluations"][0]["eligible"] is True
    assert body["comparison"]["recipientStockoutPrevented"] is True


def test_unsafe_donors_are_visibly_rejected(client):
    body = simulate(client, transfer("DH-CBE-001", "PHC-VLR-001", 2000), transfer("PHC-TNJ-001", "PHC-VLR-001", 10)).json()
    drained, no_cold_chain = body["transferEvaluations"]
    assert drained["eligible"] is False and "BELOW_PROTECTED_STOCK" in drained["rejectionCodes"]
    assert no_cold_chain["rejectionCodes"] == ["COLD_CHAIN_UNAVAILABLE"]
    assert body["comparison"]["safeToRecommend"] is False


def test_a_second_medicine_keeps_its_mg_unit(client):
    body = simulate(client, transfer("WH-TN-001", "CHC-TRY-001", 1000.5, medicine="1")).json()
    assert (body["medicine"]["id"], body["medicine"]["unit"]) == ("1", "mg")
    assert body["transferEvaluations"][0]["route"] is not None
    assert facility(body["intervention"], "CHC-TRY-001")["transferIn"] == 1000.5


def test_simulation_is_read_only_and_deterministic(client, settings):
    before = table_state(settings)
    request = (transfer("WH-TN-001", "PHC-VLR-001", 300), transfer("DH-CBE-001", "PHC-VLR-001", 2000))
    first, second = simulate(client, *request), simulate(client, *request)
    assert first.status_code == 200 and first.content == second.content
    assert table_state(settings) == before
