import csv
import json
import math
import shutil
import subprocess
from datetime import timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.data_store import DEFAULT_CONSUMPTION_CSV, INSULIN_ID, SimulatedDataStore
from app.main import analyse_target, create_app
from app.risk_engine import analyse_shortage, compute_regional_fragility

REPO_ROOT = Path(__file__).resolve().parents[2]
NODE_ADAPTER = REPO_ROOT / "backend" / "src" / "intelligence-adapter.js"
NAVJEEVAN_REQUEST = {"facilityId": "facility-navjeevan-phc", "medicineId": "med-insulin-100iu-vial", "horizonDays": 14}
FACILITY_IDS = ("facility-central-store", "facility-district-hospital", "facility-river-chc", "facility-navjeevan-phc")

# Fields that backend/src/intelligence-adapter.js and docs/api-contract.md rely on.
REQUIRED_BLOCK_FIELDS = {
    "forecast": {"dailyDemand", "lowerBound", "upperBound", "horizonDays"},
    "risk": {"score", "label"},
    "stockout": {"daysRemaining", "projectedWithinHorizon", "projectedStockoutDay", "shortageGapDays"},
    "confidence": {"label", "reason"},
}
REQUIRED_TOP_LEVEL_FIELDS = {"cause", "explanation", "assumptions", "decisionSupportOnly"}

client = TestClient(create_app())


def post_forecast(**overrides):
    return client.post("/forecast", json={**NAVJEEVAN_REQUEST, **overrides})


def write_consumption_csv(path, mutate):
    with DEFAULT_CONSUMPTION_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(line for line in handle if not line.startswith("#")))
    for row in rows:
        mutate(row)
    with path.open("w", newline="", encoding="utf-8") as handle:
        handle.write("# SIMULATED PROTOTYPE TEST DATA\n")
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    return path


def facility_data_from_store(store, facility_id, horizon_days):
    """Build analyse_shortage input from the same simulated data the API uses."""
    facility = store.get_facility(facility_id)
    medicine = store.get_medicine(INSULIN_ID)
    inventory = store.get_inventory(facility_id, INSULIN_ID)
    replenishment = inventory.replenishments[0] if inventory.replenishments else None
    peers = [analyse_target(store, peer, INSULIN_ID).safe_surplus for peer in store.regional_peers(facility, INSULIN_ID)]
    return {
        "as_of_date": store.as_of.isoformat(),
        "consumption_history": [
            {"date": record.day.isoformat(), "units_consumed": record.units}
            for record in store.consumption_history(facility_id, INSULIN_ID)
        ],
        "current_stock": inventory.effective_stock(store.as_of),
        "expected_replenishment_date": (
            (store.as_of + timedelta(days=replenishment.arrival_day - 1)).isoformat() if replenishment else None
        ),
        "incoming_quantity": replenishment.quantity if replenishment else None,
        "medicine_criticality": medicine.criticality,
        "facility_remoteness": facility.remoteness_score,
        "regional_fragility": compute_regional_fragility(peers),
        "protected_days": facility.protected_days,
        "horizon_days": horizon_days,
        "unit": medicine.unit,
    }


def test_health_endpoint():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "medripple-intelligence"}


def test_navjeevan_phc_returns_critical_risk():
    response = post_forecast()
    assert response.status_code == 200
    body = response.json()
    assert body["risk"]["label"] == "CRITICAL"
    assert body["risk"]["score"] >= 75
    assert body["forecast"]["dailyDemand"] == 8.06  # 0.70 x 9.0 + 0.30 x 5.86
    assert body["forecast"]["trend"] == "INCREASING"
    assert body["forecast"]["trendChangePercent"] == 53.7
    assert body["cause"] == "SUPPLY_DELAY"
    assert "DEMAND_SHOCK" in body["contributingFactors"]
    assert body["confidence"]["label"] == "HIGH"
    assert body["decisionSupportOnly"] is True


@pytest.mark.parametrize("horizon", [7, 14, 30])
def test_navjeevan_stockout_occurs_before_replenishment(horizon):
    stockout = post_forecast(horizonDays=horizon).json()["stockout"]
    assert stockout["projectedWithinHorizon"] is True
    assert stockout["daysRemaining"] == 2.7
    assert stockout["projectedStockoutDay"] == 3
    assert stockout["projectedStockoutDate"] == "2026-09-03"
    assert stockout["nextReplenishment"]["arrivalDay"] == 8
    assert stockout["projectedStockoutDay"] < stockout["nextReplenishment"]["arrivalDay"]
    assert stockout["replenishmentTiming"] == "AFTER_STOCKOUT"
    assert stockout["replenishmentArrivesBeforeStockout"] is False
    assert stockout["shortageGapDays"] == 5


def test_navjeevan_30_day_view_flags_second_shortage_after_replenishment():
    body = post_forecast(horizonDays=30).json()
    stockout = body["stockout"]
    assert stockout["supplyRestoredDay"] == 8
    assert stockout["totalShortageDays"] == 16  # days 3-7, then 20-30 once the 100 vials run out
    assert "runs short again later in the horizon (11 more shortage day(s))" in body["explanation"]


def test_projection_uses_effective_not_recorded_stock():
    body = post_forecast().json()
    assert body["inventory"]["recordedStock"] == 27
    assert body["inventory"]["effectiveStock"] == 22
    assert body["inventory"]["excludedStock"] == 5
    assert body["projection"][0]["openingStock"] == 22


def test_healthy_warehouse_returns_lower_risk():
    navjeevan = post_forecast().json()
    central = post_forecast(facilityId="facility-central-store").json()
    assert central["risk"]["score"] < navjeevan["risk"]["score"]
    # Plain weighted sum: no stockout or gap, but HIGH criticality (25) + remoteness (0.5) + fragility (6.7) = 32.
    assert central["risk"]["label"] == "MEDIUM"
    contributions = {component["key"]: component["contribution"] for component in central["risk"]["components"]}
    assert contributions["stockoutUrgency"] == 0 and contributions["replenishmentGap"] == 0
    assert central["stockout"]["projectedWithinHorizon"] is False
    assert central["stockout"]["projectedStockoutDate"] is None
    assert central["cause"] == "STABLE"
    assert central["inventory"]["safeSurplus"] > 0


def test_district_hospital_has_stock_but_no_safe_donor_surplus():
    body = post_forecast(facilityId="facility-district-hospital").json()
    assert body["inventory"]["effectiveStock"] == 260
    assert body["inventory"]["safeSurplus"] == 0
    assert body["cause"] == "INVENTORY_IMBALANCE"
    assert body["dataQuality"]["anomalies"], "the simulated data-entry spike should be flagged"


def test_river_chc_has_smaller_but_safe_surplus():
    river = post_forecast(facilityId="facility-river-chc").json()
    central = post_forecast(facilityId="facility-central-store").json()
    assert 10 <= river["inventory"]["safeSurplus"] < central["inventory"]["safeSurplus"]
    assert river["confidence"]["label"] == "MEDIUM"  # two simulated missing reports


def test_forecast_is_deterministic_across_requests():
    assert post_forecast().json() == post_forecast().json()


def test_unknown_facility_returns_404():
    response = post_forecast(facilityId="facility-does-not-exist")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "FACILITY_NOT_FOUND"


def test_unknown_medicine_returns_404():
    response = post_forecast(medicineId="med-unknown")
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEDICINE_NOT_FOUND"


@pytest.mark.parametrize("horizon", [0, 10, 31, -7, "14", 14.5, True, None])
def test_invalid_horizon_returns_422(horizon):
    response = post_forecast(horizonDays=horizon)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "INVALID_HORIZON"
    assert error["message"] == "horizonDays must be one of 7, 14 or 30."


def test_horizon_defaults_to_14_like_the_node_backend():
    response = client.post("/forecast", json={"facilityId": "facility-navjeevan-phc", "medicineId": "med-insulin-100iu-vial"})
    assert response.status_code == 200
    assert response.json()["forecast"]["horizonDays"] == 14


@pytest.mark.parametrize(
    "body, field",
    [
        ({"medicineId": "med-insulin-100iu-vial", "horizonDays": 14}, "facilityId"),
        ({"facilityId": "facility-navjeevan-phc", "horizonDays": 14}, "medicineId"),
        ({"facilityId": "   ", "medicineId": "med-insulin-100iu-vial", "horizonDays": 14}, "facilityId"),
        ({"facilityId": 42, "medicineId": "med-insulin-100iu-vial", "horizonDays": 14}, "facilityId"),
    ],
)
def test_missing_or_invalid_required_fields_return_422(body, field):
    response = client.post("/forecast", json=body)
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "INVALID_REQUEST"
    assert field in error["message"]


def test_empty_and_malformed_bodies_return_422():
    assert client.post("/forecast", json={}).json()["error"]["code"] == "INVALID_REQUEST"
    malformed = client.post("/forecast", content="not json", headers={"content-type": "application/json"})
    assert malformed.status_code == 422
    assert malformed.json()["error"] == {
        "code": "INVALID_REQUEST",
        "message": "Request body must be valid JSON.",
        "details": malformed.json()["error"]["details"],
    }


def test_missing_and_invalid_consumption_values_are_handled_safely(tmp_path):
    corrupt = {"2026-08-29": "", "2026-08-30": "not-recorded", "2026-08-31": "-4"}

    def mutate(row):
        if row["facility_id"] == "facility-navjeevan-phc" and row["date"] in corrupt:
            row["units_consumed"] = corrupt[row["date"]]

    store = SimulatedDataStore.from_csv(write_consumption_csv(tmp_path / "consumption.csv", mutate))
    response = TestClient(create_app(store)).post("/forecast", json=NAVJEEVAN_REQUEST)
    assert response.status_code == 200
    body = response.json()
    assert math.isfinite(body["forecast"]["dailyDemand"]) and body["forecast"]["dailyDemand"] > 0
    assert body["confidence"]["label"] != "HIGH"
    assert body["confidence"]["missingOrInvalidRecords"] == 3
    assert "missing or invalid" in body["confidence"]["reason"]
    assert {item["issue"] for item in body["dataQuality"]["missingOrInvalid"]} == {"MISSING", "NOT_A_NUMBER", "NEGATIVE"}


def test_unusable_consumption_history_returns_422(tmp_path):
    def mutate(row):
        if row["facility_id"] == "facility-navjeevan-phc":
            row["units_consumed"] = "not-recorded"

    store = SimulatedDataStore.from_csv(write_consumption_csv(tmp_path / "consumption.csv", mutate))
    app_client = TestClient(create_app(store))
    response = app_client.post("/forecast", json=NAVJEEVAN_REQUEST)
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_HISTORY"
    # Other facilities still forecast; Navjeevan simply counts as a peer without safe surplus.
    assert app_client.post("/forecast", json={**NAVJEEVAN_REQUEST, "facilityId": "facility-river-chc"}).status_code == 200


@pytest.mark.parametrize("facility_id", FACILITY_IDS)
@pytest.mark.parametrize("horizon", [7, 14, 30])
def test_analyse_shortage_matches_the_forecast_endpoint(facility_id, horizon):
    store = SimulatedDataStore.from_csv()
    result = analyse_shortage(facility_data_from_store(store, facility_id, horizon))
    body = post_forecast(facilityId=facility_id, horizonDays=horizon).json()
    assert result == {
        "predicted_demand": body["forecast"]["dailyDemand"],
        "days_remaining": body["stockout"]["daysRemaining"],
        "stockout_date": body["stockout"]["projectedStockoutDate"],
        "risk_score": body["risk"]["score"],
        "risk_level": body["risk"]["label"],
        "cause": body["cause"],
        "confidence": {"label": body["confidence"]["label"], "reason": body["confidence"]["reason"]},
        "explanation": body["explanation"],
    }


@pytest.mark.parametrize("facility_id", FACILITY_IDS)
@pytest.mark.parametrize("horizon", [7, 14, 30])
def test_response_meets_node_adapter_contract(facility_id, horizon):
    response = post_forecast(facilityId=facility_id, horizonDays=horizon)
    assert response.status_code == 200
    body = response.json()
    for block, fields in REQUIRED_BLOCK_FIELDS.items():
        assert isinstance(body[block], dict)
        assert fields <= body[block].keys()
    assert REQUIRED_TOP_LEVEL_FIELDS <= body.keys()
    # Checks mirrored from validateIntelligenceResponse in intelligence-adapter.js.
    score = body["risk"]["score"]
    assert isinstance(score, (int, float)) and not isinstance(score, bool) and math.isfinite(score)
    assert isinstance(body["risk"]["label"], str)
    assert body["risk"]["label"] in {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
    assert body["confidence"]["label"] in {"HIGH", "MEDIUM", "LOW"} and body["confidence"]["reason"].strip()
    assert body["forecast"]["horizonDays"] == horizon
    assert body["decisionSupportOnly"] is True
    assert "source" not in body  # the Node adapter sets source itself
    assert "All inventory and consumption data is simulated." in body["assumptions"]
    assert "Risk weights are prototype assumptions and are not clinically validated." in body["assumptions"]


def run_node_validator(payload):
    script = (
        "const { validateIntelligenceResponse } = require(process.argv[1]);"
        "let input = '';"
        "process.stdin.on('data', (chunk) => { input += chunk; });"
        "process.stdin.on('end', () => { validateIntelligenceResponse(JSON.parse(input)); console.log('VALID'); });"
    )
    return subprocess.run(
        ["node", "-e", script, str(NODE_ADAPTER)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=30,
    )


@pytest.mark.skipif(shutil.which("node") is None or not NODE_ADAPTER.exists(), reason="Node.js or the backend adapter is unavailable")
def test_response_passes_the_real_node_adapter_validator():
    accepted = run_node_validator(post_forecast().json())
    assert accepted.returncode == 0, accepted.stderr
    assert accepted.stdout.strip() == "VALID"
    # Guard against a vacuous check: the same validator must reject a payload without risk.
    rejected = run_node_validator({"forecast": {}})
    assert rejected.returncode != 0
