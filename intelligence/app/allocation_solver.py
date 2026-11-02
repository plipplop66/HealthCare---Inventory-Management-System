"""Integer allocation model for the transfer optimizer, solved with Google OR-Tools CP-SAT.

The model knows nothing about facilities or medicines. app/optimizer.py passes donors, their batches, arrival options
and safe capacities, and the recipient's projection inputs, all as integers in hundredths of the medicine's unit
(QUANTITY_SCALE = 100). DECIMAL(12,2) quantities are therefore exact and nothing is rounded; medicines counted in whole
units move in steps of 100.

Decision variables, per donor d:
- batch_units[d][b]   how much batch b sends (one transfer instruction per batch used)
- arrives[d][o]       whether donor d delivers on arrival option o (at most one option per donor)
- sent[d][o]          the quantity arriving through option o
- headroom[d][o]      parts per million of option o's safe capacity that is sent
The recipient's day-by-day stock, unmet demand and shortage days follow app/stock_projection.py exactly: deliveries
and replenishments arrive at the start of the day and stock is floored at zero.

Hard constraints:
- the requested quantity is sent exactly;
- no donor sends more than its safe capacity for the chosen arrival day;
- no batch sends more than it holds;
- a batch is used only when every earlier-expiring batch of that donor is used in full (FEFO).

The objective is optimised in lexicographic stages. Each stage's optimum is fixed as a constraint before the next
stage, so shortage always outranks donor protection, which always outranks logistics:
1. RECIPIENT_SHORTAGE = 31 x unmet demand (hundredths) + 1 x shortage days
2. DONOR_PROTECTION   = sum over donors of headroom used (parts per million) x (100 + equity index)
3. LOGISTICS          = 10^10 x arrival days + 1000 x distance (tenths of a km) + 1 x (donors + transfer instructions)

The search is deterministic: one worker, a fixed seed and a deterministic (not wall-clock) time limit.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

QUANTITY_SCALE = 100
# Headroom is measured in parts per million of a donor's safe capacity (rounded up). A coarser unit lets rounding tie
# a clean split with one that takes slightly more from the donor with less headroom.
HEADROOM_SCALE = 1_000_000
MAX_HORIZON_DAYS = 30
RANDOM_SEED = 0

# One hundredth of unmet demand outweighs every shortage day of the longest horizon.
UNMET_DEMAND_WEIGHT = MAX_HORIZON_DAYS + 1
SHORTAGE_DAY_WEIGHT = 1
# Headroom used costs 100 per part per million; a donor's equity index (0 for a central warehouse) is added to that weight.
HEADROOM_WEIGHT = 100
EQUITY_WEIGHT = 1
ARRIVAL_DAY_WEIGHT = 10**10
DISTANCE_WEIGHT = 1_000
TRANSFER_WEIGHT = 1
# Bounds that keep each logistics term dominant over the terms after it.
MAX_TRANSFER_TERMS = DISTANCE_WEIGHT - 1
MAX_TOTAL_DISTANCE_TENTHS = ARRIVAL_DAY_WEIGHT // DISTANCE_WEIGHT - 1


class SolverUnavailableError(RuntimeError):
    """OR-Tools is not installed (reported as 503)."""


@dataclass(frozen=True)
class ObjectiveTerm:
    name: str
    weight: int
    description: str


@dataclass(frozen=True)
class ObjectiveStage:
    priority: int
    name: str
    terms: tuple[ObjectiveTerm, ...]


OBJECTIVE_STAGES = (
    ObjectiveStage(1, "RECIPIENT_SHORTAGE", (
        ObjectiveTerm(
            "recipientUnmetDemand", UNMET_DEMAND_WEIGHT,
            "Projected unmet demand at the recipient in hundredths of the unit; the weight exceeds the 30 possible shortage days.",
        ),
        ObjectiveTerm("recipientShortageDays", SHORTAGE_DAY_WEIGHT, "Projected days with unmet demand at the recipient."),
    )),
    ObjectiveStage(2, "DONOR_PROTECTION", (
        ObjectiveTerm(
            "donorHeadroomUsed", HEADROOM_WEIGHT,
            "Parts per million of each donor's safe capacity that is sent, summed over donors: donors that keep more headroom are preferred.",
        ),
        ObjectiveTerm(
            "remoteDonorEquityImpact", EQUITY_WEIGHT,
            "The same parts per million multiplied by the donor's equity index (100 x equity uplift): rural and remote donors cost more.",
        ),
    )),
    ObjectiveStage(3, "LOGISTICS", (
        ObjectiveTerm("arrivalDays", ARRIVAL_DAY_WEIGHT, "Arrival day of each donor's delivery, summed: earlier arrival first."),
        ObjectiveTerm("distanceTenthsKm", DISTANCE_WEIGHT, "Route distance of each donor used, in tenths of a km: shorter routes next."),
        ObjectiveTerm("donorsAndTransfers", TRANSFER_WEIGHT, "Donor facilities plus transfer instructions (one per batch): fewer last."),
    )),
)

HARD_CONSTRAINTS = (
    "The requested quantity is allocated exactly; no stock is created.",
    "No donor sends more than its safe capacity for the chosen arrival day, so it keeps its retained floor on every day "
    "from departure to the end of the horizon and gains no shortage.",
    "No batch sends more than its usable quantity, only batches in date until the end of the horizon are used, and a "
    "donor's batches are used earliest expiry first.",
    "Each donor delivers once, on an arrival day within the horizon and no later than the recipient's projected stockout day.",
    "Medicines counted in whole units move in whole units.",
)


@dataclass(frozen=True)
class DonorOption:
    arrival_day: int
    departure_day: int
    # Safe capacity for this departure day, in hundredths.
    capacity: int


@dataclass(frozen=True)
class DonorInput:
    key: str
    # Usable quantity of each batch in hundredths, earliest expiry first.
    batch_capacities: tuple[int, ...]
    options: tuple[DonorOption, ...]
    equity_index: int
    distance_tenths_km: int


@dataclass(frozen=True)
class RecipientInput:
    opening_stock: int
    daily_demand: int
    # Scheduled replenishment by projection day, in hundredths.
    replenishments: Mapping[int, int]
    horizon_days: int


@dataclass(frozen=True)
class StageResult:
    priority: int
    name: str
    value: int
    status: str


@dataclass(frozen=True)
class DonorAllocation:
    key: str
    arrival_day: int
    departure_day: int
    # Hundredths sent from each batch, in the donor's batch order.
    batch_quantities: tuple[int, ...]

    @property
    def total(self) -> int:
        return sum(self.batch_quantities)


@dataclass(frozen=True)
class AllocationResult:
    allocations: tuple[DonorAllocation, ...]
    stages: tuple[StageResult, ...]
    recipient_unmet_demand: int
    recipient_shortage_days: int

    @property
    def status(self) -> str:
        return "OPTIMAL" if all(stage.status == "OPTIMAL" for stage in self.stages) else "FEASIBLE"


def solver_version() -> str:
    try:
        import ortools
    except ImportError as error:
        raise SolverUnavailableError("OR-Tools is not installed; run pip install -r requirements.txt.") from error
    return ortools.__version__


def solve_allocation(
    donors: Sequence[DonorInput],
    recipient: RecipientInput,
    requested: int,
    step: int,
    forbidden_donor_sets: Sequence[frozenset[str]] = (),
    max_deterministic_time: float = 10.0,
) -> AllocationResult | None:
    """Allocate the requested quantity (hundredths) across donors. Returns None when no allocation satisfies the hard constraints.

    forbidden_donor_sets lists donor combinations that the Ripple Simulator rejected; at least one donor of each set is left out.
    """
    try:
        from ortools.sat.python import cp_model
    except ImportError as error:
        raise SolverUnavailableError("OR-Tools is not installed; run pip install -r requirements.txt.") from error
    if requested <= 0 or step < 1 or requested % step:
        raise ValueError("requested must be a positive multiple of step.")
    if not 1 <= recipient.horizon_days <= MAX_HORIZON_DAYS:
        raise ValueError(f"horizon_days must be between 1 and {MAX_HORIZON_DAYS}.")
    donors = [donor for donor in donors if donor.options and donor.batch_capacities]
    if not donors:
        return None
    if len(donors) + sum(len(donor.batch_capacities) for donor in donors) > MAX_TRANSFER_TERMS:
        raise ValueError(f"At most {MAX_TRANSFER_TERMS} donors plus batches can be allocated in one request.")
    if sum(donor.distance_tenths_km for donor in donors) > MAX_TOTAL_DISTANCE_TENTHS:
        raise ValueError("Total route distance is too large for the logistics weights.")

    model = cp_model.CpModel()
    variables = []
    batch_units: list[list[tuple[object, int]]] = []
    option_arrives: list[list[object]] = []
    arrivals_by_day: dict[int, list[object]] = {}
    donor_arrival_flags: dict[str, list[object]] = {}
    sent_totals, protection, arrival_terms, distance_terms, transfer_terms = [], [], [], [], []

    for index, donor in enumerate(donors):
        sent = model.new_int_var(0, max(option.capacity for option in donor.options), f"sent_{index}")
        units = []
        for position, capacity in enumerate(donor.batch_capacities):
            whole = capacity // step
            count = model.new_int_var(0, whole, f"batch_{index}_{position}")
            uses = model.new_bool_var(f"uses_batch_{index}_{position}")
            model.add(count >= 1).only_enforce_if(uses)
            model.add(count == 0).only_enforce_if(~uses)
            units.append((count, whole))
            variables.extend((count, uses))
            transfer_terms.append(uses)
        for position in range(len(units) - 1):
            full = model.new_bool_var(f"batch_full_{index}_{position}")
            model.add(units[position][0] == units[position][1]).only_enforce_if(full)
            model.add(units[position + 1][0] == 0).only_enforce_if(~full)
            variables.append(full)
        model.add(sum(step * count for count, _ in units) == sent)

        flags, quantities = [], []
        for option in donor.options:
            arrives = model.new_bool_var(f"arrives_{index}_day_{option.arrival_day}")
            quantity = model.new_int_var(0, option.capacity, f"sent_{index}_day_{option.arrival_day}")
            headroom = model.new_int_var(0, HEADROOM_SCALE, f"headroom_{index}_day_{option.arrival_day}")
            model.add(quantity <= option.capacity * arrives)
            model.add(quantity >= step).only_enforce_if(arrives)
            model.add(HEADROOM_SCALE * quantity <= option.capacity * headroom)
            variables.extend((arrives, quantity, headroom))
            flags.append(arrives)
            quantities.append(quantity)
            arrivals_by_day.setdefault(option.arrival_day, []).append(quantity)
            protection.append((HEADROOM_WEIGHT + EQUITY_WEIGHT * donor.equity_index) * headroom)
            arrival_terms.append(option.arrival_day * arrives)
            distance_terms.append(donor.distance_tenths_km * arrives)
            transfer_terms.append(arrives)
        model.add_at_most_one(flags)
        model.add(sum(quantities) == sent)
        variables.append(sent)
        sent_totals.append(sent)
        batch_units.append(units)
        option_arrives.append(flags)
        donor_arrival_flags[donor.key] = flags

    model.add(sum(sent_totals) == requested)
    for forbidden in forbidden_donor_sets:
        if forbidden and forbidden <= donor_arrival_flags.keys():
            model.add(sum(flag for key in sorted(forbidden) for flag in donor_arrival_flags[key]) <= len(forbidden) - 1)

    demand = recipient.daily_demand
    upper = recipient.opening_stock + sum(recipient.replenishments.values()) + requested
    zero = model.new_constant(0)
    previous = recipient.opening_stock
    unmet_terms, shortage_terms = [], []
    for day in range(1, recipient.horizon_days + 1):
        available = previous + recipient.replenishments.get(day, 0) + sum(arrivals_by_day.get(day, []))
        balance = model.new_int_var(-demand, upper, f"balance_day_{day}")
        model.add(balance == available - demand)
        closing = model.new_int_var(0, upper, f"closing_day_{day}")
        model.add_max_equality(closing, [balance, zero])
        unmet = model.new_int_var(0, demand, f"unmet_day_{day}")
        model.add(unmet == closing - balance)
        short = model.new_bool_var(f"short_day_{day}")
        model.add(unmet >= 1).only_enforce_if(short)
        model.add(unmet == 0).only_enforce_if(~short)
        variables.extend((balance, closing, unmet, short))
        unmet_terms.append(unmet)
        shortage_terms.append(short)
        previous = closing

    expressions = (
        UNMET_DEMAND_WEIGHT * sum(unmet_terms) + SHORTAGE_DAY_WEIGHT * sum(shortage_terms),
        sum(protection),
        ARRIVAL_DAY_WEIGHT * sum(arrival_terms) + DISTANCE_WEIGHT * sum(distance_terms) + TRANSFER_WEIGHT * sum(transfer_terms),
    )

    solver = cp_model.CpSolver()
    solver.parameters.num_workers = 1
    solver.parameters.random_seed = RANDOM_SEED
    solver.parameters.max_deterministic_time = max_deterministic_time

    def extract() -> AllocationResult:
        allocations = []
        for index, donor in enumerate(donors):
            quantities = tuple(step * solver.value(count) for count, _ in batch_units[index])
            if not sum(quantities):
                continue
            option = next(option for option, flag in zip(donor.options, option_arrives[index]) if solver.boolean_value(flag))
            allocations.append(DonorAllocation(donor.key, option.arrival_day, option.departure_day, quantities))
        return AllocationResult(
            allocations=tuple(allocations),
            stages=tuple(stages),
            recipient_unmet_demand=sum(solver.value(unmet) for unmet in unmet_terms),
            recipient_shortage_days=sum(solver.boolean_value(short) for short in shortage_terms),
        )

    stages: list[StageResult] = []
    best = None
    for stage, expression in zip(OBJECTIVE_STAGES, expressions):
        model.minimize(expression)
        status = solver.solve(model)
        if status == cp_model.MODEL_INVALID:
            raise ValueError(f"The allocation model is invalid: {model.validate()}")
        if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            # INFEASIBLE, or no solution within the deterministic limit. A later stage keeps the previous stage's plan.
            break
        value = round(solver.objective_value)
        stages.append(StageResult(stage.priority, stage.name, value, "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE"))
        best = extract()
        model.add(expression <= value)
        model.clear_hints()
        for variable in variables:
            model.add_hint(variable, solver.value(variable))
    return best

