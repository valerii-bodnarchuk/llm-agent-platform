from app.models import FraudCheckRequest, RuleResult
from app.config import CONFIG


def _cfg(rule_name: str) -> dict:
    return CONFIG["rules"][rule_name]


def check_velocity(req: FraudCheckRequest) -> RuleResult:
    """Too many payouts in 24h"""
    for tier in _cfg("velocity")["thresholds"]:
        if req.seller_payout_count_24h >= tier["min_count"]:
            return RuleResult(
                rule="velocity",
                triggered=True,
                score=tier["score"],
                reason=f"{req.seller_payout_count_24h} payouts in 24h",
            )
    return RuleResult(rule="velocity", triggered=False, score=0.0)


def check_amount_threshold(req: FraudCheckRequest) -> RuleResult:
    """Single payout exceeds threshold"""
    for tier in _cfg("amount_threshold")["thresholds"]:
        if req.amount >= tier["min_amount"]:
            return RuleResult(
                rule="amount_threshold",
                triggered=True,
                score=tier["score"],
                reason=f"Amount €{req.amount} exceeds €{tier['min_amount']}",
            )
    return RuleResult(rule="amount_threshold", triggered=False, score=0.0)


def check_daily_volume(req: FraudCheckRequest) -> RuleResult:
    """Total daily volume too high"""
    total = req.seller_total_amount_24h + req.amount
    for tier in _cfg("daily_volume")["thresholds"]:
        if total >= tier["min_volume"]:
            return RuleResult(
                rule="daily_volume",
                triggered=True,
                score=tier["score"],
                reason=f"Daily volume €{total} exceeds €{tier['min_volume']}",
            )
    return RuleResult(rule="daily_volume", triggered=False, score=0.0)


def check_failed_history(req: FraudCheckRequest) -> RuleResult:
    """Recent failed payouts indicate risk"""
    for tier in _cfg("failed_history")["thresholds"]:
        if req.seller_failed_payouts_7d >= tier["min_count"]:
            return RuleResult(
                rule="failed_history",
                triggered=True,
                score=tier["score"],
                reason=f"{req.seller_failed_payouts_7d} failed payouts in 7d",
            )
    return RuleResult(rule="failed_history", triggered=False, score=0.0)


def check_new_account(req: FraudCheckRequest) -> RuleResult:
    """New accounts are higher risk"""
    for tier in _cfg("new_account")["thresholds"]:
        if req.seller_account_age_days < tier["max_days"]:
            return RuleResult(
                rule="new_account",
                triggered=True,
                score=tier["score"],
                reason=f"Account is {req.seller_account_age_days} days old",
            )
    return RuleResult(rule="new_account", triggered=False, score=0.0)


def check_dispute_rate(req: FraudCheckRequest) -> RuleResult:
    """High dispute count"""
    for tier in _cfg("dispute_rate")["thresholds"]:
        if req.seller_dispute_count >= tier["min_count"]:
            return RuleResult(
                rule="dispute_rate",
                triggered=True,
                score=tier["score"],
                reason=f"{req.seller_dispute_count} dispute(s) on record",
            )
    return RuleResult(rule="dispute_rate", triggered=False, score=0.0)


ALL_RULES = [
    check_velocity,
    check_amount_threshold,
    check_daily_volume,
    check_failed_history,
    check_new_account,
    check_dispute_rate,
]


def evaluate(req: FraudCheckRequest) -> tuple[float, list[RuleResult]]:
    results = [rule(req) for rule in ALL_RULES]
    total_score = min(
        sum(r.score * _cfg(r.rule)["weight"] for r in results),
        1.0,
    )
    return total_score, results
