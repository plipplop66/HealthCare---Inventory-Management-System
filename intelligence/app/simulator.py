"""Ripple Simulator: regional before/after projection of proposed medicine transfers (POST /scenarios/simulate).

The simulator reuses the POST /forecast engine rather than a simplified formula:
- demand is the weighted moving average of app/forecast.py;
- each facility is projected day by day with app/stock_projection.py;
- protected stock, safe surplus, regional fragility and the risk score come from app/risk_engine.py.
A facility's baseline is built by build_shortage_analysis, the call POST /forecast makes, so baseline stockouts
and risk scores match the forecast endpoint. The intervention adds the transfers as outbound withdrawals and
inbound arrivals and scores the new projection with the same score_risk.

The data store is only read. Transfers are held in separate per-day schedules, so neither the fixture nor MySQL
is ever changed.

EVERYTHING HERE IS SIMULATED DECISION SUPPORT. A qualified person must approve every operational transfer, and
the simulator never substitutes one medicine for another.
"""

from __future__ import annotations

import math
import statistics
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timedelta

from .data_store import Batch, Facility, InventorySnapshot, Medicine, Replenishment, Route, SimulatedDataStore
from .forecast import InsufficientHistoryError, clean_history, weighted_moving_average
from .risk_engine import (
    DEFAULT_RISK_CONFIG,
    RiskAssessment,
    RiskConfig,
    _number,
    _quantity,
    build_shortage_analysis,
    compute_regional_fragility,
    protected_stock_for,
    safe_surplus_for,
    score_risk,
)
from .schemas import (
    ALLOWED_HORIZON_DAYS,
    BatchAllocationBlock,
    DataMappingBlock,
    FacilityChangeBlock,
    FacilityProjectionBlock,
    NewRiskBlock,
    RecipientOutcomeBlock,
    RegionalStateBlock,
    RouteBlock,
    SimulatedDayBlock,
    SimulationComparisonBlock,
    SimulationDataContextBlock,
    SimulationMedicineBlock,
    SimulationRequest,
    SimulationResponse,
    TransferEvaluationBlock,
)
from .stock_projection import StockProjection, project_stock

MODEL_VERSION = "aiml-ripple-simulator-v1"
# Quantities are reported with 2 decimals, so differences smaller than half a hundredth are treated as equal.
EPSILON = 0.005
TRANSFER_STATUS = "TRANSFER"

# How a facility's daily demand was obtained.
FORECAST = "FORECAST"
NO_CONSUMPTION_STORAGE_FACILITY = "NO_CONSUMPTION_STORAGE_FACILITY"
UNAVAILABLE = "UNAVAILABLE"
# Facility types that store and dispatch stock instead of dispensing it (fixture WAREHOUSE, database Warehouse).
STORAGE_FACILITY_TYPES = frozenset({"WAREHOUSE"})

# A facility's part in the scenario.
DONOR = "DONOR"
RECIPIENT = "RECIPIENT"
DONOR_AND_RECIPIENT = "DONOR_AND_RECIPIENT"
NOT_IN_TRANSFER = "NOT_IN_TRANSFER"

# Transfer feasibility gate. Codes before INSUFFICIENT_DONOR_STOCK stop a transfer from being simulated;
# the impact codes (BELOW_PROTECTED_STOCK onwards) are found after simulating it and make it ineligible.
INVALID_QUANTITY = "INVALID_QUANTITY"
INVALID_ARRIVAL_DAY = "INVALID_ARRIVAL_DAY"
SOURCE_FACILITY_NOT_FOUND = "SOURCE_FACILITY_NOT_FOUND"
DESTINATION_FACILITY_NOT_FOUND = "DESTINATION_FACILITY_NOT_FOUND"
MEDICINE_NOT_FOUND = "MEDICINE_NOT_FOUND"
MEDICINE_IDENTITY_MISMATCH = "MEDICINE_IDENTITY_MISMATCH"
SAME_SOURCE_AND_DESTINATION = "SAME_SOURCE_AND_DESTINATION"
INCOMPLETE_DATA = "INCOMPLETE_DATA"
ARRIVAL_OUTSIDE_HORIZON = "ARRIVAL_OUTSIDE_HORIZON"
ROUTE_NOT_FOUND = "ROUTE_NOT_FOUND"
COLD_CHAIN_UNAVAILABLE = "COLD_CHAIN_UNAVAILABLE"
TRAVEL_TIME_EXCEEDS_ARRIVAL_DAY = "TRAVEL_TIME_EXCEEDS_ARRIVAL_DAY"
INSUFFICIENT_DONOR_STOCK = "INSUFFICIENT_DONOR_STOCK"
BATCH_EXPIRES_BEFORE_USE = "BATCH_EXPIRES_BEFORE_USE"
BELOW_PROTECTED_STOCK = "BELOW_PROTECTED_STOCK"
DONOR_BECOMES_CRITICAL = "DONOR_BECOMES_CRITICAL"
CREATES_REGIONAL_SHORTAGE = "CREATES_REGIONAL_SHORTAGE"
ARRIVES_AFTER_RECIPIENT_STOCKOUT = "ARRIVES_AFTER_RECIPIENT_STOCKOUT"


class SimulationError(Exception):
    """A scenario that cannot be simulated at all (for example, none of its medicines exist)."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ProposedTransfer:
    from_facility_id: str
    to_facility_id: str
    medicine_id: str
    quantity: float
    arrival_day: int = 1


@dataclass(frozen=True)
class FacilityState:
    """One facility's snapshot of the scenario medicine, read once and never modified."""

    facility: Facility
    inventory: InventorySnapshot
    effective_stock: float
    demand: float | None
    demand_basis: str
    protected_stock: float | None
    unavailable_reason: str | None
    # Usable batches at the snapshot, earliest expiry first.
    usable_batches: tuple[Batch, ...]

    @property
    def available(self) -> bool:
        return self.unavailable_reason is None


@dataclass(frozen=True)
class FacilityOutcome:
    """A facility's projection with a given set of transfers (none for the baseline)."""

    state: FacilityState
    projection: StockProjection | None
    risk: RiskAssessment | None
    transfer_in: Mapping[int, float]
    transfer_out: Mapping[int, float]

    @property
    def total_in(self) -> float:
        return sum(self.transfer_in.values())

    @property
    def total_out(self) -> float:
        return sum(self.transfer_out.values())

    @property
    def stock_after_transfers(self) -> float:
        return self.state.effective_stock + self.total_in - self.total_out


def load_facility_state(store: SimulatedDataStore, facility: Facility, medicine: Medicine, inventory: InventorySnapshot) -> FacilityState:
    """Forecast demand and protected stock exactly as POST /forecast does."""
    effective_stock = inventory.effective_stock(store.as_of)
    usable = tuple(sorted((batch for batch in inventory.batches if batch.is_usable_on(store.as_of)), key=lambda batch: (batch.expiry_date, batch.batch_no)))
    history_start, history_end = store.history_window
    demand, basis, reason = None, UNAVAILABLE, None
    if not store.has_consumption_records(facility.id, medicine.id):
        if facility.type.upper() in STORAGE_FACILITY_TYPES:
            # A storage facility dispatches stock; with no consumption rows it has no clinical demand to project.
            demand, basis = 0.0, NO_CONSUMPTION_STORAGE_FACILITY
        else:
            reason = f"No consumption records exist between {history_start} and {history_end}, so demand cannot be forecast."
    else:
        try:
            demand = weighted_moving_average(clean_history(store.consumption_history(facility.id, medicine.id)).values).daily_demand
            basis = FORECAST
        except InsufficientHistoryError as error:
            reason = f"Consumption history cannot be used: {error}."

    protected_stock = None
    if reason is None:
        if inventory.protected_stock is None and facility.protected_days is None:
            reason = "Protected stock is neither recorded nor defined by protected days."
        else:
            protected_stock = protected_stock_for(demand, facility.protected_days, inventory.protected_stock)
    return FacilityState(facility, inventory, effective_stock, demand, basis, protected_stock, reason, usable)


def safe_surplus_at(state: FacilityState, stock: float) -> float | None:
    """A facility's safe donor surplus for regional fragility, measured the way POST /forecast measures peers."""
    if state.inventory.protected_stock is not None:
        return safe_surplus_for(stock, state.inventory.protected_stock)
    if state.demand_basis == FORECAST:
        return safe_surplus_for(stock, state.protected_stock)
    return None


def regional_fragility_for(
    store: SimulatedDataStore,
    states: Mapping[str, FacilityState],
    facility_id: str,
    medicine_id: str,
    stock_by_facility: Mapping[str, float],
) -> float:
    peers = store.regional_peers(states[facility_id].facility, medicine_id)
    return compute_regional_fragility([safe_surplus_at(states[peer.id], stock_by_facility[peer.id]) for peer in peers])


def baseline_outcome(
    store: SimulatedDataStore,
    states: Mapping[str, FacilityState],
    state: FacilityState,
    medicine: Medicine,
    horizon_days: int,
    config: RiskConfig,
) -> FacilityOutcome:
    if not state.available:
        return FacilityOutcome(state, None, None, {}, {})
    if state.demand_basis != FORECAST:
        projection = project_stock(state.effective_stock, state.demand, horizon_days, state.inventory.replenishments, start_date=store.as_of)
        return FacilityOutcome(state, projection, None, {}, {})
    snapshot_stock = {facility_id: other.effective_stock for facility_id, other in states.items()}
    analysis = build_shortage_analysis(
        records=store.consumption_history(state.facility.id, medicine.id),
        effective_stock=state.effective_stock,
        replenishments=state.inventory.replenishments,
        as_of=store.as_of,
        horizon_days=horizon_days,
        protected_days=state.facility.protected_days,
        medicine_criticality=medicine.criticality,
        facility_remoteness=state.facility.remoteness_score,
        regional_fragility=regional_fragility_for(store, states, state.facility.id, medicine.id, snapshot_stock),
        unit=medicine.unit,
        config=config,
        recorded_protected_stock=state.inventory.protected_stock,
    )
    return FacilityOutcome(state, analysis.projection, analysis.risk, {}, {})


def projected_outcome(
    store: SimulatedDataStore,
    states: Mapping[str, FacilityState],
    state: FacilityState,
    medicine: Medicine,
    horizon_days: int,
    config: RiskConfig,
    transfer_in: Mapping[int, float],
    transfer_out: Mapping[int, float],
    stock_by_facility: Mapping[str, float],
) -> FacilityOutcome:
    """Project a facility with transfers: outbound stock leaves at the start of its day, inbound stock arrives like a replenishment."""
    if not state.available:
        return FacilityOutcome(state, None, None, dict(transfer_in), dict(transfer_out))
    arrivals = [Replenishment(quantity=quantity, arrival_day=day, status=TRANSFER_STATUS) for day, quantity in sorted(transfer_in.items())]
    projection = project_stock(
        state.effective_stock,
        state.demand,
        horizon_days,
        [*state.inventory.replenishments, *arrivals],
        start_date=store.as_of,
        withdrawals=dict(transfer_out) or None,
    )
    risk = None
    if state.demand_basis == FORECAST:
        risk = score_risk(
            projection=projection,
            protected_stock=state.protected_stock,
            medicine_criticality=medicine.criticality,
            facility_remoteness=state.facility.remoteness_score,
            regional_fragility=regional_fragility_for(store, states, state.facility.id, medicine.id, stock_by_facility),
            config=config,
        )
    return FacilityOutcome(state, projection, risk, dict(transfer_in), dict(transfer_out))


@dataclass
class TransferEvaluation:
    """The feasibility gate's working record for one proposed transfer."""

    index: int
    transfer: ProposedTransfer
    source: Facility | None = None
    destination: Facility | None = None
    route: Route | None = None
    departure_day: int | None = None
    applied: bool = False
    reasons: list[tuple[str, str]] = field(default_factory=list)
    batches: list[tuple[Batch, float]] = field(default_factory=list)

    def reject(self, code: str, message: str) -> None:
        self.reasons.append((code, message))

    @property
    def eligible(self) -> bool:
        return not self.reasons


def describe_medicine(medicine: Medicine) -> str:
    return f"{medicine.generic_name} {medicine.strength} {medicine.dosage_form}"


def scenario_medicine(store: SimulatedDataStore, transfers: Sequence[ProposedTransfer]) -> Medicine:
    """The first requested medicine that exists; every transfer is checked against its exact identity."""
    for transfer in transfers:
        medicine = store.get_medicine(transfer.medicine_id)
        if medicine is not None:
            return medicine
    requested = ", ".join(dict.fromkeys(f"'{transfer.medicine_id}'" for transfer in transfers))
    raise SimulationError(404, MEDICINE_NOT_FOUND, f"Medicine {requested} was not found in the {store.context.description}.")


def transfer_schedules(evaluations: Sequence[TransferEvaluation]) -> tuple[dict[str, dict[int, float]], dict[str, dict[int, float]]]:
    """Per-facility outbound quantities by departure day and inbound quantities by arrival day."""
    outgoing: defaultdict[str, defaultdict[int, float]] = defaultdict(lambda: defaultdict(float))
    incoming: defaultdict[str, defaultdict[int, float]] = defaultdict(lambda: defaultdict(float))
    for evaluation in evaluations:
        outgoing[evaluation.source.id][evaluation.departure_day] += evaluation.transfer.quantity
        incoming[evaluation.destination.id][evaluation.transfer.arrival_day] += evaluation.transfer.quantity
    return {key: dict(value) for key, value in outgoing.items()}, {key: dict(value) for key, value in incoming.items()}


def transfer_arrivals(schedule: Mapping[int, float]) -> list[Replenishment]:
    return [Replenishment(quantity=quantity, arrival_day=day, status=TRANSFER_STATUS) for day, quantity in sorted(schedule.items())]


def check_transfer(store: SimulatedDataStore, states: Mapping[str, FacilityState], medicine: Medicine, horizon_days: int, evaluation: TransferEvaluation) -> None:
    """Identity, data, route, cold-chain and timing checks that decide whether a transfer can be simulated."""
    transfer = evaluation.transfer
    description = store.context.description
    quantity_valid = not isinstance(transfer.quantity, bool) and isinstance(transfer.quantity, (int, float)) and math.isfinite(transfer.quantity) and transfer.quantity > 0
    if not quantity_valid:
        evaluation.reject(INVALID_QUANTITY, "The quantity must be a positive number.")
    arrival_valid = not isinstance(transfer.arrival_day, bool) and isinstance(transfer.arrival_day, int) and transfer.arrival_day >= 1
    if not arrival_valid:
        evaluation.reject(INVALID_ARRIVAL_DAY, "arrivalDay must be a whole number of at least 1.")

    source = evaluation.source = store.get_facility(transfer.from_facility_id)
    destination = evaluation.destination = store.get_facility(transfer.to_facility_id)
    if source is None:
        evaluation.reject(SOURCE_FACILITY_NOT_FOUND, f"The source facility '{transfer.from_facility_id}' does not exist in the {description}.")
    if destination is None:
        evaluation.reject(DESTINATION_FACILITY_NOT_FOUND, f"The destination facility '{transfer.to_facility_id}' does not exist in the {description}.")

    requested = store.get_medicine(transfer.medicine_id)
    if requested is None:
        evaluation.reject(MEDICINE_NOT_FOUND, f"The medicine '{transfer.medicine_id}' does not exist in the {description}.")
    elif requested.id != medicine.id:
        evaluation.reject(
            MEDICINE_IDENTITY_MISMATCH,
            f"Medicine '{transfer.medicine_id}' ({describe_medicine(requested)}) is not the scenario medicine {medicine.id} "
            f"({describe_medicine(medicine)}). A scenario moves one exact medicine identity and no substitution is made.",
        )

    same_facility = source is not None and destination is not None and source.id == destination.id
    if same_facility:
        evaluation.reject(SAME_SOURCE_AND_DESTINATION, f"The source and destination are the same facility ({source.id}).")
    for facility in dict.fromkeys(item for item in (source, destination) if item is not None):
        state = states.get(facility.id)
        if state is None:
            evaluation.reject(INCOMPLETE_DATA, f"{facility.name} ({facility.id}) has no inventory record for {describe_medicine(medicine)}.")
        elif not state.available:
            evaluation.reject(INCOMPLETE_DATA, f"{facility.name} ({facility.id}) cannot be projected: {state.unavailable_reason}")
    if arrival_valid and transfer.arrival_day > horizon_days:
        evaluation.reject(
            ARRIVAL_OUTSIDE_HORIZON,
            f"The transfer arrives on day {transfer.arrival_day}, after the {horizon_days}-day horizon, so it cannot change the simulated outcome.",
        )

    if source is None or destination is None or same_facility:
        return
    if store.routes is None:
        evaluation.reject(INCOMPLETE_DATA, "Route data was not loaded, so the transport route cannot be checked.")
        return
    route = evaluation.route = store.get_route(source.id, destination.id)
    if route is None:
        evaluation.reject(ROUTE_NOT_FOUND, f"No transport route exists from {source.name} to {destination.name}.")
        return
    if medicine.requires_cold_chain is None:
        evaluation.reject(INCOMPLETE_DATA, f"Whether {describe_medicine(medicine)} needs a cold chain is not recorded.")
    elif medicine.requires_cold_chain and not route.cold_chain_capable:
        evaluation.reject(
            COLD_CHAIN_UNAVAILABLE,
            f"{describe_medicine(medicine)} requires a cold chain, but the route from {source.name} to {destination.name} is not cold-chain capable.",
        )
    elif medicine.requires_cold_chain and destination.has_cold_chain is False:
        evaluation.reject(COLD_CHAIN_UNAVAILABLE, f"{describe_medicine(medicine)} requires a cold chain, but {destination.name} has no cold-chain storage.")
    if arrival_valid:
        departure_day = transfer.arrival_day - int(route.travel_hours // 24)
        if departure_day < 1:
            evaluation.reject(
                TRAVEL_TIME_EXCEEDS_ARRIVAL_DAY,
                f"The route takes {_number(route.travel_hours)} hours, so the transfer cannot arrive by day {transfer.arrival_day}.",
            )
        else:
            evaluation.departure_day = departure_day


def check_donor_stock(store: SimulatedDataStore, states: Mapping[str, FacilityState], medicine: Medicine, horizon_days: int, evaluations: Sequence[TransferEvaluation]) -> None:
    """Reject transfers that would ask a donor for more stock than it is projected to hold when they depart.

    All candidate transfers are projected together. When a donor falls short on a day, the last transfer
    departing that day is rejected and the donor is projected again.
    """
    while True:
        candidates = [evaluation for evaluation in evaluations if evaluation.eligible]
        outgoing, incoming = transfer_schedules(candidates)
        short = None
        for facility_id, schedule in outgoing.items():
            state = states[facility_id]
            projection = project_stock(
                state.effective_stock,
                state.demand,
                horizon_days,
                [*state.inventory.replenishments, *transfer_arrivals(incoming.get(facility_id, {}))],
                start_date=store.as_of,
                withdrawals=schedule,
            )
            day = next((item for item in projection.days if schedule.get(item.day, 0.0) - item.withdrawal > EPSILON), None)
            if day is not None:
                short = (state, day, schedule[day.day])
                break
        if short is None:
            return
        state, day, requested = short
        departing = [item for item in candidates if item.source.id == state.facility.id and item.departure_day == day.day]
        departing[-1].reject(
            INSUFFICIENT_DONOR_STOCK,
            f"{state.facility.name} is projected to hold {_quantity(day.opening_stock, medicine.unit)} of usable stock at the start of "
            f"day {day.day}, less than the {_quantity(requested, medicine.unit)} requested to leave that day.",
        )


def allocate_batches(store: SimulatedDataStore, states: Mapping[str, FacilityState], medicine: Medicine, horizon_days: int, evaluations: Sequence[TransferEvaluation]) -> None:
    """Allocate each candidate transfer to the donor's usable batches, earliest expiry first.

    Transferred stock must stay in date until the end of the horizon, because the projection does not model
    expiry within the horizon. Stock from replenishments arriving later has no recorded batch and is not sent.
    """
    use_by = store.as_of + timedelta(days=horizon_days - 1)
    unit = medicine.unit
    remaining_by_donor: dict[str, dict[str, float]] = {}
    for evaluation in sorted((item for item in evaluations if item.eligible), key=lambda item: (item.departure_day, item.index)):
        state = states[evaluation.source.id]
        remaining = remaining_by_donor.setdefault(state.facility.id, {batch.batch_no: batch.quantity for batch in state.usable_batches})
        lasting = [batch for batch in state.usable_batches if batch.expiry_date >= use_by]
        lasting_quantity = sum(remaining[batch.batch_no] for batch in lasting)
        quantity = evaluation.transfer.quantity
        if quantity - lasting_quantity > EPSILON:
            usable_quantity = sum(remaining.values())
            if quantity - usable_quantity > EPSILON:
                evaluation.reject(
                    INSUFFICIENT_DONOR_STOCK,
                    f"{state.facility.name} holds {_quantity(usable_quantity, unit)} of usable stock in recorded batches, less than the "
                    f"{_quantity(quantity, unit)} requested.",
                )
            else:
                evaluation.reject(
                    BATCH_EXPIRES_BEFORE_USE,
                    f"Only {_quantity(lasting_quantity, unit)} of {state.facility.name}'s usable stock stays in date until {use_by} "
                    f"(the end of the horizon), less than the {_quantity(quantity, unit)} requested.",
                )
            continue
        needed = quantity
        for batch in lasting:
            take = min(needed, remaining[batch.batch_no])
            if take > 0:
                evaluation.batches.append((batch, take))
                remaining[batch.batch_no] -= take
                needed -= take
            if needed <= 0:
                break


def project_intervention(
    store: SimulatedDataStore,
    states: Mapping[str, FacilityState],
    medicine: Medicine,
    horizon_days: int,
    config: RiskConfig,
    applied: Sequence[TransferEvaluation],
) -> dict[str, FacilityOutcome]:
    outgoing, incoming = transfer_schedules(applied)
    stock_after = {
        facility_id: state.effective_stock + sum(incoming.get(facility_id, {}).values()) - sum(outgoing.get(facility_id, {}).values())
        for facility_id, state in states.items()
    }
    return {
        facility_id: projected_outcome(
            store, states, state, medicine, horizon_days, config, incoming.get(facility_id, {}), outgoing.get(facility_id, {}), stock_after
        )
        for facility_id, state in states.items()
    }


def check_impact(
    store: SimulatedDataStore,
    states: Mapping[str, FacilityState],
    medicine: Medicine,
    horizon_days: int,
    baseline: Mapping[str, FacilityOutcome],
    intervention: Mapping[str, FacilityOutcome],
    applied: Sequence[TransferEvaluation],
) -> None:
    """Safety checks on the simulated result. A transfer that fails them stays in the intervention but is ineligible."""
    unit = medicine.unit
    for evaluation in applied:
        donor = evaluation.source
        before, after = baseline[donor.id], intervention[donor.id]
        protected = after.state.protected_stock
        later_after = [day for day in after.projection.days if day.day >= evaluation.departure_day]
        lowest_after = min(later_after, key=lambda day: day.closing_stock)
        if protected > 0 and lowest_after.closing_stock < protected - EPSILON:
            lowest_before = min(day.closing_stock for day in before.projection.days if day.day >= evaluation.departure_day)
            if lowest_before < protected - EPSILON:
                message = (
                    f"{donor.name} is already projected below its protected safety stock of {_quantity(protected, unit)} without this "
                    f"transfer (lowest {_quantity(lowest_before, unit)}), so it has no safe surplus to send; with the transfer its lowest "
                    f"projected stock is {_quantity(lowest_after.closing_stock, unit)} on day {lowest_after.day}."
                )
            else:
                message = (
                    f"{donor.name} would fall below its protected safety stock of {_quantity(protected, unit)}: projected stock drops to "
                    f"{_quantity(lowest_after.closing_stock, unit)} on day {lowest_after.day}."
                )
            evaluation.reject(BELOW_PROTECTED_STOCK, message)

        if after.risk is not None and after.risk.label == "CRITICAL":
            if before.risk.label == "CRITICAL":
                message = f"{donor.name} is already CRITICAL (risk {before.risk.score}) and cannot safely donate."
            else:
                message = f"{donor.name} would become CRITICAL: its risk rises from {before.risk.score} ({before.risk.label}) to {after.risk.score}."
            evaluation.reject(DONOR_BECOMES_CRITICAL, message)

        before_projection, after_projection = before.projection, after.projection
        if after_projection.projected_stockout_day is not None:
            if before_projection.projected_stockout_day is None:
                evaluation.reject(
                    CREATES_REGIONAL_SHORTAGE,
                    f"{donor.name} would run out on day {after_projection.projected_stockout_day} "
                    f"({after_projection.projected_stockout_date}), creating a new shortage in the region.",
                )
            elif (
                after_projection.total_shortage_days > before_projection.total_shortage_days
                or after_projection.unmet_demand - before_projection.unmet_demand > EPSILON
            ):
                evaluation.reject(
                    CREATES_REGIONAL_SHORTAGE,
                    f"{donor.name}'s shortage would grow from {before_projection.total_shortage_days} to "
                    f"{after_projection.total_shortage_days} shortage day(s) and from {_quantity(before_projection.unmet_demand, unit)} to "
                    f"{_quantity(after_projection.unmet_demand, unit)} of unmet demand.",
                )

        recipient = states[evaluation.destination.id]
        outgoing, incoming = transfer_schedules([item for item in applied if item is not evaluation])
        without = project_stock(
            recipient.effective_stock,
            recipient.demand,
            horizon_days,
            [*recipient.inventory.replenishments, *transfer_arrivals(incoming.get(recipient.facility.id, {}))],
            start_date=store.as_of,
            withdrawals=outgoing.get(recipient.facility.id) or None,
        )
        if without.projected_stockout_day is not None and evaluation.transfer.arrival_day > without.projected_stockout_day:
            evaluation.reject(
                ARRIVES_AFTER_RECIPIENT_STOCKOUT,
                f"{recipient.facility.name} is projected to run out on day {without.projected_stockout_day} "
                f"({without.projected_stockout_date}), before this transfer arrives on day {evaluation.transfer.arrival_day}.",
            )


@dataclass(frozen=True)
class SimulationResult:
    store: SimulatedDataStore
    medicine: Medicine
    horizon_days: int
    states: Mapping[str, FacilityState]
    baseline: Mapping[str, FacilityOutcome]
    intervention: Mapping[str, FacilityOutcome]
    evaluations: tuple[TransferEvaluation, ...]


def simulate(
    store: SimulatedDataStore,
    transfers: Sequence[ProposedTransfer],
    horizon_days: int,
    config: RiskConfig = DEFAULT_RISK_CONFIG,
) -> SimulationResult:
    """Evaluate every proposed transfer together against one isolated regional snapshot."""
    if horizon_days not in ALLOWED_HORIZON_DAYS:
        raise ValueError("horizon_days must be one of 7, 14 or 30.")
    if not transfers:
        raise ValueError("At least one transfer is required.")
    medicine = scenario_medicine(store, transfers)
    states = {
        facility.id: load_facility_state(store, facility, medicine, inventory)
        for facility in store.facilities.values()
        if (inventory := store.get_inventory(facility.id, medicine.id)) is not None
    }
    if not states:
        raise SimulationError(
            404, "SCENARIO_TARGET_NOT_FOUND", f"No facility holds {describe_medicine(medicine)} in the {store.context.description}."
        )
    baseline = {facility_id: baseline_outcome(store, states, state, medicine, horizon_days, config) for facility_id, state in states.items()}

    evaluations = tuple(TransferEvaluation(index, transfer) for index, transfer in enumerate(transfers))
    for evaluation in evaluations:
        check_transfer(store, states, medicine, horizon_days, evaluation)
    check_donor_stock(store, states, medicine, horizon_days, evaluations)
    allocate_batches(store, states, medicine, horizon_days, evaluations)
    applied = [evaluation for evaluation in evaluations if evaluation.eligible]
    for evaluation in applied:
        evaluation.applied = True

    intervention = project_intervention(store, states, medicine, horizon_days, config, applied)
    check_impact(store, states, medicine, horizon_days, baseline, intervention, applied)
    return SimulationResult(store, medicine, horizon_days, states, baseline, intervention, evaluations)


SIMULATION_ASSUMPTIONS = (
    "All inventory, consumption, route and transfer data is simulated.",
    "Each facility's demand is the weighted moving average used by POST /forecast (0.70 x mean of the latest 7 available "
    "days + 0.30 x mean of the previous 21); transfers do not change demand.",
    "The baseline is the POST /forecast projection and risk score of every facility holding the medicine.",
    "A transfer leaves the donor at the start of its departure day, before that day's replenishment and demand, and "
    "arrives in full at the start of arrivalDay; a route shorter than 24 hours departs on the arrival day.",
    "Stock never goes below zero, and a donor cannot send more than it is projected to hold when the transfer departs.",
    "Transferred stock comes from the donor's usable batches, earliest expiry first, that stay in date until the end of the horizon.",
    "Scheduled and delayed replenishments arrive in full on their expected day, as in POST /forecast.",
    "Regional fragility in the intervention uses every facility's safe surplus after all simulated transfers.",
    "A storage facility (warehouse) without consumption records is projected with zero clinical demand and is not risk-scored.",
    "Only the exact medicine identity is moved; the simulator never substitutes one medicine for another.",
)
DECISION_SUPPORT_ASSUMPTION = (
    "Decision support only: a qualified person must review and approve every operational transfer before any stock moves."
)
SIMULATION_LIMITATIONS = (
    "Risk weights and thresholds are prototype assumptions and are not clinically validated.",
    "Batch expiry within the horizon, transport losses, vehicle and storage capacity, and cost are not modelled.",
    "Stock from replenishments arriving during the horizon has no recorded batch or expiry, so it is not used for transfers.",
    "Supplier reliability is not used: delayed orders are assumed to arrive on their current expected date.",
    "One medicine is simulated per scenario, and patients are not redistributed between facilities.",
    "Nothing is written to the data source: no transfer is created and no inventory is changed.",
)


def _round(value: float) -> float:
    return round(value, 2)


def facility_roles(applied: Sequence[TransferEvaluation]) -> dict[str, str]:
    donors = {evaluation.source.id for evaluation in applied}
    recipients = {evaluation.destination.id for evaluation in applied}
    roles = {facility_id: DONOR for facility_id in donors}
    for facility_id in recipients:
        roles[facility_id] = DONOR_AND_RECIPIENT if facility_id in donors else RECIPIENT
    return roles


def regional_state_block(
    store: SimulatedDataStore,
    outcomes: Mapping[str, FacilityOutcome],
    roles: Mapping[str, str],
    applied_count: int,
) -> RegionalStateBlock:
    projected = [outcome for outcome in outcomes.values() if outcome.projection is not None]
    scores = [outcome.risk.score for outcome in projected if outcome.risk is not None]
    return RegionalStateBlock(
        critical_facility_count=sum(1 for outcome in projected if outcome.risk is not None and outcome.risk.label == "CRITICAL"),
        stockout_facility_count=sum(1 for outcome in projected if outcome.projection.projected_stockout_day is not None),
        regional_shortage_days=sum(outcome.projection.total_shortage_days for outcome in projected),
        regional_unmet_demand=_round(sum(outcome.projection.unmet_demand for outcome in projected)),
        regional_risk=max(scores) if scores else None,
        average_risk=round(statistics.fmean(scores), 1) if scores else None,
        applied_transfer_count=applied_count,
        facilities=[facility_block(store, outcome, roles.get(facility_id, NOT_IN_TRANSFER)) for facility_id, outcome in outcomes.items()],
    )


def facility_block(store: SimulatedDataStore, outcome: FacilityOutcome, role: str) -> FacilityProjectionBlock:
    state, projection = outcome.state, outcome.projection
    stock_after = outcome.stock_after_transfers
    days = []
    if projection is not None:
        for day in projection.days:
            transfer_in = outcome.transfer_in.get(day.day, 0.0)
            days.append(
                SimulatedDayBlock(
                    day=day.day,
                    date=store.as_of + timedelta(days=day.day - 1),
                    opening_stock=_round(day.opening_stock),
                    transfer_out=_round(day.withdrawal),
                    scheduled_replenishment=_round(day.replenishment - transfer_in),
                    transfer_in=_round(transfer_in),
                    demand=_round(day.demand),
                    closing_stock=_round(day.closing_stock),
                    unmet_demand=_round(day.unmet_demand),
                )
            )
    below_protected = None
    if projection is not None:
        below_protected = any(day.closing_stock < state.protected_stock - EPSILON for day in projection.days)
    return FacilityProjectionBlock(
        facility_id=state.facility.id,
        facility_name=state.facility.name,
        facility_type=state.facility.type,
        role=role,
        projection_available=projection is not None,
        unavailable_reason=state.unavailable_reason,
        effective_stock=_round(state.effective_stock),
        transfer_in=_round(outcome.total_in),
        transfer_out=_round(outcome.total_out),
        stock_after_transfers=_round(stock_after),
        protected_stock=state.protected_stock,
        protected_stock_source=state.inventory.protected_stock_source,
        predicted_daily_demand=state.demand,
        demand_basis=state.demand_basis,
        days_remaining=round(stock_after / state.demand, 1) if state.demand else None,
        stockout_day=projection.projected_stockout_day if projection else None,
        stockout_date=projection.projected_stockout_date if projection else None,
        shortage_days=projection.total_shortage_days if projection else 0,
        shortage_gap_days=projection.shortage_gap_days if projection else 0,
        unmet_demand=_round(projection.unmet_demand) if projection else 0.0,
        minimum_projected_stock=_round(projection.minimum_projected_stock) if projection else None,
        ending_stock=_round(projection.days[-1].closing_stock) if projection else None,
        below_protected_stock=below_protected,
        risk_score=outcome.risk.score if outcome.risk else None,
        risk_label=outcome.risk.label if outcome.risk else None,
        projected_daily_stock=days,
    )


def find_new_risks(baseline: Mapping[str, FacilityOutcome], intervention: Mapping[str, FacilityOutcome], unit: str) -> list[NewRiskBlock]:
    risks = []
    for facility_id, before in baseline.items():
        after = intervention[facility_id]
        if before.projection is None:
            continue
        name = before.state.facility.name
        before_projection, after_projection = before.projection, after.projection
        if before_projection.projected_stockout_day is None and after_projection.projected_stockout_day is not None:
            risks.append(NewRiskBlock(
                facility_id=facility_id, facility_name=name, risk_type="NEW_STOCKOUT", day=after_projection.projected_stockout_day,
                detail=f"{name} is projected to run out on day {after_projection.projected_stockout_day} "
                f"({after_projection.projected_stockout_date}); without the transfers it had no stockout in the horizon.",
            ))
        elif before_projection.projected_stockout_day is not None and (
            after_projection.total_shortage_days > before_projection.total_shortage_days
            or after_projection.unmet_demand - before_projection.unmet_demand > EPSILON
        ):
            risks.append(NewRiskBlock(
                facility_id=facility_id, facility_name=name, risk_type="MORE_SHORTAGE", day=after_projection.projected_stockout_day,
                detail=f"{name}'s shortage grows from {before_projection.total_shortage_days} to {after_projection.total_shortage_days} "
                f"shortage day(s) and from {_quantity(before_projection.unmet_demand, unit)} to {_quantity(after_projection.unmet_demand, unit)} of unmet demand.",
            ))
        if before.risk is not None and after.risk is not None:
            if after.risk.label == "CRITICAL" and before.risk.label != "CRITICAL":
                risks.append(NewRiskBlock(
                    facility_id=facility_id, facility_name=name, risk_type="NEW_CRITICAL", day=None,
                    detail=f"{name} becomes CRITICAL: risk rises from {before.risk.score} ({before.risk.label}) to {after.risk.score}.",
                ))
            elif after.risk.label == "HIGH" and before.risk.label in ("LOW", "MEDIUM"):
                risks.append(NewRiskBlock(
                    facility_id=facility_id, facility_name=name, risk_type="NEW_HIGH_RISK", day=None,
                    detail=f"{name} becomes HIGH risk: risk rises from {before.risk.score} ({before.risk.label}) to {after.risk.score}.",
                ))
        protected = before.state.protected_stock
        if (
            protected > EPSILON
            and before_projection.minimum_projected_stock >= protected - EPSILON
            and after_projection.minimum_projected_stock < protected - EPSILON
        ):
            first = next(day for day in after_projection.days if day.closing_stock < protected - EPSILON)
            risks.append(NewRiskBlock(
                facility_id=facility_id, facility_name=name, risk_type="FELL_BELOW_PROTECTED_STOCK", day=first.day,
                detail=f"{name} falls below its protected safety stock of {_quantity(protected, unit)} on day {first.day} "
                f"(lowest {_quantity(after_projection.minimum_projected_stock, unit)}).",
            ))
    return risks


def facility_change(before: FacilityOutcome, after: FacilityOutcome, role: str) -> tuple[str | None, FacilityChangeBlock]:
    """Classify one facility as WORSENED, IMPROVED or unchanged (None). Any worsening outweighs an improvement."""
    before_projection, after_projection = before.projection, after.projection
    before_score = before.risk.score if before.risk else None
    after_score = after.risk.score if after.risk else None
    protected = before.state.protected_stock
    worse = (
        (before_score is not None and after_score > before_score)
        or after_projection.total_shortage_days > before_projection.total_shortage_days
        or after_projection.unmet_demand - before_projection.unmet_demand > EPSILON
        or (
            protected > EPSILON
            and before_projection.minimum_projected_stock >= protected - EPSILON
            and after_projection.minimum_projected_stock < protected - EPSILON
        )
    )
    better = (
        (before_score is not None and after_score < before_score)
        or after_projection.total_shortage_days < before_projection.total_shortage_days
        or before_projection.unmet_demand - after_projection.unmet_demand > EPSILON
    )
    block = FacilityChangeBlock(
        facility_id=before.state.facility.id,
        facility_name=before.state.facility.name,
        role=role,
        risk_score_before=before_score,
        risk_score_after=after_score,
        shortage_days_before=before_projection.total_shortage_days,
        shortage_days_after=after_projection.total_shortage_days,
        unmet_demand_before=_round(before_projection.unmet_demand),
        unmet_demand_after=_round(after_projection.unmet_demand),
        minimum_projected_stock_before=_round(before_projection.minimum_projected_stock),
        minimum_projected_stock_after=_round(after_projection.minimum_projected_stock),
    )
    return ("WORSENED" if worse else "IMPROVED" if better else None), block


def regional_outcome(shortage_days_before: int, shortage_days_after: int, unmet_before: float, unmet_after: float) -> str:
    worse = shortage_days_after > shortage_days_before or unmet_after - unmet_before > EPSILON
    better = shortage_days_after < shortage_days_before or unmet_before - unmet_after > EPSILON
    if worse and better:
        return "MIXED"
    return "WORSENED" if worse else "IMPROVED" if better else "UNCHANGED"


def recipient_outcome_blocks(result: SimulationResult, applied: Sequence[TransferEvaluation]) -> list[RecipientOutcomeBlock]:
    blocks = []
    for facility_id in dict.fromkeys(evaluation.destination.id for evaluation in applied):
        before, after = result.baseline[facility_id].projection, result.intervention[facility_id].projection
        blocks.append(RecipientOutcomeBlock(
            facility_id=facility_id,
            facility_name=result.states[facility_id].facility.name,
            stockout_day_before=before.projected_stockout_day,
            stockout_day_after=after.projected_stockout_day,
            stockout_prevented=before.projected_stockout_day is not None and after.projected_stockout_day is None,
            shortage_days_before=before.total_shortage_days,
            shortage_days_after=after.total_shortage_days,
            unmet_demand_before=_round(before.unmet_demand),
            unmet_demand_after=_round(after.unmet_demand),
        ))
    return blocks


def explain_transfer(result: SimulationResult, evaluation: TransferEvaluation) -> str:
    unit = result.medicine.unit
    transfer = evaluation.transfer
    if not evaluation.eligible:
        tail = " It was still simulated so its regional effect is visible." if evaluation.applied else " It was not simulated."
        return "Not eligible: " + " ".join(message for _, message in evaluation.reasons) + tail
    source, destination, route = evaluation.source, evaluation.destination, evaluation.route
    donor = result.intervention[source.id]
    lowest = min(day.closing_stock for day in donor.projection.days if day.day >= evaluation.departure_day)
    cold_chain = ", cold-chain capable" if route.cold_chain_capable else ""
    text = (
        f"Eligible: {_quantity(transfer.quantity, unit)} leaves {source.name} on day {evaluation.departure_day} and reaches "
        f"{destination.name} on day {transfer.arrival_day} ({_number(route.distance_km)} km, {_number(route.travel_hours)} h{cold_chain}). "
        f"{source.name} keeps at least {_quantity(lowest, unit)} against its protected stock of {_quantity(donor.state.protected_stock, unit)}."
    )
    before, after = result.baseline[destination.id].projection, result.intervention[destination.id].projection
    if before.projected_stockout_day is None:
        return text + f" {destination.name} had no projected stockout in the horizon."
    if after.projected_stockout_day is None:
        return text + f" With the simulated transfers {destination.name} no longer runs out (a stockout was projected on day {before.projected_stockout_day})."
    return text + f" With the simulated transfers {destination.name} still runs out on day {after.projected_stockout_day}."


def summarise(
    result: SimulationResult,
    applied: Sequence[TransferEvaluation],
    recipients: Sequence[RecipientOutcomeBlock],
    new_risks: Sequence[NewRiskBlock],
    baseline: RegionalStateBlock,
    intervention: RegionalStateBlock,
    outcome: str,
    safe: bool,
) -> str:
    unit = result.medicine.unit
    if not applied:
        return "No proposed transfer could be simulated, so the region is unchanged. Not safe to recommend."
    sentences = []
    for recipient in recipients:
        if recipient.stockout_day_before is None:
            sentences.append(f"{recipient.facility_name} had no projected stockout; the transfer adds buffer stock.")
        elif recipient.stockout_prevented:
            sentences.append(f"{recipient.facility_name} avoids the stockout projected on day {recipient.stockout_day_before}.")
        else:
            sentences.append(
                f"{recipient.facility_name} still runs out on day {recipient.stockout_day_after} (day {recipient.stockout_day_before} without the transfers)."
            )
    sentences.extend(risk.detail for risk in new_risks)
    sentences.append(
        f"Regional shortage days {baseline.regional_shortage_days} -> {intervention.regional_shortage_days}; unmet demand "
        f"{_quantity(baseline.regional_unmet_demand, unit)} -> {_quantity(intervention.regional_unmet_demand, unit)} ({outcome.lower()})."
    )
    if safe:
        sentences.append("Safe to recommend for human review: every transfer passed the feasibility gate and no new regional risk was found.")
    else:
        problems = []
        rejected = sum(1 for evaluation in result.evaluations if not evaluation.eligible)
        if rejected:
            problems.append(f"{rejected} transfer(s) failed the feasibility gate")
        if new_risks:
            problems.append("the scenario creates new regional risk")
        if outcome in ("WORSENED", "MIXED"):
            problems.append("regional shortage does not clearly improve")
        sentences.append("Not safe to recommend: " + "; ".join(problems) + ".")
    return " ".join(sentences)


def build_simulation_response(result: SimulationResult) -> SimulationResponse:
    store, medicine = result.store, result.medicine
    context = store.context
    applied = [evaluation for evaluation in result.evaluations if evaluation.applied]
    roles = facility_roles(applied)
    baseline = regional_state_block(store, result.baseline, roles, 0)
    intervention = regional_state_block(store, result.intervention, roles, len(applied))

    new_risks = find_new_risks(result.baseline, result.intervention, medicine.unit)
    improved, worsened = [], []
    for facility_id, before in result.baseline.items():
        if before.projection is None:
            continue
        status, block = facility_change(before, result.intervention[facility_id], roles.get(facility_id, NOT_IN_TRANSFER))
        if status == "WORSENED":
            worsened.append(block)
        elif status == "IMPROVED":
            improved.append(block)
    recipients = recipient_outcome_blocks(result, applied)
    at_risk = [recipient for recipient in recipients if recipient.stockout_day_before is not None]
    outcome = regional_outcome(
        baseline.regional_shortage_days, intervention.regional_shortage_days, baseline.regional_unmet_demand, intervention.regional_unmet_demand
    )
    safe = (
        bool(applied)
        and all(evaluation.eligible for evaluation in result.evaluations)
        and not new_risks
        and outcome in ("IMPROVED", "UNCHANGED")
    )
    comparison = SimulationComparisonBlock(
        recipient_stockout_prevented=bool(at_risk) and all(recipient.stockout_prevented for recipient in at_risk),
        recipient_outcomes=recipients,
        new_shortages_created=list(dict.fromkeys(risk.facility_id for risk in new_risks if risk.risk_type in ("NEW_STOCKOUT", "MORE_SHORTAGE"))),
        new_critical_facilities=[risk.facility_id for risk in new_risks if risk.risk_type == "NEW_CRITICAL"],
        new_risks=new_risks,
        improved_facilities=improved,
        worsened_facilities=worsened,
        regional_shortage_days_before=baseline.regional_shortage_days,
        regional_shortage_days_after=intervention.regional_shortage_days,
        shortage_days_prevented=baseline.regional_shortage_days - intervention.regional_shortage_days,
        regional_unmet_demand_before=baseline.regional_unmet_demand,
        regional_unmet_demand_after=intervention.regional_unmet_demand,
        unmet_demand_reduced=_round(baseline.regional_unmet_demand - intervention.regional_unmet_demand),
        critical_facility_delta=intervention.critical_facility_count - baseline.critical_facility_count,
        regional_risk_before=baseline.regional_risk,
        regional_risk_after=intervention.regional_risk,
        regional_outcome=outcome,
        safe_to_recommend=safe,
        summary=summarise(result, applied, recipients, new_risks, baseline, intervention, outcome, safe),
    )

    evaluations = [
        TransferEvaluationBlock(
            index=evaluation.index,
            from_facility_id=evaluation.transfer.from_facility_id,
            to_facility_id=evaluation.transfer.to_facility_id,
            medicine_id=evaluation.transfer.medicine_id,
            quantity=evaluation.transfer.quantity,
            arrival_day=evaluation.transfer.arrival_day,
            departure_day=evaluation.departure_day,
            eligible=evaluation.eligible,
            applied=evaluation.applied,
            rejection_reasons=[message for _, message in evaluation.reasons],
            rejection_codes=[code for code, _ in evaluation.reasons],
            route=(
                RouteBlock(
                    distance_km=evaluation.route.distance_km,
                    travel_hours=evaluation.route.travel_hours,
                    cold_chain_available=evaluation.route.cold_chain_capable,
                )
                if evaluation.route
                else None
            ),
            batches=[BatchAllocationBlock(batch_no=batch.batch_no, quantity=_round(quantity), expiry_date=batch.expiry_date) for batch, quantity in evaluation.batches],
            explanation=explain_transfer(result, evaluation),
        )
        for evaluation in result.evaluations
    ]

    notes = list(context.notes)
    overdue = [state.facility.name for state in result.states.values() if state.inventory.overdue_replenishments]
    if overdue:
        notes.append(
            f"{len(overdue)} facility(ies) have open replenishment orders expected on or before {context.simulation_date} that have "
            f"not arrived; they are not projected: {', '.join(overdue)}."
        )
    notes.extend(
        f"{state.facility.name} ({state.facility.id}) is excluded from regional totals: {state.unavailable_reason}"
        for state in result.states.values()
        if not state.available
    )
    history_start, history_end = store.history_window
    mapping_assumptions = [
        f"{mapping.name}: {mapping.rule.rstrip('.')} ({mapping.status.replace('_', ' ').lower()}; review: {mapping.review_owner})."
        for mapping in context.mappings
    ]
    return SimulationResponse(
        scenario_type="SIMULATED_DATABASE" if context.data_source == "MYSQL" else "SIMULATED_FIXTURE",
        horizon_days=result.horizon_days,
        medicine_id=medicine.id,
        medicine=SimulationMedicineBlock(
            id=medicine.id,
            generic_name=medicine.generic_name,
            strength=medicine.strength,
            dosage_form=medicine.dosage_form,
            unit=medicine.unit,
            criticality=medicine.criticality,
            requires_cold_chain=medicine.requires_cold_chain,
        ),
        baseline=baseline,
        intervention=intervention,
        transfer_evaluations=evaluations,
        comparison=comparison,
        assumptions=[*SIMULATION_ASSUMPTIONS, context.protected_stock_assumption, DECISION_SUPPORT_ASSUMPTION, *mapping_assumptions],
        limitations=list(SIMULATION_LIMITATIONS),
        decision_support_only=True,
        data_context=SimulationDataContextBlock(
            data_source=context.data_source,
            data_label=context.data_label,
            simulation_date=context.simulation_date,
            as_of_date=store.as_of,
            history_start=history_start,
            history_end=history_end,
            unit=medicine.unit,
            mappings=[
                DataMappingBlock(name=mapping.name, source=mapping.source, rule=mapping.rule, status=mapping.status, review_owner=mapping.review_owner)
                for mapping in context.mappings
            ],
            notes=notes,
        ),
        data_label=context.data_label,
        model_version=MODEL_VERSION,
    )


def run_simulation(store: SimulatedDataStore, request: SimulationRequest, config: RiskConfig = DEFAULT_RISK_CONFIG) -> SimulationResponse:
    """POST /scenarios/simulate: evaluate a validated request against one data-store snapshot."""
    transfers = [
        ProposedTransfer(item.from_facility_id, item.to_facility_id, item.medicine_id, item.quantity, item.arrival_day)
        for item in request.transfers
    ]
    return build_simulation_response(simulate(store, transfers, request.horizon_days, config))
