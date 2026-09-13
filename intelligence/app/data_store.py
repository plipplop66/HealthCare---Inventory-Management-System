"""In-memory data model read by the intelligence engine, plus the offline Navjeevan PHC fixture.

SimulatedDataStore holds one snapshot of facilities, medicines, inventory, transport routes and daily consumption.
It is filled from the fixture below (DATA_SOURCE=fixture) or by app/mysql_store.py from Dhiren's
MySQL database (DATA_SOURCE=mysql). The forecast, projection and risk engine only reads this
structure, so both data sources run exactly the same calculations.

EVERYTHING IN THE FIXTURE IS SIMULATED PROTOTYPE DATA. Facility, medicine and inventory values
follow the Navjeevan PHC golden scenario of the Node fixture (backend/src/fixture-store.js).
Daily consumption history is read from data/simulated_consumption.csv.
"""

from __future__ import annotations

import csv
import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path
from typing import Any

DATA_LABEL = "SIMULATED_PROTOTYPE"
# Fixed snapshot date keeps every forecast reproducible regardless of the wall clock.
AS_OF_DATE = date(2026, 9, 1)
HISTORY_DAYS = 60
DEFAULT_CONSUMPTION_CSV = Path(__file__).resolve().parents[1] / "data" / "simulated_consumption.csv"
REQUIRED_CSV_COLUMNS = ("date", "facility_id", "medicine_id", "units_consumed")
MISSING_MARKERS = frozenset({"", "NA", "N/A", "NULL", "NONE"})

# Where a snapshot's protected stock comes from.
PROTECTED_STOCK_FROM_PROTECTED_DAYS = "FORECAST_X_PROTECTED_DAYS"
PROTECTED_STOCK_RECORDED = "FACILITY_SAFETY_STOCK"
PROTECTED_STOCK_NOT_RECORDED = "NOT_RECORDED_TREATED_AS_ZERO"

# Which other facilities count when measuring regional fragility.
PEERS_IN_DISTRICT = "DISTRICT"
PEERS_ALL_FACILITIES = "ALL_FACILITIES"


@dataclass(frozen=True)
class Medicine:
    id: str
    generic_name: str
    strength: str
    dosage_form: str
    unit: str
    criticality: str
    storage: str
    # Whether storage and transport need a cold chain; None when the data source did not load it.
    requires_cold_chain: bool | None = None


@dataclass(frozen=True)
class Facility:
    id: str
    name: str
    type: str
    district: str
    # Scale used by the risk score: 0 (central) to 1 (most remote).
    remoteness_score: float
    # Days of forecast demand kept as protected stock; None when the data source records protected stock directly.
    protected_days: int | None
    # Remoteness exactly as stored by the data source, before scaling (None for the fixture).
    source_remoteness_score: float | None = None
    # Whether the facility has cold-chain storage; None when the data source did not load it.
    has_cold_chain: bool | None = None


@dataclass(frozen=True)
class Batch:
    batch_no: str
    quantity: float
    expiry_date: date
    status: str

    def is_usable_on(self, day: date) -> bool:
        return self.status == "USABLE" and self.expiry_date >= day


@dataclass(frozen=True)
class Replenishment:
    quantity: float
    arrival_day: int
    status: str = "EXPECTED"
    # Calendar date of arrival when the data source records one.
    expected_date: date | None = None


@dataclass(frozen=True)
class Route:
    """A directed transport route between two facilities."""

    origin_id: str
    destination_id: str
    distance_km: float
    travel_hours: float
    cold_chain_capable: bool


@dataclass(frozen=True)
class InventorySnapshot:
    facility_id: str
    medicine_id: str
    batches: tuple[Batch, ...]
    replenishments: tuple[Replenishment, ...] = ()
    # Protected stock recorded by the data source; None means forecast daily demand x protected days.
    protected_stock: float | None = None
    protected_stock_source: str = PROTECTED_STOCK_FROM_PROTECTED_DAYS
    protected_stock_confirmed: bool | None = None
    # Open orders whose expected date has passed without arriving; they are reported, not projected.
    overdue_replenishments: int = 0

    @property
    def recorded_stock(self) -> float:
        return sum(batch.quantity for batch in self.batches)

    def effective_stock(self, as_of: date) -> float:
        """Usable, unexpired stock only - the quantity that can actually be dispensed."""
        return sum(batch.quantity for batch in self.batches if batch.is_usable_on(as_of))


@dataclass(frozen=True)
class ConsumptionRecord:
    day: date
    units: float | None
    issue: str | None = None


@dataclass(frozen=True)
class DataMapping:
    """How one data-source field is interpreted for the engine."""

    name: str
    source: str
    rule: str
    review_owner: str
    status: str = "PROVISIONAL"


@dataclass(frozen=True)
class DataContext:
    """Where a snapshot came from; reported with every forecast."""

    data_source: str
    description: str
    simulation_date: date
    protected_stock_assumption: str
    data_label: str = DATA_LABEL
    mappings: tuple[DataMapping, ...] = ()
    notes: tuple[str, ...] = ()


INSULIN_ID = "med-insulin-100iu-vial"

MEDICINES: dict[str, Medicine] = {
    INSULIN_ID: Medicine(
        id=INSULIN_ID,
        generic_name="Human insulin",
        strength="100 IU/mL",
        dosage_form="10 mL vial",
        unit="vial",
        criticality="HIGH",
        storage="2-8 C",
        requires_cold_chain=True,
    ),
}

# Cold-chain flags follow backend/src/fixture-store.js, which treats every fixture facility as cold-chain capable.
FACILITIES: dict[str, Facility] = {
    facility.id: facility
    for facility in (
        Facility("facility-central-store", "Central District Store", "WAREHOUSE", "Medripple District", 0.05, 14, has_cold_chain=True),
        Facility("facility-district-hospital", "District Hospital", "DISTRICT_HOSPITAL", "Medripple District", 0.15, 10, has_cold_chain=True),
        Facility("facility-river-chc", "River CHC", "CHC", "Medripple District", 0.55, 10, has_cold_chain=True),
        Facility("facility-navjeevan-phc", "Navjeevan PHC", "PHC", "Medripple District", 0.8, 14, has_cold_chain=True),
    )
}

# The three simulated routes of backend/src/fixture-store.js, all into Navjeevan PHC; no other pair has a route.
ROUTES: dict[tuple[str, str], Route] = {
    (route.origin_id, route.destination_id): route
    for route in (
        Route("facility-central-store", "facility-navjeevan-phc", 22.0, 1.2, True),
        Route("facility-river-chc", "facility-navjeevan-phc", 14.0, 0.8, True),
        Route("facility-district-hospital", "facility-navjeevan-phc", 18.0, 1.0, True),
    )
}

INVENTORY: dict[tuple[str, str], InventorySnapshot] = {
    (snapshot.facility_id, snapshot.medicine_id): snapshot
    for snapshot in (
        InventorySnapshot(
            "facility-central-store",
            INSULIN_ID,
            (
                Batch("INS-CS-2401", 600, date(2027, 1, 31), "USABLE"),
                Batch("INS-CS-2402", 300, date(2027, 4, 30), "USABLE"),
            ),
        ),
        InventorySnapshot(
            "facility-district-hospital",
            INSULIN_ID,
            (Batch("INS-DH-2403", 260, date(2026, 12, 31), "USABLE"),),
        ),
        InventorySnapshot(
            "facility-river-chc",
            INSULIN_ID,
            (Batch("INS-RC-2404", 100, date(2026, 11, 30), "USABLE"),),
        ),
        InventorySnapshot(
            "facility-navjeevan-phc",
            INSULIN_ID,
            (
                Batch("INS-NP-2405", 22, date(2026, 10, 31), "USABLE"),
                Batch("INS-NP-OLD", 5, date(2026, 1, 31), "EXPIRED"),
            ),
            (Replenishment(quantity=100, arrival_day=8),),
        ),
    )
}

FIXTURE_CONTEXT = DataContext(
    data_source="FIXTURE",
    description="simulated dataset",
    simulation_date=AS_OF_DATE,
    protected_stock_assumption=(
        "Protected stock = forecast daily demand x the facility's protected days (provisional rule pending safety review)."
    ),
)


def parse_units(raw: Any) -> tuple[float | None, str | None]:
    """Parse one consumption value. Unusable values become None with an issue code."""
    text = "" if raw is None else str(raw).strip()
    if text.upper() in MISSING_MARKERS:
        return None, "MISSING"
    try:
        value = float(text)
    except ValueError:
        return None, "NOT_A_NUMBER"
    if not math.isfinite(value):
        return None, "NOT_A_NUMBER"
    if value < 0:
        return None, "NEGATIVE"
    return value, None


def daily_records(
    raw_by_day: Mapping[date, Sequence[Any]],
    as_of: date,
    history_days: int = HISTORY_DAYS,
) -> list[ConsumptionRecord]:
    """One record per calendar day in the history_days before as_of, oldest first.

    Absent days are MISSING; days reported more than once are DUPLICATE_DATE
    because the conflicting values cannot be reconciled automatically.
    """
    start = as_of - timedelta(days=history_days)
    records = []
    for offset in range(history_days):
        day = start + timedelta(days=offset)
        raw_values = raw_by_day.get(day, [])
        if not raw_values:
            records.append(ConsumptionRecord(day, None, "MISSING"))
        elif len(raw_values) > 1:
            records.append(ConsumptionRecord(day, None, "DUPLICATE_DATE"))
        else:
            units, issue = parse_units(raw_values[0])
            records.append(ConsumptionRecord(day, units, issue))
    return records


class SimulatedDataStore:
    """Read-only access to one snapshot of facilities, inventory and consumption history."""

    def __init__(
        self,
        consumption_rows: Iterable[Mapping[str, Any]],
        *,
        as_of: date = AS_OF_DATE,
        history_days: int = HISTORY_DAYS,
        medicines: Mapping[str, Medicine] = MEDICINES,
        facilities: Mapping[str, Facility] = FACILITIES,
        inventory: Mapping[tuple[str, str], InventorySnapshot] = INVENTORY,
        context: DataContext = FIXTURE_CONTEXT,
        peer_scope: str = PEERS_IN_DISTRICT,
        facility_aliases: Mapping[str, str] | None = None,
        medicine_aliases: Mapping[str, str] | None = None,
        routes: Mapping[tuple[str, str], Route] | None = ROUTES,
    ) -> None:
        if peer_scope not in (PEERS_IN_DISTRICT, PEERS_ALL_FACILITIES):
            raise ValueError(f"peer_scope must be {PEERS_IN_DISTRICT} or {PEERS_ALL_FACILITIES}.")
        self.as_of = as_of
        self.history_days = history_days
        self.medicines = dict(medicines)
        self.facilities = dict(facilities)
        self.inventory = dict(inventory)
        # None means the data source did not load routes (the MySQL forecast path does not need them).
        self.routes = None if routes is None else dict(routes)
        self.context = context
        self.peer_scope = peer_scope
        self.facility_aliases = dict(facility_aliases or {})
        self.medicine_aliases = dict(medicine_aliases or {})
        self.rejected_rows = 0
        self._raw_units: dict[tuple[str, str], dict[date, list[Any]]] = {}
        for row in consumption_rows:
            try:
                day = date.fromisoformat((row.get("date") or "").strip())
            except ValueError:
                self.rejected_rows += 1
                continue
            key = ((row.get("facility_id") or "").strip(), (row.get("medicine_id") or "").strip())
            self._raw_units.setdefault(key, {}).setdefault(day, []).append(row.get("units_consumed"))

    @classmethod
    def from_csv(cls, path: Path | str = DEFAULT_CONSUMPTION_CSV, **options) -> SimulatedDataStore:
        """Load consumption rows from CSV, skipping '#' comment lines."""
        with open(path, newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(line for line in handle if not line.startswith("#"))
            missing = [column for column in REQUIRED_CSV_COLUMNS if column not in (reader.fieldnames or [])]
            if missing:
                raise ValueError(f"{path} is missing required columns: {', '.join(missing)}.")
            return cls(list(reader), **options)

    @property
    def history_window(self) -> tuple[date, date]:
        """First and last calendar day of the consumption history (the last is the day before as_of)."""
        return self.as_of - timedelta(days=self.history_days), self.as_of - timedelta(days=1)

    def get_facility(self, facility_id: str) -> Facility | None:
        """Look up by ID, or by an alias the data source registered (for example a numeric database ID)."""
        return self.facilities.get(facility_id) or self.facilities.get(self.facility_aliases.get(facility_id, ""))

    def get_medicine(self, medicine_id: str) -> Medicine | None:
        return self.medicines.get(medicine_id) or self.medicines.get(self.medicine_aliases.get(medicine_id, ""))

    def get_inventory(self, facility_id: str, medicine_id: str) -> InventorySnapshot | None:
        return self.inventory.get((facility_id, medicine_id))

    def get_route(self, origin_id: str, destination_id: str) -> Route | None:
        """The directed route between two facilities (IDs or aliases); None when there is none or routes were not loaded."""
        origin, destination = self.get_facility(origin_id), self.get_facility(destination_id)
        if self.routes is None or origin is None or destination is None:
            return None
        return self.routes.get((origin.id, destination.id))

    def regional_peers(self, facility: Facility, medicine_id: str) -> list[Facility]:
        """Other facilities holding the medicine: in the same district, or anywhere when peer_scope is ALL_FACILITIES."""
        return [
            other
            for other in self.facilities.values()
            if other.id != facility.id
            and (self.peer_scope == PEERS_ALL_FACILITIES or other.district == facility.district)
            and (other.id, medicine_id) in self.inventory
        ]

    def has_consumption_records(self, facility_id: str, medicine_id: str) -> bool:
        """Whether any consumption row, valid or not, exists for the pair inside the history window."""
        start, end = self.history_window
        return any(start <= day <= end for day in self._raw_units.get((facility_id, medicine_id), {}))

    def consumption_history(self, facility_id: str, medicine_id: str) -> list[ConsumptionRecord]:
        """One record per calendar day in the history window, oldest first (see daily_records)."""
        return daily_records(self._raw_units.get((facility_id, medicine_id), {}), self.as_of, self.history_days)
