from datetime import date

import pytest

from app.data_store import INSULIN_ID, INVENTORY, Replenishment
from app.stock_projection import (
    AFTER_STOCKOUT,
    BEFORE_STOCKOUT,
    NO_STOCKOUT_PROJECTED,
    NONE_SCHEDULED,
    project_stock,
)


def test_navjeevan_stockout_precedes_replenishment():
    projection = project_stock(22, 8.4, 14, [Replenishment(quantity=100, arrival_day=8)])
    assert projection.days_remaining == 2.6
    assert projection.projected_within_horizon is True
    assert projection.projected_stockout_day == 3
    assert projection.supply_restored_day == 8
    assert projection.shortage_gap_days == 5
    assert projection.minimum_projected_stock == 0
    assert projection.replenishment_timing == AFTER_STOCKOUT
    assert projection.replenishment_arrives_before_stockout is False
    assert projection.next_replenishment.arrival_day == 8
    assert [round(day.closing_stock, 2) for day in projection.days[:3]] == [13.6, 5.2, 0.0]
    assert round(projection.days[2].unmet_demand, 2) == 3.2


def test_stockout_date_counts_the_as_of_date_as_day_one():
    projection = project_stock(22, 8.4, 14, [Replenishment(quantity=100, arrival_day=8)], start_date=date(2026, 9, 1))
    assert projection.projected_stockout_day == 3
    assert projection.projected_stockout_date == date(2026, 9, 3)
    assert project_stock(22, 8.4, 14).projected_stockout_date is None  # no start date given
    assert project_stock(900, 20, 14, start_date=date(2026, 9, 1)).projected_stockout_date is None  # no stockout


def test_each_day_applies_the_projection_formula():
    projection = project_stock(50, 7.5, 30, [Replenishment(quantity=40, arrival_day=5), Replenishment(quantity=20, arrival_day=12)])
    previous = 50.0
    for day in projection.days:
        assert day.opening_stock == pytest.approx(previous)
        assert day.closing_stock == pytest.approx(max(0.0, previous - day.demand + day.replenishment))
        assert day.unmet_demand == pytest.approx(max(0.0, day.demand - previous - day.replenishment))
        previous = day.closing_stock
    assert len(projection.days) == 30


def test_replenishment_beyond_horizon_still_counts_as_late():
    projection = project_stock(22, 8.4, 7, [Replenishment(quantity=100, arrival_day=8)])
    assert projection.projected_stockout_day == 3
    assert projection.supply_restored_day is None
    assert projection.shortage_gap_days == 5  # days 3-7 inside the 7-day horizon
    assert projection.replenishment_timing == AFTER_STOCKOUT


def test_healthy_stock_has_no_stockout():
    projection = project_stock(900, 20, 30)
    assert projection.projected_within_horizon is False
    assert projection.projected_stockout_day is None
    assert projection.shortage_gap_days == 0
    assert projection.minimum_projected_stock == 300
    assert projection.replenishment_timing == NONE_SCHEDULED
    assert projection.replenishment_arrives_before_stockout is None


def test_timely_replenishment_prevents_stockout():
    projection = project_stock(22, 8.4, 14, [Replenishment(quantity=100, arrival_day=2)])
    assert projection.projected_stockout_day is None
    assert projection.replenishment_timing == NO_STOCKOUT_PROJECTED


def test_insufficient_early_replenishment_is_before_stockout():
    projection = project_stock(10, 5, 14, [Replenishment(quantity=5, arrival_day=2)])
    assert projection.projected_stockout_day == 4
    assert projection.replenishment_timing == BEFORE_STOCKOUT
    assert projection.replenishment_arrives_before_stockout is True


def test_gap_runs_to_horizon_end_without_replenishment():
    projection = project_stock(100, 8, 14)
    assert projection.projected_stockout_day == 13
    assert projection.shortage_gap_days == 2
    assert projection.total_shortage_days == 2


def test_zero_demand_never_stocks_out():
    projection = project_stock(10, 0, 14)
    assert projection.days_remaining is None
    assert projection.projected_stockout_day is None


def test_effective_stock_excludes_expired_batches():
    snapshot = INVENTORY[("facility-navjeevan-phc", INSULIN_ID)]
    assert snapshot.recorded_stock == 27
    assert snapshot.effective_stock(date(2026, 9, 1)) == 22


@pytest.mark.parametrize(
    "stock, demand, horizon",
    [(-1, 8, 14), (10, -1, 14), (10, 8, 0)],
)
def test_invalid_projection_inputs_raise(stock, demand, horizon):
    with pytest.raises(ValueError):
        project_stock(stock, demand, horizon)
