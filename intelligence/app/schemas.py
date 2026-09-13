"""Request and response contracts for the intelligence service.

Fields are camelCase on the wire so backend/src/intelligence-adapter.js can use
responses unchanged. Additional fields beyond the adapter contract are allowed;
the required ones (forecast, risk, stockout, confidence, cause, explanation,
assumptions, decisionSupportOnly) must not be removed or renamed.

Quantities are in the medicine's unit (forecast.unit) and keep their decimals.
"""

import datetime as dt
import math
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
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


MAX_SIMULATION_TRANSFERS = 50
TRANSFERS_REQUIRED_MESSAGE = "transfers must include at least one transfer."

FacilityRole = Literal["DONOR", "RECIPIENT", "DONOR_AND_RECIPIENT", "NOT_IN_TRANSFER"]
DemandBasis = Literal["FORECAST", "NO_CONSUMPTION_STORAGE_FACILITY", "UNAVAILABLE"]
RegionalOutcome = Literal["IMPROVED", "WORSENED", "MIXED", "UNCHANGED"]
NewRiskType = Literal["NEW_STOCKOUT", "MORE_SHORTAGE", "NEW_CRITICAL", "NEW_HIGH_RISK", "FELL_BELOW_PROTECTED_STOCK"]


def _check_horizon(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value not in ALLOWED_HORIZON_DAYS:
        raise ValueError(HORIZON_ERROR_MESSAGE)
    return value


class TransferRequest(BaseModel):
    """One proposed transfer, in the shape backend/src/validation.js accepts."""

    model_config = ConfigDict(alias_generator=to_camel, str_strip_whitespace=True)

    from_facility_id: str = Field(min_length=1, examples=["DH-CBE-001"])
    to_facility_id: str = Field(min_length=1, examples=["PHC-VLR-001"])
    medicine_id: str = Field(min_length=1, examples=["7"])
    quantity: float = Field(description="Quantity in the medicine's unit; decimals are kept.", examples=[100])
    arrival_day: int = Field(default=1, description="Projection day on which the transfer arrives; day 1 is the as-of date.")

    @field_validator("quantity", mode="before")
    @classmethod
    def check_quantity(cls, value: Any) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
            raise ValueError("quantity must be a positive number")
        return float(value)

    @field_validator("arrival_day", mode="before")
    @classmethod
    def check_arrival_day(cls, value: Any) -> int:
        if isinstance(value, bool) or not isinstance(value, int) or value < 1:
            raise ValueError("arrivalDay must be a whole number of at least 1")
        return value

    @model_validator(mode="after")
    def check_different_facilities(self) -> "TransferRequest":
        if self.from_facility_id == self.to_facility_id:
            raise ValueError("fromFacilityId and toFacilityId must be different")
        return self


class SimulationRequest(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel)

    horizon_days: int = Field(default=14, description="Simulation horizon in days: 7, 14 or 30.", examples=[14])
    transfers: list[TransferRequest] = Field(
        max_length=MAX_SIMULATION_TRANSFERS, description="Transfers of one medicine, evaluated together."
    )

    @field_validator("horizon_days", mode="before")
    @classmethod
    def check_horizon(cls, value: Any) -> int:
        return _check_horizon(value)

    @field_validator("transfers", mode="before")
    @classmethod
    def check_transfers(cls, value: Any) -> Any:
        if not isinstance(value, list) or not value:
            raise ValueError(TRANSFERS_REQUIRED_MESSAGE)
        return value


class SimulationMedicineBlock(ApiModel):
    id: str
    generic_name: str
    strength: str
    dosage_form: str
    unit: str
    criticality: str
    requires_cold_chain: bool | None


class SimulatedDayBlock(ApiModel):
    day: int
    date: dt.date
    opening_stock: float
    transfer_out: float = Field(description="Stock leaving at the start of the day, before replenishment and demand.")
    scheduled_replenishment: float
    transfer_in: float
    demand: float
    closing_stock: float
    unmet_demand: float


class FacilityProjectionBlock(ApiModel):
    facility_id: str
    facility_name: str
    facility_type: str
    role: FacilityRole
    projection_available: bool
    unavailable_reason: str | None
    effective_stock: float = Field(description="Usable, unexpired stock at the snapshot, before any simulated transfer.")
    transfer_in: float
    transfer_out: float
    stock_after_transfers: float = Field(description="effectiveStock + transferIn - transferOut.")
    protected_stock: float | None
    protected_stock_source: ProtectedStockSource | None
    predicted_daily_demand: float | None
    demand_basis: DemandBasis
    days_remaining: float | None = Field(description="stockAfterTransfers / predictedDailyDemand, before scheduled replenishment.")
    stockout_day: int | None
    stockout_date: dt.date | None
    shortage_days: int = Field(description="Days in the horizon with unmet demand.")
    shortage_gap_days: int
    unmet_demand: float
    minimum_projected_stock: float | None
    ending_stock: float | None
    below_protected_stock: bool | None = Field(description="Whether projected closing stock falls below protected stock on any day.")
    risk_score: int | None
    risk_label: RiskLabel | None
    projected_daily_stock: list[SimulatedDayBlock]


class RegionalStateBlock(ApiModel):
    critical_facility_count: int = Field(description="Facilities whose risk label is CRITICAL.")
    stockout_facility_count: int
    regional_shortage_days: int
    regional_unmet_demand: float
    regional_risk: int | None = Field(description="Highest facility risk score in the region.")
    average_risk: float | None
    applied_transfer_count: int
    facilities: list[FacilityProjectionBlock]


class RouteBlock(ApiModel):
    distance_km: float
    travel_hours: float
    cold_chain_available: bool


class BatchAllocationBlock(ApiModel):
    batch_no: str
    quantity: float
    expiry_date: dt.date


class TransferEvaluationBlock(ApiModel):
    index: int
    from_facility_id: str
    to_facility_id: str
    medicine_id: str
    quantity: float
    arrival_day: int
    departure_day: int | None
    eligible: bool
    applied: bool = Field(description="Whether the transfer was included in the intervention projection.")
    rejection_reasons: list[str]
    rejection_codes: list[str]
    route: RouteBlock | None
    batches: list[BatchAllocationBlock]
    explanation: str


class NewRiskBlock(ApiModel):
    facility_id: str
    facility_name: str
    risk_type: NewRiskType
    day: int | None
    detail: str


class FacilityChangeBlock(ApiModel):
    facility_id: str
    facility_name: str
    role: FacilityRole
    risk_score_before: int | None
    risk_score_after: int | None
    shortage_days_before: int
    shortage_days_after: int
    unmet_demand_before: float
    unmet_demand_after: float
    minimum_projected_stock_before: float | None
    minimum_projected_stock_after: float | None


class RecipientOutcomeBlock(ApiModel):
    facility_id: str
    facility_name: str
    stockout_day_before: int | None
    stockout_day_after: int | None
    stockout_prevented: bool
    shortage_days_before: int
    shortage_days_after: int
    unmet_demand_before: float
    unmet_demand_after: float


class SimulationComparisonBlock(ApiModel):
    recipient_stockout_prevented: bool
    recipient_outcomes: list[RecipientOutcomeBlock]
    new_shortages_created: list[str] = Field(description="IDs of facilities that gain a stockout or more shortage.")
    new_critical_facilities: list[str]
    new_risks: list[NewRiskBlock]
    improved_facilities: list[FacilityChangeBlock]
    worsened_facilities: list[FacilityChangeBlock]
    regional_shortage_days_before: int
    regional_shortage_days_after: int
    shortage_days_prevented: int
    regional_unmet_demand_before: float
    regional_unmet_demand_after: float
    unmet_demand_reduced: float
    critical_facility_delta: int
    regional_risk_before: int | None
    regional_risk_after: int | None
    regional_outcome: RegionalOutcome
    safe_to_recommend: bool
    summary: str


class SimulationDataContextBlock(ApiModel):
    data_source: Literal["FIXTURE", "MYSQL"]
    data_label: str
    simulation_date: dt.date
    as_of_date: dt.date
    history_start: dt.date
    history_end: dt.date
    unit: str
    mappings: list[DataMappingBlock]
    notes: list[str]


class SimulationResponse(ApiModel):
    scenario_type: Literal["SIMULATED_FIXTURE", "SIMULATED_DATABASE"]
    horizon_days: int
    medicine_id: str
    medicine: SimulationMedicineBlock
    baseline: RegionalStateBlock
    intervention: RegionalStateBlock
    transfer_evaluations: list[TransferEvaluationBlock]
    comparison: SimulationComparisonBlock
    assumptions: list[str]
    limitations: list[str]
    decision_support_only: Literal[True] = True
    data_context: SimulationDataContextBlock
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
