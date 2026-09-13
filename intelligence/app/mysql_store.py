"""Read-only MySQL data source for the intelligence service (DATA_SOURCE=mysql).

Reads Dhiren's schema (database/schema.sql) and normalises the rows into the structures the offline
fixture already uses (SimulatedDataStore, Facility, Medicine, InventorySnapshot, Batch, Replenishment
and daily consumption rows), so POST /forecast runs the unchanged forecast, projection and risk engine.
This module holds no forecasting, projection or risk logic, never writes to the database and never
falls back to fixture data.

Quantities stay in each medicine's base unit (mg, mL or count) with their decimals; nothing is converted.
The interpretation rules are listed in database_mappings() and returned with every forecast.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, contextmanager
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from .config import Settings
from .data_store import (
    HISTORY_DAYS,
    PEERS_ALL_FACILITIES,
    PROTECTED_STOCK_NOT_RECORDED,
    PROTECTED_STOCK_RECORDED,
    Batch,
    DataContext,
    DataMapping,
    Facility,
    InventorySnapshot,
    Medicine,
    Replenishment,
    SimulatedDataStore,
)

DATA_SOURCE_NAME = "MYSQL"
DESCRIPTION = "MEDRIPPLE MySQL database"
BASE_UNITS = ("mg", "mL", "count")
CRITICALITY_LEVELS = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
# database/schema.sql: facilities.remoteness_score runs from 0 (urban) to 10 (very remote); the engine uses 0-1.
REMOTENESS_SCALE_MAX = 10.0
# Open orders are projected on their expected date. ARRIVED stock is already in inventory; CANCELLED never arrives.
PROJECTED_REPLENISHMENT_STATUSES = ("SCHEDULED", "DELAYED")
# docs/api-contract.md keeps the fixture insulin ID accepted in MySQL mode. It resolves to one exact medicine
# identity (generic name, strength, strength unit, form), the same lookup database/golden-scenario.sql uses.
MEDICINE_ALIASES: Mapping[str, tuple[str, Decimal, str, str]] = {
    "med-insulin-100iu-vial": ("Human Insulin", Decimal("100"), "IU/mL", "Vial"),
}
READ_TIMEOUT_SECONDS = 10

Row = Mapping[str, Any]
QueryRunner = Callable[[str, Sequence[Any]], list[Row]]
Connector = Callable[[], AbstractContextManager[QueryRunner]]

MEDICINES_SQL = """
SELECT medicine_id, generic_name, strength_value, strength_unit, form, base_unit,
       storage_temp_min_c, storage_temp_max_c, criticality_level
FROM medicines
ORDER BY medicine_id
"""

FACILITIES_SQL = """
SELECT facility_id, facility_code, name, facility_type, region, remoteness_score
FROM facilities
ORDER BY facility_id
"""

INVENTORY_SQL = """
SELECT i.facility_id, b.batch_number, i.quantity_on_hand, i.status, b.expiry_date, b.quarantined
FROM inventory i
JOIN batches b ON b.batch_id = i.batch_id
WHERE b.medicine_id = %s
ORDER BY i.facility_id, b.expiry_date, b.batch_id
"""

SAFETY_STOCK_SQL = """
SELECT facility_id, safety_stock_qty, confirmed_by_aaryan
FROM facility_safety_stock
WHERE medicine_id = %s
"""

REPLENISHMENTS_SQL = """
SELECT facility_id, quantity, expected_arrival_date, status
FROM replenishments
WHERE medicine_id = %s
ORDER BY facility_id, expected_arrival_date, replenishment_id
"""

CONSUMPTION_SQL = """
SELECT facility_id, consumption_date, quantity_consumed
FROM consumption
WHERE medicine_id = %s AND consumption_date BETWEEN %s AND %s
ORDER BY facility_id, consumption_date
"""


class DatabaseUnavailableError(RuntimeError):
    """MySQL could not be reached or queried (reported as 503). The fixture is never used instead."""


class DatabaseDataError(RuntimeError):
    """A database value falls outside the schema contract (reported as 500)."""


def pymysql_connector(settings: Settings) -> Connector:
    """One read-only PyMySQL connection per forecast request."""
    target = f"{settings.database_host}:{settings.database_port}/{settings.database_name}"

    @contextmanager
    def connect() -> Iterator[QueryRunner]:
        try:
            import pymysql  # imported here so fixture mode and the unit tests never need the driver
            from pymysql.cursors import DictCursor
        except ImportError as error:
            raise DatabaseUnavailableError("The PyMySQL driver is not installed; run pip install -r requirements.txt.") from error
        driver_errors = (pymysql.MySQLError, OSError)
        try:
            connection = pymysql.connect(
                host=settings.database_host,
                port=settings.database_port,
                user=settings.database_user,
                password=settings.database_password,
                database=settings.database_name,
                charset="utf8mb4",
                cursorclass=DictCursor,
                connect_timeout=settings.database_connect_timeout_seconds,
                read_timeout=READ_TIMEOUT_SECONDS,
                init_command="SET SESSION TRANSACTION READ ONLY",
            )
        except driver_errors as error:
            raise DatabaseUnavailableError(_unavailable_message(target, error)) from error

        def run(sql: str, params: Sequence[Any]) -> list[Row]:
            try:
                with connection.cursor() as cursor:
                    cursor.execute(sql, tuple(params))
                    return list(cursor.fetchall())
            except driver_errors as error:
                raise DatabaseUnavailableError(_unavailable_message(target, error)) from error

        try:
            yield run
        finally:
            try:
                connection.close()
            except driver_errors:
                pass  # The connection already failed; that error has been reported.

    return connect


def _unavailable_message(target: str, error: Exception) -> str:
    code = error.args[0] if error.args and isinstance(error.args[0], int) else None
    reason = type(error).__name__ if code is None else f"{type(error).__name__} {code}"
    return (
        f"The {DESCRIPTION} at {target} is unavailable ({reason}). "
        "Check the MySQL connection and that the database seed has run."
    )


class MySQLDataSource:
    """Reads one medicine's snapshot from MySQL for each forecast request."""

    name = DATA_SOURCE_NAME

    def __init__(self, settings: Settings, connector: Connector | None = None, history_days: int = HISTORY_DAYS) -> None:
        self.simulation_date = settings.simulation_date
        # The seed snapshots inventory at 18:00 on the simulation date, after that day's consumption,
        # so projection day 1 is the following day (mapping "asOfDate").
        self.as_of = settings.simulation_date + timedelta(days=1)
        self.history_days = history_days
        self._connect = connector if connector is not None else pymysql_connector(settings)

    def store_for(self, facility_id: str, medicine_id: str) -> SimulatedDataStore:
        """Load everything the engine needs for medicine_id over one connection.

        Every facility is loaded because all facilities holding the medicine are regional peers;
        facility_id is resolved by the store lookup, exactly as for the fixture.
        """
        history_start = self.as_of - timedelta(days=self.history_days)
        with self._connect() as run:
            medicine_rows = run(MEDICINES_SQL, ())
            facility_rows = run(FACILITIES_SQL, ())
            medicine_row, via_alias = resolve_medicine(medicine_rows, medicine_id)
            if medicine_row is None:
                inventory_rows, safety_rows, replenishment_rows, consumption_rows = [], [], [], []
            else:
                key = (medicine_row["medicine_id"],)
                inventory_rows = run(INVENTORY_SQL, key)
                safety_rows = run(SAFETY_STOCK_SQL, key)
                replenishment_rows = run(REPLENISHMENTS_SQL, key)
                consumption_rows = run(CONSUMPTION_SQL, (*key, history_start, self.simulation_date))
        return self._normalise(
            requested_medicine_id=medicine_id,
            medicine_row=medicine_row,
            via_alias=via_alias,
            facility_rows=facility_rows,
            inventory_rows=inventory_rows,
            safety_rows=safety_rows,
            replenishment_rows=replenishment_rows,
            consumption_rows=consumption_rows,
        )

    def _normalise(
        self,
        *,
        requested_medicine_id: str,
        medicine_row: Row | None,
        via_alias: bool,
        facility_rows: Sequence[Row],
        inventory_rows: Sequence[Row],
        safety_rows: Sequence[Row],
        replenishment_rows: Sequence[Row],
        consumption_rows: Sequence[Row],
    ) -> SimulatedDataStore:
        facilities_by_key = {row["facility_id"]: normalise_facility(row) for row in facility_rows}
        mappings = database_mappings(self.simulation_date, self.as_of)
        medicines: dict[str, Medicine] = {}
        medicine_aliases: dict[str, str] = {}
        inventory: dict[tuple[str, str], InventorySnapshot] = {}
        consumption: list[dict[str, Any]] = []

        if medicine_row is not None:
            medicine = normalise_medicine(medicine_row)
            medicines[medicine.id] = medicine
            if via_alias:
                medicine_aliases[requested_medicine_id] = medicine.id
                mappings.append(alias_mapping(requested_medicine_id, medicine))

            batches: defaultdict[Any, list[Batch]] = defaultdict(list)
            for row in inventory_rows:
                batches[row["facility_id"]].append(normalise_batch(row))
            safety = {row["facility_id"]: row for row in safety_rows}
            replenishments: defaultdict[Any, list[Replenishment]] = defaultdict(list)
            overdue: Counter[Any] = Counter()
            for row in replenishment_rows:
                status = str(row["status"]).upper()
                if status not in PROJECTED_REPLENISHMENT_STATUSES:
                    continue
                expected = _date(row["expected_arrival_date"], "replenishments.expected_arrival_date")
                if expected <= self.simulation_date:
                    overdue[row["facility_id"]] += 1
                    continue
                replenishments[row["facility_id"]].append(
                    Replenishment(
                        quantity=_quantity(row["quantity"], "replenishments.quantity"),
                        # Equals DATEDIFF(expected_arrival_date, SIMULATION_DATE) because day 1 is the day after it.
                        arrival_day=(expected - self.as_of).days + 1,
                        status=status,
                        expected_date=expected,
                    )
                )

            for key, facility_batches in batches.items():
                facility = _facility(facilities_by_key, key, "inventory")
                safety_row = safety.get(key)
                inventory[(facility.id, medicine.id)] = InventorySnapshot(
                    facility_id=facility.id,
                    medicine_id=medicine.id,
                    batches=tuple(facility_batches),
                    replenishments=tuple(replenishments[key]),
                    protected_stock=(
                        _quantity(safety_row["safety_stock_qty"], "facility_safety_stock.safety_stock_qty") if safety_row else 0.0
                    ),
                    protected_stock_source=PROTECTED_STOCK_RECORDED if safety_row else PROTECTED_STOCK_NOT_RECORDED,
                    protected_stock_confirmed=bool(safety_row["confirmed_by_aaryan"]) if safety_row else None,
                    overdue_replenishments=overdue[key],
                )

            consumption = [
                {
                    "date": _date(row["consumption_date"], "consumption.consumption_date").isoformat(),
                    "facility_id": _facility(facilities_by_key, row["facility_id"], "consumption").id,
                    "medicine_id": medicine.id,
                    # Passed through unchanged; the engine parses the decimal value like any other record.
                    "units_consumed": row["quantity_consumed"],
                }
                for row in consumption_rows
            ]

        context = DataContext(
            data_source=DATA_SOURCE_NAME,
            description=DESCRIPTION,
            simulation_date=self.simulation_date,
            protected_stock_assumption=(
                "Protected stock = facility_safety_stock.safety_stock_qty recorded in the database (draft values until "
                "confirmed by Aaryan); a facility without a row is treated as 0, as in backend/src/mysql-store.js."
            ),
            mappings=tuple(mappings),
        )
        return SimulatedDataStore(
            consumption,
            as_of=self.as_of,
            history_days=self.history_days,
            medicines=medicines,
            facilities={facility.id: facility for facility in facilities_by_key.values()},
            inventory=inventory,
            context=context,
            peer_scope=PEERS_ALL_FACILITIES,
            facility_aliases={str(key): facility.id for key, facility in facilities_by_key.items()},
            medicine_aliases=medicine_aliases,
        )


def database_mappings(simulation_date: date, as_of: date) -> list[DataMapping]:
    """How database fields are interpreted for the engine. PROVISIONAL rules await review by their owner."""
    return [
        DataMapping(
            name="units",
            source="medicines.base_unit and DECIMAL(12,2) quantities",
            rule="Quantities are used in the medicine's base unit (mg, mL or count) with their decimals, without conversion.",
            review_owner="Dhiren",
            status="DATABASE_POLICY",
        ),
        DataMapping(
            name="asOfDate",
            source="SIMULATION_DATE and inventory.last_updated (18:00 on the simulation date)",
            rule=(
                f"Inventory is an end-of-day snapshot for {simulation_date}, so projection day 1 is {as_of} and consumption "
                f"history ends on {simulation_date}; a replenishment's arrival day equals "
                "DATEDIFF(expected_arrival_date, SIMULATION_DATE), as in backend/src/mysql-store.js."
            ),
            review_owner="Dhiren and Sahil",
        ),
        DataMapping(
            name="medicineCriticality",
            source="medicines.criticality_level",
            rule="CRITICAL uses risk signal 1.0, the same as HIGH; HIGH 1.0, MEDIUM 0.6 and LOW 0.3 are unchanged.",
            review_owner="Aaryan",
        ),
        DataMapping(
            name="facilityRemoteness",
            source="facilities.remoteness_score (0-10)",
            rule="Risk signal = remoteness_score / 10.",
            review_owner="Aaryan",
        ),
        DataMapping(
            name="protectedStock",
            source="facility_safety_stock.safety_stock_qty",
            rule="Used directly as protected stock; a facility without a row is treated as 0, as in backend/src/mysql-store.js.",
            review_owner="Aaryan",
        ),
        DataMapping(
            name="effectiveStock",
            source="inventory.status, batches.quarantined, batches.expiry_date",
            rule=(
                f"Only AVAILABLE inventory from non-quarantined batches expiring on or after {as_of} counts; "
                "QUARANTINED, EXPIRED and RESERVED stock is recorded but excluded."
            ),
            review_owner="Dhiren",
        ),
        DataMapping(
            name="replenishments",
            source="replenishments.status, expected_arrival_date, quantity",
            rule=(
                f"SCHEDULED and DELAYED orders expected after {simulation_date} arrive in full on their expected date; "
                "ARRIVED and CANCELLED orders and supplier_reliability_score are not used."
            ),
            review_owner="Dhiren and Sahil",
        ),
        DataMapping(
            name="regionalPeers",
            source="facilities.region",
            rule="Each seeded facility has its own region, so regional fragility compares all other database facilities holding the medicine.",
            review_owner="Aaryan",
        ),
    ]


def alias_mapping(requested_id: str, medicine: Medicine) -> DataMapping:
    return DataMapping(
        name="medicineAlias",
        source="docs/api-contract.md",
        rule=f"'{requested_id}' resolves to database medicine {medicine.id} ({medicine.generic_name} {medicine.strength} {medicine.dosage_form}).",
        review_owner="Sahil",
    )


def resolve_medicine(rows: Sequence[Row], requested_id: str) -> tuple[Row | None, bool]:
    """Match a medicine_id, then a documented alias by exact identity. Returns (row, matched_via_alias)."""
    for row in rows:
        if str(row["medicine_id"]) == requested_id:
            return row, False
    identity = MEDICINE_ALIASES.get(requested_id)
    if identity is None:
        return None, False
    matches = [row for row in rows if _identity(row) == identity]
    return (matches[0], True) if len(matches) == 1 else (None, False)


def normalise_medicine(row: Row) -> Medicine:
    unit = row["base_unit"]
    if unit not in BASE_UNITS:
        raise DatabaseDataError(
            f"medicines.base_unit for medicine {row['medicine_id']} must be one of {', '.join(BASE_UNITS)}; got {unit!r}."
        )
    criticality = str(row["criticality_level"]).upper()
    if criticality not in CRITICALITY_LEVELS:
        raise DatabaseDataError(
            f"medicines.criticality_level for medicine {row['medicine_id']} must be one of {', '.join(CRITICALITY_LEVELS)}; got {criticality!r}."
        )
    return Medicine(
        id=str(row["medicine_id"]),
        generic_name=row["generic_name"],
        strength=f"{_plain(row['strength_value'], 'medicines.strength_value')} {row['strength_unit']}",
        dosage_form=row["form"],
        unit=unit,
        criticality=criticality,
        storage=(
            f"{_plain(row['storage_temp_min_c'], 'medicines.storage_temp_min_c')}-"
            f"{_plain(row['storage_temp_max_c'], 'medicines.storage_temp_max_c')} C"
        ),
    )


def normalise_facility(row: Row) -> Facility:
    code = row["facility_code"]
    raw_remoteness = float(_decimal(row["remoteness_score"], f"facilities.remoteness_score for {code}"))
    if not 0 <= raw_remoteness <= REMOTENESS_SCALE_MAX:
        raise DatabaseDataError(f"facilities.remoteness_score for {code} must be between 0 and 10; got {raw_remoteness}.")
    return Facility(
        id=code,
        name=row["name"],
        type=row["facility_type"],
        district=row["region"],
        # The schema stores two decimals, so three are exact after scaling (2.30 -> 0.23, not 0.22999999999999998).
        remoteness_score=round(raw_remoteness / REMOTENESS_SCALE_MAX, 3),
        protected_days=None,
        source_remoteness_score=raw_remoteness,
    )


def normalise_batch(row: Row) -> Batch:
    status = str(row["status"]).upper()
    if bool(row["quarantined"]) or status == "QUARANTINED":
        engine_status = "QUARANTINED"
    elif status == "AVAILABLE":
        engine_status = "USABLE"
    else:
        engine_status = status  # EXPIRED or RESERVED: recorded, but not dispensable
    return Batch(
        batch_no=row["batch_number"],
        quantity=_quantity(row["quantity_on_hand"], "inventory.quantity_on_hand"),
        expiry_date=_date(row["expiry_date"], "batches.expiry_date"),
        status=engine_status,
    )


def _identity(row: Row) -> tuple[str, Decimal, str, str]:
    return (row["generic_name"], _decimal(row["strength_value"], "medicines.strength_value"), row["strength_unit"], row["form"])


def _facility(facilities_by_key: Mapping[Any, Facility], key: Any, table: str) -> Facility:
    try:
        return facilities_by_key[key]
    except KeyError as error:
        raise DatabaseDataError(f"{table}.facility_id {key} does not match any facility.") from error


def _decimal(value: Any, field: str) -> Decimal:
    if value is None or isinstance(value, bool):
        raise DatabaseDataError(f"{field} must be a number; got {value!r}.")
    try:
        number = value if isinstance(value, Decimal) else Decimal(str(value))
    except InvalidOperation as error:
        raise DatabaseDataError(f"{field} must be a number; got {value!r}.") from error
    if not number.is_finite():
        raise DatabaseDataError(f"{field} must be a finite number; got {value!r}.")
    return number


def _quantity(value: Any, field: str) -> float:
    """A non-negative DECIMAL quantity. float keeps the fractional part; values are never cast to int."""
    number = _decimal(value, field)
    if number < 0:
        raise DatabaseDataError(f"{field} cannot be negative; got {number}.")
    return float(number)


def _plain(value: Any, field: str) -> str:
    """Decimal text without trailing zeros: 100.000 -> '100', 2.500 -> '2.5'."""
    return format(_decimal(value, field).normalize(), "f")


def _date(value: Any, field: str) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise DatabaseDataError(f"{field} must be a date; got {value!r}.")
