"""Static checks of the final PostgreSQL demo dataset: database/seed-postgres.sql and migration 005.

No database is needed. The scenarios themselves are exercised against a local PostgreSQL in
tests/test_postgres_demo_live.py.
"""

import math
import re
from collections import Counter
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

import pytest

DATABASE = Path(__file__).resolve().parents[2] / "database"
SEED = DATABASE / "seed-postgres.sql"
MIGRATION = DATABASE / "migrations" / "005_expand_final_demo_scenarios_postgres.sql"
SECTIONS = (
    ("-- >>> BEGIN SHARED FINAL DEMO REFERENCE DATA >>>", "-- <<< END SHARED FINAL DEMO REFERENCE DATA <<<"),
    ("-- >>> BEGIN SHARED FINAL DEMO INSERTS >>>", "-- <<< END SHARED FINAL DEMO INSERTS <<<"),
)
SIMULATION_DATE = date(2026, 9, 11)
# The last projection day of the longest horizon (30 days from 2026-09-12).
LONGEST_HORIZON_END = date(2026, 10, 11)
DHIREN_CODES = ["WH-TN-001", "DH-CBE-001", "DH-MDU-001", "CHC-TRY-001", "CHC-SLM-001", "PHC-VLR-001", "PHC-TNJ-001",
                "PHC-TNV-001", "SC-DPI-001", "SC-RMD-001"]
DEMO_CODES = ["PHC-KRR-001", "PHC-HSR-001"]
FACILITY_COLUMNS = ("canonical_no", "facility_code", "name", "facility_type", "region", "latitude", "longitude", "population_served",
                    "remoteness_score", "storage_capacity_ml", "has_cold_chain", "origin")
MEDICINE_COLUMNS = ("canonical_no", "generic_name", "strength_value", "strength_unit", "form", "base_unit", "storage_temp_min_c",
                    "storage_temp_max_c", "requires_cold_chain", "criticality_level", "shelf_life_days")
BATCH_COLUMNS = ("canonical_no", "medicine_no", "batch_number", "manufacture_date", "expiry_date", "quantity_received", "supplier_name",
                 "quarantined", "quarantine_reason", "origin")
ROUTE_COLUMNS = ("origin_code", "destination_code", "distance_km", "transport_time_hours", "cold_chain_capable")


@pytest.fixture(scope="module")
def seed():
    return SEED.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def migration():
    return MIGRATION.read_text(encoding="utf-8")


def section(text, begin, end):
    assert text.count(begin) == 1 and text.count(end) == 1
    return text[text.index(begin):text.index(end) + len(end)]


def statements_only(sql):
    """The SQL without comments, DO-block bodies or the temporary-table ON COMMIT DROP clause."""
    sql = re.sub(r"--[^\n]*", "", sql)
    sql = re.sub(r"\$\$.*?\$\$", "$$ $$", sql, flags=re.S)
    return sql.replace("ON COMMIT DROP", "")


TOKEN = re.compile(r"\s*(?:DATE '(?P<date>\d{4}-\d{2}-\d{2})'|'(?P<text>(?:[^']|'')*)'|(?P<word>TRUE|FALSE|NULL)|(?P<number>-?\d+(?:\.\d+)?))")


def literal_rows(sql, table, columns):
    """Parse `INSERT INTO <table> VALUES (...), (...);` into dictionaries."""
    position = sql.index(f"INSERT INTO {table} VALUES") + len(f"INSERT INTO {table} VALUES")
    rows = []
    while True:
        position = sql.index("(", position) + 1
        row = []
        while True:
            match = TOKEN.match(sql, position)
            assert match, sql[position:position + 60]
            if match["date"]:
                row.append(date.fromisoformat(match["date"]))
            elif match["text"] is not None:
                row.append(match["text"].replace("''", "'"))
            elif match["word"]:
                row.append({"TRUE": True, "FALSE": False, "NULL": None}[match["word"]])
            else:
                row.append(Decimal(match["number"]))
            position = match.end()
            separator = sql[position:].lstrip()[0]
            position = sql.index(separator, position) + 1
            if separator == ")":
                break
        rows.append(dict(zip(columns, row, strict=True)))
        if sql[position:].lstrip()[0] == ";":
            return rows


@pytest.fixture(scope="module")
def reference(migration):
    text = section(migration, *SECTIONS[0])
    return {
        "facilities": literal_rows(text, "demo_facility", FACILITY_COLUMNS),
        "medicines": literal_rows(text, "demo_medicine", MEDICINE_COLUMNS),
        "batches": literal_rows(text, "demo_batch", BATCH_COLUMNS),
        "routes": literal_rows(text, "demo_route", ROUTE_COLUMNS),
        "inventory_override": literal_rows(text, "demo_inventory_override", ("facility_code", "batch_number", "quantity_on_hand", "note")),
        "inventory_extra": literal_rows(text, "demo_inventory_extra", ("facility_code", "batch_number", "quantity_on_hand", "status")),
        "replenishment_override": literal_rows(text, "demo_replenishment_override",
                                               ("facility_code", "medicine_no", "expected_arrival_date", "status", "note")),
        "replenishment_extra": literal_rows(text, "demo_replenishment_extra",
                                            ("facility_code", "medicine_no", "batch_number", "expected_arrival_date", "actual_arrival_date",
                                             "quantity", "supplier_reliability_score", "status")),
    }


def round2(value):
    return Decimal(repr(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def haversine_km(origin, destination):
    lat1, lon1, lat2, lon2 = (math.radians(float(value)) for value in (
        origin["latitude"], origin["longitude"], destination["latitude"], destination["longitude"]))
    a = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return round2(6371 * 2 * math.asin(math.sqrt(a)))


# ---- Script structure and safety ----


def test_seed_and_migration_share_identical_sections(seed, migration):
    for begin, end in SECTIONS:
        assert section(seed, begin, end) == section(migration, begin, end)


@pytest.mark.parametrize("path", [SEED, MIGRATION], ids=["seed", "migration"])
def test_each_script_is_one_transaction(path):
    body = statements_only(path.read_text(encoding="utf-8")).strip()
    assert body.startswith("BEGIN;") and body.endswith("COMMIT;")
    assert body.count("BEGIN;") == 1 and body.count("COMMIT;") == 1


def test_migration_is_insert_only(migration):
    statements = statements_only(migration)
    assert not re.search(r"\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE|setval)\b", statements, flags=re.I)
    created = re.findall(r"CREATE\s+(?:\w+\s+)?TABLE", statements)
    assert created and set(created) == {"CREATE TEMP TABLE"}
    # Accounts, plans, transfers and audit history are never written.
    assert not re.search(r"\b(app_users|plans|transfers|audit_events)\b", statements)


def test_seed_refuses_a_database_with_other_ids_and_only_moves_sequences_forward(seed):
    statements = statements_only(seed)
    assert not re.search(r"\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER|GRANT|REVOKE)\b", statements, flags=re.I)
    assert "RAISE EXCEPTION 'seed-postgres.sql is only for a new database" in seed
    assert "IF highest > COALESCE(pg_sequence_last_value(sequence_name::regclass), 0) THEN" in seed
    assert "PERFORM setval(sequence_name, highest);" in seed
    assert not re.search(r"\b(plans|transfers|audit_events)\b", statements)
    assert "INSERT INTO app_users" not in statements


@pytest.mark.parametrize("path", [SEED, MIGRATION], ids=["seed", "migration"])
def test_data_is_labelled_simulated_deterministic_and_patient_free(path):
    text = path.read_text(encoding="utf-8")
    assert "SIMULATED PROTOTYPE DATA ONLY" in text and "SIMULATION_DATE = 2026-09-11" in text
    statements = statements_only(text)
    assert not re.search(r"\b(now|random|clock_timestamp|CURRENT_TIMESTAMP|CURRENT_DATE|gen_random_uuid)\b", statements, flags=re.I)
    assert "patient" not in statements.lower()
    assert "TIMESTAMP '2026-09-11 18:00:00'" in statements


# ---- Reference rows ----


def test_dhiren_ids_and_demo_ids_are_explicit(reference):
    facilities = reference["facilities"]
    assert [row["facility_code"] for row in facilities] == DHIREN_CODES + DEMO_CODES
    assert [row["canonical_no"] for row in facilities] == list(range(1, 13))
    assert [row["origin"] for row in facilities] == ["DHIREN"] * 10 + ["DEMO"] * 2
    medicines = {row["canonical_no"]: row for row in reference["medicines"]}
    assert sorted(medicines) == list(range(1, 13))
    insulin = medicines[7]
    assert (insulin["generic_name"], insulin["strength_value"], insulin["strength_unit"], insulin["form"], insulin["base_unit"],
            insulin["requires_cold_chain"]) == ("Human Insulin", Decimal("100.000"), "IU/mL", "Vial", "mL", True)
    assert {row["base_unit"] for row in medicines.values()} == {"mg", "mL", "count"}
    batches = {row["batch_number"]: row for row in reference["batches"]}
    assert (batches["TN-007-B01-26"]["canonical_no"], batches["TN-007-B01-26"]["medicine_no"]) == (14, 7)
    assert (batches["TN-007-B03-26"]["canonical_no"], batches["TN-007-B03-26"]["origin"]) == (25, "DEMO")
    assert [row["canonical_no"] for row in reference["batches"]] == list(range(1, 26))


def test_batches_are_consistent_and_last_through_every_horizon(reference):
    medicines = {row["canonical_no"]: row for row in reference["medicines"]}
    lots = Counter(row["medicine_no"] for row in reference["batches"] if row["origin"] == "DHIREN")
    assert lots == dict.fromkeys(range(1, 13), 2)
    for batch in reference["batches"]:
        assert batch["expiry_date"] > batch["manufacture_date"] and batch["manufacture_date"] <= SIMULATION_DATE
        assert batch["expiry_date"] >= LONGEST_HORIZON_END
        assert batch["quantity_received"] > 0 and batch["medicine_no"] in medicines
    quarantined = [row["batch_number"] for row in reference["batches"] if row["quarantined"]]
    assert quarantined == ["TN-009-B01-26"]


def test_demo_facilities_are_simulated_phcs_with_cold_chain(reference):
    for row in reference["facilities"][10:]:
        assert (row["facility_type"], row["has_cold_chain"]) == ("PHC", True)
        assert 0 <= row["remoteness_score"] <= 10 and row["population_served"] > 0


def test_routes_are_directed_complete_and_follow_the_database_rule(reference):
    facilities = {row["facility_code"]: row for row in reference["facilities"]}
    routes = {(row["origin_code"], row["destination_code"]): row for row in reference["routes"]}
    assert len(routes) == len(reference["routes"]) == 12 * 11
    for (origin, destination), route in routes.items():
        o, d = facilities[origin], facilities[destination]
        assert route["cold_chain_capable"] == (o["has_cold_chain"] and d["has_cold_chain"])
        expected_hours = float(route["distance_km"]) / 46 + float(d["remoteness_score"]) * 0.12
        if origin in DEMO_CODES or destination in DEMO_CODES:
            # New routes use exactly the rule of database/schema.sql.
            assert route["distance_km"] == haversine_km(o, d)
            assert route["transport_time_hours"] == round2(expected_hours)
        else:
            # Dhiren's routes are copied from MySQL, which rounds its floating-point result itself.
            assert abs(float(route["transport_time_hours"]) - expected_hours) <= 0.011
            assert abs(float(route["distance_km"]) - float(haversine_km(o, d))) <= 0.011


def test_route_limit_and_cold_chain_fixtures(reference):
    routes = {(row["origin_code"], row["destination_code"]): row for row in reference["routes"]}
    hours = {key: row["transport_time_hours"] for key, row in routes.items()}
    assert hours[("WH-TN-001", "PHC-HSR-001")] == Decimal("6.00")
    assert hours[("PHC-HSR-001", "WH-TN-001")] != Decimal("6.00")
    assert hours[("WH-TN-001", "PHC-VLR-001")] == Decimal("3.19") and routes[("WH-TN-001", "PHC-VLR-001")]["distance_km"] == Decimal("124.70")
    assert hours[("WH-TN-001", "PHC-KRR-001")] > 6 and hours[("DH-MDU-001", "PHC-HSR-001")] > 6 and hours[("DH-CBE-001", "PHC-VLR-001")] > 6
    for donor in ("DH-CBE-001", "DH-MDU-001", "CHC-TRY-001", "CHC-SLM-001"):
        assert hours[(donor, "PHC-KRR-001")] < 6 and routes[(donor, "PHC-KRR-001")]["cold_chain_capable"]
    assert routes[("PHC-TNJ-001", "PHC-KRR-001")]["cold_chain_capable"] is False
    assert [key for key, value in hours.items() if value == 6] == [("WH-TN-001", "PHC-HSR-001")]


def test_scenario_rows_are_internally_consistent(reference):
    facilities = {row["facility_code"] for row in reference["facilities"]}
    batches = {row["batch_number"]: row for row in reference["batches"]}
    for row in reference["inventory_override"]:
        assert row["facility_code"] in facilities and batches[row["batch_number"]]["origin"] == "DHIREN"
    overrides = {(row["facility_code"], row["batch_number"]): row["quantity_on_hand"] for row in reference["inventory_override"]}
    # The golden Vellore shortage of database/golden-scenario.sql.
    assert (overrides[("PHC-VLR-001", "TN-007-B01-26")], overrides[("PHC-VLR-001", "TN-007-B02-26")]) == (Decimal("12.00"), Decimal("22.00"))
    orders = {row["facility_code"]: row for row in reference["replenishment_override"]}
    assert (orders["PHC-VLR-001"]["expected_arrival_date"], orders["PHC-VLR-001"]["status"]) == (date(2026, 9, 19), "DELAYED")
    assert all(row["expected_arrival_date"] > SIMULATION_DATE and row["medicine_no"] == 7 for row in orders.values())
    # The received demo lot: every unit in inventory arrived as an ARRIVED delivery before the snapshot.
    extra = reference["inventory_extra"]
    arrivals = {row["facility_code"]: row for row in reference["replenishment_extra"]}
    assert sum(row["quantity_on_hand"] for row in extra) == batches["TN-007-B03-26"]["quantity_received"]
    for row in extra:
        arrival = arrivals[row["facility_code"]]
        assert (row["status"], row["batch_number"], arrival["batch_number"]) == ("AVAILABLE", "TN-007-B03-26", "TN-007-B03-26")
        assert (arrival["status"], arrival["quantity"]) == ("ARRIVED", row["quantity_on_hand"])
        assert arrival["expected_arrival_date"] <= arrival["actual_arrival_date"] <= SIMULATION_DATE
        assert 0 < arrival["supplier_reliability_score"] <= 1
    assert set(arrivals) == {row["facility_code"] for row in extra} == {"DH-CBE-001", "DH-MDU-001"}
