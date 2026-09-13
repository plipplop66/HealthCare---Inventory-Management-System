"""Request and response contracts for the intelligence service.

Fields are camelCase on the wire so backend/src/intelligence-adapter.js can use
responses unchanged. Additional fields beyond the adapter contract are allowed;
the required ones (forecast, risk, stockout, confidence, cause, explanation,
assumptions, decisionSupportOnly) must not be removed or renamed.

Quantities are in the medicine's unit (forecast.unit) and keep their decimals.
"""

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic.alias_generators import to_camel

ALLOWED_HORIZON_DAYS = (7, 14, 30)
HORIZON_ERROR_MESSAGE = "horizonDays must be one of 7, 14 or 30."

RiskLabel = Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
TrendDirection = Literal["INCREASING", "DECREASING", "STABLE"]
ConfidenceLabel = Literal["HIGH", "MEDIUM", "LOW"]
CauseCode = Literal["DEMAND_SHOCK", "SUPPLY_DELAY", "INVENTORY_IMBALANCE", "DATA_ANOMALY", "TEMPORARY_DIP", "STABLE"]
ProtectedStockSource = Literal["FORECAST_X_PROTECTED_DAYS", "FACILITY_SAFETY_STOCK", "NOT_RECORDED_TREATED_AS_ZERO"]


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, validate_by_name=True, validate_by_alias=True)


class ForecastRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, str_strip_whitespace=True)

    facility_id: str = Field(min_length=1, examples=["facility-navjeevan-phc", "PHC-VLR-001"])
    medicine_id: str = Field(min_length=1, examples=["med-insulin-100iu-vial", "7"])
    horizon_days: int = Field(default=14, description="Forecast horizon in days: 7, 14 or 30.", examples=[14])

    @field_validator("horizon_days", mode="before")
    @classmethod
    def check_horizon(cls, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value not in ALLOWED_HORIZON_DAYS:
            raise ValueError(HORIZON_ERROR_MESSAGE)
        return value


class ForecastBlock(ApiModel):
    daily_demand: float
    lower_bound: float
    upper_bound: float
    horizon_days: int
    unit: str
    method: str
    recent_average: float = Field(description="Mean of the latest 7 available days.")
    baseline_average: float = Field(description="Mean of the previous 21 available days (before the latest 7).")
    recent_variability: float = Field(description="Standard deviation of the latest 14 available days.")
    trend: TrendDirection = Field(description="Recent 7-day average versus the previous 21 days; +/-10% or more is a trend.")
    trend_change_percent: float | None = Field(description="Percentage change of the recent average versus the previous average.")


class RiskComponentBlock(ApiModel):
    key: str
    weight: float
    signal: float
    contribution: float
    detail: str


class RiskBlock(ApiModel):
    score: int = Field(ge=0, le=100)
    label: RiskLabel
    components: list[RiskComponentBlock]


class ReplenishmentBlock(ApiModel):
    quantity: float
    arrival_day: int = Field(description="Projection day on which the delivery arrives; day 1 is the as-of date.")
    arrival_date: dt.date | None = Field(default=None, description="Calendar date of arrival.")
    status: str


class StockoutBlock(ApiModel):
    days_remaining: float | None = Field(description="Days of cover from current effective stock, before replenishment.")
    projected_within_horizon: bool
    projected_stockout_day: int | None
    projected_stockout_date: dt.date | None = Field(description="Calendar date of the projected stockout; day 1 is the as-of date.")
    shortage_gap_days: int = Field(description="Days from the first projected stockout until supply is restored or the horizon ends.")
    minimum_projected_stock: float
    total_shortage_days: int
    unmet_demand: float
    supply_restored_day: int | None
    replenishment_timing: Literal["NONE_SCHEDULED", "NO_STOCKOUT_PROJECTED", "BEFORE_STOCKOUT", "AFTER_STOCKOUT"]
    replenishment_arrives_before_stockout: bool | None
    next_replenishment: ReplenishmentBlock | None


class ConfidenceBlock(ApiModel):
    label: ConfidenceLabel
    reason: str = Field(min_length=1)
    valid_records: int
    missing_or_invalid_records: int
    anomaly_count: int
    recent_variability_cv: float | None


class FacilityBlock(ApiModel):
    id: str
    name: str
    type: str
    district: str
    remoteness_score: float = Field(description="Remoteness used by the risk score: 0 (central) to 1 (most remote).")
    protected_days: int | None = Field(description="Days of forecast demand kept as protected stock; null when the data source records protected stock.")
    source_remoteness_score: float | None = Field(
        default=None, description="Remoteness as stored by the data source before scaling (MySQL uses 0-10); null for the fixture."
    )


class MedicineBlock(ApiModel):
    id: str
    generic_name: str
    strength: str
    dosage_form: str
    unit: str
    criticality: str


class InventoryBlock(ApiModel):
    as_of_date: dt.date
    recorded_stock: float
    effective_stock: float
    excluded_stock: float
    protected_days: int | None
    protected_stock: float
    protected_stock_source: ProtectedStockSource
    protected_stock_confirmed: bool | None = Field(description="Whether recorded protected stock is clinically confirmed; null when none is recorded.")
    safe_surplus: float
    next_replenishment: ReplenishmentBlock | None = Field(description="Earliest projected delivery.")
    scheduled_replenishments: list[ReplenishmentBlock]


class ProjectionDayBlock(ApiModel):
    day: int
    date: dt.date
    opening_stock: float
    replenishment: float
    demand: float
    closing_stock: float
    unmet_demand: float


class DataIssueBlock(ApiModel):
    date: dt.date
    issue: str


class AnomalyBlock(ApiModel):
    date: dt.date
    units: float
    neighbour_median: float


class DataQualityBlock(ApiModel):
    history_start: dt.date
    history_end: dt.date
    expected_records: int
    valid_records: int
    missing_or_invalid: list[DataIssueBlock]
    anomalies: list[AnomalyBlock]


class DataMappingBlock(ApiModel):
    name: str
    source: str
    rule: str
    status: Literal["PROVISIONAL", "DATABASE_POLICY"]
    review_owner: str


class DataContextBlock(ApiModel):
    data_source: Literal["FIXTURE", "MYSQL"]
    data_label: str
    simulation_date: dt.date = Field(description="Reference date of the data snapshot (MySQL: SIMULATION_DATE).")
    as_of_date: dt.date = Field(description="Projection day 1.")
    history_start: dt.date
    history_end: dt.date
    mappings: list[DataMappingBlock] = Field(description="How data-source fields are interpreted; PROVISIONAL rules await review.")
    notes: list[str]


class ForecastResponse(ApiModel):
    forecast: ForecastBlock
    risk: RiskBlock
    stockout: StockoutBlock
    confidence: ConfidenceBlock
    cause: CauseCode
    contributing_factors: list[CauseCode]
    explanation: str
    assumptions: list[str]
    decision_support_only: Literal[True] = True
    facility: FacilityBlock
    medicine: MedicineBlock
    inventory: InventoryBlock
    projection: list[ProjectionDayBlock]
    data_quality: DataQualityBlock
    data_context: DataContextBlock
    data_label: str
    model_version: str


class HealthResponse(BaseModel):
    status: str
    service: str


class ErrorBody(BaseModel):
    code: str
    message: str
    details: list[dict[str, str]] | None = None


class ErrorResponse(BaseModel):
    error: ErrorBody
