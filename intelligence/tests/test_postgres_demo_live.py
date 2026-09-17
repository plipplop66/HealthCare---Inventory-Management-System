"""Opt-in checks of the final PostgreSQL demo dataset through the real PostgreSQL data source.

Skipped unless MEDRIPPLE_LIVE_POSTGRES=1. DATABASE_URL must name a LOCAL database (localhost or 127.0.0.1) built with
database/schema-postgres.sql and database/seed-postgres.sql, or upgraded with migration 005; any other host is refused
before connecting. The connector always verifies TLS (sslmode=verify-full), so the local server needs a certificate
the client trusts, for example through PGSSLROOTCERT. Every request here is read-only.

PowerShell example:
    $env:MEDRIPPLE_LIVE_POSTGRES = "1"; $env:PGSSLROOTCERT = "<local test CA certificate>"
    $env:DATABASE_URL = "postgresql://medripple:<password>@127.0.0.1:5434/medripple_demo"
    .\\.venv\\Scripts\\python -m pytest tests/test_postgres_demo_live.py
Also set MEDRIPPLE_LIVE_MYSQL=1 and the DATABASE_HOST/PORT/USER/PASSWORD/NAME of the seeded MySQL database to compare
the two datasets.
"""

import hashlib
import json
import os
from datetime import date
from decimal import Decimal
from urllib.parse import urlparse

import pytest
from fastapi.testclient import TestClient

from app.config import load_settings
from app.main import build_data_source, create_app

pytestmark = pytest.mark.skipif(
    os.environ.get("MEDRIPPLE_LIVE_POSTGRES") != "1",
    reason="Set MEDRIPPLE_LIVE_POSTGRES=1 and DATABASE_URL to a local PostgreSQL built with database/seed-postgres.sql.",
)

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
HORIZON = 14
GOLDEN_POSTGRES_PLAN_ID = "plan-a4d757f3efa18dc5765e61e71f993073"
GOLDEN_MYSQL_PLAN_ID = "plan-b9b11f08be174706d5dae2a446b74596"
SNAPSHOT_TABLES = ("facilities", "medicines", "batches", "inventory", "consumption", "replenishments", "routes",
                   "facility_safety_stock", "plans", "transfers", "audit_events", "app_users")


@pytest.fixture(scope="module")
def settings():
    settings = load_settings({**os.environ, "DATA_SOURCE": "postgres"})
    host = urlparse(settings.database_url).hostname
    if host not in LOCAL_HOSTS:
        pytest.fail(f"The demo dataset tests only run against a local database, not {host!r}.")
    return settings


@pytest.fixture(scope="module")
def source(settings):
    return build_data_source(settings)


@pytest.fixture(scope="module")
def client(source):
    return TestClient(create_app(data_source=source))


def query(settings, sql, params=()):
    import psycopg

    with psycopg.connect(settings.database_url, sslmode="verify-full", connect_timeout=10) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        return connection.execute(sql, params).fetchall()


@pytest.fixture(scope="module")
def ids(settings):
    medicines = dict(query(settings, "SELECT generic_name, medicine_id FROM medicines"))
    batches = dict(query(settings, "SELECT batch_number, batch_id FROM batches"))
    facilities = dict(query(settings, "SELECT facility_code, facility_id FROM facilities"))
    return {"insulin": str(medicines["Human Insulin"]), "medicines": medicines, "batches": batches, "facilities": facilities}


@pytest.fixture(scope="module")
def fresh_install(ids):
    return (ids["facilities"]["WH-TN-001"], ids["medicines"]["Human Insulin"], ids["batches"]["TN-007-B01-26"]) == (1, 7, 14)


def post(client, path, body):
    response = client.post(path, json=body)
    return response.status_code, response.json(), response.content


def plan(client, ids, destination, quantity):
    return post(client, "/plans/optimize", {"destinationFacilityId": destination, "medicineId": ids["insulin"], "quantity": quantity,
                                            "horizonDays": HORIZON})


def simulate(client, ids, source_id, destination, quantity):
    return post(client, "/scenarios/simulate", {"horizonDays": HORIZON, "transfers": [
        {"fromFacilityId": source_id, "toFacilityId": destination, "medicineId": ids["insulin"], "quantity": quantity, "arrivalDay": 1}]})


def candidates(body):
    return {item["facilityId"]: item for item in body["candidates"]}


def checks(body):
    return {item["name"]: item["passed"] for item in body["validation"]["checks"]}


def facility(block, facility_id):
    return next(item for item in block["facilities"] if item["facilityId"] == facility_id)


def expected_plan_id(destination, medicine_id, quantity, transfers, data_source="POSTGRES"):
    """The documented deterministic plan ID: plan- plus 32 hex digits of SHA-256 over the request, transfers and data context."""
    payload = {"destinationFacilityId": destination, "medicineId": medicine_id, "requestedQuantity": f"{Decimal(quantity):.2f}",
               "horizonDays": HORIZON, "dataSource": data_source, "simulationDate": "2026-09-11", "asOfDate": "2026-09-12",
               "transfers": transfers}
    return "plan-" + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()[:32]


@pytest.fixture(scope="module")
def vellore(client, ids):
    status, body, _ = plan(client, ids, "PHC-VLR-001", 300)
    assert status == 200, body
    return body


@pytest.fixture(scope="module")
def karur(client, ids):
    status, body, _ = plan(client, ids, "PHC-KRR-001", 800)
    assert status == 200, body
    return body


@pytest.fixture(scope="module")
def hosur(client, ids):
    status, body, _ = plan(client, ids, "PHC-HSR-001", 150)
    assert status == 200, body
    return body


# ---- The PostgreSQL store exposes the dataset ----


def test_python_store_exposes_the_demo_rows(source, ids):
    insulin = ids["insulin"]
    store = source.regional_store_for([insulin])
    assert store.get_medicine(insulin).unit == "mL" and store.get_medicine(insulin).requires_cold_chain is True
    karur, hosur, thanjavur = store.get_facility("PHC-KRR-001"), store.get_facility("PHC-HSR-001"), store.get_facility("PHC-TNJ-001")
    assert (karur.type, karur.district, karur.source_remoteness_score, karur.has_cold_chain) == ("PHC", "Karur", 3.6, True)
    assert (hosur.source_remoteness_score, hosur.remoteness_score, store.get_facility("WH-TN-001").type) == (1.5, 0.15, "Warehouse")
    assert thanjavur.has_cold_chain is False

    vellore = store.get_inventory("PHC-VLR-001", insulin)
    assert (vellore.recorded_stock, vellore.effective_stock(store.as_of), vellore.protected_stock) == (34.0, 34.0, 548.8)
    assert [(batch.batch_no, batch.batch_id, batch.expiry_date, batch.quantity) for batch in vellore.batches] == [
        ("TN-007-B01-26", ids["batches"]["TN-007-B01-26"], date(2028, 2, 29), 12.0),
        ("TN-007-B02-26", ids["batches"]["TN-007-B02-26"], date(2028, 4, 24), 22.0),
    ]
    assert [(item.arrival_day, item.quantity, item.status) for item in vellore.replenishments] == [(8, 1372.0, "DELAYED")]
    karur_stock = store.get_inventory("PHC-KRR-001", insulin)
    assert (karur_stock.effective_stock(store.as_of), karur_stock.protected_stock) == (40.0, 539.57)
    assert [(item.arrival_day, item.quantity, item.status) for item in karur_stock.replenishments] == [(9, 1348.91, "DELAYED")]
    coimbatore = store.get_inventory("DH-CBE-001", insulin)
    assert ("TN-007-B03-26", date(2028, 7, 19), 800.0) in [(b.batch_no, b.expiry_date, b.quantity) for b in coimbatore.batches]
    assert round(coimbatore.effective_stock(store.as_of), 2) == round(coimbatore.recorded_stock, 2) == 2941.69
    assert store.get_inventory("WH-TN-001", insulin).effective_stock(store.as_of) == 102240.0

    history = store.consumption_history("PHC-KRR-001", insulin)
    assert (len(history), history[0].day, history[-1].day) == (60, date(2026, 7, 14), date(2026, 9, 11))
    boundary, back = store.get_route("WH-TN-001", "PHC-HSR-001"), store.get_route("PHC-HSR-001", "WH-TN-001")
    assert (boundary.distance_km, boundary.travel_hours, boundary.cold_chain_capable) == (267.75, 6.0, True)
    assert back.travel_hours == 5.88
    assert store.get_route("PHC-TNJ-001", "PHC-KRR-001").cold_chain_capable is False

    rabies = source.regional_store_for([str(ids["medicines"]["Rabies Vaccine"])])
    warehouse_rabies = rabies.get_inventory("WH-TN-001", str(ids["medicines"]["Rabies Vaccine"]))
    # One rabies lot is quarantined: recorded but never effective.
    assert (warehouse_rabies.recorded_stock, warehouse_rabies.effective_stock(rabies.as_of)) == (110880.0, 55440.0)
    units = {medicine.generic_name: medicine.unit for medicine in rabies.medicines.values()}
    assert (units["Paracetamol"], units["Human Insulin"], units["Adrenaline Auto-Injector"]) == ("mg", "mL", "count")


def test_fresh_install_keeps_dhiren_ids(ids, fresh_install, vellore):
    if not fresh_install:
        pytest.skip("An upgraded database keeps its earlier IDs; only a fresh install uses Dhiren's IDs.")
    assert (ids["insulin"], ids["batches"]["TN-007-B01-26"], ids["batches"]["TN-007-B03-26"]) == ("7", 14, 25)
    assert (ids["facilities"]["PHC-VLR-001"], ids["facilities"]["PHC-KRR-001"], ids["facilities"]["PHC-HSR-001"]) == (6, 11, 12)
    assert vellore["id"] == GOLDEN_POSTGRES_PLAN_ID


# ---- 1. Golden Vellore shortage ----


def test_vellore_forecast_is_critical(client, ids):
    status, body, _ = post(client, "/forecast", {"facilityId": "PHC-VLR-001", "medicineId": ids["insulin"], "horizonDays": HORIZON})
    assert status == 200, body
    assert (body["dataContext"]["dataSource"], body["risk"]["label"], body["stockout"]["projectedStockoutDay"]) == ("POSTGRES", "CRITICAL", 1)
    assert (body["inventory"]["effectiveStock"], body["inventory"]["protectedStock"]) == (34.0, 548.8)
    # The recipient forecast still counts its delayed delivery.
    assert body["inventory"]["nextReplenishment"] == {"quantity": 1372.0, "arrivalDay": 8, "arrivalDate": "2026-09-19", "status": "DELAYED"}


def test_vellore_golden_plan(vellore, ids):
    assert [(t["fromFacilityId"], t["batchId"], t["batchNo"], t["quantity"], t["distanceKm"], t["travelHours"], t["coldChainAvailable"])
            for t in vellore["transfers"]] == [("WH-TN-001", ids["batches"]["TN-007-B01-26"], "TN-007-B01-26", 300.0, 124.7, 3.19, True)]
    assert (vellore["modelVersion"], vellore["requiresHumanApproval"], vellore["medicine"]["id"]) == ("aiml-transfer-optimizer-v2", True, ids["insulin"])
    assert all(checks(vellore).values()) and vellore["simulation"]["comparison"]["safeToRecommend"] is True
    assert (vellore["recipient"]["stockoutDayBefore"], vellore["recipient"]["stockoutDayAfter"]) == (1, None)
    comparison = vellore["simulation"]["comparison"]
    assert (comparison["newShortagesCreated"], comparison["newCriticalFacilities"], comparison["recipientStockoutPrevented"]) == ([], [], True)
    assert facility(vellore["simulation"]["baseline"], "PHC-VLR-001")["riskLabel"] == "CRITICAL"
    assert facility(vellore["simulation"]["intervention"], "WH-TN-001")["riskLabel"] not in ("HIGH", "CRITICAL")
    transfer = [["WH-TN-001", str(ids["batches"]["TN-007-B01-26"]), "TN-007-B01-26", "300.00", 1, 1]]
    assert vellore["id"] == expected_plan_id("PHC-VLR-001", ids["insulin"], 300, transfer)
    # The approved ID rule includes the data source: the same seeded data under MySQL gives the MySQL golden ID.
    assert expected_plan_id("PHC-VLR-001", "7", 300, [["WH-TN-001", "14", "TN-007-B01-26", "300.00", 1, 1]], "MYSQL") == GOLDEN_MYSQL_PLAN_ID


def test_vellore_ripple_simulation_is_safe(client, ids):
    status, body, _ = simulate(client, ids, "WH-TN-001", "PHC-VLR-001", 300)
    item = body["transferEvaluations"][0]
    assert status == 200 and (item["eligible"], item["applied"], item["rejectionCodes"]) == (True, True, [])
    assert item["route"] == {"distanceKm": 124.7, "travelHours": 3.19, "coldChainAvailable": True}
    assert body["comparison"]["safeToRecommend"] is True and body["comparison"]["recipientStockoutPrevented"] is True
    assert body["scenarioType"] == "SIMULATED_DATABASE"


# ---- 2 and 3. A clinical donor using received stock only, in a two-donor plan ----


def test_clinical_donor_is_safe_on_received_stock_only(karur):
    donor = candidates(karur)["DH-CBE-001"]
    assert (donor["status"], donor["rejectionCodes"], donor["baselineRiskLabel"]) == ("SELECTED", [], "MEDIUM")
    assert (donor["safeCapacity"], donor["futureReplenishmentExcluded"], donor["travelHours"]) == (604.49, 2998.36, 3.1)
    # Received stock alone: effective stock less 14 days of forecast use still clears the retained floor by the capacity.
    received_only = donor["effectiveStock"] - HORIZON * donor["predictedDailyDemand"] - donor["retainedFloor"]
    assert abs(received_only - donor["safeCapacity"]) <= 0.02
    assert karur["equityGuardrail"]["donorCapacityBasis"] == "RECEIVED_STOCK_ONLY"
    assert checks(karur)["DONORS_SAFE_WITHOUT_FUTURE_SUPPLY"] is True


def test_two_donor_plan(client, ids, settings, karur):
    transfers = karur["transfers"]
    assert {t["fromFacilityId"] for t in transfers} == {"DH-CBE-001", "DH-MDU-001"}
    assert (round(sum(t["quantity"] for t in transfers), 2), karur["allocatedQuantity"], karur["requestedQuantity"]) == (800.0, 800.0, 800.0)
    donors = candidates(karur)
    assert [(t["fromFacilityId"], t["batchNo"], t["quantity"]) for t in transfers] == [
        ("DH-CBE-001", "TN-007-B01-26", 167.59), ("DH-MDU-001", "TN-007-B01-26", 632.41)]
    assert 800 > max(donors["DH-CBE-001"]["safeCapacity"], donors["DH-MDU-001"]["safeCapacity"])
    assert all(donors[code]["allocatedQuantity"] <= donors[code]["safeCapacity"] for code in ("DH-CBE-001", "DH-MDU-001"))
    assert [code for code, item in donors.items() if item["status"] == "SELECTED"] == ["DH-CBE-001", "DH-MDU-001"]
    for t in transfers:
        assert t["batchId"] == ids["batches"][t["batchNo"]]
        # FEFO: the earliest-expiring lot (then the lowest batch ID) that lasts through the horizon.
        first = query(settings, """
            SELECT b.batch_number FROM inventory i JOIN batches b ON b.batch_id = i.batch_id JOIN facilities f ON f.facility_id = i.facility_id
            WHERE f.facility_code = %s AND b.medicine_id = %s AND i.status = 'AVAILABLE' AND NOT b.quarantined AND b.expiry_date >= DATE '2026-09-25'
            ORDER BY b.expiry_date, b.batch_id LIMIT 1""", (t["fromFacilityId"], int(ids["insulin"])))[0][0]
        assert t["batchNo"] == first
    assert all(checks(karur).values()) and karur["simulation"]["comparison"]["safeToRecommend"] is True
    assert karur["simulation"]["comparison"]["newShortagesCreated"] == []
    assert (karur["recipient"]["stockoutDayBefore"], karur["recipient"]["stockoutDayAfter"]) == (2, None)
    assert plan(client, ids, "PHC-KRR-001", 800)[2] == plan(client, ids, "PHC-KRR-001", 800)[2]

    status, body, _ = plan(client, ids, "PHC-KRR-001", 1300)
    details = body["error"]["details"]
    assert (status, body["error"]["code"], details["safeCapacity"], details["unmetQuantity"]) == (422, "NO_SAFE_PLAN", 1236.9, 63.1)
    assert {item["facilityId"] for item in details["eligibleCandidates"]} == {"DH-CBE-001", "DH-MDU-001"}
    assert details["equityGuardrail"]["maxTravelHours"] == 6.0
    assert any(item.startswith("WH-TN-001 is beyond the 6-hour route limit") for item in details["recommendedEscalation"])


# ---- 4. Deliberately unsafe donors ----


def test_unsafe_donors_are_rejected(client, ids):
    status, body, _ = simulate(client, ids, "DH-CBE-001", "PHC-KRR-001", 1500)
    item = body["transferEvaluations"][0]
    donor = facility(body["baseline"], "DH-CBE-001")
    # 1500 mL looks affordable against the snapshot, but not once 11 days of use are projected.
    assert donor["effectiveStock"] - donor["protectedStock"] > 1500
    assert (status, item["rejectionCodes"], item["eligible"], item["applied"]) == (200, ["BELOW_PROTECTED_STOCK"], False, True)
    assert "would fall below its protected safety stock" in item["rejectionReasons"][0]
    assert body["comparison"]["safeToRecommend"] is False

    status, body, _ = simulate(client, ids, "CHC-TRY-001", "PHC-KRR-001", 700)
    item = body["transferEvaluations"][0]
    assert item["rejectionCodes"] == ["BELOW_PROTECTED_STOCK", "CREATES_REGIONAL_SHORTAGE"]
    assert "CHC-TRY-001" in body["comparison"]["newShortagesCreated"] and body["comparison"]["safeToRecommend"] is False


# ---- 5. Cold chain ----


def test_cold_chain_failures(client, ids, karur):
    status, body, _ = simulate(client, ids, "PHC-TNJ-001", "PHC-KRR-001", 10)
    item = body["transferEvaluations"][0]
    assert (item["rejectionCodes"], item["applied"], item["route"]["coldChainAvailable"]) == (["COLD_CHAIN_UNAVAILABLE"], False, False)
    # A destination without cold-chain storage.
    status, body, _ = simulate(client, ids, "WH-TN-001", "PHC-TNJ-001", 10)
    assert "COLD_CHAIN_UNAVAILABLE" in body["transferEvaluations"][0]["rejectionCodes"]
    assert "COLD_CHAIN_UNAVAILABLE" in candidates(karur)["PHC-TNJ-001"]["rejectionCodes"]


# ---- 6. The six-hour route limit ----


@pytest.mark.parametrize("source_id, destination, quantity, plan_fixture", [
    ("WH-TN-001", "PHC-KRR-001", 300, "karur"),
    ("DH-MDU-001", "PHC-HSR-001", 100, "hosur"),
])
def test_routes_over_six_hours_are_simulated_but_rejected(client, ids, request, source_id, destination, quantity, plan_fixture):
    status, body, _ = simulate(client, ids, source_id, destination, quantity)
    item = body["transferEvaluations"][0]
    assert (item["rejectionCodes"], item["eligible"], item["applied"]) == (["TRAVEL_TIME_LIMIT_EXCEEDED"], False, True)
    assert item["route"]["travelHours"] > 6 and body["comparison"]["safeToRecommend"] is False
    assert facility(body["intervention"], destination)["transferIn"] == quantity
    rejected = candidates(request.getfixturevalue(plan_fixture))[source_id]
    assert rejected["rejectionCodes"] == ["TRAVEL_TIME_LIMIT_EXCEEDED"]
    assert rejected["rejectionReasons"] == item["rejectionReasons"]


def test_route_of_exactly_six_hours_is_accepted(client, ids, hosur):
    assert [(t["fromFacilityId"], t["travelHours"], t["quantity"]) for t in hosur["transfers"]] == [("WH-TN-001", 6.0, 150.0)]
    assert candidates(hosur)["WH-TN-001"]["status"] == "SELECTED" and checks(hosur)["ROUTES_WITHIN_TRAVEL_LIMIT"] is True
    assert all(checks(hosur).values())
    assert candidates(hosur)["DH-CBE-001"]["status"] == "ELIGIBLE_NOT_SELECTED"
    status, body, _ = simulate(client, ids, "WH-TN-001", "PHC-HSR-001", 150)
    item = body["transferEvaluations"][0]
    assert (item["eligible"], item["route"]["travelHours"], body["comparison"]["safeToRecommend"]) == (True, 6.0, True)


# ---- 7. Future supply never makes a donor eligible ----


def test_future_supply_dependent_donor_is_rejected(client, ids, karur):
    donor = candidates(karur)["CHC-SLM-001"]
    assert (donor["rejectionCodes"], donor["safeCapacity"], donor["futureReplenishmentExcluded"]) == (["NO_SAFE_DONOR_CAPACITY"], 0.0, 1745.5)
    reason = donor["rejectionReasons"][0]
    assert "not counted toward donor capacity" in reason and "only because of that future supply" in reason
    assert karur["equityGuardrail"]["donorCapacityBasis"] == "RECEIVED_STOCK_ONLY"
    # The simulator counts the scheduled delivery, which is the only reason the transfer looks safe there.
    status, body, _ = simulate(client, ids, "CHC-SLM-001", "PHC-KRR-001", 100)
    assert body["transferEvaluations"][0]["eligible"] is True


# ---- Read-only and deterministic ----


def database_state(settings):
    return {table: query(settings, f"SELECT COUNT(*), md5(COALESCE(string_agg(t::text, '|' ORDER BY t::text), '')) FROM {table} t")[0]
            for table in SNAPSHOT_TABLES}


def test_requests_are_read_only_and_deterministic(client, ids, settings):
    requests = [
        ("/forecast", {"facilityId": "PHC-VLR-001", "medicineId": ids["insulin"], "horizonDays": HORIZON}),
        ("/forecast", {"facilityId": "PHC-KRR-001", "medicineId": "med-insulin-100iu-vial", "horizonDays": HORIZON}),
        ("/scenarios/simulate", {"horizonDays": HORIZON, "transfers": [
            {"fromFacilityId": "WH-TN-001", "toFacilityId": "PHC-VLR-001", "medicineId": ids["insulin"], "quantity": 300, "arrivalDay": 1}]}),
        ("/scenarios/simulate", {"horizonDays": HORIZON, "transfers": [
            {"fromFacilityId": "DH-CBE-001", "toFacilityId": "PHC-KRR-001", "medicineId": ids["insulin"], "quantity": 1500, "arrivalDay": 1}]}),
    ] + [("/plans/optimize", {"destinationFacilityId": destination, "medicineId": ids["insulin"], "quantity": quantity, "horizonDays": HORIZON})
         for destination, quantity in (("PHC-VLR-001", 300), ("PHC-KRR-001", 800), ("PHC-KRR-001", 1300), ("PHC-HSR-001", 150))]
    before = database_state(settings)
    for path, body in requests:
        first, second = client.post(path, json=body), client.post(path, json=body)
        assert first.status_code in (200, 422) and first.content == second.content, path
    assert database_state(settings) == before


# ---- The PostgreSQL copy of Dhiren's dataset matches MySQL ----


def test_dhiren_rows_match_the_seeded_mysql_database(settings, fresh_install):
    if os.environ.get("MEDRIPPLE_LIVE_MYSQL") != "1":
        pytest.skip("Set MEDRIPPLE_LIVE_MYSQL=1 and DATABASE_HOST/PORT/USER/PASSWORD/NAME of the seeded MySQL database.")
    import pymysql

    mysql = pymysql.connect(host=os.environ.get("DATABASE_HOST", "127.0.0.1"), port=int(os.environ.get("DATABASE_PORT", "3306")),
                            user=os.environ.get("DATABASE_USER", "medripple"), password=os.environ.get("DATABASE_PASSWORD", ""),
                            database=os.environ.get("DATABASE_NAME", "medripple"), init_command="SET SESSION TRANSACTION READ ONLY")
    comparisons = {
        "facilities": ("SELECT facility_code, name, facility_type, region, latitude, longitude, population_served, remoteness_score, "
                       "storage_capacity_ml, CAST(has_cold_chain AS {int}) FROM facilities WHERE facility_code IN ({codes})"),
        "medicines": ("SELECT generic_name, strength_value, strength_unit, form, base_unit, storage_temp_min_c, storage_temp_max_c, "
                      "CAST(requires_cold_chain AS {int}), {criticality}, shelf_life_days FROM medicines"),
        "batches": ("SELECT m.generic_name, b.batch_number, b.manufacture_date, b.expiry_date, b.quantity_received, b.supplier_name, "
                    "CAST(b.quarantined AS {int}), b.quarantine_reason FROM batches b JOIN medicines m ON m.medicine_id = b.medicine_id "
                    "WHERE b.batch_number LIKE 'TN-0%%-B0_-26' AND b.batch_number <> 'TN-007-B03-26'"),
        "routes": ("SELECT o.facility_code, d.facility_code, r.distance_km, r.transport_time_hours, CAST(r.cold_chain_capable AS {int}) "
                   "FROM routes r JOIN facilities o ON o.facility_id = r.origin_facility_id JOIN facilities d ON d.facility_id = r.destination_facility_id "
                   "WHERE o.facility_code IN ({codes}) AND d.facility_code IN ({codes})"),
        "consumption": ("SELECT f.facility_code, m.generic_name, c.consumption_date, c.quantity_consumed FROM consumption c "
                        "JOIN facilities f ON f.facility_id = c.facility_id JOIN medicines m ON m.medicine_id = c.medicine_id WHERE f.facility_code IN ({codes})"),
        "safety_stock": ("SELECT f.facility_code, m.generic_name, s.safety_stock_qty, s.basis, CAST(s.confirmed_by_aaryan AS {int}) FROM facility_safety_stock s "
                         "JOIN facilities f ON f.facility_id = s.facility_id JOIN medicines m ON m.medicine_id = s.medicine_id WHERE f.facility_code IN ({codes})"),
        "inventory": ("SELECT f.facility_code, b.batch_number, i.quantity_on_hand, CAST(i.status AS {text}) FROM inventory i "
                      "JOIN facilities f ON f.facility_id = i.facility_id JOIN batches b ON b.batch_id = i.batch_id "
                      "WHERE f.facility_code IN ({codes}) AND b.batch_number <> 'TN-007-B03-26'"),
        "replenishments": ("SELECT f.facility_code, m.generic_name, b.batch_number, r.expected_arrival_date, r.actual_arrival_date, r.quantity, "
                           "r.supplier_reliability_score, CAST(r.status AS {text}) FROM replenishments r JOIN facilities f ON f.facility_id = r.facility_id "
                           "JOIN medicines m ON m.medicine_id = r.medicine_id LEFT JOIN batches b ON b.batch_id = r.batch_id "
                           "WHERE f.facility_code IN ({codes}) AND COALESCE(b.batch_number, '') <> 'TN-007-B03-26'"),
    }
    codes = ", ".join(f"'{code}'" for code in ("WH-TN-001", "DH-CBE-001", "DH-MDU-001", "CHC-TRY-001", "CHC-SLM-001", "PHC-VLR-001",
                                                 "PHC-TNJ-001", "PHC-TNV-001", "SC-DPI-001", "SC-RMD-001"))
    # An upgraded database keeps its earlier insulin row (criticality HIGH), so criticality is compared on a fresh install only.
    criticality = "criticality_level" if fresh_install else "NULL"
    try:
        with mysql.cursor() as cursor:
            for name, template in comparisons.items():
                cursor.execute(template.format(codes=codes, int="SIGNED", text="CHAR", criticality=criticality))
                expected = sorted(tuple(str(value) for value in row) for row in cursor.fetchall())
                actual = sorted(tuple(str(value) for value in row) for row in query(
                    settings, template.format(codes=codes, int="INTEGER", text="TEXT", criticality=criticality)))
                assert actual == expected, name
                assert expected, name
    finally:
        mysql.close()
