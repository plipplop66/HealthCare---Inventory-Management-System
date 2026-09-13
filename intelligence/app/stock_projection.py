"""Day-by-day projection of effective stock across the forecast horizon."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from .data_store import Replenishment

EPSILON = 1e-9

# Timing of scheduled replenishment relative to the first projected stockout.
NONE_SCHEDULED = "NONE_SCHEDULED"
NO_STOCKOUT_PROJECTED = "NO_STOCKOUT_PROJECTED"
BEFORE_STOCKOUT = "BEFORE_STOCKOUT"
AFTER_STOCKOUT = "AFTER_STOCKOUT"


@dataclass(frozen=True)
class ProjectedDay:
    day: int
    opening_stock: float
    replenishment: float
    demand: float
    closing_stock: float
    unmet_demand: float


@dataclass(frozen=True)
class StockProjection:
    effective_stock: float
    daily_demand: float
    horizon_days: int
    days: tuple[ProjectedDay, ...]
    days_remaining: float | None
    projected_stockout_day: int | None
    supply_restored_day: int | None
    shortage_gap_days: int
    total_shortage_days: int
    minimum_projected_stock: float
    unmet_demand: float
    next_replenishment: Replenishment | None
    replenishment_timing: str
    # Calendar date of day 1; when given, the stockout day is also reported as a date.
    start_date: date | None = None

    @property
    def projected_within_horizon(self) -> bool:
        return self.projected_stockout_day is not None

    @property
    def projected_stockout_date(self) -> date | None:
        if self.start_date is None or self.projected_stockout_day is None:
            return None
        return self.start_date + timedelta(days=self.projected_stockout_day - 1)

    @property
    def replenishment_arrives_before_stockout(self) -> bool | None:
        if self.replenishment_timing == AFTER_STOCKOUT:
            return False
        if self.replenishment_timing == BEFORE_STOCKOUT:
            return True
        return None


def project_stock(
    effective_stock: float,
    daily_demand: float,
    horizon_days: int,
    replenishments: Sequence[Replenishment] = (),
    start_date: date | None = None,
) -> StockProjection:
    """Project stock one day at a time.

    Each day: projected stock = previous stock - forecast daily demand + replenishment
    arriving that day. Replenishment is applied at the start of its day, stock is
    floored at zero, and demand that cannot be met is recorded as unmet rather than
    carried forward. Day 1 is start_date (the as-of date) when provided.
    """
    if effective_stock < 0:
        raise ValueError("effective_stock cannot be negative.")
    if daily_demand < 0:
        raise ValueError("daily_demand cannot be negative.")
    if horizon_days < 1:
        raise ValueError("horizon_days must be at least 1.")

    scheduled = sorted((item for item in replenishments if item.arrival_day >= 1), key=lambda item: item.arrival_day)
    arrivals: dict[int, float] = {}
    for item in scheduled:
        arrivals[item.arrival_day] = arrivals.get(item.arrival_day, 0.0) + item.quantity

    stock = float(effective_stock)
    days = []
    stockout_day = None
    restored_day = None
    total_shortage_days = 0
    unmet_total = 0.0
    for day in range(1, horizon_days + 1):
        replenishment = arrivals.get(day, 0.0)
        available = stock + replenishment
        closing = max(0.0, available - daily_demand)
        unmet = daily_demand - available
        if unmet > EPSILON:
            total_shortage_days += 1
            if stockout_day is None:
                stockout_day = day
        else:
            unmet = 0.0
            if stockout_day is not None and restored_day is None:
                restored_day = day
        unmet_total += unmet
        days.append(ProjectedDay(day, stock, replenishment, daily_demand, closing, unmet))
        stock = closing

    if stockout_day is None:
        shortage_gap_days = 0
    elif restored_day is not None:
        shortage_gap_days = restored_day - stockout_day
    else:
        shortage_gap_days = horizon_days - stockout_day + 1

    if not scheduled:
        timing, next_replenishment = NONE_SCHEDULED, None
    elif stockout_day is None:
        timing, next_replenishment = NO_STOCKOUT_PROJECTED, scheduled[0]
    else:
        # Scheduled deliveries are considered even beyond the horizon: a known late delivery is still late.
        late = [item for item in scheduled if item.arrival_day > stockout_day]
        if late:
            timing, next_replenishment = AFTER_STOCKOUT, late[0]
        else:
            timing, next_replenishment = BEFORE_STOCKOUT, scheduled[-1]

    return StockProjection(
        effective_stock=float(effective_stock),
        daily_demand=daily_demand,
        horizon_days=horizon_days,
        days=tuple(days),
        days_remaining=round(effective_stock / daily_demand, 1) if daily_demand > 0 else None,
        projected_stockout_day=stockout_day,
        supply_restored_day=restored_day,
        shortage_gap_days=shortage_gap_days,
        total_shortage_days=total_shortage_days,
        minimum_projected_stock=min(item.closing_stock for item in days),
        unmet_demand=unmet_total,
        next_replenishment=next_replenishment,
        replenishment_timing=timing,
        start_date=start_date,
    )
