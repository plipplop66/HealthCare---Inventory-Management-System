"""Safe multi-source medicine-transfer optimizer (POST /plans/optimize).

Given a destination facility, one exact medicine, a requested quantity and a 7, 14 or 30-day horizon, the optimizer
proposes the smallest safe redistribution plan from one or more donors:

1. Load one read-only regional snapshot and project every facility exactly as the Ripple Simulator does
   (load_facility_state and baseline_outcome in app/simulator.py, which reuse the POST /forecast engine).
2. Filter candidates with hard rules. Identity, data, route, cold-chain and timing checks reuse the simulator's
   feasibility gate (check_transfer), so both give the same reasons.
3. Reject donors whose route is longer than the configured maximum travel time (6 hours by default).
4. Work out each candidate's safe donor capacity from stock already received: forecast consumption with no scheduled,
   delayed or other future replenishment, its retained floor (protected stock plus the equity or operational reserve),
   its usable batches and its safe surplus. Each limit is confirmed with the Ripple Simulator. The recipient's own
   projection keeps its scheduled and delayed replenishments.
5. Allocate donors, batches (earliest expiry first) and arrival days with Google OR-Tools CP-SAT
   (app/allocation_solver.py), in integer hundredths of the unit.
6. Run the complete plan through the Ripple Simulator and re-check the travel limit and received-stock donor safety.
   Only a plan that passes every check is returned. Otherwise the donors the simulator rejects are excluded and the
   model is solved again; if no safe plan remains the result is 422 NO_SAFE_PLAN.

EVERYTHING HERE IS SIMULATED DECISION SUPPORT. A plan is a proposal that a qualified person must approve. The
optimizer never substitutes one medicine for another, never writes a transfer and never changes inventory. The
objective, equity guardrail, donor exclusions and travel-time limit are approved by Aaryan for the MEDRIPPLE hackathon
prototype only; they are not clinically validated, and real deployment requires clinical, regulatory and operational
validation.
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from .allocation_solver import (
    HARD_CONSTRAINTS,
    OBJECTIVE_STAGES,
    QUANTITY_SCALE,
    AllocationResult,
    DonorAllocation,
    DonorInput,
    DonorOption,
    RecipientInput,
    solve_allocation,
    solver_version,
)
from .data_store import (
    APPROVED_FOR_HACKATHON_PROTOTYPE,
    PROTECTED_STOCK_NOT_RECORDED,
    Batch,
    DataMapping,
    Facility,
    Medicine,
    Replenishment,
    Route,
    SimulatedDataStore,
)
from .risk_engine import DEFAULT_RISK_CONFIG, RiskConfig, _number, _per_day, _quantity
from .schemas import (
    CandidateBlock,
    DataMappingBlock,
    EquityGuardrailBlock,
    NoSafePlanDetailsBlock,
    ObjectiveStageBlock,
    ObjectiveTermBlock,
    OptimizeRequest,
    PlanResponse,
    PlanTransferBlock,
    PlanValidationBlock,
    RecipientPlanBlock,
    SimulationDataContextBlock,
    SimulationMedicineBlock,
    SimulationResponse,
    SolverBlock,
    ValidationCheckBlock,
)
from .simulator import (
    ARRIVES_AFTER_RECIPIENT_STOCKOUT,
    BATCH_EXPIRES_BEFORE_USE,
    DECISION_SUPPORT_ASSUMPTION,
    DEFAULT_MAX_TRAVEL_HOURS,
    EPSILON,
    FORECAST,
    MODEL_VERSION as SIMULATOR_MODEL_VERSION,
    PATIENT_IMPACT_LIMITATION,
    PROTOTYPE_VALIDATION_LIMITATION,
    STORAGE_FACILITY_TYPES,
    TRAVEL_TIME_LIMIT_EXCEEDED,
    FacilityOutcome,
    FacilityState,
    ProposedTransfer,
    SimulationResult,
    TransferEvaluation,
    baseline_outcome,
    build_simulation_response,
    check_max_travel_hours,
    check_transfer,
    check_travel_limit,
    describe_medicine,
    exceeds_travel_limit,
    find_new_risks,
    load_facility_state,
    safe_surplus_at,
    simulate,
)
from .stock_projection import StockProjection, project_stock

MODEL_VERSION = "aiml-transfer-optimizer-v2"
RECEIVED_STOCK_ONLY = "RECEIVED_STOCK_ONLY"
SOLVER_NAME = "OR-Tools"
SOLVER_ALGORITHM = "CP-SAT"
PLAN_STATUS = "PROPOSED"
COUNT_UNIT = "count"
NO_SAFE_PLAN = "NO_SAFE_PLAN"
NO_SAFE_PLAN_MESSAGE = "No safe regional redistribution plan can satisfy the requested quantity."

SELECTED = "SELECTED"
ELIGIBLE_NOT_SELECTED = "ELIGIBLE_NOT_SELECTED"
REJECTED = "REJECTED"

# Candidate rejection codes. The simulator adds ROUTE_NOT_FOUND, COLD_CHAIN_UNAVAILABLE, INCOMPLETE_DATA,
# ARRIVAL_OUTSIDE_HORIZON, TRAVEL_TIME_LIMIT_EXCEEDED and its other feasibility codes.
DESTINATION_FACILITY = "DESTINATION_FACILITY"
NO_INVENTORY_RECORD = "NO_INVENTORY_RECORD"
NO_EFFECTIVE_STOCK = "NO_EFFECTIVE_STOCK"
NO_USABLE_BATCH = "NO_USABLE_BATCH"
SAFETY_STOCK_NOT_RECORDED = "SAFETY_STOCK_NOT_RECORDED"
DONOR_AT_RISK = "DONOR_AT_RISK"
NO_SAFE_DONOR_CAPACITY = "NO_SAFE_DONOR_CAPACITY"
CAPACITY_NOT_VERIFIED = "CAPACITY_NOT_VERIFIED"
SIMULATION_REJECTED = "SIMULATION_REJECTED"


class OptimizationError(Exception):
    """A request that cannot be optimised at all: unknown destination or medicine, or unusable data."""

    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class NoSafePlanError(Exception):
    """No plan satisfies the hard constraints and passes the Ripple Simulator (422 NO_SAFE_PLAN)."""

    status_code = 422
    code = NO_SAFE_PLAN

    def __init__(self, details: NoSafePlanDetailsBlock) -> None:
        super().__init__(NO_SAFE_PLAN_MESSAGE)
        self.message = NO_SAFE_PLAN_MESSAGE
        self.details = details


def normalise_facility_type(facility_type: str) -> str:
    """WAREHOUSE, DISTRICTHOSPITAL, CHC, PHC, SUBCENTRE: database and fixture spellings compare equal."""
    return "".join(character for character in facility_type.upper() if character.isalnum())


@dataclass(frozen=True)
class OptimizerConfig:
    """Donor guardrails approved by Aaryan for the MEDRIPPLE hackathon prototype only; none is clinically validated.

    retained floor      = max(protected stock x (1 + equity uplift), operational reserve)
    equity uplift       = facility-type uplift + remoteness weight x remoteness (0-1)
    operational reserve = warehouse operational reserve share x effective stock (storage facilities only)
    route cap           = a donor route may take at most max_travel_hours (a route of exactly that length is allowed)
    """

    remoteness_weight: float = 0.5
    facility_type_uplift: Mapping[str, float] = field(
        default_factory=lambda: {"WAREHOUSE": 0.0, "DISTRICTHOSPITAL": 0.0, "CHC": 0.10, "PHC": 0.25, "SUBCENTRE": 0.35}
    )
    # Facility types not listed are treated like a PHC.
    default_type_uplift: float = 0.25
    warehouse_operational_reserve_share: float = 0.10
    excluded_donor_risk_labels: tuple[str, ...] = ("HIGH", "CRITICAL")
    # Longest donor-to-destination route in hours; longer routes are rejected with TRAVEL_TIME_LIMIT_EXCEEDED. The Ripple
    # Simulator is given this same value, so POST /scenarios/simulate and POST /plans/optimize apply one limit.
    max_travel_hours: float = DEFAULT_MAX_TRAVEL_HOURS
    max_attempts: int = 5
    max_deterministic_time: float = 10.0

    def __post_init__(self) -> None:
        check_max_travel_hours(self.max_travel_hours)
        weights = [*self.facility_type_uplift.values(), self.default_type_uplift, self.remoteness_weight]
        if any(not math.isfinite(weight) or weight < 0 for weight in weights):
            raise ValueError("Equity uplifts and the remoteness weight must be non-negative numbers.")
        if not 0 <= self.warehouse_operational_reserve_share < 1:
            raise ValueError("warehouse_operational_reserve_share must be at least 0 and below 1.")
        if self.max_attempts < 1 or self.max_deterministic_time <= 0:
            raise ValueError("max_attempts and max_deterministic_time must be positive.")

    def equity_uplift(self, facility: Facility) -> float:
        type_uplift = self.facility_type_uplift.get(normalise_facility_type(facility.type), self.default_type_uplift)
        return round(type_uplift + self.remoteness_weight * min(1.0, max(0.0, facility.remoteness_score)), 4)


DEFAULT_OPTIMIZER_CONFIG = OptimizerConfig()
EQUITY_FORMULA = (
    "retained floor = max(protected stock x (1 + equity uplift), operational reserve); "
    "equity uplift = facility-type uplift + remoteness weight x remoteness (0-1); "
    "operational reserve = warehouse operational reserve share x effective stock, for storage facilities only"
)


def scaled(value: float) -> int:
    """An exact 2-decimal data quantity in hundredths (float sums such as 2019.9299999999998 are exact after rounding)."""
    return round(value * QUANTITY_SCALE)


def scaled_down(value: float, step: int) -> int:
    """The largest multiple of step hundredths not above a computed limit: a safety limit is never rounded up."""
    units = max(0, math.floor(value * QUANTITY_SCALE + 1e-6))
    return units - units % step


def ceil_hundredths(value: float) -> float:
    """A retained floor rounded up to the hundredth, so a donor never keeps less than the rule requires."""
    return math.ceil(value * QUANTITY_SCALE - 1e-6) / QUANTITY_SCALE


def unscaled(units: int) -> float:
    return units / QUANTITY_SCALE


@dataclass(frozen=True)
class Scenario:
    """One request resolved against one regional snapshot, read once and never modified."""

    store: SimulatedDataStore
    medicine: Medicine
    destination: Facility
    horizon_days: int
    # Requested quantity in hundredths, and the smallest movable step (100 for medicines counted in whole units).
    requested: int
    step: int
    states: Mapping[str, FacilityState]
    baselines: Mapping[str, FacilityOutcome]
    config: OptimizerConfig
    risk_config: RiskConfig

    @property
    def unit(self) -> str:
        return self.medicine.unit

    @property
    def recipient(self) -> FacilityState:
        return self.states[self.destination.id]

    @property
    def recipient_baseline(self) -> FacilityOutcome:
        return self.baselines[self.destination.id]

    @property
    def use_by(self) -> date:
        """Transferred stock must stay in date until the end of the horizon, as the simulator requires."""
        return self.store.as_of + timedelta(days=self.horizon_days - 1)

    @property
    def recipient_stockout_day(self) -> int | None:
        return self.recipient_baseline.projection.projected_stockout_day

    @property
    def last_useful_arrival_day(self) -> int:
        stockout = self.recipient_stockout_day
        return self.horizon_days if stockout is None else min(self.horizon_days, stockout)

    def day_date(self, day: int) -> date:
        return self.store.as_of + timedelta(days=day - 1)


def resolve_scenario(store: SimulatedDataStore, request: OptimizeRequest, config: OptimizerConfig, risk_config: RiskConfig) -> Scenario:
    description = store.context.description
    destination = store.get_facility(request.destination_facility_id)
    if destination is None:
        raise OptimizationError(404, "FACILITY_NOT_FOUND", f"Destination facility '{request.destination_facility_id}' was not found in the {description}.")
    medicine = store.get_medicine(request.medicine_id)
    if medicine is None:
        raise OptimizationError(404, "MEDICINE_NOT_FOUND", f"Medicine '{request.medicine_id}' was not found in the {description}.")
    if store.get_inventory(destination.id, medicine.id) is None:
        raise OptimizationError(
            404,
            "OPTIMIZATION_TARGET_NOT_FOUND",
            f"{destination.name} ({destination.id}) has no inventory record for {describe_medicine(medicine)} in the {description}.",
        )
    step = QUANTITY_SCALE if medicine.unit == COUNT_UNIT else 1
    requested = int(Decimal(str(request.quantity)) * QUANTITY_SCALE)
    if requested % step:
        raise OptimizationError(
            422,
            "INVALID_QUANTITY_FOR_UNIT",
            f"{describe_medicine(medicine)} is counted in whole units, so quantity must be a whole number; got {_number(request.quantity)}.",
        )
    states = {
        facility.id: load_facility_state(store, facility, medicine, inventory)
        for facility in store.facilities.values()
        if (inventory := store.get_inventory(facility.id, medicine.id)) is not None
    }
    if not states[destination.id].available:
        raise OptimizationError(
            422, "OPTIMIZATION_DATA_INCOMPLETE", f"{destination.name} ({destination.id}) cannot be projected: {states[destination.id].unavailable_reason}"
        )
    baselines = {
        facility_id: baseline_outcome(store, states, state, medicine, request.horizon_days, risk_config) for facility_id, state in states.items()
    }
    return Scenario(store, medicine, destination, request.horizon_days, requested, step, states, baselines, config, risk_config)


@dataclass
class Candidate:
    """The optimizer's working record for one facility that could donate."""

    facility: Facility
    state: FacilityState | None
    baseline: FacilityOutcome | None
    route: Route | None = None
    earliest_arrival_day: int | None = None
    lasting_batches: tuple[Batch, ...] = ()
    equity_uplift: float | None = None
    equity_reserve: float | None = None
    operational_reserve: float | None = None
    retained_floor: float | None = None
    # Donor-only projection from stock already received (no future replenishment), and the future supply it leaves out.
    received_projection: StockProjection | None = None
    excluded_replenishments: tuple[Replenishment, ...] = ()
    options: list[DonorOption] = field(default_factory=list)
    reasons: list[tuple[str, str]] = field(default_factory=list)
    allocation: DonorAllocation | None = None

    def reject(self, code: str, message: str) -> None:
        self.reasons.append((code, message))

    @property
    def eligible(self) -> bool:
        return not self.reasons and bool(self.options)

    @property
    def capacity(self) -> int:
        return max(option.capacity for option in self.options) if self.eligible else 0

    @property
    def lasting_quantity(self) -> float:
        return sum(batch.quantity for batch in self.lasting_batches)


def unusable_description(batch: Batch, as_of: date) -> str:
    return "expired" if batch.status == "USABLE" and batch.expiry_date < as_of else batch.status.lower()


def reserve_description(candidate: Candidate, unit: str) -> str:
    state = candidate.state
    if (
        candidate.operational_reserve is not None
        and candidate.operational_reserve > EPSILON
        and candidate.operational_reserve >= state.protected_stock + candidate.equity_reserve
    ):
        share = 100 * candidate.operational_reserve / state.effective_stock
        return f"an operational reserve of {_quantity(candidate.operational_reserve, unit)}, {share:.0f}% of its effective stock"
    if candidate.equity_reserve > EPSILON:
        return (
            f"{_quantity(state.protected_stock, unit)} protected stock plus a {_quantity(candidate.equity_reserve, unit)} equity reserve "
            f"({_number(candidate.equity_uplift * 100)}% uplift for its facility type and remoteness)"
        )
    return f"its protected stock of {_quantity(state.protected_stock, unit)}"


def consumption_description(state: FacilityState, unit: str) -> str:
    if state.demand_basis != FORECAST:
        return "no clinical consumption (storage facility)"
    return f"forecast consumption of {_number(state.demand)} {_per_day(unit)}"


def received_stock_projection(scenario: Scenario, state: FacilityState, withdrawals: Mapping[int, float] | None = None) -> StockProjection:
    """A donor's day-by-day projection from stock already received: the forecast engine's projection with no replenishment.

    Only donor capacity uses it. The recipient, POST /forecast and the Ripple Simulator keep scheduled and delayed
    replenishments; ARRIVED stock is already part of effective stock and is never projected again.
    """
    return project_stock(state.effective_stock, state.demand, scenario.horizon_days, (), start_date=scenario.store.as_of, withdrawals=withdrawals)


def future_supply(scenario: Scenario, state: FacilityState) -> tuple[Replenishment, ...]:
    """Open orders due within the horizon that donor capacity deliberately leaves out."""
    return tuple(item for item in state.inventory.replenishments if 1 <= item.arrival_day <= scenario.horizon_days)


def excluded_supply_text(candidate: Candidate, unit: str) -> str:
    if not candidate.excluded_replenishments:
        return ""
    orders = "; ".join(
        f"{_quantity(item.quantity, unit)} {item.status.lower()} for day {item.arrival_day}" for item in candidate.excluded_replenishments
    )
    return f" Future supply ({orders}) is deliberately not counted toward donor capacity; only stock already received counts."


def arrival_options(scenario: Scenario, candidate: Candidate) -> list[DonorOption]:
    """Safe donor capacity for each useful arrival day.

    capacity = min(opening stock on the departure day,
                   lowest received-stock projection from the departure day to the horizon end - retained floor,
                   usable batches that stay in date until the horizon end,
                   safe surplus at the snapshot - 0.01, so other facilities' regional fragility does not rise)
    The received-stock projection includes forecast consumption but no future replenishment, so a scheduled or delayed
    delivery can neither make a donor eligible nor raise its capacity, and capacity is never simply effective stock minus
    protected stock. Up to the floor a withdrawal lowers every later closing stock by the same amount, which is why the
    lowest projected stock bounds it.
    """
    state, projection = candidate.state, candidate.received_projection
    travel_days = int(candidate.route.travel_hours // 24)
    lasting = sum(scaled(batch.quantity) for batch in candidate.lasting_batches)
    lasting -= lasting % scenario.step
    surplus = safe_surplus_at(state, state.effective_stock)
    options = []
    for arrival_day in range(candidate.earliest_arrival_day, scenario.last_useful_arrival_day + 1):
        departure_day = arrival_day - travel_days
        days = projection.days[departure_day - 1:]
        limits = [days[0].opening_stock, min(day.closing_stock for day in days) - candidate.retained_floor]
        if surplus is not None and surplus > EPSILON:
            limits.append(surplus - 1 / QUANTITY_SCALE)
        capacity = min(scaled_down(min(limits), scenario.step), lasting)
        if capacity > 0:
            options.append(DonorOption(arrival_day, departure_day, capacity))
    return options


def explain_no_capacity(scenario: Scenario, candidate: Candidate) -> str:
    state, unit, name = candidate.state, scenario.unit, candidate.facility.name
    departure_day = max(1, candidate.earliest_arrival_day - int(candidate.route.travel_hours // 24))
    lowest = min(candidate.received_projection.days[departure_day - 1:], key=lambda day: day.closing_stock)
    text = (
        f"{name} must keep {_quantity(candidate.retained_floor, unit)} ({reserve_description(candidate, unit)}). With "
        f"{consumption_description(state, unit)} and no future deliveries counted, its lowest projected stock from day "
        f"{departure_day} is {_quantity(lowest.closing_stock, unit)} on day {lowest.day}, so it has no safe surplus to send."
    )
    text += excluded_supply_text(candidate, unit)
    with_future_supply = min(day.closing_stock for day in candidate.baseline.projection.days[departure_day - 1:]) - candidate.retained_floor
    if candidate.excluded_replenishments and with_future_supply > EPSILON:
        text += (
            f" Counting that supply it would appear able to send {_quantity(with_future_supply, unit)}, but only because of that "
            "future supply."
        )
    naive = state.effective_stock - state.protected_stock
    if naive > EPSILON:
        text += (
            f" Effective stock minus protected stock ({_quantity(naive, unit)}) is not a safe capacity once consumption "
            f"over the {scenario.horizon_days}-day horizon is projected."
        )
    return text


def assess_candidate(scenario: Scenario, facility: Facility) -> Candidate:
    """Apply the hard candidate filters and work out the safe donor capacity of one facility."""
    medicine, destination, unit, config = scenario.medicine, scenario.destination, scenario.unit, scenario.config
    state, baseline = scenario.states.get(facility.id), scenario.baselines.get(facility.id)
    candidate = Candidate(facility, state, baseline)
    if facility.id == destination.id:
        candidate.reject(DESTINATION_FACILITY, f"{facility.name} is the destination and cannot donate to itself.")
        return candidate
    if state is None:
        candidate.reject(
            NO_INVENTORY_RECORD,
            f"{facility.name} holds no inventory record for {describe_medicine(medicine)}; only this exact medicine is moved and nothing is substituted.",
        )
        return candidate

    route = scenario.store.get_route(facility.id, destination.id)
    earliest = 1 + int(route.travel_hours // 24) if route is not None else 1
    probe = TransferEvaluation(0, ProposedTransfer(facility.id, destination.id, medicine.id, 1.0, earliest))
    check_transfer(scenario.store, scenario.states, medicine, scenario.horizon_days, probe)
    # The simulator's own route-cap rule, so both report the same code and reason.
    check_travel_limit([probe], config.max_travel_hours)
    for code, message in probe.reasons:
        candidate.reject(code, message)
    candidate.route = probe.route
    candidate.earliest_arrival_day = earliest if probe.route is not None else None
    if not state.available:
        return candidate

    candidate.received_projection = received_stock_projection(scenario, state)
    candidate.excluded_replenishments = future_supply(scenario, state)
    candidate.equity_uplift = config.equity_uplift(facility)
    candidate.equity_reserve = ceil_hundredths(state.protected_stock * candidate.equity_uplift)
    if facility.type.upper() in STORAGE_FACILITY_TYPES:
        candidate.operational_reserve = ceil_hundredths(config.warehouse_operational_reserve_share * state.effective_stock)
    candidate.retained_floor = ceil_hundredths(max(state.protected_stock + candidate.equity_reserve, candidate.operational_reserve or 0.0))

    as_of = scenario.store.as_of
    if state.effective_stock <= EPSILON:
        unusable = [batch for batch in state.inventory.batches if batch.quantity > 0 and not batch.is_usable_on(as_of)]
        if unusable:
            statuses = " or ".join(sorted({unusable_description(batch, as_of) for batch in unusable}))
            candidate.reject(
                NO_USABLE_BATCH,
                f"{facility.name} records {_quantity(state.inventory.recorded_stock, unit)}, but every batch is {statuses}, so none can be sent.",
            )
        else:
            candidate.reject(NO_EFFECTIVE_STOCK, f"{facility.name} has no usable stock of {describe_medicine(medicine)}.")
        return candidate
    candidate.lasting_batches = tuple(batch for batch in state.usable_batches if batch.expiry_date >= scenario.use_by and batch.quantity > 0)
    if not candidate.lasting_batches:
        candidate.reject(
            BATCH_EXPIRES_BEFORE_USE,
            f"All of {facility.name}'s usable stock expires before {scenario.use_by} (the end of the horizon), so none can be sent.",
        )
    if state.inventory.protected_stock_source == PROTECTED_STOCK_NOT_RECORDED and state.demand_basis == FORECAST:
        candidate.reject(
            SAFETY_STOCK_NOT_RECORDED,
            f"{facility.name} has no recorded safety stock for {describe_medicine(medicine)}, so a safe donor capacity cannot be established.",
        )
    risk = baseline.risk
    if risk is not None and risk.label in config.excluded_donor_risk_labels:
        candidate.reject(DONOR_AT_RISK, f"{facility.name} is already {risk.label} risk ({risk.score}) without any transfer, so it is not asked to donate.")

    if candidate.route is None or not candidate.lasting_batches or earliest > scenario.horizon_days:
        return candidate
    if earliest > scenario.last_useful_arrival_day:
        stockout = scenario.recipient_stockout_day
        candidate.reject(
            ARRIVES_AFTER_RECIPIENT_STOCKOUT,
            f"{destination.name} is projected to run out on day {stockout} ({scenario.day_date(stockout)}), before a delivery from "
            f"{facility.name} could arrive on day {earliest} ({_number(candidate.route.travel_hours)} h route).",
        )
        return candidate
    options = arrival_options(scenario, candidate)
    if not options:
        candidate.reject(NO_SAFE_DONOR_CAPACITY, explain_no_capacity(scenario, candidate))
    candidate.options = options
    return candidate


def verify_capacity(scenario: Scenario, candidate: Candidate) -> None:
    """Confirm with the Ripple Simulator that sending the full safe capacity keeps this donor safe."""
    earliest, largest = candidate.options[0], max(candidate.options, key=lambda option: (option.capacity, -option.arrival_day))
    for option in sorted({earliest, largest}, key=lambda item: item.arrival_day):
        transfer = ProposedTransfer(candidate.facility.id, scenario.destination.id, scenario.medicine.id, unscaled(option.capacity), option.arrival_day)
        result = simulate(scenario.store, [transfer], scenario.horizon_days, scenario.risk_config, scenario.config.max_travel_hours)
        evaluation = result.evaluations[0]
        donor_risks = [risk for risk in find_new_risks(result.baseline, result.intervention, scenario.unit) if risk.facility_id == candidate.facility.id]
        if not evaluation.eligible or donor_risks:
            details = " ".join([message for _, message in evaluation.reasons] + [risk.detail for risk in donor_risks])
            candidate.reject(
                CAPACITY_NOT_VERIFIED,
                f"The Ripple Simulator did not confirm a safe capacity of {_quantity(unscaled(option.capacity), scenario.unit)} "
                f"arriving on day {option.arrival_day}: {details}",
            )
            return


def assess_candidates(scenario: Scenario) -> list[Candidate]:
    candidates = [assess_candidate(scenario, facility) for facility in sorted(scenario.store.facilities.values(), key=lambda item: item.id)]
    for candidate in candidates:
        if candidate.eligible:
            verify_capacity(scenario, candidate)
    return candidates


@dataclass(frozen=True)
class PlannedTransfer:
    """One transfer instruction: one donor batch, in hundredths."""

    candidate: Candidate
    batch: Batch
    quantity: int
    arrival_day: int
    departure_day: int

    @property
    def batch_identifier(self) -> int | str:
        # The fixture has no database batch ID; like backend/src/fixture-store.js it uses the batch number.
        return self.batch.batch_id if self.batch.batch_id is not None else self.batch.batch_no


def donor_inputs(scenario: Scenario, candidates: Sequence[Candidate]) -> list[DonorInput]:
    return [
        DonorInput(
            key=candidate.facility.id,
            batch_capacities=tuple(units - units % scenario.step for units in (scaled(batch.quantity) for batch in candidate.lasting_batches)),
            options=tuple(candidate.options),
            equity_index=math.floor(100 * candidate.equity_uplift + 0.5),
            distance_tenths_km=math.floor(10 * candidate.route.distance_km + 0.5),
        )
        for candidate in candidates
        if candidate.eligible
    ]


def recipient_input(scenario: Scenario) -> RecipientInput:
    state = scenario.recipient
    replenishments: dict[int, int] = {}
    for item in state.inventory.replenishments:
        if 1 <= item.arrival_day <= scenario.horizon_days:
            replenishments[item.arrival_day] = replenishments.get(item.arrival_day, 0) + scaled(item.quantity)
    return RecipientInput(scaled(state.effective_stock), scaled(state.demand), replenishments, scenario.horizon_days)


def plan_transfers(candidates: Sequence[Candidate], result: AllocationResult) -> list[PlannedTransfer]:
    by_id = {candidate.facility.id: candidate for candidate in candidates}
    transfers = []
    for allocation in sorted(result.allocations, key=lambda item: (item.arrival_day, item.key)):
        candidate = by_id[allocation.key]
        candidate.allocation = allocation
        for batch, quantity in zip(candidate.lasting_batches, allocation.batch_quantities):
            if quantity:
                transfers.append(PlannedTransfer(candidate, batch, quantity, allocation.arrival_day, allocation.departure_day))
    return transfers


def check(name: str, passed: bool, passed_detail: str, failed_detail: str) -> ValidationCheckBlock:
    return ValidationCheckBlock(name=name, passed=passed, detail=passed_detail if passed else failed_detail)


def validation_checks(
    scenario: Scenario, transfers: Sequence[PlannedTransfer], result: SimulationResult, simulation: SimulationResponse
) -> list[ValidationCheckBlock]:
    """The conditions a plan must meet in the Ripple Simulator before it is returned."""
    unit, comparison = scenario.unit, simulation.comparison
    ineligible = [evaluation for evaluation in result.evaluations if not evaluation.eligible or not evaluation.applied]
    donors = {transfer.candidate.facility.id for transfer in transfers}
    critical = [item.facility_id for item in simulation.intervention.facilities if item.facility_id in donors and item.risk_label == "CRITICAL"]
    recipient = next(item for item in simulation.intervention.facilities if item.facility_id == scenario.destination.id)
    allocated = sum(transfer.quantity for transfer in transfers)
    supplied = allocated == scenario.requested and abs(recipient.transfer_in - unscaled(scenario.requested)) <= EPSILON
    mismatched = [
        transfer.batch.batch_no
        for transfer, evaluation in zip(transfers, result.evaluations)
        if len(evaluation.batches) != 1
        or evaluation.batches[0][0].batch_no != transfer.batch.batch_no
        or abs(evaluation.batches[0][1] - unscaled(transfer.quantity)) > EPSILON
    ]
    regional = (
        f"Regional shortage days {comparison.regional_shortage_days_before} -> {comparison.regional_shortage_days_after}; unmet demand "
        f"{_quantity(comparison.regional_unmet_demand_before, unit)} -> {_quantity(comparison.regional_unmet_demand_after, unit)} "
        f"({comparison.regional_outcome.lower()})."
    )
    return [
        check(
            "ALL_TRANSFERS_ELIGIBLE", not ineligible,
            f"All {len(transfers)} transfer instruction(s) passed the simulator's feasibility gate and impact checks.",
            " ".join(f"{evaluation.transfer.from_facility_id}: {' '.join(message for _, message in evaluation.reasons)}" for evaluation in ineligible),
        ),
        check(
            "NO_NEW_REGIONAL_RISK", not comparison.new_risks,
            "No facility gains a stockout, more shortage, a new HIGH or CRITICAL label, or falls below protected stock.",
            " ".join(risk.detail for risk in comparison.new_risks),
        ),
        check("NO_DONOR_CRITICAL", not critical, "No donor is CRITICAL after the transfers.", f"CRITICAL after the transfers: {', '.join(critical)}."),
        check(
            "NO_NEW_STOCKOUT", not comparison.new_shortages_created, "No facility gains a stockout or more shortage.",
            f"New or larger shortage at: {', '.join(comparison.new_shortages_created)}.",
        ),
        check(
            "REQUESTED_QUANTITY_SUPPLIED", supplied,
            f"{_quantity(unscaled(scenario.requested), unit)} is allocated and reaches {scenario.destination.name} in the simulation.",
            f"{_quantity(unscaled(allocated), unit)} allocated and {_quantity(recipient.transfer_in, unit)} simulated, not "
            f"{_quantity(unscaled(scenario.requested), unit)}.",
        ),
        check("REGIONAL_SHORTAGE_NOT_WORSE", comparison.regional_outcome in ("IMPROVED", "UNCHANGED"), regional, regional),
        check(
            "BATCH_ALLOCATION_MATCHES", not mismatched, "The simulator allocated exactly the planned batches and quantities.",
            f"The simulator allocated different stock for batch(es) {', '.join(mismatched)}.",
        ),
        travel_limit_check(scenario, transfers),
        received_stock_check(scenario, transfers),
        check(
            "SAFE_TO_RECOMMEND", comparison.safe_to_recommend,
            "The Ripple Simulator marks the complete plan safe to recommend for human review.",
            "The Ripple Simulator does not mark the complete plan safe to recommend.",
        ),
    ]


def travel_limit_check(scenario: Scenario, transfers: Sequence[PlannedTransfer]) -> ValidationCheckBlock:
    """The candidate route cap, applied again to the final plan."""
    limit = scenario.config.max_travel_hours
    too_long = list(dict.fromkeys(
        f"{transfer.candidate.facility.id} ({_number(transfer.candidate.route.travel_hours)} h)"
        for transfer in transfers
        if exceeds_travel_limit(transfer.candidate.route, limit)
    ))
    return check(
        "ROUTES_WITHIN_TRAVEL_LIMIT", not too_long,
        f"Every donor route takes at most {_number(limit)} hours.",
        f"Donor routes over the {_number(limit)}-hour limit: {', '.join(too_long)}.",
    )


def received_stock_check(scenario: Scenario, transfers: Sequence[PlannedTransfer]) -> ValidationCheckBlock:
    """Each donor, projected from stock already received with its whole withdrawal on its departure day, keeps its floor."""
    unit = scenario.unit
    sent: dict[str, list] = {}
    for transfer in transfers:
        sent.setdefault(transfer.candidate.facility.id, [transfer.candidate, transfer.departure_day, 0])[2] += transfer.quantity
    unsafe = []
    for facility_id, (candidate, departure_day, units) in sent.items():
        projection = received_stock_projection(scenario, candidate.state, {departure_day: unscaled(units)})
        lowest = min(day.closing_stock for day in projection.days[departure_day - 1:])
        if projection.withdrawal_shortfall > EPSILON or lowest < candidate.retained_floor - EPSILON:
            unsafe.append(f"{facility_id} (lowest {_quantity(lowest, unit)} against a retained floor of {_quantity(candidate.retained_floor, unit)})")
    return check(
        "DONORS_SAFE_WITHOUT_FUTURE_SUPPLY", not unsafe,
        "Counting only stock already received, every donor keeps its retained floor from departure to the end of the horizon.",
        f"Donors that would rely on future supply: {'; '.join(unsafe)}.",
    )


def reject_failing_donors(candidates: Sequence[Candidate], transfers: Sequence[PlannedTransfer], result: SimulationResult, simulation: SimulationResponse) -> bool:
    """Exclude the donors the simulator rejected. Returns False when the failure cannot be traced to a donor."""
    donors = {transfer.candidate.facility.id for transfer in transfers}
    messages: dict[str, list[str]] = {}
    for evaluation in result.evaluations:
        if not evaluation.eligible and evaluation.source is not None:
            messages.setdefault(evaluation.source.id, []).extend(message for _, message in evaluation.reasons)
    for risk in simulation.comparison.new_risks:
        if risk.facility_id in donors:
            messages.setdefault(risk.facility_id, []).append(risk.detail)
    for candidate in candidates:
        if candidate.facility.id in messages:
            detail = " ".join(dict.fromkeys(messages[candidate.facility.id]))
            candidate.reject(SIMULATION_REJECTED, f"The Ripple Simulator rejected the combined plan for this donor: {detail}")
    return bool(messages)


def quantity_to_avoid_shortage(scenario: Scenario) -> float | None:
    """Smallest quantity that, arriving on day 1, removes the recipient's projected shortage (0 when there is none)."""
    state = scenario.recipient
    if state.demand is None:
        return None
    arrivals: Counter[int] = Counter()
    for item in state.inventory.replenishments:
        arrivals[item.arrival_day] += item.quantity
    needed, received = 0.0, 0.0
    for day in range(1, scenario.horizon_days + 1):
        received += arrivals[day]
        # Without flooring (which extra stock prevents), closing stock on day d = stock + received - d x demand.
        needed = max(needed, day * state.demand - state.effective_stock - received)
    units = max(0, math.ceil(needed * QUANTITY_SCALE - 1e-6))
    return unscaled(units + (-units) % scenario.step)


def reserve_text(candidate: Candidate, scenario: Scenario) -> str:
    return f"{_quantity(candidate.retained_floor, scenario.unit)} ({reserve_description(candidate, scenario.unit)})"


def candidate_explanation(scenario: Scenario, candidate: Candidate) -> str:
    unit = scenario.unit
    if candidate.allocation is not None:
        allocation, route = candidate.allocation, candidate.route
        sent = ", ".join(
            f"{_quantity(unscaled(quantity), unit)} from batch {batch.batch_no} (expires {batch.expiry_date})"
            for batch, quantity in zip(candidate.lasting_batches, allocation.batch_quantities)
            if quantity
        )
        after = received_stock_projection(scenario, candidate.state, {allocation.departure_day: unscaled(allocation.total)})
        lowest = min(day.closing_stock for day in after.days[allocation.departure_day - 1:])
        return (
            f"Selected: sends {sent}, leaving on day {allocation.departure_day} and arriving on day {allocation.arrival_day} "
            f"({_number(route.distance_km)} km, {_number(route.travel_hours)} h{', cold-chain capable' if route.cold_chain_capable else ''}). "
            f"Its safe capacity is {_quantity(unscaled(candidate.capacity), unit)}, keeping at least {reserve_text(candidate, scenario)} "
            f"through day {scenario.horizon_days}; counting only stock already received, its lowest projected stock after the "
            f"transfer is {_quantity(lowest, unit)}."
        ) + excluded_supply_text(candidate, unit)
    if candidate.eligible:
        return (
            f"Eligible but not needed: it could safely send up to {_quantity(unscaled(candidate.capacity), unit)} while keeping "
            f"{reserve_text(candidate, scenario)}. The solver preferred donors that keep more headroom above their floor, then "
            "earlier arrival, shorter routes and fewer transfers."
        ) + excluded_supply_text(candidate, unit)
    return "Rejected: " + " ".join(message for _, message in candidate.reasons)


def candidate_block(scenario: Scenario, candidate: Candidate) -> CandidateBlock:
    state, route = candidate.state, candidate.route
    risk = candidate.baseline.risk if candidate.baseline is not None else None
    status = SELECTED if candidate.allocation is not None else ELIGIBLE_NOT_SELECTED if candidate.eligible else REJECTED
    return CandidateBlock(
        facility_id=candidate.facility.id,
        facility_name=candidate.facility.name,
        facility_type=candidate.facility.type,
        status=status,
        rejection_codes=[code for code, _ in candidate.reasons],
        rejection_reasons=[message for _, message in candidate.reasons],
        effective_stock=round(state.effective_stock, 2) if state else 0.0,
        predicted_daily_demand=state.demand if state else None,
        demand_basis=state.demand_basis if state else "UNAVAILABLE",
        protected_stock=state.protected_stock if state else None,
        equity_uplift=candidate.equity_uplift,
        equity_reserve=candidate.equity_reserve,
        operational_reserve=candidate.operational_reserve,
        retained_floor=candidate.retained_floor,
        lasting_batch_quantity=round(candidate.lasting_quantity, 2),
        future_replenishment_excluded=round(sum(item.quantity for item in candidate.excluded_replenishments), 2),
        safe_capacity=unscaled(candidate.capacity),
        allocated_quantity=unscaled(candidate.allocation.total) if candidate.allocation else 0.0,
        baseline_risk_score=risk.score if risk else None,
        baseline_risk_label=risk.label if risk else None,
        earliest_arrival_day=candidate.earliest_arrival_day,
        distance_km=route.distance_km if route else None,
        travel_hours=route.travel_hours if route else None,
        explanation=candidate_explanation(scenario, candidate),
    )


OPTIMIZER_ASSUMPTIONS = (
    "All inventory, consumption, route and transfer data is simulated.",
    "Allocation is solved by Google OR-Tools CP-SAT, a deterministic integer solver (one worker, fixed seed, deterministic "
    "time limit); no LLM or random choice is involved.",
    "Quantities are solved as integer hundredths of the medicine's unit (quantity scale 100, matching DECIMAL(12,2)); a request "
    "with more than 2 decimals is refused rather than rounded, and medicines counted in whole units move in whole units.",
    "Demand, stock projections, protected stock and risk come from the POST /forecast engine through the Ripple Simulator.",
    "Safe donor capacity is the smallest of: opening stock on the departure day; the lowest projected stock from departure to "
    "the end of the horizon, counting only stock already received (forecast consumption with no scheduled, delayed or other "
    "future replenishment), minus the retained floor; usable batches in date until the end of the horizon; and the snapshot "
    "safe surplus less 0.01, so no other facility's regional fragility rises.",
    "A future delivery never makes a donor eligible or increases what it may send, and ARRIVED stock is already in inventory "
    "so it is not added again. The recipient's projection still counts its scheduled and delayed replenishments.",
    f"Retained floor (equity guardrail approved for the hackathon prototype): {EQUITY_FORMULA}.",
    "Donors already at HIGH or CRITICAL risk, donors without recorded safety stock, and facilities whose demand cannot be "
    "forecast do not donate.",
    "Missing route or logistics data is rejected, never assumed safe; a cold-chain medicine needs a cold-chain route and a "
    "destination with cold-chain storage.",
    "Each donor delivers once, on the earliest useful day its route allows unless a later day is needed; a delivery that cannot "
    "arrive by the recipient's projected stockout day is not considered.",
    "The objective is optimised in lexicographic stages: recipient shortage (unmet demand, then shortage days), then donor "
    "protection and equity, then logistics (arrival day, distance, number of transfers). Donor safety and the exact quantity "
    "are hard constraints.",
    "Batches are allocated earliest expiry first, then by database batch ID (by batch number only in the fixture, which has no "
    "batch IDs); each batch is a separate transfer instruction because a database transfer names one batch.",
    "A plan is returned only after the Ripple Simulator evaluates the complete plan and marks it safe to recommend; the "
    "optimizer never declares its own result safe.",
    "The plan ID is a SHA-256 digest of the request, the transfers and the data context, so an identical request on unchanged "
    "data returns the same ID. It is authoritative: the Node backend must persist this ID rather than create another.",
    "Only the exact medicine identity (same medicine, strength and dosage form) is moved; the optimizer never substitutes one "
    "medicine for another, no request field can override this, and any alternative needs manual pharmacist or qualified "
    "clinical review.",
)
OPTIMIZER_LIMITATIONS = (
    "The objective, equity uplifts, warehouse operational reserve, donor exclusions, travel-time limit and received-stock-only "
    "donor rule are approved by Aaryan for the hackathon prototype only; they are not clinically validated.",
    PROTOTYPE_VALIDATION_LIMITATION,
    PATIENT_IMPACT_LIMITATION,
    "Emergency reduction of the warehouse reserve, outbreak exceptions for HIGH or CRITICAL donors and travel-time-derived "
    "remoteness are not implemented: they need authenticated authorization data and an agreed definition.",
    "A donor's own dispensing is assumed not to use the batches chosen for transfer; expiry is handled only by sending batches "
    "that stay in date until the end of the horizon.",
    "Vehicle and destination storage capacity, temperature logs, transport cost, transport losses and route-validity dates are "
    "not modelled.",
    "Stock from replenishments arriving during the horizon has no recorded batch, so it is not sent onward.",
    "A slower donor that could only help in combination with a faster one, arriving after the recipient's projected stockout "
    "begins, is not considered.",
    "Supplier reliability is not used: delayed orders are assumed to arrive on their current expected date.",
    "One destination and one medicine per request; patients are not redistributed between facilities.",
    "Nothing is written to the data source: no plan, transfer or audit event is stored and no inventory is changed.",
)


def optimizer_mappings(scenario: Scenario) -> list[DataMapping]:
    database = scenario.store.context.data_source != "FIXTURE"
    return [
        DataMapping(
            name="equityReserve",
            source="facilities.facility_type, facilities.remoteness_score, facility_safety_stock.safety_stock_qty"
            if database else "fixture facility type, remoteness and protected stock",
            rule=f"{EQUITY_FORMULA}.",
            review_owner="Aaryan",
            status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        ),
        DataMapping(
            name="travelTimeLimit",
            source="routes.transport_time_hours" if database else "fixture route travel hours",
            rule=(
                f"A donor route may take at most {_number(scenario.config.max_travel_hours)} hours; a longer route is rejected "
                "with TRAVEL_TIME_LIMIT_EXCEEDED and a missing route is rejected, never assumed safe."
            ),
            review_owner="Aaryan",
            status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        ),
        DataMapping(
            name="donorReceivedStockOnly",
            source="inventory (effective stock) and replenishments.status" if database else "fixture inventory and replenishments",
            rule=(
                "Donor capacity counts only stock already in effective inventory; SCHEDULED, DELAYED and other future replenishments "
                "are ignored for donors but still projected for the recipient."
            ),
            review_owner="Aaryan",
            status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        ),
        DataMapping(
            name="batchIdentity",
            source="inventory.batch_id, batches.batch_number, batches.expiry_date" if database else "fixture batch numbers and expiry dates",
            rule=(
                "Each transfer instruction names one batch, allocated earliest expiry first and then by batches.batch_id; batchId is "
                "batches.batch_id. Persisting it in transfers is Sahil's pending Node work."
                if database else "Each transfer instruction names one batch, allocated earliest expiry first and then by batch number "
                "(the fixture has no batch IDs); batchId is the batch number, as in backend/src/fixture-store.js."
            ),
            review_owner="Dhiren",
            status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        ),
        DataMapping(
            name="quantityScale",
            source="DECIMAL(12,2) quantities and medicines.base_unit" if database else "fixture quantities",
            rule="Quantities are solved as integer hundredths and returned with their decimals; count medicines move in whole units; nothing is rounded.",
            review_owner="Dhiren",
            status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        ),
    ]


def plan_data_context(scenario: Scenario, simulation: SimulationResponse | None = None) -> SimulationDataContextBlock:
    store, context = scenario.store, scenario.store.context
    mappings = [*context.mappings, *optimizer_mappings(scenario)]
    history_start, history_end = store.history_window
    return SimulationDataContextBlock(
        data_source=context.data_source,
        data_label=context.data_label,
        simulation_date=context.simulation_date,
        as_of_date=store.as_of,
        history_start=history_start,
        history_end=history_end,
        unit=scenario.unit,
        mappings=[
            DataMappingBlock(name=item.name, source=item.source, rule=item.rule, status=item.status, review_owner=item.review_owner)
            for item in mappings
        ],
        notes=list(simulation.data_context.notes) if simulation is not None else list(context.notes),
    )


def plan_assumptions(scenario: Scenario) -> list[str]:
    context = scenario.store.context
    mappings = [*context.mappings, *optimizer_mappings(scenario)]
    return [
        *OPTIMIZER_ASSUMPTIONS,
        f"A donor route may take at most {_number(scenario.config.max_travel_hours)} hours (configurable; approved for the hackathon "
        "prototype); a longer route is rejected with TRAVEL_TIME_LIMIT_EXCEEDED.",
        context.protected_stock_assumption,
        DECISION_SUPPORT_ASSUMPTION,
        *(f"{item.name}: {item.rule.rstrip('.')} ({item.status.replace('_', ' ').lower()}; review: {item.review_owner})." for item in mappings),
    ]


def equity_block(config: OptimizerConfig) -> EquityGuardrailBlock:
    return EquityGuardrailBlock(
        formula=EQUITY_FORMULA,
        remoteness_weight=config.remoteness_weight,
        facility_type_uplift=dict(config.facility_type_uplift),
        default_type_uplift=config.default_type_uplift,
        warehouse_operational_reserve_share=config.warehouse_operational_reserve_share,
        excluded_donor_risk_labels=list(config.excluded_donor_risk_labels),
        max_travel_hours=config.max_travel_hours,
        donor_capacity_basis=RECEIVED_STOCK_ONLY,
        status=APPROVED_FOR_HACKATHON_PROTOTYPE,
        review_owner="Aaryan",
        validation_note=PROTOTYPE_VALIDATION_LIMITATION,
    )


def solver_block(result: AllocationResult, attempts: int) -> SolverBlock:
    stages = {stage.name: stage for stage in result.stages}
    return SolverBlock(
        name=SOLVER_NAME,
        algorithm=SOLVER_ALGORITHM,
        version=solver_version(),
        status=result.status,
        quantity_scale=QUANTITY_SCALE,
        objective_value=result.stages[0].value,
        objective_stages=[
            ObjectiveStageBlock(
                priority=stage.priority,
                name=stage.name,
                value=stages[stage.name].value,
                status=stages[stage.name].status,
                terms=[ObjectiveTermBlock(name=term.name, weight=term.weight, description=term.description) for term in stage.terms],
            )
            for stage in OBJECTIVE_STAGES
            if stage.name in stages
        ],
        attempts=attempts,
        hard_constraints=list(HARD_CONSTRAINTS),
    )


def deterministic_plan_id(scenario: Scenario, transfers: Sequence[PlannedTransfer]) -> str:
    """plan-<first 32 hex digits of SHA-256> over the request, the normalised transfers and the data context."""
    context = scenario.store.context
    payload = {
        "destinationFacilityId": scenario.destination.id,
        "medicineId": scenario.medicine.id,
        "requestedQuantity": f"{Decimal(scenario.requested) / QUANTITY_SCALE:.2f}",
        "horizonDays": scenario.horizon_days,
        "dataSource": context.data_source,
        "simulationDate": context.simulation_date.isoformat(),
        "asOfDate": scenario.store.as_of.isoformat(),
        "transfers": [
            [
                transfer.candidate.facility.id, str(transfer.batch_identifier), transfer.batch.batch_no,
                f"{Decimal(transfer.quantity) / QUANTITY_SCALE:.2f}", transfer.departure_day, transfer.arrival_day,
            ]
            for transfer in transfers
        ],
    }
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
    return f"plan-{digest[:32]}"


def rejection_summary(candidates: Sequence[Candidate], destination_id: str) -> str:
    counts = Counter(candidate.reasons[0][0] for candidate in candidates if candidate.reasons and candidate.facility.id != destination_id)
    return ", ".join(f"{count} {code}" for code, count in sorted(counts.items()))


def plan_rationale(
    scenario: Scenario, candidates: Sequence[Candidate], transfers: Sequence[PlannedTransfer], recipient: RecipientPlanBlock, simulation: SimulationResponse
) -> str:
    unit, destination = scenario.unit, scenario.destination
    selected = sorted((candidate for candidate in candidates if candidate.allocation), key=lambda item: (item.allocation.arrival_day, item.facility.id))
    donors = "; ".join(
        f"{candidate.facility.name} sends {_quantity(unscaled(candidate.allocation.total), unit)}, arriving on day {candidate.allocation.arrival_day}"
        for candidate in selected
    )
    sentences = [
        f"The plan supplies the requested {_quantity(unscaled(scenario.requested), unit)} of {describe_medicine(scenario.medicine)} to "
        f"{destination.name} from {len(selected)} donor{'s' if len(selected) != 1 else ''} in {len(transfers)} batch transfer(s): {donors}.",
        "Counting only stock already received, every donor keeps its protected safety stock plus the equity or operational reserve "
        "on every day from departure to the end of the horizon, none gains a shortage, and every route takes at most "
        f"{_number(scenario.config.max_travel_hours)} hours.",
    ]
    if recipient.stockout_day_before is None:
        sentences.append(f"{destination.name} had no projected stockout in the {scenario.horizon_days}-day horizon; the transfer adds buffer stock.")
    elif recipient.stockout_prevented:
        sentences.append(f"{destination.name} avoids the stockout projected on day {recipient.stockout_day_before}.")
    else:
        sentences.append(
            f"{destination.name} still runs short from day {recipient.stockout_day_after}; about "
            f"{_quantity(recipient.quantity_to_avoid_shortage, unit)} arriving on day 1 would be needed to avoid the projected shortage."
        )
    comparison = simulation.comparison
    sentences.append(
        f"The Ripple Simulator validated the complete plan: every transfer is eligible, no facility gains new risk, and regional "
        f"shortage days go from {comparison.regional_shortage_days_before} to {comparison.regional_shortage_days_after} "
        f"(unmet demand {_quantity(comparison.regional_unmet_demand_before, unit)} -> {_quantity(comparison.regional_unmet_demand_after, unit)})."
    )
    rejected = rejection_summary(candidates, destination.id)
    not_needed = sum(1 for candidate in candidates if candidate.eligible and candidate.allocation is None)
    if rejected or not_needed:
        sentences.append(f"Other candidates: {rejected or 'none rejected'}{f'; {not_needed} eligible but not needed' if not_needed else ''}.")
    sentences.append(DECISION_SUPPORT_ASSUMPTION)
    return " ".join(sentences)


def recipient_block(scenario: Scenario, result: SimulationResult) -> RecipientPlanBlock:
    state, before = scenario.recipient, scenario.recipient_baseline.projection
    after = result.intervention[scenario.destination.id].projection
    return RecipientPlanBlock(
        facility_id=scenario.destination.id,
        facility_name=scenario.destination.name,
        effective_stock=round(state.effective_stock, 2),
        predicted_daily_demand=state.demand,
        protected_stock=state.protected_stock,
        stockout_day_before=before.projected_stockout_day,
        stockout_day_after=after.projected_stockout_day,
        shortage_days_before=before.total_shortage_days,
        shortage_days_after=after.total_shortage_days,
        unmet_demand_before=round(before.unmet_demand, 2),
        unmet_demand_after=round(after.unmet_demand, 2),
        stockout_prevented=before.projected_stockout_day is not None and after.projected_stockout_day is None,
        quantity_to_avoid_shortage=quantity_to_avoid_shortage(scenario),
    )


def build_plan(
    scenario: Scenario,
    candidates: Sequence[Candidate],
    transfers: Sequence[PlannedTransfer],
    allocation: AllocationResult,
    attempts: int,
    result: SimulationResult,
    simulation: SimulationResponse,
    checks: Sequence[ValidationCheckBlock],
) -> PlanResponse:
    medicine, destination, unit = scenario.medicine, scenario.destination, scenario.unit
    recipient = recipient_block(scenario, result)
    return PlanResponse(
        id=deterministic_plan_id(scenario, transfers),
        status=PLAN_STATUS,
        medicine=SimulationMedicineBlock(
            id=medicine.id,
            generic_name=medicine.generic_name,
            strength=medicine.strength,
            dosage_form=medicine.dosage_form,
            unit=unit,
            criticality=medicine.criticality,
            requires_cold_chain=medicine.requires_cold_chain,
        ),
        destination_facility_id=destination.id,
        destination_facility_name=destination.name,
        requested_quantity=unscaled(scenario.requested),
        allocated_quantity=unscaled(sum(transfer.quantity for transfer in transfers)),
        unit=unit,
        horizon_days=scenario.horizon_days,
        solver=solver_block(allocation, attempts),
        transfers=[
            PlanTransferBlock(
                from_facility_id=transfer.candidate.facility.id,
                from_facility_name=transfer.candidate.facility.name,
                to_facility_id=destination.id,
                to_facility_name=destination.name,
                medicine_id=medicine.id,
                batch_id=transfer.batch_identifier,
                batch_no=transfer.batch.batch_no,
                expiry_date=transfer.batch.expiry_date,
                quantity=unscaled(transfer.quantity),
                unit=unit,
                departure_day=transfer.departure_day,
                arrival_day=transfer.arrival_day,
                arrival_date=scenario.day_date(transfer.arrival_day),
                distance_km=transfer.candidate.route.distance_km,
                travel_hours=transfer.candidate.route.travel_hours,
                cold_chain_available=transfer.candidate.route.cold_chain_capable,
            )
            for transfer in transfers
        ],
        recipient=recipient,
        candidates=[candidate_block(scenario, candidate) for candidate in candidates],
        equity_guardrail=equity_block(scenario.config),
        rationale=plan_rationale(scenario, candidates, transfers, recipient, simulation),
        validation=PlanValidationBlock(validator=f"Ripple Simulator {SIMULATOR_MODEL_VERSION}", passed=True, checks=list(checks)),
        assumptions=plan_assumptions(scenario),
        limitations=list(OPTIMIZER_LIMITATIONS),
        simulation=simulation,
        decision_support_only=True,
        requires_human_approval=True,
        data_context=plan_data_context(scenario, simulation),
        data_label=scenario.store.context.data_label,
        model_version=MODEL_VERSION,
    )


def recommended_escalation(scenario: Scenario, safe_capacity: int) -> list[str]:
    state, destination, medicine, unit = scenario.recipient, scenario.destination, scenario.medicine, scenario.unit
    items = []
    if medicine.requires_cold_chain and destination.has_cold_chain is False:
        items.append(f"{describe_medicine(medicine)} needs a cold chain and {destination.name} has no cold-chain storage: arrange cold-chain storage or an equipped delivery first.")
    for item in sorted(state.inventory.replenishments, key=lambda order: order.arrival_day):
        expected = item.expected_date or scenario.day_date(item.arrival_day)
        items.append(
            f"Ask the supplier to expedite the {item.status.lower()} replenishment of {_quantity(item.quantity, unit)} for {destination.name}, "
            f"currently expected on day {item.arrival_day} ({expected})."
        )
    if state.inventory.overdue_replenishments:
        items.append(
            f"Follow up the {state.inventory.overdue_replenishments} overdue replenishment order(s) for {destination.name} expected on or "
            f"before {scenario.store.context.simulation_date}."
        )
    if not state.inventory.replenishments:
        items.append(f"Raise an emergency replenishment order for {destination.name}; none is scheduled.")
    if 0 < safe_capacity < scenario.requested:
        items.append(
            f"A smaller request of up to {_quantity(unscaled(safe_capacity), unit)} can be planned from eligible donors now; it still needs human approval."
        )
    items.append(
        "Escalate to the district supply officer for emergency procurement from outside the region; the optimizer never creates stock "
        "or lowers a donor's protected stock to meet a request."
    )
    items.append("Any change of medicine or regimen is a clinical decision for a qualified clinician; the optimizer never substitutes medicines.")
    return items


def no_safe_plan_details(scenario: Scenario, candidates: Sequence[Candidate], status: str, attempts: int) -> NoSafePlanDetailsBlock:
    unit, destination = scenario.unit, scenario.destination
    considered = [candidate for candidate in candidates if candidate.facility.id != destination.id]
    eligible = [candidate for candidate in considered if candidate.eligible]
    rejected = [candidate for candidate in considered if not candidate.eligible]
    safe_capacity = sum(candidate.capacity for candidate in eligible)
    unmet = max(0, scenario.requested - safe_capacity)
    requested_text = _quantity(unscaled(scenario.requested), unit)
    if status == "INFEASIBLE" and unmet:
        explanation = (
            f"Eligible donors can safely send {_quantity(unscaled(safe_capacity), unit)} of the {requested_text} requested for "
            f"{destination.name}, leaving {_quantity(unscaled(unmet), unit)} that no donor can supply without breaking a safety rule."
        )
    elif status == "INFEASIBLE":
        explanation = f"No combination of eligible donors, batches and arrival days can deliver exactly {requested_text} to {destination.name} within the hard constraints."
    else:
        explanation = (
            f"The Ripple Simulator rejected every plan the solver proposed in {attempts} attempt(s), so no plan for {requested_text} to "
            f"{destination.name} is safe to recommend."
        )
    summary = rejection_summary(candidates, destination.id)
    if summary:
        explanation += f" Rejected candidates: {summary}."
    explanation += " No stock is created and no donor's protected stock is lowered to meet the request."
    return NoSafePlanDetailsBlock(
        requested_quantity=unscaled(scenario.requested),
        safe_capacity=unscaled(safe_capacity),
        unmet_quantity=unscaled(unmet),
        unit=unit,
        medicine_id=scenario.medicine.id,
        destination_facility_id=destination.id,
        horizon_days=scenario.horizon_days,
        solver_status=status,
        attempts=attempts,
        candidates_considered=len(considered),
        eligible_candidates=[candidate_block(scenario, candidate) for candidate in eligible],
        rejected_candidates=[candidate_block(scenario, candidate) for candidate in rejected],
        recommended_escalation=[*recommended_escalation(scenario, safe_capacity), *donor_rule_escalation(scenario, rejected)],
        explanation=explanation,
        equity_guardrail=equity_block(scenario.config),
        decision_support_only=True,
        data_context=plan_data_context(scenario),
    )


def donor_rule_escalation(scenario: Scenario, rejected: Sequence[Candidate]) -> list[str]:
    """Name the donors held back by the reviewed rules; no rule is relaxed to meet a request."""
    items = []
    too_far = [candidate.facility.id for candidate in rejected if any(code == TRAVEL_TIME_LIMIT_EXCEEDED for code, _ in candidate.reasons)]
    if too_far:
        items.append(
            f"{', '.join(too_far)} {'is' if len(too_far) == 1 else 'are'} beyond the {_number(scenario.config.max_travel_hours)}-hour "
            "route limit; a longer transfer would need logistics and clinical approval outside this prototype and is not proposed."
        )
    # Only donors held back by capacity alone: a delivery cannot fix a long route, a missing cold chain or a HIGH risk.
    waiting = [
        candidate.facility.id
        for candidate in rejected
        if candidate.excluded_replenishments and {code for code, _ in candidate.reasons} == {NO_SAFE_DONOR_CAPACITY}
    ]
    if waiting:
        items.append(
            f"{', '.join(waiting)} could be reassessed after their scheduled or delayed deliveries are received; future stock is "
            "never counted toward donor capacity."
        )
    return items


def run_optimization(
    store: SimulatedDataStore,
    request: OptimizeRequest,
    config: OptimizerConfig = DEFAULT_OPTIMIZER_CONFIG,
    risk_config: RiskConfig = DEFAULT_RISK_CONFIG,
) -> PlanResponse:
    """POST /plans/optimize: propose a safe plan validated by the Ripple Simulator, or raise NoSafePlanError. Never writes."""
    scenario = resolve_scenario(store, request, config, risk_config)
    candidates = assess_candidates(scenario)
    recipient = recipient_input(scenario)
    forbidden: list[frozenset[str]] = []
    status, attempts = "INFEASIBLE", 0
    while attempts < config.max_attempts:
        attempts += 1
        for candidate in candidates:
            candidate.allocation = None
        allocation = solve_allocation(
            donor_inputs(scenario, candidates), recipient, scenario.requested, scenario.step, forbidden, config.max_deterministic_time
        )
        if allocation is None:
            break
        transfers = plan_transfers(candidates, allocation)
        proposed = [
            ProposedTransfer(transfer.candidate.facility.id, scenario.destination.id, scenario.medicine.id, unscaled(transfer.quantity), transfer.arrival_day)
            for transfer in transfers
        ]
        result = simulate(store, proposed, scenario.horizon_days, risk_config, scenario.config.max_travel_hours)
        simulation = build_simulation_response(result)
        checks = validation_checks(scenario, transfers, result, simulation)
        if all(item.passed for item in checks):
            return build_plan(scenario, candidates, transfers, allocation, attempts, result, simulation, checks)
        status = "VALIDATION_FAILED"
        if not reject_failing_donors(candidates, transfers, result, simulation):
            forbidden.append(frozenset(transfer.candidate.facility.id for transfer in transfers))
    for candidate in candidates:
        candidate.allocation = None
    raise NoSafePlanError(no_safe_plan_details(scenario, candidates, status, attempts))
