"""Ripple Simulator scenarios on in-memory MySQL rows and the offline fixture: no Docker, MySQL or network.

Expected numbers are hand-calculated from tests/simulator_support.py, where daily consumption is constant.
"""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from app.data_store import SimulatedDataStore
from app.main import create_app
from app.mysql_store import MySQLDataSource
from app.simulator import INVALID_ARRIVAL_DAY, INVALID_QUANTITY, ProposedTransfer, simulate as simulate_transfers
from tests.simulator_support import (
    CONSUMPTION_ROWS,
    INVENTORY_ROWS,
    SETTINGS,
    SUBCENTRE,
    FakeDatabase,
    facility,
    inventory_row,
    mysql_client,
    simulate,
    transfer,
)

FIXTURE_INSULIN = "med-insulin-100iu-vial"


@pytest.fixture()
def client():
    return mysql_client()[0]


def evaluation(body, index=0):
    return body["transferEvaluations"][index]


def ok(response):
    assert response.status_code == 200, response.text
    return response.json()


def test_healthy_baseline_with_no_new_risk_and_count_unit(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 5, medicine="10")))
    assert body["medicine"]["unit"] == body["dataContext"]["unit"] == "count"
    assert (body["baseline"]["criticalFacilityCount"], body["baseline"]["stockoutFacilityCount"], body["baseline"]["regionalShortageDays"]) == (0, 0, 0)
    comparison = body["comparison"]
    assert evaluation(body)["eligible"] is True
    assert (comparison["newRisks"], comparison["worsenedFacilities"], comparison["recipientStockoutPrevented"]) == ([], [], False)
    assert comparison["safeToRecommend"] is True
    day_one = facility(body["intervention"], "PHC-SIM-001")["projectedDailyStock"][0]
    assert (day_one["transferIn"], day_one["demand"], day_one["closingStock"]) == (5.0, 1.0, 44.0)
    assert "count" in evaluation(body)["explanation"] and "counts" not in evaluation(body)["explanation"]


def test_critical_recipient_baseline_matches_the_projection(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)))
    phc = facility(body["baseline"], "PHC-SIM-001")
    assert (phc["stockoutDay"], phc["stockoutDate"], phc["shortageDays"], phc["unmetDemand"]) == (1, "2026-09-12", 7, 250.0)
    assert (phc["riskScore"], phc["riskLabel"], phc["predictedDailyDemand"], phc["protectedStock"]) == (84, "CRITICAL", 40.0, 560.0)
    assert (body["baseline"]["criticalFacilityCount"], body["baseline"]["regionalRisk"]) == (1, 84)


def test_safe_transfer_prevents_the_recipient_stockout(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)))
    item = evaluation(body)
    assert (item["eligible"], item["applied"], item["departureDay"], item["rejectionCodes"]) == (True, True, 1, [])
    assert item["route"] == {"distanceKm": 210.25, "travelHours": 5.1, "coldChainAvailable": True}
    assert item["batches"] == [{"batchNo": "SIM-007-B02", "quantity": 600.0, "expiryDate": "2028-04-24"}]
    after = facility(body["intervention"], "PHC-SIM-001")
    assert (after["stockoutDay"], after["unmetDemand"], after["riskScore"], after["riskLabel"]) == (None, 0.0, 36, "MEDIUM")
    warehouse = facility(body["intervention"], "WH-SIM-001")
    assert (warehouse["demandBasis"], warehouse["riskScore"], warehouse["transferOut"], warehouse["endingStock"]) == (
        "NO_CONSUMPTION_STORAGE_FACILITY", None, 600.0, 4400.0,
    )
    comparison = body["comparison"]
    assert comparison["recipientStockoutPrevented"] is True
    assert (comparison["shortageDaysPrevented"], comparison["unmetDemandReduced"]) == (7, 250.0)
    assert (comparison["regionalRiskBefore"], comparison["regionalRiskAfter"], comparison["regionalOutcome"]) == (84, 36, "IMPROVED")
    assert comparison["safeToRecommend"] is True
    assert "600 mL" in item["explanation"] and "mLs" not in item["explanation"]


def test_transfer_below_donor_protected_stock_is_rejected_but_simulated(client):
    body = ok(simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 400)))
    item = evaluation(body)
    assert (item["eligible"], item["applied"], item["rejectionCodes"]) == (False, True, ["BELOW_PROTECTED_STOCK"])
    assert "protected safety stock" in item["rejectionReasons"][0]
    donor = facility(body["intervention"], "DH-SIM-001")
    assert (donor["minimumProjectedStock"], donor["belowProtectedStock"]) == (300.0, True)
    assert facility(body["baseline"], "DH-SIM-001")["belowProtectedStock"] is False
    comparison = body["comparison"]
    assert comparison["recipientStockoutPrevented"] is True
    assert [(risk["riskType"], risk["facilityId"]) for risk in comparison["newRisks"]] == [("FELL_BELOW_PROTECTED_STOCK", "DH-SIM-001")]
    assert comparison["safeToRecommend"] is False
    # Earliest-expiry usable batch first; the quarantined batch is never sent.
    assert item["batches"] == [{"batchNo": "SIM-007-B01", "quantity": 400.0, "expiryDate": "2028-02-29"}]


def test_recipient_saved_but_donor_becomes_critical_is_not_safe(client):
    body = ok(simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 980)))
    comparison = body["comparison"]
    assert comparison["recipientStockoutPrevented"] is True
    assert comparison["newShortagesCreated"] == ["DH-SIM-001"]
    assert comparison["newCriticalFacilities"] == ["DH-SIM-001"]
    assert comparison["safeToRecommend"] is False
    assert set(evaluation(body)["rejectionCodes"]) == {"BELOW_PROTECTED_STOCK", "DONOR_BECOMES_CRITICAL", "CREATES_REGIONAL_SHORTAGE"}
    donor = facility(body["intervention"], "DH-SIM-001")
    assert (donor["stockoutDay"], donor["shortageDays"], donor["unmetDemand"], donor["riskLabel"]) == (1, 6, 280.0, "CRITICAL")
    assert "DH-SIM-001" in [item["facilityId"] for item in comparison["worsenedFacilities"]]
    assert comparison["regionalOutcome"] == "MIXED"


def test_insufficient_donor_inventory_excludes_expired_and_quarantined_stock(client):
    body = ok(simulate(client, transfer("DH-SIM-001", "PHC-SIM-001", 1100)))
    item = evaluation(body)
    assert (item["rejectionCodes"], item["applied"]) == (["INSUFFICIENT_DONOR_STOCK"], False)
    assert "1000 mL" in item["rejectionReasons"][0]
    # Recorded stock is 1500 mL, but 300 mL is expired and 200 mL is quarantined.
    assert facility(body["baseline"], "DH-SIM-001")["effectiveStock"] == 1000.0
    assert facility(body["baseline"], "PHC-SIM-001")["effectiveStock"] == 30.0
    assert body["intervention"]["regionalUnmetDemand"] == body["baseline"]["regionalUnmetDemand"]
    assert body["intervention"]["appliedTransferCount"] == 0


def test_missing_route_is_rejected(client):
    item = evaluation(ok(simulate(client, transfer("DH-SIM-001", "SC-SIM-001", 10))))
    assert (item["rejectionCodes"], item["route"], item["applied"]) == (["ROUTE_NOT_FOUND"], None, False)


def test_cold_chain_medicine_on_a_route_without_cold_chain_is_rejected(client):
    item = evaluation(ok(simulate(client, transfer("DH-SIM-001", "CHC-SIM-001", 10))))
    assert item["rejectionCodes"] == ["COLD_CHAIN_UNAVAILABLE"]
    assert item["route"]["coldChainAvailable"] is False


def test_medicine_identity_mismatch_is_rejected_without_substitution(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600), transfer("WH-SIM-001", "PHC-SIM-001", 10, medicine="8")))
    assert body["medicine"]["id"] == "7"
    assert evaluation(body, 0)["eligible"] is True
    mismatch = evaluation(body, 1)
    assert (mismatch["rejectionCodes"], mismatch["applied"]) == (["MEDICINE_IDENTITY_MISMATCH"], False)
    assert "no substitution" in mismatch["rejectionReasons"][0]


def test_documented_alias_is_the_same_medicine_identity(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 300), transfer("WH-SIM-001", "PHC-SIM-001", 300, medicine=FIXTURE_INSULIN)))
    assert [item["eligible"] for item in body["transferEvaluations"]] == [True, True]
    assert facility(body["intervention"], "PHC-SIM-001")["transferIn"] == 600.0


def test_transfer_arriving_after_recipient_stockout_is_flagged(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600, arrival_day=3)))
    item = evaluation(body)
    assert (item["rejectionCodes"], item["applied"]) == (["ARRIVES_AFTER_RECIPIENT_STOCKOUT"], True)
    assert facility(body["intervention"], "PHC-SIM-001")["shortageDays"] == 2
    assert body["comparison"]["safeToRecommend"] is False


def test_destination_already_critical_is_not_a_rejection_reason(client):
    item = evaluation(ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600))))
    assert item["eligible"] is True


def test_multiple_transfers_are_evaluated_together(client):
    single = ok(simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 100)))
    assert evaluation(single)["eligible"] is True
    together = ok(simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 100), transfer("SC-SIM-001", "PHC-SIM-001", 100)))
    assert [item["rejectionCodes"] for item in together["transferEvaluations"]] == [["BELOW_PROTECTED_STOCK"], ["BELOW_PROTECTED_STOCK"]]
    assert facility(together["intervention"], "SC-SIM-001")["transferOut"] == 200.0

    safe = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 300), transfer("SC-SIM-001", "PHC-SIM-001", 50)))
    assert [item["eligible"] for item in safe["transferEvaluations"]] == [True, True]
    assert safe["intervention"]["appliedTransferCount"] == 2
    recipient = facility(safe["intervention"], "PHC-SIM-001")
    assert (recipient["transferIn"], recipient["stockoutDay"], recipient["role"]) == (350.0, None, "RECIPIENT")
    assert safe["comparison"]["safeToRecommend"] is True


def test_decimal_quantities_are_preserved(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600.25)))
    item = evaluation(body)
    assert (item["quantity"], item["batches"][0]["quantity"]) == (600.25, 600.25)
    recipient = facility(body["intervention"], "PHC-SIM-001")
    assert (recipient["transferIn"], recipient["stockAfterTransfers"]) == (600.25, 630.25)
    assert recipient["projectedDailyStock"][0]["closingStock"] == 590.25
    assert facility(body["intervention"], "WH-SIM-001")["endingStock"] == 4399.75


def test_mg_unit_is_preserved_with_decimals(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 20000.5, medicine="1")))
    assert body["medicine"]["unit"] == "mg"
    before, after = facility(body["baseline"], "PHC-SIM-001"), facility(body["intervention"], "PHC-SIM-001")
    assert (before["predictedDailyDemand"], before["stockoutDay"], after["stockoutDay"], after["transferIn"]) == (1000.5, 3, None, 20000.5)
    assert "20000.5 mg" in evaluation(body)["explanation"] and "mgs" not in evaluation(body)["explanation"]


def test_scheduled_and_delayed_replenishments_are_applied_and_cancelled_ignored(client):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600)))
    hospital_day_seven = facility(body["baseline"], "DH-SIM-001")["projectedDailyStock"][6]
    assert (hospital_day_seven["openingStock"], hospital_day_seven["scheduledReplenishment"], hospital_day_seven["closingStock"]) == (700.0, 700.0, 1350.0)
    phc_day_eight = facility(body["baseline"], "PHC-SIM-001")["projectedDailyStock"][7]
    assert (phc_day_eight["scheduledReplenishment"], phc_day_eight["closingStock"]) == (600.0, 560.0)
    assert all(day["scheduledReplenishment"] == 0 for day in facility(body["baseline"], "CHC-SIM-001")["projectedDailyStock"])


@pytest.mark.parametrize("horizon, shortage_days, unmet", [(7, 7, 250.0), (14, 7, 250.0), (30, 15, 570.0)])
def test_every_horizon_projects_every_facility(client, horizon, shortage_days, unmet):
    body = ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 600), horizon=horizon))
    assert body["horizonDays"] == horizon
    for block in (body["baseline"], body["intervention"]):
        assert all(len(item["projectedDailyStock"]) == horizon for item in block["facilities"])
    before = facility(body["baseline"], "PHC-SIM-001")
    assert (before["shortageDays"], before["unmetDemand"]) == (shortage_days, unmet)
    assert facility(body["intervention"], "PHC-SIM-001")["stockoutDay"] is None
    assert body["comparison"]["safeToRecommend"] is True


def test_source_equal_to_destination_through_an_alias_is_rejected(client):
    item = evaluation(ok(simulate(client, transfer("3", "PHC-SIM-001", 10))))
    assert "SAME_SOURCE_AND_DESTINATION" in item["rejectionCodes"]
    assert item["applied"] is False


def test_invalid_quantity_and_arrival_day_are_rejected_by_the_gate():
    store = MySQLDataSource(SETTINGS, connector=FakeDatabase().connect).regional_store_for(["7"])
    result = simulate_transfers(
        store,
        [ProposedTransfer("WH-SIM-001", "PHC-SIM-001", "7", 0), ProposedTransfer("WH-SIM-001", "PHC-SIM-001", "7", 10, arrival_day=0)],
        14,
    )
    assert [code for code, _ in result.evaluations[0].reasons] == [INVALID_QUANTITY]
    assert INVALID_ARRIVAL_DAY in [code for code, _ in result.evaluations[1].reasons]
    assert not any(item.applied for item in result.evaluations)


def test_unknown_facilities_are_rejected_with_a_useful_reason(client):
    item = evaluation(ok(simulate(client, transfer("WH-NOPE-001", "PHC-NOPE-001", 10))))
    assert item["rejectionCodes"] == ["SOURCE_FACILITY_NOT_FOUND", "DESTINATION_FACILITY_NOT_FOUND"]
    assert item["rejectionReasons"][0] == "The source facility 'WH-NOPE-001' does not exist in the MEDRIPPLE MySQL database."


def test_route_travel_time_sets_the_departure_day(client):
    too_soon = evaluation(ok(simulate(client, transfer("WH-SIM-001", "SC-SIM-001", 10))))
    assert too_soon["rejectionCodes"] == ["TRAVEL_TIME_EXCEEDS_ARRIVAL_DAY"]
    later = ok(simulate(client, transfer("WH-SIM-001", "SC-SIM-001", 10, arrival_day=3)))
    assert (evaluation(later)["eligible"], evaluation(later)["departureDay"]) == (True, 2)
    assert facility(later["intervention"], "WH-SIM-001")["projectedDailyStock"][1]["transferOut"] == 10.0


def test_arrival_after_the_horizon_is_rejected(client):
    item = evaluation(ok(simulate(client, transfer("WH-SIM-001", "PHC-SIM-001", 10, arrival_day=8), horizon=7)))
    assert item["rejectionCodes"] == ["ARRIVAL_OUTSIDE_HORIZON"]


def test_batch_expiring_before_the_end_of_the_horizon_is_not_sent():
    short_dated = [row for row in INVENTORY_ROWS if not (row["facility_id"] == SUBCENTRE and row["medicine_id"] == 7)]
    short_dated.append(inventory_row(SUBCENTRE, 7, "SIM-007-B06", "400.00", expiry=date(2026, 9, 20)))
    client, _ = mysql_client(FakeDatabase(inventory=short_dated))
    item = evaluation(ok(simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 100))))
    assert (item["rejectionCodes"], item["applied"]) == (["BATCH_EXPIRES_BEFORE_USE"], False)


def test_facility_without_usable_history_is_incomplete_data_and_excluded():
    rows = [row for row in CONSUMPTION_ROWS if not (row["facility_id"] == SUBCENTRE and row["medicine_id"] == 7)]
    client, _ = mysql_client(FakeDatabase(consumption=rows))
    body = ok(simulate(client, transfer("SC-SIM-001", "PHC-SIM-001", 10)))
    assert evaluation(body)["rejectionCodes"] == ["INCOMPLETE_DATA"]
    subcentre = facility(body["baseline"], "SC-SIM-001")
    assert (subcentre["projectionAvailable"], subcentre["demandBasis"], subcentre["riskScore"]) == (False, "UNAVAILABLE", None)
    assert any("SC-SIM-001" in note for note in body["dataContext"]["notes"])


# ---- Offline fixture (DATA_SOURCE=fixture) ----


@pytest.fixture()
def fixture_client():
    return TestClient(create_app(SimulatedDataStore.from_csv()))


def fixture_transfer(source, destination, quantity, arrival_day=1):
    return transfer(source, destination, quantity, medicine=FIXTURE_INSULIN, arrival_day=arrival_day)


def test_fixture_central_store_can_safely_supply_navjeevan(fixture_client):
    body = ok(simulate(fixture_client, fixture_transfer("facility-central-store", "facility-navjeevan-phc", 45)))
    assert body["scenarioType"] == "SIMULATED_FIXTURE" and body["dataContext"]["dataSource"] == "FIXTURE"
    assert (facility(body["baseline"], "facility-navjeevan-phc")["stockoutDay"], facility(body["intervention"], "facility-navjeevan-phc")["stockoutDay"]) == (3, None)
    assert evaluation(body)["eligible"] is True
    assert body["comparison"]["safeToRecommend"] is True
    assert body["medicine"]["unit"] == "vial"


def test_fixture_district_hospital_donation_is_rejected_for_protected_stock(fixture_client):
    item = evaluation(ok(simulate(fixture_client, fixture_transfer("facility-district-hospital", "facility-navjeevan-phc", 45))))
    assert item["eligible"] is False
    assert "BELOW_PROTECTED_STOCK" in item["rejectionCodes"]
    assert "protected safety stock" in item["rejectionReasons"][0]


def test_fixture_has_no_route_from_navjeevan_to_river_chc(fixture_client):
    item = evaluation(ok(simulate(fixture_client, fixture_transfer("facility-navjeevan-phc", "facility-river-chc", 5))))
    assert item["rejectionCodes"] == ["ROUTE_NOT_FOUND"]
