from pydantic import BaseModel, Field
from enum import Enum
from datetime import datetime, timezone


class Decision(str, Enum):
    ALLOW = "ALLOW"
    REVIEW = "REVIEW"
    BLOCK = "BLOCK"


class FraudCheckRequest(BaseModel):
    transaction_id: int
    seller_id: int
    amount: float
    currency: str = "EUR"
    seller_payout_count_24h: int = 0
    seller_total_amount_24h: float = 0.0
    seller_failed_payouts_7d: int = 0
    seller_account_age_days: int = 0
    seller_dispute_count: int = 0


class RuleResult(BaseModel):
    rule: str
    triggered: bool
    score: float
    reason: str | None = None


class FraudCheckResponse(BaseModel):
    transaction_id: int
    risk_score: float
    decision: Decision
    rules_triggered: list[RuleResult]
    explanation: str


class DetailedFraudCheckResponse(FraudCheckResponse):
    all_rules: list[RuleResult]
    config_version: str
    score_breakdown: dict[str, float]


class OutcomeReport(BaseModel):
    transaction_id: int
    original_decision: Decision
    actual_outcome: str
    reported_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class OutcomeStats(BaseModel):
    total_decisions: int
    outcomes_reported: int
    false_positives: int
    false_negatives: int
    precision: float | None
    recall: float | None
