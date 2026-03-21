from app.models import FraudCheckRequest, Decision
from app.rules.engine import evaluate, check_velocity, check_amount_threshold, check_new_account
from app.config import CONFIG
from app.main import build_explanation, score_to_decision


def make_request(**overrides) -> FraudCheckRequest:
    """Helper — clear request, all fields default besides overrides"""
    defaults = {
        "transaction_id": 1,
        "seller_id": 1,
        "amount": 500,
        "seller_payout_count_24h": 0,
        "seller_total_amount_24h": 0,
        "seller_failed_payouts_7d": 0,
        "seller_account_age_days": 90,
        "seller_dispute_count": 0,
    }
    defaults.update(overrides)
    return FraudCheckRequest(**defaults)


class TestVelocity:
    def test_low_velocity_no_trigger(self):
        result = check_velocity(make_request(seller_payout_count_24h=2))
        assert not result.triggered
        assert result.score == 0.0

    def test_medium_velocity_triggers(self):
        result = check_velocity(make_request(seller_payout_count_24h=6))
        assert result.triggered
        assert result.score == 0.2

    def test_high_velocity_triggers(self):
        result = check_velocity(make_request(seller_payout_count_24h=12))
        assert result.triggered
        assert result.score == 0.4


class TestAmountThreshold:
    def test_normal_amount_no_trigger(self):
        result = check_amount_threshold(make_request(amount=1000))
        assert not result.triggered

    def test_medium_amount_triggers(self):
        result = check_amount_threshold(make_request(amount=7000))
        assert result.triggered
        assert result.score == 0.2

    def test_high_amount_triggers(self):
        result = check_amount_threshold(make_request(amount=15000))
        assert result.triggered
        assert result.score == 0.5


class TestNewAccount:
    def test_old_account_no_trigger(self):
        result = check_new_account(make_request(seller_account_age_days=90))
        assert not result.triggered

    def test_new_account_triggers(self):
        result = check_new_account(make_request(seller_account_age_days=3))
        assert result.triggered
        assert result.score == 0.15


class TestEvaluate:
    def test_clean_transaction_allow(self):
        score, results = evaluate(make_request())
        assert score < 0.3
        triggered = [r for r in results if r.triggered]
        assert len(triggered) == 0

    def test_suspicious_transaction_review(self):
        score, results = evaluate(make_request(
            amount=7000,
            seller_account_age_days=5,
        ))
        assert 0.3 <= score < 0.7

    def test_dangerous_transaction_block(self):
        score, results = evaluate(make_request(
            amount=15000,
            seller_payout_count_24h=12,
            seller_failed_payouts_7d=5,
            seller_dispute_count=3,
        ))
        assert score >= 0.7

    def test_score_capped_at_one(self):
        score, _ = evaluate(make_request(
            amount=15000,
            seller_payout_count_24h=12,
            seller_failed_payouts_7d=6,
            seller_dispute_count=5,
            seller_account_age_days=1,
            seller_total_amount_24h=60000,
        ))
        assert score == 1.0


class TestConfig:
    def test_config_loads_expected_keys(self):
        assert "decision_boundaries" in CONFIG
        assert "rules" in CONFIG
        assert "version" in CONFIG
        for rule in ["velocity", "amount_threshold", "daily_volume",
                     "failed_history", "new_account", "dispute_rate"]:
            assert rule in CONFIG["rules"]
            assert "weight" in CONFIG["rules"][rule]
            assert "thresholds" in CONFIG["rules"][rule]

    def test_decision_boundaries_values(self):
        assert CONFIG["decision_boundaries"]["allow_below"] == 0.3
        assert CONFIG["decision_boundaries"]["block_above"] == 0.7

    def test_weight_scaling_changes_score(self):
        # Temporarily double the velocity weight and verify score increases
        original_weight = CONFIG["rules"]["velocity"]["weight"]
        try:
            CONFIG["rules"]["velocity"]["weight"] = 2.0
            req = make_request(seller_payout_count_24h=6)  # triggers velocity at 0.2
            score_doubled, _ = evaluate(req)
            CONFIG["rules"]["velocity"]["weight"] = original_weight
            score_normal, _ = evaluate(req)
            assert score_doubled > score_normal
        finally:
            CONFIG["rules"]["velocity"]["weight"] = original_weight


class TestExplanation:
    def test_allow_explanation(self):
        explanation = build_explanation(Decision.ALLOW, 0.1, [])
        assert explanation == "Transaction passed all checks (score: 0.1)"

    def test_review_explanation(self):
        from app.models import RuleResult
        triggered = [
            RuleResult(rule="amount_threshold", triggered=True, score=0.2, reason="Amount €7000 exceeds €5000"),
            RuleResult(rule="new_account", triggered=True, score=0.15, reason="Account is 3 days old"),
        ]
        explanation = build_explanation(Decision.REVIEW, 0.35, triggered)
        assert explanation.startswith("Flagged for review:")
        assert "amount_threshold" in explanation
        assert "Dominant factor: amount_threshold" in explanation
        assert "Score: 0.35" in explanation

    def test_block_explanation(self):
        from app.models import RuleResult
        triggered = [
            RuleResult(rule="amount_threshold", triggered=True, score=0.5, reason="Amount €15000 exceeds €10000"),
            RuleResult(rule="velocity", triggered=True, score=0.4, reason="12 payouts in 24h"),
            RuleResult(rule="failed_history", triggered=True, score=0.5, reason="5 failed payouts in 7d"),
        ]
        explanation = build_explanation(Decision.BLOCK, 1.0, triggered)
        assert explanation.startswith("Blocked:")
        assert "Primary risk:" in explanation
        assert "Combined score: 1.0" in explanation