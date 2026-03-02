from app.models import FraudCheckRequest, RuleResult


def check_velocity(req: FraudCheckRequest) -> RuleResult:
    """Too many payouts in 24h"""
    if req.seller_payout_count_24h >= 10:
        return RuleResult(rule="velocity", triggered=True, score=0.4, reason=f"{req.seller_payout_count_24h} payouts in 24h")
    if req.seller_payout_count_24h >= 5:
        return RuleResult(rule="velocity", triggered=True, score=0.2, reason=f"{req.seller_payout_count_24h} payouts in 24h")
    return RuleResult(rule="velocity", triggered=False, score=0.0)


def check_amount_threshold(req: FraudCheckRequest) -> RuleResult:
    """Single payout exceeds threshold"""
    if req.amount >= 10000:
        return RuleResult(rule="amount_threshold", triggered=True, score=0.5, reason=f"Amount €{req.amount} exceeds €10,000")
    if req.amount >= 5000:
        return RuleResult(rule="amount_threshold", triggered=True, score=0.2, reason=f"Amount €{req.amount} exceeds €5,000")
    return RuleResult(rule="amount_threshold", triggered=False, score=0.0)


def check_daily_volume(req: FraudCheckRequest) -> RuleResult:
    """Total daily volume too high"""
    total = req.seller_total_amount_24h + req.amount
    if total >= 50000:
        return RuleResult(rule="daily_volume", triggered=True, score=0.4, reason=f"Daily volume €{total} exceeds €50,000")
    if total >= 20000:
        return RuleResult(rule="daily_volume", triggered=True, score=0.15, reason=f"Daily volume €{total} exceeds €20,000")
    return RuleResult(rule="daily_volume", triggered=False, score=0.0)


def check_failed_history(req: FraudCheckRequest) -> RuleResult:
    """Recent failed payouts indicate risk"""
    if req.seller_failed_payouts_7d >= 5:
        return RuleResult(rule="failed_history", triggered=True, score=0.5, reason=f"{req.seller_failed_payouts_7d} failed payouts in 7d")
    if req.seller_failed_payouts_7d >= 2:
        return RuleResult(rule="failed_history", triggered=True, score=0.2, reason=f"{req.seller_failed_payouts_7d} failed payouts in 7d")
    return RuleResult(rule="failed_history", triggered=False, score=0.0)


def check_new_account(req: FraudCheckRequest) -> RuleResult:
    """New accounts are higher risk"""
    if req.seller_account_age_days < 7:
        return RuleResult(rule="new_account", triggered=True, score=0.3, reason=f"Account is {req.seller_account_age_days} days old")
    if req.seller_account_age_days < 30:
        return RuleResult(rule="new_account", triggered=True, score=0.1, reason=f"Account is {req.seller_account_age_days} days old")
    return RuleResult(rule="new_account", triggered=False, score=0.0)


def check_dispute_rate(req: FraudCheckRequest) -> RuleResult:
    """High dispute count"""
    if req.seller_dispute_count >= 3:
        return RuleResult(rule="dispute_rate", triggered=True, score=0.5, reason=f"{req.seller_dispute_count} disputes on record")
    if req.seller_dispute_count >= 1:
        return RuleResult(rule="dispute_rate", triggered=True, score=0.15, reason=f"{req.seller_dispute_count} dispute(s) on record")
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
    total_score = min(sum(r.score for r in results), 1.0)
    return total_score, results