import csv
from datetime import date, timedelta

import pytest

from app.data_store import (
    DEFAULT_CONSUMPTION_CSV,
    INSULIN_ID,
    ConsumptionRecord,
    SimulatedDataStore,
    parse_units,
)
from app.forecast import (
    InsufficientHistoryError,
    assess_confidence,
    clean_history,
    demand_trend,
    detect_anomalies,
    weighted_moving_average,
)

FACILITY_IDS = ("facility-central-store", "facility-district-hospital", "facility-river-chc", "facility-navjeevan-phc")


def records_from(values, start=date(2026, 7, 3)):
    return [
        ConsumptionRecord(start + timedelta(days=offset), value, None if value is not None else "MISSING")
        for offset, value in enumerate(values)
    ]


def test_weighted_forecast_matches_hand_calculation():
    # Values older than the latest 7 + previous 21 days must not influence the forecast.
    values = [100.0] * 10 + [6.0] * 21 + [9.0] * 7
    result = weighted_moving_average(values)
    assert result.recent_average == 9.0
    assert result.baseline_average == 6.0  # previous 21 days, excluding the latest 7
    assert result.daily_demand == 8.1  # 0.70 x 9 + 0.30 x 6
    # Bounds: 8.1 +/- stdev(latest 14 = seven 6s and seven 9s) = 8.1 +/- 1.5566
    assert result.lower_bound == 6.54
    assert result.upper_bound == 9.66
    assert result.trend == "INCREASING"
    assert result.trend_change_percent == 50.0


def test_weighted_forecast_is_deterministic():
    values = [5.0, 6.0, 7.0, 6.0, 8.0, 9.0, 7.0] * 4
    assert weighted_moving_average(values) == weighted_moving_average(list(values))


def test_previous_period_uses_available_records_when_history_is_short():
    result = weighted_moving_average([4.0] * 10 + [8.0] * 7)
    assert result.recent_average == 8.0
    assert result.baseline_average == 4.0  # only 10 previous values available
    assert result.daily_demand == pytest.approx(6.8)  # 0.70 x 8 + 0.30 x 4


def test_lower_bound_never_negative():
    assert weighted_moving_average([0.0, 20.0] * 7).lower_bound >= 0


def test_at_least_14_valid_records_are_required():
    with pytest.raises(InsufficientHistoryError, match="at least 14"):
        weighted_moving_average([8.0] * 13)
    assert weighted_moving_average([8.0] * 14).daily_demand == 8.0


@pytest.mark.parametrize(
    "recent, previous, expected",
    [
        (9.0, 6.0, ("INCREASING", 50.0)),
        (6.0, 10.0, ("DECREASING", -40.0)),
        (8.4, 8.0, ("STABLE", 5.0)),
        (8.0, 8.0, ("STABLE", 0.0)),
        (5.0, 0.0, ("INCREASING", None)),
        (0.0, 0.0, ("STABLE", 0.0)),
    ],
)
def test_recent_demand_trend(recent, previous, expected):
    assert demand_trend(recent, previous) == expected


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("7.5", (7.5, None)),
        ("0", (0.0, None)),
        (9, (9.0, None)),
        ("", (None, "MISSING")),
        (None, (None, "MISSING")),
        ("NA", (None, "MISSING")),
        ("seven", (None, "NOT_A_NUMBER")),
        ("nan", (None, "NOT_A_NUMBER")),
        ("inf", (None, "NOT_A_NUMBER")),
        (True, (None, "NOT_A_NUMBER")),
        ("-3", (None, "NEGATIVE")),
        (-3, (None, "NEGATIVE")),
    ],
)
def test_parse_units_handles_missing_and_invalid_values(raw, expected):
    assert parse_units(raw) == expected


def test_invalid_records_are_excluded_from_forecast():
    values = [8.0] * 25
    for index in (5, 20, 24):
        values[index] = None
    history = clean_history(records_from(values))
    assert len(history.invalid) == 3
    assert len(history.usable) == 22
    assert weighted_moving_average(history.values).daily_demand == 8.0


def test_isolated_spike_is_flagged_and_excluded():
    history = clean_history(records_from([8.0] * 30 + [80.0] + [8.0] * 9))
    assert [anomaly.units for anomaly in history.anomalies] == [80.0]
    assert weighted_moving_average(history.values).daily_demand == 8.0
    confidence = assess_confidence(history)
    assert confidence.label == "MEDIUM"
    assert "anomalous" in confidence.reason


def test_sustained_demand_shift_is_not_flagged_as_anomaly():
    assert detect_anomalies(records_from([6.0] * 20 + [9.0] * 7)) == []


def test_high_confidence_for_complete_stable_history():
    confidence = assess_confidence(clean_history(records_from([8.0, 9.0] * 30)))
    assert confidence.label == "HIGH"
    assert confidence.reason.startswith("Sufficient recent data")
    assert not confidence.data_quality_poor


def test_missing_recent_values_lower_confidence():
    values = [8.0, 9.0] * 30
    values[-3] = None
    values[-10] = None
    confidence = assess_confidence(clean_history(records_from(values)))
    assert confidence.label == "MEDIUM"
    assert "2 of the latest 21 daily records are missing or invalid" in confidence.reason


def test_sparse_history_gives_low_confidence():
    values = [None] * 45 + [8.0] * 15
    confidence = assess_confidence(clean_history(records_from(values)))
    assert confidence.label == "LOW"
    assert confidence.data_quality_poor
    assert "valid daily records" in confidence.reason


def test_high_variability_gives_low_confidence():
    confidence = assess_confidence(clean_history(records_from([5.0, 11.0] * 30)))
    assert confidence.label == "LOW"
    assert "highly variable" in confidence.reason


@pytest.mark.parametrize(
    "values",
    [[8.0] * 60, [None] * 50 + [3.0] * 10, [5.0, 11.0] * 30, [0.0] * 60],
)
def test_confidence_always_has_a_reason(values):
    assert assess_confidence(clean_history(records_from(values))).reason.strip()


def test_simulated_csv_is_labelled_and_complete():
    first_line = DEFAULT_CONSUMPTION_CSV.read_text(encoding="utf-8").splitlines()[0]
    assert "SIMULATED PROTOTYPE DATA" in first_line
    with DEFAULT_CONSUMPTION_CSV.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(line for line in handle if not line.startswith("#")))
    assert {row["data_label"] for row in rows} == {"SIMULATED_PROTOTYPE"}
    store = SimulatedDataStore.from_csv()
    for facility_id in FACILITY_IDS:
        history = store.consumption_history(facility_id, INSULIN_ID)
        assert len(history) == 60
        assert sum(1 for row in rows if row["facility_id"] == facility_id) == 60


def test_duplicate_and_unparseable_rows_are_handled(tmp_path):
    path = tmp_path / "consumption.csv"
    path.write_text(
        "# SIMULATED TEST DATA\n"
        "date,facility_id,medicine_id,units_consumed\n"
        "2026-08-30,facility-river-chc,med-insulin-100iu-vial,8\n"
        "2026-08-30,facility-river-chc,med-insulin-100iu-vial,9\n"
        "not-a-date,facility-river-chc,med-insulin-100iu-vial,7\n"
        "2026-08-31,facility-river-chc,med-insulin-100iu-vial,6\n",
        encoding="utf-8",
    )
    store = SimulatedDataStore.from_csv(path)
    history = store.consumption_history("facility-river-chc", INSULIN_ID)
    assert store.rejected_rows == 1
    assert history[-2].issue == "DUPLICATE_DATE" and history[-2].units is None
    assert history[-1].units == 6.0
    assert history[0].issue == "MISSING"


def test_csv_without_required_columns_is_rejected(tmp_path):
    path = tmp_path / "bad.csv"
    path.write_text("date,facility_id\n2026-08-31,facility-river-chc\n", encoding="utf-8")
    with pytest.raises(ValueError, match="missing required columns"):
        SimulatedDataStore.from_csv(path)
