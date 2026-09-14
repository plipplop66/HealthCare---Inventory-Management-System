"""In-memory MySQL rows for the optimizer tests, built on tests/simulator_support.py: no Docker, MySQL server or network.

The simulator's rows gain database batch IDs. Insulin (medicine 7, mL, cold chain) to PHC-SIM-001 over 14 days
(30 mL, 40 mL/day, safety stock 560, 600 mL DELAYED to day 8: stockout on day 1, 7 shortage days, 250 mL unmet).
Donor routes may take at most 6 hours, and donor capacity counts only stock already received:
- WH-SIM-001  warehouse, 5000 mL, no consumption and no safety stock row: retained floor = 10% x 5000 = 500,
              safe capacity 4500 mL; 210.25 km, 5.1 h, cold chain
- DH-SIM-001  1000 mL, 50 mL/day, safety stock 700 (floor 780.5 with the 11.5% equity uplift). Without its 700 mL
              delivery on day 7 its stock falls to 300 mL by day 14: no safe capacity, although effective stock minus
              safety stock is 300
- CHC-SIM-001 route to PHC-SIM-001 is not cold-chain capable
- SC-SIM-001  SubCentre, remoteness 0.72, route 7.6 h: over the 6-hour limit. On a route inside the limit its lowest
              projected stock is 253 against a floor of 147 x 1.71 = 251.37, a safe capacity of 1.63 mL (106 mL
              without the equity reserve)
"""

from datetime import date

from fastapi.testclient import TestClient

from app.main import create_app
from app.mysql_store import MySQLDataSource
from tests.simulator_support import (
    CONSUMPTION_ROWS,
    HOSPITAL,
    INSULIN,
    INVENTORY_ROWS,
    PHC,
    REPLENISHMENT_ROWS,
    ROUTE_ROWS,
    SAFETY_ROWS,
    SETTINGS,
    SUBCENTRE,
    WAREHOUSE,
    FakeDatabase,
    daily_consumption,
    inventory_row,
    mysql_client,
    replenishment_row,
    route_row,
    safety_row,
)

BATCH_IDS = {
    "SIM-001-B02": 2, "SIM-007-B01": 13, "SIM-007-B02": 14, "SIM-007-B03": 15, "SIM-007-B04": 16, "SIM-007-B05": 17,
    "SIM-007-B06": 18, "SIM-007-B07": 19, "SIM-010-B02": 20,
}


def with_batch_ids(rows):
    return [row if "batch_id" in row else {**row, "batch_id": BATCH_IDS[row["batch_number"]]} for row in rows]


def without_pair(rows, facility_id, medicine_id):
    return [row for row in rows if not (row["facility_id"] == facility_id and row["medicine_id"] == medicine_id)]


def replace_facility_rows(rows, facility_id, medicine_id, *replacements):
    return without_pair(rows, facility_id, medicine_id) + list(replacements)


def optimizer_client(config=None, **tables):
    """A client over FakeDatabase rows with batch IDs; keyword tables replace the defaults and config replaces OptimizerConfig."""
    tables["inventory"] = with_batch_ids(tables.get("inventory", INVENTORY_ROWS))
    database = FakeDatabase(**tables)
    if config is None:
        return mysql_client(database)
    return TestClient(create_app(data_source=MySQLDataSource(SETTINGS, connector=database.connect), optimizer_config=config)), database


def routes_without(origin, destination, routes=ROUTE_ROWS):
    return [row for row in routes if not (row["origin_facility_id"] == origin and row["destination_facility_id"] == destination)]


def routes_with(origin, destination, hours, distance="100.00", cold_chain=True, routes=ROUTE_ROWS):
    """The routes with origin -> destination replaced (or added) by one taking the given hours."""
    return routes_without(origin, destination, routes) + [route_row(origin, destination, distance, hours, cold_chain)]


def multi_source_tables():
    """A 700 mL warehouse (safe capacity 630) and a hospital with safety stock 100 (floor 111.5).

    Counting only received stock the hospital falls to 300 mL by day 14, a safe capacity of 188.5 mL; its 700 mL
    delivery on day 7 would have lifted that to 588.5 mL.
    """
    return {
        "inventory": replace_facility_rows(INVENTORY_ROWS, WAREHOUSE, INSULIN, inventory_row(WAREHOUSE, INSULIN, "SIM-007-B02", "700.00")),
        "safety": replace_facility_rows(SAFETY_ROWS, HOSPITAL, INSULIN, safety_row(HOSPITAL, INSULIN, "100.00")),
    }


def split_batch_tables():
    """Warehouse insulin in two batches: 200.5 mL expiring first, then 499.5 mL (safe capacity 630 mL)."""
    return {
        "inventory": replace_facility_rows(
            INVENTORY_ROWS, WAREHOUSE, INSULIN,
            inventory_row(WAREHOUSE, INSULIN, "SIM-007-B02", "499.50"),
            inventory_row(WAREHOUSE, INSULIN, "SIM-007-B01", "200.50", expiry=date(2028, 2, 29)),
        ),
    }


def no_warehouse_route_tables():
    """Only the subcentre can reach PHC-SIM-001 safely, on a 5.5-hour route, so its equity reserve decides the outcome."""
    return {"routes": routes_with(SUBCENTRE, PHC, "5.50", "310.00", routes=routes_without(WAREHOUSE, PHC))}


def future_supply_donor_tables(status):
    """DH-SIM-001 holds 500 mL, uses 30 mL a day, keeps 100 mL safety stock (floor 111.5) and expects 1000 mL on day 7.

    Counting that delivery its lowest stock is 320 mL on day 6; counting only received stock it falls to 80 mL by day 14,
    below its floor. The warehouse has no route to PHC-SIM-001, so this hospital is the only donor inside the 6-hour limit.
    """
    return {
        "inventory": replace_facility_rows(INVENTORY_ROWS, HOSPITAL, INSULIN, inventory_row(HOSPITAL, INSULIN, "SIM-007-B01", "500.00", expiry=date(2028, 2, 29))),
        "consumption": without_pair(CONSUMPTION_ROWS, HOSPITAL, INSULIN) + daily_consumption(HOSPITAL, INSULIN, "30.00"),
        "safety": replace_facility_rows(SAFETY_ROWS, HOSPITAL, INSULIN, safety_row(HOSPITAL, INSULIN, "100.00")),
        "replenishments": replace_facility_rows(REPLENISHMENT_ROWS, HOSPITAL, INSULIN, replenishment_row(HOSPITAL, INSULIN, 7, "1000.00", status)),
        "routes": routes_without(WAREHOUSE, PHC),
    }


def replenishment_status_tables(facility_id, status):
    """The default rows with that facility's insulin order given another status."""
    return {
        "replenishments": [
            {**row, "status": status} if (row["facility_id"], row["medicine_id"]) == (facility_id, INSULIN) else row for row in REPLENISHMENT_ROWS
        ]
    }


def arrived_replenishment_tables():
    """ARRIVED orders for the recipient and a donor: that stock is already in inventory and must not be projected again."""
    return {
        "replenishments": REPLENISHMENT_ROWS + [
            replenishment_row(PHC, INSULIN, 3, "500.00", "ARRIVED"),
            replenishment_row(HOSPITAL, INSULIN, 2, "700.00", "ARRIVED"),
        ]
    }


def high_risk_subcentre_tables():
    """SC-SIM-001 holds only 100 mL at 10.5 mL a day: it runs out on day 10 and scores HIGH. Its route is 5 hours."""
    return {
        "inventory": replace_facility_rows(INVENTORY_ROWS, SUBCENTRE, INSULIN, inventory_row(SUBCENTRE, INSULIN, "SIM-007-B02", "100.00")),
        "routes": routes_with(SUBCENTRE, PHC, "5.00", "310.00"),
    }


def optimize(client, destination, quantity, medicine="7", horizon=14):
    return client.post(
        "/plans/optimize", json={"destinationFacilityId": destination, "medicineId": medicine, "quantity": quantity, "horizonDays": horizon}
    )


def candidate(body, facility_id):
    return next(item for item in body["candidates"] if item["facilityId"] == facility_id)


def details(response):
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "NO_SAFE_PLAN"
    return error["details"]
