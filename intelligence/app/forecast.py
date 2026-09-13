"""Explainable demand forecast, recent demand trend and consumption data-quality checks.

The forecast is a weighted moving average with no deep learning, LLM or random
component, so every number can be reproduced by hand from the CSV.
"""

from __future__ import annotations

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date

from .data_store import ConsumptionRecord

FORECAST_METHOD = "WEIGHTED_MOVING_AVERAGE_7D_21D"
RECENT_WINDOW_DAYS = 7
PREVIOUS_WINDOW_DAYS = 21
RECENT_WEIGHT = 0.70
PREVIOUS_WEIGHT = 0.30
# Forecast bounds = forecast +/- BOUND_STD_MULTIPLIER x standard deviation of the latest 14 available days.
BOUND_WINDOW_DAYS = 14
BOUND_STD_MULTIPLIER = 1.0
# The latest 7 records plus at least 7 earlier records for the previous-period average.
MIN_VALID_RECORDS = 2 * RECENT_WINDOW_DAYS
# Recent average at least 10% above (below) the previous average is INCREASING (DECREASING).
TREND_CHANGE_THRESHOLD = 0.10

# A value is anomalous when it differs from the median of up to 3 valid neighbours on each
# side by more than the largest of: 4 x sqrt(median) (ordinary day-to-day count noise),
# 50% of the median, or 5 units. Conservative on purpose: excluding genuine high days
# would understate demand.
ANOMALY_NEIGHBOURS = 3
ANOMALY_NOISE_MULTIPLIER = 4.0
ANOMALY_RELATIVE_DEVIATION = 0.50
ANOMALY_MIN_ABSOLUTE_DEVIATION = 5.0

CONFIDENCE_WINDOW_DAYS = 21
HIGH_CONFIDENCE_MIN_RECORDS = 42
LOW_CONFIDENCE_MIN_RECORDS = 21
MEDIUM_MISSING_SHARE = 0.05
LOW_MISSING_SHARE = 0.20
MEDIUM_VARIABILITY_CV = 0.20
LOW_VARIABILITY_CV = 0.35
LOW_CONFIDENCE_ANOMALIES = 3


class InsufficientHistoryError(ValueError):
    """Raised when too few valid consumption records exist to forecast."""


@dataclass(frozen=True)
class Anomaly:
    day: date
    units: float
    neighbour_median: float


@dataclass(frozen=True)
class CleanHistory:
    records: tuple[ConsumptionRecord, ...]
    usable: tuple[ConsumptionRecord, ...]
    invalid: tuple[ConsumptionRecord, ...]
    anomalies: tuple[Anomaly, ...]

    @property
    def values(self) -> list[float]:
        return [record.units for record in self.usable]


@dataclass(frozen=True)
class DemandForecast:
    daily_demand: float
    lower_bound: float
    upper_bound: float
    recent_average: float
    # Mean of the previous 21 available days (before the latest 7).
    baseline_average: float
    recent_variability: float
    trend: str
    trend_change_percent: float | None


@dataclass(frozen=True)
class ConfidenceAssessment:
    label: str
    reason: str
    valid_records: int
    missing_or_invalid_records: int
    recent_missing_or_invalid_records: int
    anomaly_count: int
    recent_anomaly_count: int
    recent_variability_cv: float | None
    data_quality_poor: bool


def detect_anomalies(records: Sequence[ConsumptionRecord]) -> list[Anomaly]:
    """Flag isolated spikes or drops relative to neighbouring valid records.

    Sustained level shifts are not flagged: once neighbours share the new level
    their median moves with it, so a genuine demand change stays in the forecast.
    """
    valid = [record for record in records if record.units is not None]
    anomalies = []
    for position, record in enumerate(valid):
        window = valid[max(0, position - ANOMALY_NEIGHBOURS):position] + valid[position + 1:position + 1 + ANOMALY_NEIGHBOURS]
        if len(window) < ANOMALY_NEIGHBOURS:
            continue
        median = statistics.median(neighbour.units for neighbour in window)
        threshold = max(
            ANOMALY_NOISE_MULTIPLIER * math.sqrt(median),
            ANOMALY_RELATIVE_DEVIATION * median,
            ANOMALY_MIN_ABSOLUTE_DEVIATION,
        )
        if abs(record.units - median) > threshold:
            anomalies.append(Anomaly(record.day, record.units, median))
    return anomalies


def clean_history(records: Sequence[ConsumptionRecord]) -> CleanHistory:
    """Separate usable values from missing, invalid and anomalous ones."""
    anomalies = detect_anomalies(records)
    anomalous_days = {anomaly.day for anomaly in anomalies}
    usable = tuple(record for record in records if record.units is not None and record.day not in anomalous_days)
    invalid = tuple(record for record in records if record.units is None)
    return CleanHistory(tuple(records), usable, invalid, tuple(anomalies))


def recent_and_previous_averages(values: Sequence[float]) -> tuple[float, float]:
    """Mean of the latest 7 available days and of the (up to) 21 available days before them."""
    if len(values) < MIN_VALID_RECORDS:
        raise InsufficientHistoryError(
            f"at least {MIN_VALID_RECORDS} valid daily consumption records are required, found {len(values)}"
        )
    recent = statistics.fmean(values[-RECENT_WINDOW_DAYS:])
    previous = statistics.fmean(values[-(RECENT_WINDOW_DAYS + PREVIOUS_WINDOW_DAYS):-RECENT_WINDOW_DAYS])
    return recent, previous


def demand_trend(recent_average: float, previous_average: float) -> tuple[str, float | None]:
    """Direction and percentage change of recent demand versus the previous 21 days."""
    if previous_average <= 0:
        return ("INCREASING", None) if recent_average > 0 else ("STABLE", 0.0)
    change = recent_average / previous_average - 1
    if change >= TREND_CHANGE_THRESHOLD:
        direction = "INCREASING"
    elif change <= -TREND_CHANGE_THRESHOLD:
        direction = "DECREASING"
    else:
        direction = "STABLE"
    return direction, round(change * 100, 1)


def weighted_moving_average(values: Sequence[float]) -> DemandForecast:
    """predicted daily demand = 0.70 x mean(latest 7 values) + 0.30 x mean(previous 21 values)."""
    recent_average, previous_average = recent_and_previous_averages(values)
    demand = RECENT_WEIGHT * recent_average + PREVIOUS_WEIGHT * previous_average
    variability = statistics.stdev(values[-BOUND_WINDOW_DAYS:])
    spread = BOUND_STD_MULTIPLIER * variability
    trend, trend_change_percent = demand_trend(recent_average, previous_average)
    return DemandForecast(
        daily_demand=round(demand, 2),
        lower_bound=round(max(0.0, demand - spread), 2),
        upper_bound=round(demand + spread, 2),
        recent_average=round(recent_average, 2),
        baseline_average=round(previous_average, 2),
        recent_variability=round(variability, 2),
        trend=trend,
        trend_change_percent=trend_change_percent,
    )


def assess_confidence(history: CleanHistory) -> ConfidenceAssessment:
    """Grade confidence from record count, missing values, recent variability and anomalies."""
    window_days = min(CONFIDENCE_WINDOW_DAYS, len(history.records))
    window_start = history.records[-window_days].day if window_days else None
    recent_invalid = sum(1 for record in history.invalid if window_start and record.day >= window_start)
    recent_anomalies = sum(1 for anomaly in history.anomalies if window_start and anomaly.day >= window_start)
    missing_share = recent_invalid / window_days if window_days else 1.0
    valid = len(history.usable)

    recent_values = history.values[-RECENT_WINDOW_DAYS:]
    cv = None
    if len(recent_values) >= 2 and statistics.fmean(recent_values) > 0:
        cv = round(statistics.stdev(recent_values) / statistics.fmean(recent_values), 3)

    low: list[str] = []
    medium: list[str] = []
    if valid < LOW_CONFIDENCE_MIN_RECORDS:
        low.append(f"only {valid} valid daily records are available (at least {LOW_CONFIDENCE_MIN_RECORDS} needed)")
    elif valid < HIGH_CONFIDENCE_MIN_RECORDS:
        medium.append(f"only {valid} valid daily records are available ({HIGH_CONFIDENCE_MIN_RECORDS} or more gives high confidence)")

    missing_text = f"{recent_invalid} of the latest {window_days} daily records are missing or invalid"
    if missing_share > LOW_MISSING_SHARE:
        low.append(missing_text)
    elif missing_share > MEDIUM_MISSING_SHARE:
        medium.append(missing_text)

    if cv is None:
        low.append("recent consumption variability cannot be measured")
    elif cv > LOW_VARIABILITY_CV:
        low.append(f"recent consumption is highly variable (coefficient of variation {cv:.2f})")
    elif cv > MEDIUM_VARIABILITY_CV:
        medium.append(f"recent consumption is moderately variable (coefficient of variation {cv:.2f})")

    anomaly_text = f"{recent_anomalies} anomalous value(s) in the latest {window_days} days were excluded"
    if recent_anomalies >= LOW_CONFIDENCE_ANOMALIES:
        low.append(anomaly_text)
    elif recent_anomalies:
        medium.append(anomaly_text)

    if low:
        label, issues = "LOW", low + medium
    elif medium:
        label, issues = "MEDIUM", medium
    else:
        label, issues = "HIGH", []

    if issues:
        text = "; ".join(issues)
        reason = f"{label.capitalize()} confidence: {text}."
    else:
        missing_phrase = "no missing or invalid values" if recent_invalid == 0 else f"{recent_invalid} missing or invalid value(s)"
        reason = (
            f"Sufficient recent data: {valid} valid daily records, {missing_phrase} in the latest {window_days} days, "
            f"stable variability (coefficient of variation {cv:.2f}) and no recent anomalies."
        )
    older_anomalies = len(history.anomalies) - recent_anomalies
    if older_anomalies:
        reason += f" {older_anomalies} older anomalous value(s) were excluded from the history."

    return ConfidenceAssessment(
        label=label,
        reason=reason,
        valid_records=valid,
        missing_or_invalid_records=len(history.invalid),
        recent_missing_or_invalid_records=recent_invalid,
        anomaly_count=len(history.anomalies),
        recent_anomaly_count=recent_anomalies,
        recent_variability_cv=cv,
        data_quality_poor=(
            valid < LOW_CONFIDENCE_MIN_RECORDS
            or missing_share > LOW_MISSING_SHARE
            or recent_anomalies >= LOW_CONFIDENCE_ANOMALIES
        ),
    )
