"""In-memory MySQL rows for the Ripple Simulator tests: no Docker, MySQL server or network.

Daily consumption is constant, so every forecast equals that constant and each projection can be checked by
hand. Facility codes use -SIM- so passing tests cannot depend on the real seed.

Insulin (medicine 7, mL, CRITICAL, cold chain), 14-day baseline:
- WH-SIM-001  warehouse, 5000 mL, no consumption, no safety stock row
- DH-SIM-001  1000 mL effective (plus 300 expired and 200 quarantined), 50 mL/day, safety stock 700,
              700 mL SCHEDULED on day 7: lowest stock exactly 700 on day 6, MEDIUM
- PHC-SIM-001 30 mL effective (plus 50 expired), 40 mL/day, safety stock 560, 600 mL DELAYED to day 8:
              stockout on day 1, 7 shortage days, 250 mL unmet, CRITICAL 84
- CHC-SIM-001 500 mL, 20 mL/day, safety stock 280, no cold-chain storage; its 100 mL order is CANCELLED
- SC-SIM-001  400 mL, 10.5 mL/day, safety stock 147
Paracetamol (1, mg) and adrenaline auto-injectors (10, count) exercise the other base units; oxytocin (8) exists
only in the catalogue, for identity-mismatch checks.
"""

from contextlib import contextmanager
from datetime import date, timedelta
from decimal import Decimal

from fastapi.testclient import TestClient

from app.config import MYSQL, Settings
from app.main import create_app
from app.mysql_store import (
    CONSUMPTION_SQL,
    FACILITIES_SQL,
    INVENTORY_SQL,
    MEDICINES_SQL,
    REPLENISHMENTS_SQL,
    ROUTES_SQL,
    SAFETY_STOCK_SQL,
    SIMULATION_FACILITIES_SQL,
    SIMULATION_MEDICINES_SQL,
    DatabaseUnavailableError,
    MySQLDataSource,
)

SIMULATION_DATE = date(2026, 9, 11)
AS_OF = date(2026, 9, 12)
SETTINGS = Settings(data_source=MYSQL, simulation_date=SIMULATION_DATE)
PARACETAMOL, INSULIN, OXYTOCIN, ADRENALINE = 1, 7, 8, 10
WAREHOUSE, HOSPITAL, PHC, CHC, SUBCENTRE = 1, 2, 3, 4, 5
FAR_EXPIRY = date(2028, 4, 24)


def medicine_row(medicine_id, name, strength, strength_unit, form, unit, criticality, cold_chain):
    return {
        "medicine_id": medicine_id, "generic_name": name, "strength_value": Decimal(strength), "strength_unit": strength_unit,
        "form": form, "base_unit": unit, "storage_temp_min_c": Decimal("2.0") if cold_chain else Decimal("15.0"),
        "storage_temp_max_c": Decimal("8.0") if cold_chain else Decimal("30.0"), "criticality_level": criticality,
        "requires_cold_chain": int(cold_chain),
    }


MEDICINE_ROWS = [
    medicine_row(PARACETAMOL, "Paracetamol", "500.000", "mg", "Tablet", "mg", "MEDIUM", False),
    medicine_row(INSULIN, "Human Insulin", "100.000", "IU/mL", "Vial", "mL", "CRITICAL", True),
    medicine_row(OXYTOCIN, "Oxytocin", "10.000", "IU/mL", "Ampoule", "mL", "CRITICAL", True),
    medicine_row(ADRENALINE, "Adrenaline Auto-Injector", "1.000", "mg", "PreFilledPen", "count", "CRITICAL", False),
]


def facility_row(facility_id, code, name, facility_type, region, remoteness, cold_chain):
    return {
        "facility_id": facility_id, "facility_code": code, "name": name, "facility_type": facility_type, "region": region,
        "remoteness_score": Decimal(remoteness), "has_cold_chain": int(cold_chain),
    }


FACILITY_ROWS = [
    facility_row(WAREHOUSE, "WH-SIM-001", "Sim Regional Warehouse", "Warehouse", "North", "0.50", True),
    facility_row(HOSPITAL, "DH-SIM-001", "Sim District Hospital", "DistrictHospital", "Central", "2.30", True),
    facility_row(PHC, "PHC-SIM-001", "Sim Primary Health Centre", "PHC", "East", "4.00", True),
    facility_row(CHC, "CHC-SIM-001", "Sim Community Health Centre", "CHC", "West", "3.00", False),
    facility_row(SUBCENTRE, "SC-SIM-001", "Sim Rural SubCentre", "SubCentre", "South", "7.20", True),
]


def inventory_row(facility_id, medicine_id, batch, quantity, status="AVAILABLE", expiry=FAR_EXPIRY, quarantined=0):
    return {
        "facility_id": facility_id, "medicine_id": medicine_id, "batch_number": batch, "quantity_on_hand": Decimal(quantity),
        "status": status, "expiry_date": expiry, "quarantined": quarantined,
    }


INVENTORY_ROWS = [
    inventory_row(WAREHOUSE, INSULIN, "SIM-007-B02", "5000.00"),
    inventory_row(HOSPITAL, INSULIN, "SIM-007-B01", "400.00", expiry=date(2028, 2, 29)),
    inventory_row(HOSPITAL, INSULIN, "SIM-007-B02", "600.00"),
    inventory_row(HOSPITAL, INSULIN, "SIM-007-B03", "300.00", status="EXPIRED", expiry=date(2026, 9, 1)),
    inventory_row(HOSPITAL, INSULIN, "SIM-007-B04", "200.00", quarantined=1),
    inventory_row(PHC, INSULIN, "SIM-007-B02", "30.00"),
    inventory_row(PHC, INSULIN, "SIM-007-B05", "50.00", status="EXPIRED", expiry=date(2026, 8, 31)),
    inventory_row(CHC, INSULIN, "SIM-007-B02", "500.00"),
    inventory_row(SUBCENTRE, INSULIN, "SIM-007-B02", "400.00"),
    inventory_row(WAREHOUSE, PARACETAMOL, "SIM-001-B02", "900000.00"),
    inventory_row(HOSPITAL, PARACETAMOL, "SIM-001-B02", "80000.50"),
    inventory_row(PHC, PARACETAMOL, "SIM-001-B02", "3000.75"),
    inventory_row(WAREHOUSE, ADRENALINE, "SIM-010-B02", "300"),
    inventory_row(HOSPITAL, ADRENALINE, "SIM-010-B02", "60"),
    inventory_row(PHC, ADRENALINE, "SIM-010-B02", "40"),
]


def safety_row(facility_id, medicine_id, quantity):
    return {"facility_id": facility_id, "medicine_id": medicine_id, "safety_stock_qty": Decimal(quantity), "confirmed_by_aaryan": 0}


SAFETY_ROWS = [
    safety_row(HOSPITAL, INSULIN, "700.00"),
    safety_row(PHC, INSULIN, "560.00"),
    safety_row(CHC, INSULIN, "280.00"),
    safety_row(SUBCENTRE, INSULIN, "147.00"),
    safety_row(HOSPITAL, PARACETAMOL, "60000.25"),
    safety_row(PHC, PARACETAMOL, "14007.00"),
    safety_row(HOSPITAL, ADRENALINE, "28"),
    safety_row(PHC, ADRENALINE, "14"),
]


def replenishment_row(facility_id, medicine_id, day, quantity, status):
    return {
        "facility_id": facility_id, "medicine_id": medicine_id, "quantity": Decimal(quantity),
        "expected_arrival_date": SIMULATION_DATE + timedelta(days=day), "status": status,
    }


REPLENISHMENT_ROWS = [
    replenishment_row(HOSPITAL, INSULIN, 7, "700.00", "SCHEDULED"),
    replenishment_row(PHC, INSULIN, 8, "600.00", "DELAYED"),
    replenishment_row(CHC, INSULIN, 4, "100.00", "CANCELLED"),
]


def daily_consumption(facility_id, medicine_id, quantity):
    first = date(2026, 6, 29)
    return [
        {"facility_id": facility_id, "medicine_id": medicine_id, "consumption_date": first + timedelta(days=offset), "quantity_consumed": Decimal(quantity)}
        for offset in range((SIMULATION_DATE - first).days + 1)
    ]


CONSUMPTION_ROWS = (
    daily_consumption(HOSPITAL, INSULIN, "50.00")
    + daily_consumption(PHC, INSULIN, "40.00")
    + daily_consumption(CHC, INSULIN, "20.00")
    + daily_consumption(SUBCENTRE, INSULIN, "10.50")
    + daily_consumption(HOSPITAL, PARACETAMOL, "5000.25")
    + daily_consumption(PHC, PARACETAMOL, "1000.50")
    + daily_consumption(HOSPITAL, ADRENALINE, "2")
    + daily_consumption(PHC, ADRENALINE, "1")
)


def route_row(origin, destination, distance, hours, cold_chain):
    return {
        "origin_facility_id": origin, "destination_facility_id": destination, "distance_km": Decimal(distance),
        "transport_time_hours": Decimal(hours), "cold_chain_capable": int(cold_chain),
    }


# No route exists from the district hospital to the subcentre.
ROUTE_ROWS = [
    route_row(WAREHOUSE, HOSPITAL, "120.40", "2.75", True),
    route_row(WAREHOUSE, PHC, "210.25", "5.10", True),
    route_row(WAREHOUSE, CHC, "180.00", "4.20", False),
    route_row(WAREHOUSE, SUBCENTRE, "1300.00", "30.00", True),
    route_row(HOSPITAL, PHC, "95.50", "2.50", True),
    route_row(HOSPITAL, CHC, "60.00", "1.60", False),
    route_row(PHC, HOSPITAL, "95.50", "2.60", True),
    route_row(CHC, PHC, "140.00", "3.40", False),
    route_row(SUBCENTRE, PHC, "310.00", "7.60", True),
]

WRITE_KEYWORDS = ("INSERT", "UPDATE", "DELETE", "REPLACE", "ALTER", "DROP", "CREATE", "TRUNCATE")


class FakeDatabase:
    """Stands in for MySQL: returns the rows each read query would select and records every query."""

    def __init__(self, **tables):
        self.tables = {
            "medicines": MEDICINE_ROWS, "facilities": FACILITY_ROWS, "inventory": INVENTORY_ROWS, "safety": SAFETY_ROWS,
            "replenishments": REPLENISHMENT_ROWS, "consumption": CONSUMPTION_ROWS, "routes": ROUTE_ROWS, **tables,
        }
        self.queries = []
        self.connections = 0

    @contextmanager
    def connect(self):
        self.connections += 1
        yield self.run

    def run(self, sql, params):
        self.queries.append((sql, tuple(params)))
        if sql in (MEDICINES_SQL, SIMULATION_MEDICINES_SQL):
            # The forecast query does not select requires_cold_chain, exactly as in MySQL.
            return [row if sql == SIMULATION_MEDICINES_SQL else _without(row, "requires_cold_chain") for row in self.tables["medicines"]]
        if sql in (FACILITIES_SQL, SIMULATION_FACILITIES_SQL):
            return [row if sql == SIMULATION_FACILITIES_SQL else _without(row, "has_cold_chain") for row in self.tables["facilities"]]
        if sql == ROUTES_SQL:
            return list(self.tables["routes"])
        table = {INVENTORY_SQL: "inventory", SAFETY_STOCK_SQL: "safety", REPLENISHMENTS_SQL: "replenishments", CONSUMPTION_SQL: "consumption"}[sql]
        rows = [row for row in self.tables[table] if row["medicine_id"] == params[0]]
        if sql == CONSUMPTION_SQL:
            rows = [row for row in rows if params[1] <= row["consumption_date"] <= params[2]]
        return rows


def _without(row, column):
    return {key: value for key, value in row.items() if key != column}


def unavailable_connector():
    @contextmanager
    def connect():
        raise DatabaseUnavailableError("The MEDRIPPLE MySQL database at 127.0.0.1:3307/medripple is unavailable (OperationalError 2003).")
        yield  # pragma: no cover

    return connect


def mysql_client(database=None):
    database = database or FakeDatabase()
    return TestClient(create_app(data_source=MySQLDataSource(SETTINGS, connector=database.connect))), database


def transfer(source, destination, quantity, medicine="7", arrival_day=1):
    return {"fromFacilityId": source, "toFacilityId": destination, "medicineId": medicine, "quantity": quantity, "arrivalDay": arrival_day}


def simulate(client, *transfers, horizon=14):
    return client.post("/scenarios/simulate", json={"horizonDays": horizon, "transfers": list(transfers)})


def facility(block, facility_id):
    return next(item for item in block["facilities"] if item["facilityId"] == facility_id)
