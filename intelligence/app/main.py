"""FastAPI entry point for the MEDRIPPLE intelligence service.

Run from the intelligence/ directory:
    python -m uvicorn app.main:app --host 127.0.0.1 --port 8000

DATA_SOURCE=fixture (the default) serves the offline Navjeevan PHC fixture. DATA_SOURCE=mysql reads
Dhiren's MySQL database through app/mysql_store.py and never falls back to the fixture.
"""

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import timedelta
from typing import Protocol

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import MYSQL, Settings, load_settings
from .data_store import DataContext, Facility, Replenishment, SimulatedDataStore
from .forecast import (
    FORECAST_METHOD,
    CleanHistory,
    DemandForecast,
    InsufficientHistoryError,
    clean_history,
    weighted_moving_average,
)
from .mysql_store import Connector, DatabaseDataError, DatabaseUnavailableError, MySQLDataSource
from .simulator import SimulationError, run_simulation
from .risk_engine import (
    DEFAULT_RISK_CONFIG,
    RiskConfig,
    build_shortage_analysis,
    compute_regional_fragility,
    protected_stock_for,
    safe_surplus_for,
)
from .schemas import (
    HORIZON_ERROR_MESSAGE,
    AnomalyBlock,
    ConfidenceBlock,
    DataContextBlock,
    DataIssueBlock,
    DataMappingBlock,
    DataQualityBlock,
    ErrorResponse,
    FacilityBlock,
    ForecastBlock,
    ForecastRequest,
    ForecastResponse,
    HealthResponse,
    SimulationRequest,
    SimulationResponse,
    InventoryBlock,
    MedicineBlock,
    ProjectionDayBlock,
    ReplenishmentBlock,
    RiskBlock,
    RiskComponentBlock,
    StockoutBlock,
)

logger = logging.getLogger("medripple.intelligence")

SERVICE_NAME = "medripple-intelligence"
MODEL_VERSION = "aiml-step1-wma-v1"
# Assumptions for every data source; the protected-stock rule and field mappings come from the DataContext.
SHARED_ASSUMPTIONS = (
    "All inventory and consumption data is simulated.",
    "Risk weights are prototype assumptions and are not clinically validated.",
    "Forecast = 0.70 x mean of the latest 7 available days + 0.30 x mean of the previous 21 available days; "
    "missing, invalid and anomalous values are excluded.",
    "Projection uses effective stock (usable, unexpired batches), not recorded stock.",
    "Scheduled replenishment arrives in full at the start of its day; unmet demand is not carried forward.",
)
DECISION_SUPPORT_ASSUMPTION = "Decision support only: a qualified person must review before any transfer or clinical action."


class ServiceError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


class DataSource(Protocol):
    name: str

    def store_for(self, facility_id: str, medicine_id: str) -> SimulatedDataStore: ...

    def regional_store_for(self, medicine_ids: Sequence[str]) -> SimulatedDataStore: ...


class FixtureDataSource:
    """The offline fixture: one in-memory snapshot shared by every request. Requests only read it."""

    name = "FIXTURE"

    def __init__(self, store: SimulatedDataStore) -> None:
        self.store = store

    def store_for(self, facility_id: str, medicine_id: str) -> SimulatedDataStore:
        return self.store

    def regional_store_for(self, medicine_ids: Sequence[str]) -> SimulatedDataStore:
        return self.store


def build_data_source(settings: Settings, connector: Connector | None = None) -> DataSource:
    """The configured data source. MySQL mode never falls back to the fixture."""
    if settings.data_source == MYSQL:
        return MySQLDataSource(settings, connector)
    return FixtureDataSource(SimulatedDataStore.from_csv())


def build_assumptions(context: DataContext) -> list[str]:
    mapping_assumptions = [
        f"{mapping.name}: {mapping.rule.rstrip('.')} ({mapping.status.replace('_', ' ').lower()}; review: {mapping.review_owner})."
        for mapping in context.mappings
    ]
    return [*SHARED_ASSUMPTIONS, context.protected_stock_assumption, DECISION_SUPPORT_ASSUMPTION, *mapping_assumptions]


@dataclass(frozen=True)
class TargetAnalysis:
    history: CleanHistory
    forecast: DemandForecast
    effective_stock: float
    protected_stock: float
    safe_surplus: float


def analyse_target(store: SimulatedDataStore, facility: Facility, medicine_id: str) -> TargetAnalysis:
    """Forecast and safe surplus for a facility; used to measure regional fragility."""
    inventory = store.get_inventory(facility.id, medicine_id)
    history = clean_history(store.consumption_history(facility.id, medicine_id))
    forecast = weighted_moving_average(history.values)
    effective_stock = inventory.effective_stock(store.as_of)
    protected_stock = protected_stock_for(forecast.daily_demand, facility.protected_days, inventory.protected_stock)
    return TargetAnalysis(
        history=history,
        forecast=forecast,
        effective_stock=effective_stock,
        protected_stock=protected_stock,
        safe_surplus=safe_surplus_for(effective_stock, protected_stock),
    )


def peer_safe_surplus(store: SimulatedDataStore, facility: Facility, medicine_id: str) -> float | None:
    """A peer's safe donor surplus, or None when it cannot be measured (counted as no surplus)."""
    inventory = store.get_inventory(facility.id, medicine_id)
    if inventory.protected_stock is not None:
        # Recorded protected stock needs no forecast, so facilities without consumption (warehouses) still count.
        return safe_surplus_for(inventory.effective_stock(store.as_of), inventory.protected_stock)
    try:
        return analyse_target(store, facility, medicine_id).safe_surplus
    except InsufficientHistoryError:
        return None


def replenishment_block(store: SimulatedDataStore, item: Replenishment) -> ReplenishmentBlock:
    return ReplenishmentBlock(
        quantity=round(item.quantity, 2),
        arrival_day=item.arrival_day,
        arrival_date=item.expected_date or store.as_of + timedelta(days=item.arrival_day - 1),
        status=item.status,
    )


def run_forecast(
    store: SimulatedDataStore,
    payload: ForecastRequest,
    risk_config: RiskConfig = DEFAULT_RISK_CONFIG,
) -> ForecastResponse:
    context = store.context
    facility = store.get_facility(payload.facility_id)
    if facility is None:
        raise ServiceError(404, "FACILITY_NOT_FOUND", f"Facility '{payload.facility_id}' was not found in the {context.description}.")
    medicine = store.get_medicine(payload.medicine_id)
    if medicine is None:
        raise ServiceError(404, "MEDICINE_NOT_FOUND", f"Medicine '{payload.medicine_id}' was not found in the {context.description}.")
    inventory = store.get_inventory(facility.id, medicine.id)
    if inventory is None:
        raise ServiceError(
            404, "FORECAST_TARGET_NOT_FOUND", f"No inventory exists for medicine '{medicine.id}' at '{facility.id}' in the {context.description}."
        )
    history_start, history_end = store.history_window
    if not store.has_consumption_records(facility.id, medicine.id):
        raise ServiceError(
            422,
            "NO_CONSUMPTION_HISTORY",
            f"No consumption records exist for medicine '{medicine.id}' at '{facility.id}' ({facility.type}) between "
            f"{history_start} and {history_end} in the {context.description}, so no demand forecast can be made. "
            "Facilities that do not dispense to patients, such as warehouses, have no consumption history.",
        )

    peer_surpluses = [peer_safe_surplus(store, peer, medicine.id) for peer in store.regional_peers(facility, medicine.id)]
    effective_stock = inventory.effective_stock(store.as_of)
    try:
        analysis = build_shortage_analysis(
            records=store.consumption_history(facility.id, medicine.id),
            effective_stock=effective_stock,
            replenishments=inventory.replenishments,
            as_of=store.as_of,
            horizon_days=payload.horizon_days,
            protected_days=facility.protected_days,
            medicine_criticality=medicine.criticality,
            facility_remoteness=facility.remoteness_score,
            regional_fragility=compute_regional_fragility(peer_surpluses),
            unit=medicine.unit,
            config=risk_config,
            recorded_protected_stock=inventory.protected_stock,
        )
    except InsufficientHistoryError as error:
        raise ServiceError(422, "INVALID_HISTORY", f"Consumption history for '{facility.id}' cannot be used: {error}.") from error

    forecast = analysis.forecast
    projection = analysis.projection
    confidence = analysis.confidence
    history = analysis.history
    upcoming = projection.next_replenishment
    scheduled = sorted((item for item in inventory.replenishments if item.arrival_day >= 1), key=lambda item: item.arrival_day)
    notes = list(context.notes)
    if inventory.overdue_replenishments:
        notes.append(
            f"{inventory.overdue_replenishments} open replenishment order(s) for this facility were expected on or before "
            f"{context.simulation_date} but have not arrived; they are not projected."
        )

    return ForecastResponse(
        forecast=ForecastBlock(
            daily_demand=forecast.daily_demand,
            lower_bound=forecast.lower_bound,
            upper_bound=forecast.upper_bound,
            horizon_days=payload.horizon_days,
            unit=medicine.unit,
            method=FORECAST_METHOD,
            recent_average=forecast.recent_average,
            baseline_average=forecast.baseline_average,
            recent_variability=forecast.recent_variability,
            trend=forecast.trend,
            trend_change_percent=forecast.trend_change_percent,
        ),
        risk=RiskBlock(
            score=analysis.risk.score,
            label=analysis.risk.label,
            components=[
                RiskComponentBlock(
                    key=component.key,
                    weight=component.weight,
                    signal=component.signal,
                    contribution=component.contribution,
                    detail=component.detail,
                )
                for component in analysis.risk.components
            ],
        ),
        stockout=StockoutBlock(
            days_remaining=projection.days_remaining,
            projected_within_horizon=projection.projected_within_horizon,
            projected_stockout_day=projection.projected_stockout_day,
            projected_stockout_date=projection.projected_stockout_date,
            shortage_gap_days=projection.shortage_gap_days,
            minimum_projected_stock=round(projection.minimum_projected_stock, 2),
            total_shortage_days=projection.total_shortage_days,
            unmet_demand=round(projection.unmet_demand, 2),
            supply_restored_day=projection.supply_restored_day,
            replenishment_timing=projection.replenishment_timing,
            replenishment_arrives_before_stockout=projection.replenishment_arrives_before_stockout,
            next_replenishment=replenishment_block(store, upcoming) if upcoming else None,
        ),
        confidence=ConfidenceBlock(
            label=confidence.label,
            reason=confidence.reason,
            valid_records=confidence.valid_records,
            missing_or_invalid_records=confidence.missing_or_invalid_records,
            anomaly_count=confidence.anomaly_count,
            recent_variability_cv=confidence.recent_variability_cv,
        ),
        cause=analysis.cause.primary,
        contributing_factors=list(analysis.cause.contributing),
        explanation=analysis.explanation,
        assumptions=build_assumptions(context),
        decision_support_only=True,
        facility=FacilityBlock(
            id=facility.id,
            name=facility.name,
            type=facility.type,
            district=facility.district,
            remoteness_score=facility.remoteness_score,
            protected_days=facility.protected_days,
            source_remoteness_score=facility.source_remoteness_score,
        ),
        medicine=MedicineBlock(
            id=medicine.id,
            generic_name=medicine.generic_name,
            strength=medicine.strength,
            dosage_form=medicine.dosage_form,
            unit=medicine.unit,
            criticality=medicine.criticality,
        ),
        inventory=InventoryBlock(
            as_of_date=store.as_of,
            recorded_stock=round(inventory.recorded_stock, 2),
            effective_stock=round(effective_stock, 2),
            excluded_stock=round(inventory.recorded_stock - effective_stock, 2),
            protected_days=facility.protected_days,
            protected_stock=analysis.protected_stock,
            protected_stock_source=inventory.protected_stock_source,
            protected_stock_confirmed=inventory.protected_stock_confirmed,
            safe_surplus=analysis.safe_surplus,
            next_replenishment=replenishment_block(store, scheduled[0]) if scheduled else None,
            scheduled_replenishments=[replenishment_block(store, item) for item in scheduled],
        ),
        projection=[
            ProjectionDayBlock(
                day=day.day,
                date=store.as_of + timedelta(days=day.day - 1),
                opening_stock=round(day.opening_stock, 2),
                replenishment=round(day.replenishment, 2),
                demand=round(day.demand, 2),
                closing_stock=round(day.closing_stock, 2),
                unmet_demand=round(day.unmet_demand, 2),
            )
            for day in projection.days
        ],
        data_quality=DataQualityBlock(
            history_start=history.records[0].day,
            history_end=history.records[-1].day,
            expected_records=len(history.records),
            valid_records=len(history.usable),
            missing_or_invalid=[DataIssueBlock(date=record.day, issue=record.issue) for record in history.invalid],
            anomalies=[
                AnomalyBlock(date=anomaly.day, units=anomaly.units, neighbour_median=anomaly.neighbour_median)
                for anomaly in history.anomalies
            ],
        ),
        data_context=DataContextBlock(
            data_source=context.data_source,
            data_label=context.data_label,
            simulation_date=context.simulation_date,
            as_of_date=store.as_of,
            history_start=history_start,
            history_end=history_end,
            mappings=[
                DataMappingBlock(
                    name=mapping.name,
                    source=mapping.source,
                    rule=mapping.rule,
                    status=mapping.status,
                    review_owner=mapping.review_owner,
                )
                for mapping in context.mappings
            ],
            notes=notes,
        ),
        data_label=context.data_label,
        model_version=MODEL_VERSION,
    )


def error_response(status_code: int, code: str, message: str, details: list[dict[str, str]] | None = None) -> JSONResponse:
    error: dict = {"code": code, "message": message}
    if details:
        error["details"] = details
    return JSONResponse(status_code=status_code, content={"error": error})


def _field_name(location: tuple) -> str:
    return ".".join(str(part) for part in location if part != "body") or "body"


def create_app(
    store: SimulatedDataStore | None = None,
    risk_config: RiskConfig = DEFAULT_RISK_CONFIG,
    data_source: DataSource | None = None,
) -> FastAPI:
    """Build the app from a data source, a fixture store, or (by default) the DATA_SOURCE environment variable."""
    if data_source is None:
        data_source = FixtureDataSource(store) if store is not None else build_data_source(load_settings())
    app = FastAPI(
        title="MEDRIPPLE intelligence service",
        version=__version__,
        description="Explainable medicine-shortage forecasts over SIMULATED prototype data. Decision support only; not clinical advice.",
    )
    app.state.data_source = data_source

    @app.exception_handler(ServiceError)
    async def handle_service_error(request: Request, error: ServiceError) -> JSONResponse:
        return error_response(error.status_code, error.code, error.message)

    @app.exception_handler(DatabaseUnavailableError)
    async def handle_database_unavailable(request: Request, error: DatabaseUnavailableError) -> JSONResponse:
        logger.warning("MySQL data source unavailable: %s", error)
        return error_response(503, "DATABASE_UNAVAILABLE", str(error))

    @app.exception_handler(DatabaseDataError)
    async def handle_database_data_error(request: Request, error: DatabaseDataError) -> JSONResponse:
        logger.error("MySQL data outside the schema contract: %s", error)
        return error_response(500, "DATABASE_DATA_INVALID", str(error))

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, error: RequestValidationError) -> JSONResponse:
        errors = error.errors()
        details = [{"field": _field_name(item.get("loc", ())), "message": str(item.get("msg", "Invalid value."))} for item in errors]
        first = errors[0] if errors else {}
        field = details[0]["field"] if details else "body"
        if field == "horizonDays":
            return error_response(422, "INVALID_HORIZON", HORIZON_ERROR_MESSAGE, details)
        if first.get("type") == "json_invalid":
            message = "Request body must be valid JSON."
        elif first.get("type") == "missing":
            message = "A JSON request body is required." if field == "body" else f"{field} is required."
        else:
            message = f"{field}: {first.get('msg', 'Invalid value.')}"
        return error_response(422, "INVALID_REQUEST", message, details)

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, error: StarletteHTTPException) -> JSONResponse:
        code = {404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}.get(error.status_code, "HTTP_ERROR")
        response = error_response(error.status_code, code, str(error.detail))
        if error.headers:
            response.headers.update(error.headers)
        return response

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, error: Exception) -> JSONResponse:
        logger.exception("Unhandled intelligence service error")
        return error_response(500, "INTERNAL_ERROR", "An unexpected error occurred.")

    @app.get("/health", response_model=HealthResponse)
    def health() -> dict:
        return {"status": "ok", "service": SERVICE_NAME}

    @app.post(
        "/forecast",
        response_model=ForecastResponse,
        responses={
            404: {"model": ErrorResponse},
            422: {"model": ErrorResponse},
            500: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    def forecast(payload: ForecastRequest) -> ForecastResponse:
        store = data_source.store_for(payload.facility_id, payload.medicine_id)
        return run_forecast(store, payload, risk_config)

    @app.exception_handler(SimulationError)
    async def handle_simulation_error(request: Request, error: SimulationError) -> JSONResponse:
        return error_response(error.status_code, error.code, error.message)

    @app.post(
        "/scenarios/simulate",
        response_model=SimulationResponse,
        responses={
            404: {"model": ErrorResponse},
            422: {"model": ErrorResponse},
            500: {"model": ErrorResponse},
            503: {"model": ErrorResponse},
        },
    )
    def simulate_scenario(payload: SimulationRequest) -> SimulationResponse:
        """Ripple Simulator: read-only before/after projection of proposed transfers. Decision support only."""
        store = data_source.regional_store_for([item.medicine_id for item in payload.transfers])
        return run_simulation(store, payload, risk_config)

    return app


app = create_app()
