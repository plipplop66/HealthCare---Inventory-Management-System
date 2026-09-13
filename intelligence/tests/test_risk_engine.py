import math
from datetime import date, timedelta

import pytest

from app.data_store import Replenishment
from app.forecast import ConfidenceAssessment, InsufficientHistoryError, weighted_moving_average
from app.risk_engine import (
    DATA_ANOMALY,
    DEMAND_SHOCK,
    INVENTORY_IMBALANCE,
    STABLE,
    SUPPLY_DELAY,
    TEMPORARY_DIP,
    RiskConfig,
    analyse_shortage,
    build_explanation,
    compute_regional_fragility,
    detect_cause,
    label_for_score,
    score_risk,
)
from app.stock_projection import project_stock

NAVJEEVAN_VALUES = [6.0] * 21 + [9.0] * 7  # previous 21 days at 6/day, latest 7 at 9/day
NAVJEEVAN_REPLENISHMENT = (Replenishment(quantity=100, arrival_day=8),)
AS_OF = date(2026, 9, 1)


def confidence(poor=False, recent_anomalies=0):
    return ConfidenceAssessment(
        label="LOW" if poor else "HIGH",
        reason="Test confidence reason.",
        valid_records=60,
        missing_or_invalid_records=0,
        recent_missing_or_invalid_records=0,
        anomaly_count=recent_anomalies,
        recent_anomaly_count=recent_anomalies,
        recent_variability_cv=0.1,
        data_quality_poor=poor,
    )


def navjeevan_projection(horizon=14):
    demand = weighted_moving_average(NAVJEEVAN_VALUES).daily_demand
    return project_stock(22, demand, horizon, NAVJEEVAN_REPLENISHMENT)


def history_rows(values, as_of=AS_OF):
    start = as_of - timedelta(days=len(values))
    return [{"date": (start + timedelta(days=offset)).isoformat(), "units_consumed": value} for offset, value in enumerate(values)]


def navjeevan_facility_data(**overrides):
    data = {
        "as_of_date": "2026-09-01",
        "consumption_history": history_rows([5.0] * 32 + NAVJEEVAN_VALUES),
        "current_stock": 22,
        "expected_replenishment_date": "2026-09-08",
        "incoming_quantity": 100,
        "medicine_criticality": "HIGH",
        "facility_remoteness": 0.8,
        "regional_fragility": 1 / 3,
        "protected_days": 14,
        "horizon_days": 14,
        "unit": "vial",
    }
    data.update(overrides)
    return data


@pytest.mark.parametrize(
    "score, label",
    [(0, "LOW"), (29, "LOW"), (30, "MEDIUM"), (54, "MEDIUM"), (55, "HIGH"), (74, "HIGH"), (75, "CRITICAL"), (100, "CRITICAL")],
)
def test_risk_label_bands(score, label):
    assert label_for_score(score) == label


def test_default_weights_match_prototype_assumptions():
    assert RiskConfig().weights == {
        "stockoutUrgency": 0.35,
        "medicineCriticality": 0.25,
        "replenishmentGap": 0.20,
        "facilityRemoteness": 0.10,
        "regionalFragility": 0.10,
    }


def test_weights_must_sum_to_one():
    with pytest.raises(ValueError):
        RiskConfig(stockout_urgency_weight=0.5)


def test_navjeevan_like_profile_is_critical_with_hand_calculated_score():
    projection = navjeevan_projection()
    risk = score_risk(
        projection=projection,
        protected_stock=8.1 * 14,
        medicine_criticality="HIGH",
        facility_remoteness=0.8,
        regional_fragility=1 / 3,
    )
    # urgency = 1 - (3 - 1) / 30 = 0.9333; gap = 5 / 7
    # 100 x (0.35 x 0.9333 + 0.25 x 1 + 0.20 x 0.7143 + 0.10 x 0.8 + 0.10 x 0.3333) = 83.3
    assert risk.score == 83
    assert risk.label == "CRITICAL"
    assert [component.contribution for component in risk.components] == [32.7, 25.0, 14.3, 8.0, 3.3]


def test_score_is_a_plain_weighted_sum_of_the_five_signals():
    risk = score_risk(
        projection=project_stock(900, 20, 30),
        protected_stock=20 * 14,
        medicine_criticality="HIGH",
        facility_remoteness=0.05,
        regional_fragility=2 / 3,
    )
    # Healthy warehouse: no stockout or gap, but criticality, remoteness and fragility still count.
    assert [component.contribution for component in risk.components] == [0.0, 25.0, 0.0, 0.5, 6.7]
    for component in risk.components:
        assert component.contribution == pytest.approx(100 * component.weight * component.signal, abs=0.1)
    assert risk.score == 32
    assert risk.label == "MEDIUM"


def test_protected_stock_breach_raises_urgency_without_stockout():
    projection = project_stock(260, 26.4, 7)
    risk = score_risk(
        projection=projection,
        protected_stock=264,
        medicine_criticality="HIGH",
        facility_remoteness=0.15,
        regional_fragility=1 / 3,
    )
    assert projection.projected_stockout_day is None
    assert risk.components[0].contribution > 0
    assert risk.score == 42


def test_score_is_bounded():
    risk = score_risk(
        projection=project_stock(0, 50, 30),
        protected_stock=500,
        medicine_criticality="HIGH",
        facility_remoteness=5.0,
        regional_fragility=5.0,
    )
    assert risk.score == 100


def test_regional_fragility_counts_peers_without_safe_surplus():
    assert compute_regional_fragility([620, 0, 20]) == pytest.approx(1 / 3)
    assert compute_regional_fragility([None, 10]) == 0.5
    assert compute_regional_fragility([]) == 1.0


def test_supply_delay_is_primary_when_stockout_precedes_late_delivery_even_at_prior_demand():
    cause = detect_cause(
        values=NAVJEEVAN_VALUES,
        projection=navjeevan_projection(),
        effective_stock=22,
        protected_stock=113.4,
        replenishments=NAVJEEVAN_REPLENISHMENT,
        confidence=confidence(),
    )
    assert cause.primary == SUPPLY_DELAY
    assert cause.contributing == (DEMAND_SHOCK,)
    assert cause.recent_average == 9.0
    assert cause.prior_average == 6.0


def test_demand_shock_is_primary_when_stockout_only_happens_because_of_the_shock():
    values = [3.0] * 21 + [9.0] * 7
    replenishments = (Replenishment(quantity=100, arrival_day=10),)
    projection = project_stock(50, weighted_moving_average(values).daily_demand, 14, replenishments)
    cause = detect_cause(
        values=values,
        projection=projection,
        effective_stock=50,
        protected_stock=100,
        replenishments=replenishments,
        confidence=confidence(),
    )
    assert projection.projected_stockout_day == 7
    assert cause.primary == DEMAND_SHOCK
    assert cause.contributing == (SUPPLY_DELAY,)


def test_stock_below_protected_level_is_inventory_imbalance():
    cause = detect_cause(
        values=[26.0] * 28,
        projection=project_stock(260, 26.0, 7),
        effective_stock=260,
        protected_stock=270,
        replenishments=(),
        confidence=confidence(),
    )
    assert cause.primary == INVENTORY_IMBALANCE


def test_recent_drop_is_temporary_dip():
    values = [10.0] * 21 + [6.0] * 7
    cause = detect_cause(
        values=values,
        projection=project_stock(500, weighted_moving_average(values).daily_demand, 14),
        effective_stock=500,
        protected_stock=100,
        replenishments=(),
        confidence=confidence(),
    )
    assert cause.primary == TEMPORARY_DIP


def test_poor_data_quality_becomes_primary_cause():
    cause = detect_cause(
        values=NAVJEEVAN_VALUES,
        projection=navjeevan_projection(),
        effective_stock=22,
        protected_stock=113.4,
        replenishments=NAVJEEVAN_REPLENISHMENT,
        confidence=confidence(poor=True),
    )
    assert cause.primary == DATA_ANOMALY
    assert cause.contributing[0] == SUPPLY_DELAY


def test_stable_facility():
    cause = detect_cause(
        values=[20.0] * 28,
        projection=project_stock(900, 20.0, 14),
        effective_stock=900,
        protected_stock=280,
        replenishments=(),
        confidence=confidence(),
    )
    assert cause.primary == STABLE
    assert cause.contributing == ()


def test_explanation_describes_supply_delay_in_plain_language():
    projection = navjeevan_projection()
    cause = detect_cause(
        values=NAVJEEVAN_VALUES,
        projection=projection,
        effective_stock=22,
        protected_stock=113.4,
        replenishments=NAVJEEVAN_REPLENISHMENT,
        confidence=confidence(),
    )
    text = build_explanation(
        cause=cause,
        projection=projection,
        protected_stock=113.4,
        protected_days=14,
        unit="vial",
        confidence=confidence(),
    )
    assert text.startswith("Effective stock is projected to run out before the scheduled replenishment arrives.")
    assert "stockout is projected on day 3" in text
    assert "arrives on day 8" in text
    assert "5-day shortage gap" in text
    assert "Demand is also rising" in text


def test_analyse_shortage_returns_the_day1_fields():
    result = analyse_shortage(navjeevan_facility_data())
    assert list(result) == [
        "predicted_demand",
        "days_remaining",
        "stockout_date",
        "risk_score",
        "risk_level",
        "cause",
        "confidence",
        "explanation",
    ]
    assert result["predicted_demand"] == 8.1
    assert result["days_remaining"] == 2.7  # 22 / 8.1
    assert result["stockout_date"] == "2026-09-03"
    assert result["risk_score"] == 83
    assert result["risk_level"] == "CRITICAL"
    assert result["cause"] == SUPPLY_DELAY
    assert result["confidence"]["label"] == "HIGH"
    assert result["confidence"]["reason"].strip()
    assert "day 3 (2026-09-03)" in result["explanation"]


def test_analyse_shortage_for_healthy_stock_without_replenishment():
    result = analyse_shortage(
        navjeevan_facility_data(
            consumption_history=history_rows([20.0] * 60),
            current_stock=900,
            expected_replenishment_date=None,
            incoming_quantity=None,
            facility_remoteness=0.05,
            regional_fragility=2 / 3,
        )
    )
    assert result["predicted_demand"] == 20.0
    assert result["days_remaining"] == 45.0
    assert result["stockout_date"] is None
    assert result["cause"] == STABLE
    assert result["risk_score"] == 32
    assert result["risk_level"] == "MEDIUM"


def test_analyse_shortage_handles_missing_and_invalid_consumption_values():
    rows = history_rows([5.0] * 32 + NAVJEEVAN_VALUES)
    rows[-1]["units_consumed"] = "not-recorded"
    rows[-2]["units_consumed"] = -4
    rows[-3]["units_consumed"] = None
    rows[-4]["date"] = "not-a-date"
    result = analyse_shortage(navjeevan_facility_data(consumption_history=rows))
    assert math.isfinite(result["predicted_demand"]) and result["predicted_demand"] > 0
    assert result["confidence"]["label"] != "HIGH"
    assert "4 of the latest 21 daily records are missing or invalid" in result["confidence"]["reason"]


def test_analyse_shortage_needs_enough_history():
    with pytest.raises(InsufficientHistoryError):
        analyse_shortage(navjeevan_facility_data(consumption_history=history_rows([8.0] * 13)))


@pytest.mark.parametrize(
    "overrides, message",
    [
        ({"current_stock": -1}, "current_stock"),
        ({"horizon_days": 10}, "horizon_days"),
        ({"medicine_criticality": "SEVERE"}, "medicine_criticality"),
        ({"facility_remoteness": 1.5}, "facility_remoteness"),
        ({"regional_fragility": "high"}, "regional_fragility"),
        ({"as_of_date": "01/09/2026"}, "as_of_date"),
        ({"consumption_history": "not a list"}, "consumption_history"),
        ({"incoming_quantity": None}, "provided together"),
        ({"expected_replenishment_date": "2026-08-01"}, "before as_of_date"),
    ],
)
def test_analyse_shortage_rejects_invalid_facility_data(overrides, message):
    with pytest.raises(ValueError, match=message):
        analyse_shortage(navjeevan_facility_data(**overrides))


def test_analyse_shortage_lists_missing_required_fields():
    data = navjeevan_facility_data()
    del data["regional_fragility"]
    del data["protected_days"]
    with pytest.raises(ValueError, match="regional_fragility, protected_days"):
        analyse_shortage(data)
