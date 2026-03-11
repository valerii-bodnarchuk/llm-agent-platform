from app.models import FraudCheckRequest
from app.rules.engine import evaluate, check_velocity, check_amount_threshold, check_new_account


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