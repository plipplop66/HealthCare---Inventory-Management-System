"""Transparent prototype risk score, cause detection, explanation and the Day 1 entry point.

`analyse_shortage(facility_data)` runs the whole Day 1 pipeline for one facility and
medicine: forecast -> day-by-day stock projection -> risk score, cause, confidence
and explanation.

Every weight and threshold in this module is a PROTOTYPE ASSUMPTION chosen for
explainability. None of them is clinically validated.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from .data_store import HISTORY_DAYS, ConsumptionRecord, Replenishment, daily_records
from .forecast import (
    MIN_VALID_RECORDS,
    CleanHistory,
    ConfidenceAssessment,
    DemandForecast,
    assess_confidence,
    clean_history,
    recent_and_previous_averages,
    weighted_moving_average,
)
from .schemas import ALLOWED_HORIZON_DAYS
from .stock_projection import AFTER_STOCKOUT, BEFORE_STOCKOUT, NONE_SCHEDULED, StockProjection, project_stock

DEMAND_SHOCK = "DEMAND_SHOCK"
SUPPLY_DELAY = "SUPPLY_DELAY"
INVENTORY_IMBALANCE = "INVENTORY_IMBALANCE"
DATA_ANOMALY = "DATA_ANOMALY"
TEMPORARY_DIP = "TEMPORARY_DIP"
STABLE = "STABLE"

RISK_LABEL_THRESHOLDS = ((75, "CRITICAL"), (55, "HIGH"), (30, "MEDIUM"), (0, "LOW"))

# Demand change compares the latest 7 available days with the previous 21 available days.
DEMAND_SHOCK_RATIO = 1.30
TEMPORARY_DIP_RATIO = 0.70

DEFAULT_HORIZON_DAYS = 14
REQUIRED_FACILITY_FIELDS = (
    "as_of_date",
    "consumption_history",
    "current_stock",
    "medicine_criticality",
    "facility_remoteness",
    "regional_fragility",
    "protected_days",
)


@dataclass(frozen=True)
class RiskConfig:
    """Configurable prototype risk assumptions. The five weights must sum to 1."""

    stockout_urgency_weight: float = 0.35
    medicine_criticality_weight: float = 0.25
    replenishment_gap_weight: float = 0.20
    facility_remoteness_weight: float = 0.10
    regional_fragility_weight: float = 0.10
    # A stockout on day 1 has urgency 1.0, falling linearly to 0 at this many days.
    urgency_reference_days: int = 30
    # Urgency when no stockout is projected but stock falls fully below protected stock.
    protected_breach_max_urgency: float = 0.5
    # A shortage gap of this many days or more receives the full replenishment-gap weight.
    gap_reference_days: int = 7
    # CRITICAL (a MySQL criticality_level) is provisionally scored like HIGH until Aaryan confirms the scale.
    criticality_levels: Mapping[str, float] = field(
        default_factory=lambda: {"CRITICAL": 1.0, "HIGH": 1.0, "MEDIUM": 0.6, "LOW": 0.3}
    )

    def __post_init__(self) -> None:
        weights = self.weights.values()
        if any(weight < 0 for weight in weights) or not math.isclose(sum(weights), 1.0, abs_tol=1e-9):
            raise ValueError("Risk weights must be non-negative and sum to 1.")
        if self.urgency_reference_days < 1 or self.gap_reference_days < 1:
            raise ValueError("Risk reference day counts must be at least 1.")

    @property
    def weights(self) -> dict[str, float]:
        return {
            "stockoutUrgency": self.stockout_urgency_weight,
            "medicineCriticality": self.medicine_criticality_weight,
            "replenishmentGap": self.replenishment_gap_weight,
            "facilityRemoteness": self.facility_remoteness_weight,
            "regionalFragility": self.regional_fragility_weight,
        }


DEFAULT_RISK_CONFIG = RiskConfig()


@dataclass(frozen=True)
class RiskComponent:
    key: str
    weight: float
    signal: float
    contribution: float
    detail: str


@dataclass(frozen=True)
class RiskAssessment:
    score: int
    label: str
    urgency: float
    components: tuple[RiskComponent, ...]


@dataclass(frozen=True)
class CauseAssessment:
    primary: str
    contributing: tuple[str, ...]
    recent_average: float | None
    prior_average: float | None


def clamp(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


def label_for_score(score: float) -> str:
    for threshold, label in RISK_LABEL_THRESHOLDS:
        if score >= threshold:
            return label
    return "LOW"


def protected_stock_breach(projection: StockProjection, protected_stock: float) -> float:
    """How far (0-1) the minimum projected stock falls below protected stock."""
    if protected_stock <= 0:
        return 0.0
    return clamp((protected_stock - projection.minimum_projected_stock) / protected_stock)


def stockout_urgency(projection: StockProjection, protected_stock: float, config: RiskConfig = DEFAULT_RISK_CONFIG) -> float:
    time_urgency = 0.0
    if projection.projected_stockout_day is not None:
        time_urgency = clamp(1 - (projection.projected_stockout_day - 1) / config.urgency_reference_days)
    return max(time_urgency, config.protected_breach_max_urgency * protected_stock_breach(projection, protected_stock))


def compute_regional_fragility(peer_safe_surpluses: Sequence[float | None]) -> float:
    """Share of other regional facilities without a safe donor surplus (unknown counts as none)."""
    if not peer_safe_surpluses:
        return 1.0
    return sum(1 for surplus in peer_safe_surpluses if surplus is None or surplus <= 0) / len(peer_safe_surpluses)


def protected_stock_for(daily_demand: float, protected_days: float | None, recorded_protected_stock: float | None = None) -> float:
    """Protected stock recorded by the data source, otherwise forecast daily demand x protected days."""
    if recorded_protected_stock is not None:
        return round(recorded_protected_stock, 2)
    if protected_days is None:
        raise ValueError("protected_days is required when no protected stock is recorded.")
    return round(daily_demand * protected_days, 2)


def safe_surplus_for(effective_stock: float, protected_stock: float) -> float:
    """Stock a facility could donate while keeping its protected stock."""
    return round(max(0.0, effective_stock - protected_stock), 2)


def score_risk(
    *,
    projection: StockProjection,
    protected_stock: float,
    medicine_criticality: str,
    facility_remoteness: float,
    regional_fragility: float,
    config: RiskConfig = DEFAULT_RISK_CONFIG,
) -> RiskAssessment:
    """Score risk from 0 to 100 as a plain weighted sum (Day 1 formula).

    score = 100 x (0.35 x stockout urgency + 0.25 x medicine criticality + 0.20 x replenishment gap
                   + 0.10 x facility remoteness + 0.10 x regional fragility)

    Every signal is between 0 and 1.
    """
    urgency = stockout_urgency(projection, protected_stock, config)
    gap = clamp(projection.shortage_gap_days / config.gap_reference_days)
    criticality = config.criticality_levels.get(medicine_criticality.upper(), max(config.criticality_levels.values()))
    remoteness = clamp(facility_remoteness)
    fragility = clamp(regional_fragility)

    if projection.projected_stockout_day is not None:
        urgency_detail = f"Stockout projected on day {projection.projected_stockout_day}."
    elif protected_stock_breach(projection, protected_stock) > 0:
        urgency_detail = (
            f"No stockout within the horizon, but projected stock falls "
            f"{protected_stock_breach(projection, protected_stock):.0%} below protected stock."
        )
    else:
        urgency_detail = "No stockout within the horizon and projected stock stays at or above protected stock."

    parts = (
        ("stockoutUrgency", config.stockout_urgency_weight, urgency, urgency_detail),
        ("medicineCriticality", config.medicine_criticality_weight, criticality,
         f"{medicine_criticality.upper()} criticality medicine."),
        ("replenishmentGap", config.replenishment_gap_weight, gap,
         f"{projection.shortage_gap_days} projected shortage day(s) before supply is restored; "
         f"{config.gap_reference_days} or more receives the full weight."),
        ("facilityRemoteness", config.facility_remoteness_weight, remoteness,
         f"Facility remoteness score {remoteness:.2f}."),
        ("regionalFragility", config.regional_fragility_weight, fragility,
         f"{fragility:.0%} of other facilities in the region have no safe donor surplus."),
    )
    raw_score = 0.0
    components = []
    for key, weight, signal, detail in parts:
        points = 100 * weight * signal
        raw_score += points
        components.append(RiskComponent(key, weight, round(signal, 3), round(points, 1), detail))

    score = int(math.floor(clamp(raw_score, 0.0, 100.0) + 0.5))
    return RiskAssessment(score, label_for_score(score), round(urgency, 3), tuple(components))


def demand_change(values: Sequence[float]) -> tuple[float | None, float | None]:
    """Mean of the latest 7 available days and of the previous 21 (None when history is too short)."""
    if len(values) < MIN_VALID_RECORDS:
        return None, None
    return recent_and_previous_averages(values)


def detect_cause(
    *,
    values: Sequence[float],
    projection: StockProjection,
    effective_stock: float,
    protected_stock: float,
    replenishments: Sequence[Replenishment],
    confidence: ConfidenceAssessment,
) -> CauseAssessment:
    """Pick one primary cause and list any contributing factors."""
    recent, prior = demand_change(values)
    shock = recent is not None and prior is not None and recent > 0 and recent >= DEMAND_SHOCK_RATIO * prior
    dip = recent is not None and prior is not None and prior > 0 and recent <= TEMPORARY_DIP_RATIO * prior

    contributing: list[str] = []
    if projection.projected_stockout_day is not None:
        supply_delay = projection.replenishment_timing == AFTER_STOCKOUT
        if supply_delay and shock:
            # Both apply: supply timing is primary if stock would still run out before the
            # late delivery even at the pre-shock demand level.
            if _stockout_before_arrival(effective_stock, prior, projection, replenishments):
                primary, contributing = SUPPLY_DELAY, [DEMAND_SHOCK]
            else:
                primary, contributing = DEMAND_SHOCK, [SUPPLY_DELAY]
        elif supply_delay:
            primary = SUPPLY_DELAY
        elif shock:
            primary = DEMAND_SHOCK
        else:
            primary = INVENTORY_IMBALANCE
        if dip:
            contributing.append(TEMPORARY_DIP)
    elif shock:
        primary = DEMAND_SHOCK
    elif dip:
        primary = TEMPORARY_DIP
    elif effective_stock < protected_stock:
        primary = INVENTORY_IMBALANCE
    else:
        primary = STABLE

    if confidence.data_quality_poor:
        if primary != STABLE:
            contributing.insert(0, primary)
        primary = DATA_ANOMALY
    elif confidence.recent_anomaly_count:
        contributing.append(DATA_ANOMALY)

    return CauseAssessment(
        primary=primary,
        contributing=tuple(contributing),
        recent_average=None if recent is None else round(recent, 2),
        prior_average=None if prior is None else round(prior, 2),
    )


def _stockout_before_arrival(
    effective_stock: float,
    demand: float,
    projection: StockProjection,
    replenishments: Sequence[Replenishment],
) -> bool:
    arrival_day = projection.next_replenishment.arrival_day
    baseline = project_stock(effective_stock, demand, arrival_day, replenishments)
    return baseline.projected_stockout_day is not None and baseline.projected_stockout_day < arrival_day


def _number(value: float) -> str:
    """Up to 2 decimals without trailing zeros, matching the rounding of returned values (8.06, 22, 117.6)."""
    return f"{value:.2f}".rstrip("0").rstrip(".")


# Database base units (database/schema.sql) are symbols or mass nouns and never take a plural "s".
INVARIANT_UNITS = frozenset({"mg", "mL", "count"})


def _quantity(value: float, unit: str) -> str:
    text = _number(value)
    return f"{text} {unit}" if text == "1" or unit in INVARIANT_UNITS else f"{text} {unit}s"


def _per_day(unit: str) -> str:
    return f"{unit}/day" if unit in INVARIANT_UNITS else f"{unit}s/day"


def _demand_change_text(cause: CauseAssessment, unit: str) -> str:
    recent, prior = cause.recent_average or 0.0, cause.prior_average or 0.0
    if prior > 0:
        change = recent / prior - 1
        comparison = f"{abs(change):.0%} {'higher' if change >= 0 else 'lower'}"
    else:
        comparison = "up from zero"
    return (
        f"{_number(recent)} {_per_day(unit)} over the latest 7 available days versus "
        f"{_number(prior)} {_per_day(unit)} over the previous 21 ({comparison})"
    )


def build_explanation(
    *,
    cause: CauseAssessment,
    projection: StockProjection,
    protected_stock: float,
    protected_days: float | None,
    unit: str,
    confidence: ConfidenceAssessment,
) -> str:
    """Compose a plain-language explanation from the computed facts."""
    stockout_day = projection.projected_stockout_day
    horizon = projection.horizon_days
    effective = _quantity(projection.effective_stock, unit)
    basis = f"{_number(protected_days)} days of forecast demand" if protected_days is not None else "recorded safety stock"
    surplus_sentence = (
        f"Effective stock is below its protected stock of {_quantity(protected_stock, unit)} "
        f"({basis}), so there is no safe donor surplus."
    )

    sentences = []
    if cause.primary == SUPPLY_DELAY:
        sentences.append("Effective stock is projected to run out before the scheduled replenishment arrives.")
    elif cause.primary == DEMAND_SHOCK:
        sentences.append(f"Demand has risen sharply: {_demand_change_text(cause, unit)}.")
    elif cause.primary == INVENTORY_IMBALANCE and stockout_day is not None:
        sentences.append("Effective stock is not enough to meet forecast demand and no scheduled replenishment restores supply in time.")
    elif cause.primary == INVENTORY_IMBALANCE:
        sentences.append(surplus_sentence)
    elif cause.primary == TEMPORARY_DIP:
        sentences.append(
            f"Demand has dipped: {_demand_change_text(cause, unit)}; the forecast may understate need if consumption recovers."
        )
    elif cause.primary == DATA_ANOMALY:
        sentences.append(f"The consumption history has data-quality problems, so verify the records before relying on this result. {confidence.reason}")
    else:
        sentences.append("Demand is stable and effective stock stays above protected stock across the horizon.")

    if projection.daily_demand <= 0:
        sentences.append(f"Forecast demand is zero, so the current effective stock of {effective} is not projected to run out.")
    else:
        cover = (
            f"The current effective stock of {effective} covers about {_number(projection.days_remaining)} days "
            f"at the forecast demand of {_number(projection.daily_demand)} {_per_day(unit)}"
        )
        if stockout_day is not None:
            stockout_date = projection.projected_stockout_date
            when = f"day {stockout_day} ({stockout_date.isoformat()})" if stockout_date else f"day {stockout_day}"
            sentences.append(f"{cover}, so a stockout is projected on {when} of the {horizon}-day horizon.")
        else:
            sentences.append(f"{cover}, so no stockout is projected within the {horizon}-day horizon.")

    upcoming = projection.next_replenishment
    if projection.replenishment_timing == AFTER_STOCKOUT:
        delivery = f"The next scheduled replenishment ({_quantity(upcoming.quantity, unit)})"
        if upcoming.arrival_day > horizon:
            sentences.append(
                f"{delivery} is not due until day {upcoming.arrival_day}, after the projected stockout and beyond the "
                f"{horizon}-day horizon, leaving a shortage gap of at least {projection.shortage_gap_days} days."
            )
        elif projection.supply_restored_day is not None:
            sentences.append(
                f"{delivery} arrives on day {upcoming.arrival_day}, after the projected stockout, "
                f"leaving a {projection.shortage_gap_days}-day shortage gap."
            )
        else:
            sentences.append(
                f"{delivery} arrives on day {upcoming.arrival_day}, after the projected stockout, "
                "but is not enough to restore supply within the horizon."
            )
    elif projection.replenishment_timing == BEFORE_STOCKOUT:
        sentences.append(
            f"The scheduled replenishment on day {upcoming.arrival_day} ({_quantity(upcoming.quantity, unit)}) "
            "is not enough to prevent the stockout."
        )
    elif projection.replenishment_timing == NONE_SCHEDULED and stockout_day is not None:
        sentences.append(
            f"No replenishment is scheduled, so the facility is projected to be short for the last "
            f"{projection.shortage_gap_days} day(s) of the horizon."
        )

    later_shortage_days = projection.total_shortage_days - projection.shortage_gap_days
    if projection.supply_restored_day is not None and later_shortage_days > 0:
        sentences.append(
            f"Stock runs short again later in the horizon ({later_shortage_days} more shortage day(s)), "
            f"so scheduled supply does not cover the full {horizon} days."
        )

    for factor in cause.contributing:
        if factor == DEMAND_SHOCK:
            effect = ", which brings the projected stockout forward" if stockout_day is not None else ""
            sentences.append(f"Demand is also rising: {_demand_change_text(cause, unit)}{effect}.")
        elif factor == TEMPORARY_DIP:
            sentences.append(
                f"Recent demand is below its prior level ({_demand_change_text(cause, unit)}), "
                "so the forecast may understate need if consumption recovers."
            )
        elif factor == INVENTORY_IMBALANCE:
            sentences.append(surplus_sentence)
        elif factor == DATA_ANOMALY:
            sentences.append("Some anomalous consumption values were excluded from the forecast; verify those records.")
        # SUPPLY_DELAY is already described by the replenishment sentence.

    if cause.primary == INVENTORY_IMBALANCE and stockout_day is not None and projection.effective_stock < protected_stock:
        sentences.append(surplus_sentence)

    return " ".join(sentences)


@dataclass(frozen=True)
class ShortageAnalysis:
    """Everything computed for one facility and medicine; shared by analyse_shortage and POST /forecast."""

    history: CleanHistory
    forecast: DemandForecast
    confidence: ConfidenceAssessment
    projection: StockProjection
    protected_stock: float
    safe_surplus: float
    risk: RiskAssessment
    cause: CauseAssessment
    explanation: str


def build_shortage_analysis(
    *,
    records: Sequence[ConsumptionRecord],
    effective_stock: float,
    replenishments: Sequence[Replenishment],
    as_of: date,
    horizon_days: int,
    protected_days: float | None,
    medicine_criticality: str,
    facility_remoteness: float,
    regional_fragility: float,
    unit: str,
    config: RiskConfig = DEFAULT_RISK_CONFIG,
    recorded_protected_stock: float | None = None,
) -> ShortageAnalysis:
    """Forecast -> projection -> risk, cause, confidence and explanation. Raises InsufficientHistoryError.

    recorded_protected_stock is protected stock recorded by the data source (MySQL safety stock);
    without it, protected stock = forecast daily demand x protected_days.
    """
    history = clean_history(records)
    forecast = weighted_moving_average(history.values)
    confidence = assess_confidence(history)
    projection = project_stock(effective_stock, forecast.daily_demand, horizon_days, replenishments, start_date=as_of)
    protected_stock = protected_stock_for(forecast.daily_demand, protected_days, recorded_protected_stock)
    risk = score_risk(
        projection=projection,
        protected_stock=protected_stock,
        medicine_criticality=medicine_criticality,
        facility_remoteness=facility_remoteness,
        regional_fragility=regional_fragility,
        config=config,
    )
    cause = detect_cause(
        values=history.values,
        projection=projection,
        effective_stock=effective_stock,
        protected_stock=protected_stock,
        replenishments=replenishments,
        confidence=confidence,
    )
    explanation = build_explanation(
        cause=cause,
        projection=projection,
        protected_stock=protected_stock,
        protected_days=protected_days,
        unit=unit,
        confidence=confidence,
    )
    return ShortageAnalysis(
        history=history,
        forecast=forecast,
        confidence=confidence,
        projection=projection,
        protected_stock=protected_stock,
        safe_surplus=safe_surplus_for(effective_stock, protected_stock),
        risk=risk,
        cause=cause,
        explanation=explanation,
    )


def analyse_shortage(facility_data: Mapping[str, Any], config: RiskConfig = DEFAULT_RISK_CONFIG) -> dict[str, Any]:
    """Analyse one facility's stock of one medicine (Day 1 entry point).

    Required facility_data keys:
        as_of_date            "YYYY-MM-DD"; day 1 of the projection
        consumption_history   list of {"date": "YYYY-MM-DD", "units_consumed": number};
                              the 60 days before as_of_date are used
        current_stock         effective (usable, unexpired) stock, 0 or more
        medicine_criticality  "CRITICAL", "HIGH", "MEDIUM" or "LOW" (CRITICAL is provisionally scored like HIGH)
        facility_remoteness   0 (central) to 1 (most remote)
        regional_fragility    0 to 1: share of other regional facilities with no safe donor surplus
        protected_days        days of forecast demand kept as protected stock
    Optional keys:
        expected_replenishment_date  "YYYY-MM-DD", on or after as_of_date (give with incoming_quantity)
        incoming_quantity            quantity arriving on that date
        horizon_days                 7, 14 or 30 (default 14)
        unit                         unit name used in the explanation (default "unit")

    Returns predicted_demand, days_remaining, stockout_date, risk_score, risk_level, cause,
    confidence (label and reason) and explanation. Raises ValueError for invalid input,
    including InsufficientHistoryError when fewer than 14 valid daily records exist.
    """
    if not isinstance(facility_data, Mapping):
        raise ValueError("facility_data must be a dictionary.")
    missing = [name for name in REQUIRED_FACILITY_FIELDS if facility_data.get(name) is None]
    if missing:
        raise ValueError(f"facility_data is missing required field(s): {', '.join(missing)}.")

    as_of = _read_date(facility_data["as_of_date"], "as_of_date")
    horizon_days = facility_data.get("horizon_days", DEFAULT_HORIZON_DAYS)
    if isinstance(horizon_days, bool) or not isinstance(horizon_days, int) or horizon_days not in ALLOWED_HORIZON_DAYS:
        raise ValueError("horizon_days must be one of 7, 14 or 30.")
    criticality = facility_data["medicine_criticality"]
    if not isinstance(criticality, str) or criticality.upper() not in config.criticality_levels:
        raise ValueError(f"medicine_criticality must be one of {', '.join(config.criticality_levels)}.")
    unit = facility_data.get("unit") or "unit"
    if not isinstance(unit, str):
        raise ValueError("unit must be text.")

    analysis = build_shortage_analysis(
        records=_read_history(facility_data["consumption_history"], as_of),
        effective_stock=_read_number(facility_data["current_stock"], "current_stock"),
        replenishments=_read_replenishment(facility_data, as_of),
        as_of=as_of,
        horizon_days=horizon_days,
        protected_days=_read_number(facility_data["protected_days"], "protected_days"),
        medicine_criticality=criticality.upper(),
        facility_remoteness=_read_number(facility_data["facility_remoteness"], "facility_remoteness", maximum=1.0),
        regional_fragility=_read_number(facility_data["regional_fragility"], "regional_fragility", maximum=1.0),
        unit=unit,
        config=config,
    )
    stockout_date = analysis.projection.projected_stockout_date
    return {
        "predicted_demand": analysis.forecast.daily_demand,
        "days_remaining": analysis.projection.days_remaining,
        "stockout_date": stockout_date.isoformat() if stockout_date else None,
        "risk_score": analysis.risk.score,
        "risk_level": analysis.risk.label,
        "cause": analysis.cause.primary,
        "confidence": {"label": analysis.confidence.label, "reason": analysis.confidence.reason},
        "explanation": analysis.explanation,
    }


def _read_date(value: Any, name: str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            pass
    raise ValueError(f"{name} must be a date in YYYY-MM-DD format.")


def _read_number(value: Any, name: str, maximum: float | None = None) -> float:
    valid = not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value) and value >= 0
    if not valid or (maximum is not None and value > maximum):
        limit = f"between 0 and {_number(maximum)}" if maximum is not None else "of 0 or more"
        raise ValueError(f"{name} must be a number {limit}.")
    return float(value)


def _read_history(rows: Any, as_of: date) -> list[ConsumptionRecord]:
    if isinstance(rows, (str, bytes)) or not isinstance(rows, Sequence):
        raise ValueError("consumption_history must be a list of {date, units_consumed} records.")
    raw_by_day: dict[date, list[Any]] = {}
    for row in rows:
        if not isinstance(row, Mapping):
            raise ValueError("Each consumption_history record must be a dictionary with date and units_consumed.")
        try:
            day = _read_date(row.get("date"), "date")
        except ValueError:
            continue  # An undatable record cannot be placed on the calendar; that day stays MISSING.
        raw_by_day.setdefault(day, []).append(row.get("units_consumed"))
    return daily_records(raw_by_day, as_of, HISTORY_DAYS)


def _read_replenishment(facility_data: Mapping[str, Any], as_of: date) -> tuple[Replenishment, ...]:
    expected = facility_data.get("expected_replenishment_date")
    quantity = facility_data.get("incoming_quantity")
    if expected is None and quantity is None:
        return ()
    if expected is None or quantity is None:
        raise ValueError("expected_replenishment_date and incoming_quantity must be provided together.")
    arrival = _read_date(expected, "expected_replenishment_date")
    if arrival < as_of:
        raise ValueError("expected_replenishment_date cannot be before as_of_date.")
    return (Replenishment(quantity=_read_number(quantity, "incoming_quantity"), arrival_day=(arrival - as_of).days + 1),)
