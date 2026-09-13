"""MySQL data source tests on in-memory rows: no Docker, MySQL server or network needed.

The rows use test-only facility codes, so passing tests cannot depend on the Vellore seed.
"""

from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.config import FIXTURE, MYSQL, Settings, load_settings
from app.data_store import PROTECTED_STOCK_NOT_RECORDED, PROTECTED_STOCK_RECORDED, Replenishment
from app.main import FixtureDataSource, build_data_source, create_app
from app.mysql_store import (
    CONSUMPTION_SQL,
    FACILITIES_SQL,
    INVENTORY_SQL,
    MEDICINES_SQL,
    REPLENISHMENTS_SQL,
    SAFETY_STOCK_SQL,
    DatabaseDataError,
    DatabaseUnavailableError,
    MySQLDataSource,
    normalise_facility,
)
from app.risk_engine import (
    INVENTORY_IMBALANCE,
    CauseAssessment,
    _per_day,
    _quantity,
    analyse_shortage,
    build_explanation,
    protected_stock_for,
    score_risk,
)
from app.stock_projection import project_stock
from tests.test_api import NODE_ADAPTER, run_node_validator
from tests.test_risk_engine import confidence, navjeevan_facility_data

SIMULATION_DATE = date(2026, 9, 11)
SETTINGS = Settings(data_source=MYSQL, simulation_date=SIMULATION_DATE)
INSULIN, PARACETAMOL = 7, 1
WAREHOUSE, PHC, CHC = 1, 2, 3

MEDICINE_ROWS = [
    {
        "medicine_id": PARACETAMOL, "generic_name": "Paracetamol", "strength_value": Decimal("500.000"), "strength_unit": "mg",
        "form": "Tablet", "base_unit": "mg", "storage_temp_min_c": Decimal("15.0"), "storage_temp_max_c": Decimal("30.0"),
        "criticality_level": "MEDIUM",
    },
    {
        "medicine_id": INSULIN, "generic_name": "Human Insulin", "strength_value": Decimal("100.000"), "strength_unit": "IU/mL",
        "form": "Vial", "base_unit": "mL", "storage_temp_min_c": Decimal("2.0"), "storage_temp_max_c": Decimal("8.0"),
        "criticality_level": "CRITICAL",
    },
]

FACILITY_ROWS = [
    {"facility_id": WAREHOUSE, "facility_code": "WH-TEST-001", "name": "Test Warehouse", "facility_type": "Warehouse",
     "region": "North", "remoteness_score": Decimal("0.50")},
    {"facility_id": PHC, "facility_code": "PHC-TEST-001", "name": "Test Primary Health Centre", "facility_type": "PHC",
     "region": "East", "remoteness_score": Decimal("4.00")},
    {"facility_id": CHC, "facility_code": "CHC-TEST-001", "name": "Test Community Health Centre", "facility_type": "CHC",
     "region": "West", "remoteness_score": Decimal("3.10")},
]


def inventory_row(facility_id, medicine_id, batch, quantity, status="AVAILABLE", expiry=date(2028, 4, 24), quarantined=0):
    return {"facility_id": facility_id, "medicine_id": medicine_id, "batch_number": batch, "quantity_on_hand": Decimal(quantity),
            "status": status, "expiry_date": expiry, "quarantined": quarantined}


INVENTORY_ROWS = [
    inventory_row(WAREHOUSE, INSULIN, "TN-007-B02-26", "102240.00"),
    inventory_row(PHC, INSULIN, "TN-007-B01-26", "12.25", expiry=date(2028, 2, 29)),
    inventory_row(PHC, INSULIN, "TN-007-B02-26", "21.50"),
    inventory_row(PHC, INSULIN, "TN-007-B03-26", "5.75", quarantined=1),
    inventory_row(PHC, INSULIN, "TN-007-B04-26", "3.00", status="EXPIRED", expiry=date(2026, 9, 1)),
    inventory_row(PHC, INSULIN, "TN-007-B05-26", "2.00", status="RESERVED"),
    inventory_row(PHC, INSULIN, "TN-007-B06-26", "1.25", expiry=SIMULATION_DATE),
    inventory_row(CHC, INSULIN, "TN-007-B02-26", "1285.48"),
    inventory_row(CHC, PARACETAMOL, "TN-001-B01-26", "12000.25", expiry=date(2026, 9, 10)),
    inventory_row(CHC, PARACETAMOL, "TN-001-B02-26", "80000.50"),
]

SAFETY_ROWS = [
    {"facility_id": PHC, "medicine_id": INSULIN, "safety_stock_qty": Decimal("548.80"), "confirmed_by_aaryan": 0},
    {"facility_id": CHC, "medicine_id": INSULIN, "safety_stock_qty": Decimal("700.25"), "confirmed_by_aaryan": 0},
    {"facility_id": CHC, "medicine_id": PARACETAMOL, "safety_stock_qty": Decimal("60000.25"), "confirmed_by_aaryan": 1},
]


def replenishment_row(facility_id, medicine_id, expected, quantity, status):
    return {"facility_id": facility_id, "medicine_id": medicine_id, "quantity": Decimal(quantity),
            "expected_arrival_date": expected, "status": status}


REPLENISHMENT_ROWS = [
    replenishment_row(PHC, INSULIN, date(2026, 8, 3), "1097.60", "ARRIVED"),
    replenishment_row(PHC, INSULIN, date(2026, 9, 10), "80.00", "SCHEDULED"),  # overdue, still open
    replenishment_row(PHC, INSULIN, SIMULATION_DATE, "60.00", "DELAYED"),  # due on the snapshot day, not arrived
    replenishment_row(PHC, INSULIN, date(2026, 9, 15), "500.00", "CANCELLED"),
    replenishment_row(PHC, INSULIN, date(2026, 9, 19), "1372.40", "DELAYED"),
    replenishment_row(PHC, INSULIN, date(2026, 9, 25), "200.50", "SCHEDULED"),
    replenishment_row(CHC, PARACETAMOL, date(2026, 8, 20), "147000.00", "ARRIVED"),
]


def daily_rows(facility_id, medicine_id, quantity_for, first=date(2026, 6, 29), last=SIMULATION_DATE):
    return [
        {"facility_id": facility_id, "medicine_id": medicine_id, "consumption_date": first + timedelta(days=offset),
         "quantity_consumed": quantity_for(first + timedelta(days=offset))}
        for offset in range((last - first).days + 1)
    ]


def phc_insulin_quantity(day):
    """Latest 7 days (2026-09-05..11) average 41.5 mL, the 21 days before them 30 mL, older days 20 mL."""
    if day == SIMULATION_DATE:
        return Decimal("47.50")
    if day >= date(2026, 9, 5):
        return Decimal("40.50")
    if day >= date(2026, 8, 15):
        return Decimal("30.00")
    return Decimal("20.00")


CONSUMPTION_ROWS = (
    daily_rows(PHC, INSULIN, phc_insulin_quantity)
    + daily_rows(CHC, INSULIN, lambda day: Decimal("50.00"))
    + daily_rows(CHC, PARACETAMOL, lambda day: Decimal("5250.75"))
)  # The warehouse has no consumption rows, as in the seed.


class FakeDatabase:
    """Stands in for MySQL: returns the rows each query would select and records the queries."""

    def __init__(self, **tables):
        self.tables = {
            "medicines": MEDICINE_ROWS, "facilities": FACILITY_ROWS, "inventory": INVENTORY_ROWS, "safety": SAFETY_ROWS,
            "replenishments": REPLENISHMENT_ROWS, "consumption": CONSUMPTION_ROWS, **tables,
        }
        self.queries = []
        self.connections = 0

    @contextmanager
    def connect(self):
        self.connections += 1
        yield self.run

    def run(self, sql, params):
        self.queries.append((sql, tuple(params)))
        if sql == MEDICINES_SQL:
            return list(self.tables["medicines"])
        if sql == FACILITIES_SQL:
            return list(self.tables["facilities"])
        table = {INVENTORY_SQL: "inventory", SAFETY_STOCK_SQL: "safety", REPLENISHMENTS_SQL: "replenishments", CONSUMPTION_SQL: "consumption"}[sql]
        rows = [row for row in self.tables[table] if row["medicine_id"] == params[0]]
        if sql == CONSUMPTION_SQL:
            rows = [row for row in rows if params[1] <= row["consumption_date"] <= params[2]]
        return rows


def unavailable_connector():
    @contextmanager
    def connect():
        raise DatabaseUnavailableError("The MEDRIPPLE MySQL database at 127.0.0.1:3307/medripple is unavailable (OperationalError 2003).")
        yield  # pragma: no cover

    return connect


def mysql_source(database=None):
    database = database or FakeDatabase()
    return MySQLDataSource(SETTINGS, connector=database.connect), database


def mysql_client(database=None):
    source, database = mysql_source(database)
    return TestClient(create_app(data_source=source)), database


def post_forecast(client, facility_id, medicine_id, horizon=14):
    return client.post("/forecast", json={"facilityId": facility_id, "medicineId": medicine_id, "horizonDays": horizon})


def test_store_resolves_codes_numeric_ids_and_the_documented_alias():
    source, _ = mysql_source()
    store = source.store_for("PHC-TEST-001", "med-insulin-100iu-vial")
    assert store.get_medicine("med-insulin-100iu-vial").id == "7"
    assert store.get_medicine("7").unit == "mL"
    assert store.get_facility("2").id == "PHC-TEST-001"
    assert "medicineAlias" in {mapping.name for mapping in store.context.mappings}
    assert source.store_for("PHC-TEST-001", "med-unknown").get_medicine("med-unknown") is None


def test_effective_stock_keeps_decimals_and_excludes_unusable_batches():
    store = mysql_source()[0].store_for("PHC-TEST-001", "7")
    snapshot = store.get_inventory("PHC-TEST-001", "7")
    assert [batch.quantity for batch in snapshot.batches[:2]] == [12.25, 21.5]
    assert snapshot.recorded_stock == 45.75
    # AVAILABLE, non-quarantined and expiring on or after day 1 (2026-09-12): only B01 and B02.
    assert snapshot.effective_stock(store.as_of) == 33.75
    assert {batch.batch_no: batch.status for batch in snapshot.batches} == {
        "TN-007-B01-26": "USABLE",
        "TN-007-B02-26": "USABLE",
        "TN-007-B03-26": "QUARANTINED",
        "TN-007-B04-26": "EXPIRED",
        "TN-007-B05-26": "RESERVED",
        "TN-007-B06-26": "USABLE",  # usable status, but it expires on the simulation date
    }


def test_open_future_replenishments_use_the_backend_arrival_day():
    store = mysql_source()[0].store_for("PHC-TEST-001", "7")
    snapshot = store.get_inventory("PHC-TEST-001", "7")
    assert snapshot.replenishments == (
        Replenishment(quantity=1372.4, arrival_day=8, status="DELAYED", expected_date=date(2026, 9, 19)),
        Replenishment(quantity=200.5, arrival_day=14, status="SCHEDULED", expected_date=date(2026, 9, 25)),
    )
    assert snapshot.overdue_replenishments == 2


def test_history_window_ends_on_the_simulation_date():
    source, database = mysql_source()
    store = source.store_for("PHC-TEST-001", "7")
    assert store.as_of == date(2026, 9, 12)
    assert store.history_window == (date(2026, 7, 14), SIMULATION_DATE)
    assert (CONSUMPTION_SQL, (7, date(2026, 7, 14), SIMULATION_DATE)) in database.queries
    history = store.consumption_history("PHC-TEST-001", "7")
    assert len(history) == 60
    assert (history[-1].day, history[-1].units) == (SIMULATION_DATE, 47.5)
    assert database.connections == 1


def test_protected_stock_comes_from_safety_stock_and_missing_rows_are_explicit():
    store = mysql_source()[0].store_for("PHC-TEST-001", "7")
    phc = store.get_inventory("PHC-TEST-001", "7")
    warehouse = store.get_inventory("WH-TEST-001", "7")
    assert (phc.protected_stock, phc.protected_stock_source, phc.protected_stock_confirmed) == (548.8, PROTECTED_STOCK_RECORDED, False)
    assert (warehouse.protected_stock, warehouse.protected_stock_source, warehouse.protected_stock_confirmed) == (
        0.0, PROTECTED_STOCK_NOT_RECORDED, None,
    )
    facility = store.get_facility("PHC-TEST-001")
    assert (facility.remoteness_score, facility.source_remoteness_score, facility.protected_days) == (0.4, 4.0, None)


@pytest.mark.parametrize("stored, scaled", [(Decimal("2.30"), 0.23), (Decimal("7.80"), 0.78), (Decimal("0.00"), 0.0), (Decimal("10.00"), 1.0)])
def test_remoteness_scaling_has_no_float_artifacts(stored, scaled):
    row = {**FACILITY_ROWS[1], "remoteness_score": stored}
    assert normalise_facility(row).remoteness_score == scaled


def test_every_database_facility_holding_the_medicine_is_a_peer():
    store = mysql_source()[0].store_for("PHC-TEST-001", "7")
    assert [peer.id for peer in store.regional_peers(store.get_facility("PHC-TEST-001"), "7")] == ["WH-TEST-001", "CHC-TEST-001"]


def test_values_outside_the_schema_contract_are_rejected():
    far = [{**row, "remoteness_score": Decimal("12.00")} if row["facility_id"] == PHC else row for row in FACILITY_ROWS]
    with pytest.raises(DatabaseDataError, match="between 0 and 10"):
        mysql_source(FakeDatabase(facilities=far))[0].store_for("PHC-TEST-001", "7")
    vials = [{**row, "base_unit": "vial"} if row["medicine_id"] == INSULIN else row for row in MEDICINE_ROWS]
    with pytest.raises(DatabaseDataError, match="base_unit"):
        mysql_source(FakeDatabase(medicines=vials))[0].store_for("PHC-TEST-001", "7")


def test_mysql_forecast_reports_units_decimals_replenishment_and_context():
    client, _ = mysql_client()
    response = post_forecast(client, "PHC-TEST-001", "7")
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["forecast"]["unit"] == "mL"
    assert body["forecast"]["dailyDemand"] == 38.05  # 0.70 x 41.5 (latest 7 days, including 2026-09-11) + 0.30 x 30
    inventory = body["inventory"]
    assert (inventory["effectiveStock"], inventory["recordedStock"], inventory["excludedStock"]) == (33.75, 45.75, 12.0)
    assert (inventory["protectedStock"], inventory["protectedStockSource"], inventory["protectedDays"]) == (548.8, "FACILITY_SAFETY_STOCK", None)
    assert inventory["asOfDate"] == "2026-09-12"
    assert inventory["nextReplenishment"] == {"quantity": 1372.4, "arrivalDay": 8, "arrivalDate": "2026-09-19", "status": "DELAYED"}
    assert [item["arrivalDay"] for item in inventory["scheduledReplenishments"]] == [8, 14]

    stockout = body["stockout"]
    assert (stockout["projectedStockoutDay"], stockout["projectedStockoutDate"], stockout["shortageGapDays"]) == (1, "2026-09-12", 7)
    assert stockout["nextReplenishment"]["arrivalDay"] == 8
    assert body["projection"][0] == {
        "day": 1, "date": "2026-09-12", "openingStock": 33.75, "replenishment": 0.0, "demand": 38.05, "closingStock": 0.0, "unmetDemand": 4.3,
    }

    context = body["dataContext"]
    assert (context["dataSource"], context["simulationDate"], context["asOfDate"]) == ("MYSQL", "2026-09-11", "2026-09-12")
    assert (context["historyStart"], context["historyEnd"]) == ("2026-07-14", "2026-09-11")
    mappings = {mapping["name"]: mapping for mapping in context["mappings"]}
    assert set(mappings) == {
        "units", "asOfDate", "medicineCriticality", "facilityRemoteness", "protectedStock", "effectiveStock", "replenishments", "regionalPeers",
    }
    assert mappings["units"]["status"] == "DATABASE_POLICY"
    assert all(mapping["status"] == "PROVISIONAL" for name, mapping in mappings.items() if name != "units")
    assert any(note.startswith("2 open replenishment order(s)") for note in context["notes"])
    assert "facilityRemoteness: Risk signal = remoteness_score / 10 (provisional; review: Aaryan)." in body["assumptions"]

    assert (body["facility"]["remotenessScore"], body["facility"]["sourceRemotenessScore"]) == (0.4, 4.0)
    assert body["medicine"]["criticality"] == "CRITICAL"
    signals = {component["key"]: component["signal"] for component in body["risk"]["components"]}
    assert (signals["medicineCriticality"], signals["facilityRemoteness"]) == (1.0, 0.4)
    assert signals["regionalFragility"] == 0.0  # the warehouse (no safety row) and the CHC both keep a safe surplus
    assert (body["risk"]["score"], body["risk"]["label"], body["cause"]) == (84, "CRITICAL", "SUPPLY_DELAY")
    assert "33.75 mL" in body["explanation"] and "38.05 mL/day" in body["explanation"] and "mLs" not in body["explanation"]


def test_mysql_mode_is_generic_across_facilities_medicines_and_units():
    client, _ = mysql_client()
    body = post_forecast(client, "3", "1").json()  # numeric facility ID for CHC-TEST-001
    assert (body["facility"]["id"], body["medicine"]["id"], body["forecast"]["unit"]) == ("CHC-TEST-001", "1", "mg")
    assert body["forecast"]["dailyDemand"] == 5250.75
    inventory = body["inventory"]
    assert (inventory["effectiveStock"], inventory["recordedStock"]) == (80000.5, 92000.75)  # the batch that expired 2026-09-10 is excluded
    assert (inventory["protectedStock"], inventory["protectedStockConfirmed"]) == (60000.25, True)
    assert (inventory["nextReplenishment"], inventory["scheduledReplenishments"]) == (None, [])
    assert body["dataContext"]["dataSource"] == "MYSQL"
    assert "5250.75 mg/day" in body["explanation"] and "mgs" not in body["explanation"]


def test_alias_request_returns_the_canonical_database_medicine():
    client, _ = mysql_client()
    body = post_forecast(client, "PHC-TEST-001", "med-insulin-100iu-vial").json()
    assert (body["medicine"]["id"], body["forecast"]["unit"]) == ("7", "mL")
    assert "medicineAlias" in {mapping["name"] for mapping in body["dataContext"]["mappings"]}


def test_mysql_mode_never_serves_fixture_identifiers():
    client, _ = mysql_client()
    response = post_forecast(client, "facility-navjeevan-phc", "med-insulin-100iu-vial")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FACILITY_NOT_FOUND"
    assert "MySQL database" in response.json()["error"]["message"]
    unknown = post_forecast(client, "PHC-TEST-001", "med-unknown")
    assert (unknown.status_code, unknown.json()["error"]["code"]) == (404, "MEDICINE_NOT_FOUND")


def test_facility_without_consumption_returns_no_consumption_history():
    client, _ = mysql_client()
    response = post_forecast(client, "WH-TEST-001", "7")
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "NO_CONSUMPTION_HISTORY"
    assert "'WH-TEST-001' (Warehouse) between 2026-07-14 and 2026-09-11" in error["message"]


def test_database_outage_returns_503_and_never_uses_the_fixture():
    client = TestClient(create_app(data_source=MySQLDataSource(SETTINGS, connector=unavailable_connector())))
    for facility_id, medicine_id in (("PHC-TEST-001", "7"), ("facility-navjeevan-phc", "med-insulin-100iu-vial")):
        response = post_forecast(client, facility_id, medicine_id)
        assert response.status_code == 503
        assert response.json()["error"]["code"] == "DATABASE_UNAVAILABLE"


def test_database_values_outside_the_contract_return_500():
    far = [{**row, "remoteness_score": Decimal("12.00")} if row["facility_id"] == PHC else row for row in FACILITY_ROWS]
    client, _ = mysql_client(FakeDatabase(facilities=far))
    response = post_forecast(client, "PHC-TEST-001", "7")
    assert (response.status_code, response.json()["error"]["code"]) == (500, "DATABASE_DATA_INVALID")


def test_mysql_response_passes_the_real_node_adapter_validator():
    if not NODE_ADAPTER.exists():
        pytest.skip("backend adapter unavailable")
    client, _ = mysql_client()
    try:
        result = run_node_validator(post_forecast(client, "PHC-TEST-001", "7").json())
    except FileNotFoundError:
        pytest.skip("Node.js unavailable")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "VALID"


def test_data_source_follows_settings_without_connecting():
    assert isinstance(build_data_source(Settings(data_source=FIXTURE)), FixtureDataSource)
    database = FakeDatabase()
    assert isinstance(build_data_source(SETTINGS, connector=database.connect), MySQLDataSource)
    assert database.connections == 0  # nothing connects until a forecast is requested


def test_load_settings_reads_the_backend_variable_names():
    settings = load_settings(
        {"DATA_SOURCE": "MySQL", "DATABASE_HOST": "db", "DATABASE_PORT": "3307", "DATABASE_PASSWORD": "secret", "SIMULATION_DATE": "2026-09-11"}
    )
    assert (settings.data_source, settings.database_host, settings.database_port, settings.database_password) == ("mysql", "db", 3307, "secret")
    assert settings.simulation_date == SIMULATION_DATE
    assert load_settings({}).data_source == FIXTURE


@pytest.mark.parametrize(
    "environ, message",
    [
        ({"DATA_SOURCE": "postgres"}, "DATA_SOURCE"),
        ({"DATA_SOURCE": "mysql", "SIMULATION_DATE": "11/09/2026"}, "SIMULATION_DATE"),
        ({"DATA_SOURCE": "mysql", "DATABASE_PORT": "abc"}, "DATABASE_PORT"),
        ({"DATA_SOURCE": "mysql", "DATABASE_URL": "mysql://user@host/db"}, "DATABASE_URL"),
    ],
)
def test_load_settings_rejects_invalid_values(environ, message):
    with pytest.raises(ValueError, match=message):
        load_settings(environ)


def test_critical_criticality_is_scored_like_high():
    common = {"projection": project_stock(22, 8.1, 14), "protected_stock": 113.4, "facility_remoteness": 0.8, "regional_fragility": 1 / 3}
    critical = score_risk(medicine_criticality="CRITICAL", **common)
    high = score_risk(medicine_criticality="HIGH", **common)
    assert (critical.score, critical.components[1].signal) == (high.score, 1.0)
    assert analyse_shortage(navjeevan_facility_data(medicine_criticality="CRITICAL"))["risk_score"] == 83


def test_base_units_are_never_pluralised():
    assert (_quantity(34, "mL"), _quantity(500.5, "mg"), _quantity(3, "count")) == ("34 mL", "500.5 mg", "3 count")
    assert (_quantity(22, "vial"), _per_day("mL"), _per_day("vial")) == ("22 vials", "mL/day", "vials/day")


def test_recorded_protected_stock_replaces_protected_days():
    assert protected_stock_for(8.06, 14) == 112.84
    assert protected_stock_for(38.05, None, 548.8) == 548.8
    with pytest.raises(ValueError, match="protected_days"):
        protected_stock_for(8.06, None)
    cause = CauseAssessment(primary=INVENTORY_IMBALANCE, contributing=(), recent_average=26.0, prior_average=26.0)
    text = build_explanation(
        cause=cause, projection=project_stock(260.5, 26.0, 7), protected_stock=548.8, protected_days=None, unit="mL", confidence=confidence(),
    )
    assert text.startswith("Effective stock is below its protected stock of 548.8 mL (recorded safety stock)")
