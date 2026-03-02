from pydantic import BaseModel
from enum import Enum


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