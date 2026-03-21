from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_health():
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["status"] == "healthy"


def test_clean_transaction_returns_allow():
    response = client.post("/check", json={
        "transaction_id": 1,
        "seller_id": 1,
        "amount": 500,
        "seller_account_age_days": 90,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["decision"] == "ALLOW"
    assert data["risk_score"] < 0.3


def test_blocked_transaction():
    response = client.post("/check", json={
        "transaction_id": 2,
        "seller_id": 2,
        "amount": 15000,
        "seller_payout_count_24h": 12,
        "seller_failed_payouts_7d": 5,
        "seller_dispute_count": 3,
    })
    assert response.status_code == 200
    data = response.json()
    assert data["decision"] == "BLOCK"
    assert data["risk_score"] >= 0.7
    assert len(data["rules_triggered"]) >= 3


def test_invalid_request_returns_422():
    response = client.post("/check", json={"bad": "data"})
    assert response.status_code == 422


def test_check_response_includes_explanation():
    response = client.post("/check", json={
        "transaction_id": 10,
        "seller_id": 1,
        "amount": 500,
        "seller_account_age_days": 90,
    })
    assert response.status_code == 200
    data = response.json()
    assert "explanation" in data
    assert isinstance(data["explanation"], str)
    assert len(data["explanation"]) > 0


def test_check_explain_returns_full_breakdown():
    response = client.post("/check/explain", json={
        "transaction_id": 20,
        "seller_id": 2,
        "amount": 7000,
        "seller_account_age_days": 3,
    })
    assert response.status_code == 200
    data = response.json()
    # Inherits FraudCheckResponse fields
    assert "decision" in data
    assert "explanation" in data
    # Extra fields
    assert "all_rules" in data
    assert "config_version" in data
    assert "score_breakdown" in data
    # all_rules includes ALL 6 rules (triggered + untriggered)
    assert len(data["all_rules"]) == 6
    # score_breakdown has an entry per rule
    assert len(data["score_breakdown"]) == 6
    # config_version matches YAML
    from app.config import CONFIG
    assert data["config_version"] == CONFIG["version"]


def test_outcomes_post_and_stats():
    # Record a legitimate outcome for a REVIEW decision
    response = client.post("/outcomes", json={
        "transaction_id": 99,
        "original_decision": "REVIEW",
        "actual_outcome": "legitimate",
    })
    assert response.status_code == 200
    data = response.json()
    assert data["transaction_id"] == 99
    assert data["actual_outcome"] == "legitimate"

    # Stats endpoint returns expected schema
    stats = client.get("/outcomes/stats").json()
    assert "total_decisions" in stats
    assert "outcomes_reported" in stats
    assert "false_positives" in stats
    assert "false_negatives" in stats
    assert "precision" in stats
    assert "recall" in stats
    # At least the one outcome we just posted is counted
    assert stats["outcomes_reported"] >= 1


def test_outcomes_false_positive_counted():
    # A BLOCK on a legitimate transaction is a false positive
    before = client.get("/outcomes/stats").json()["false_positives"]
    client.post("/outcomes", json={
        "transaction_id": 100,
        "original_decision": "BLOCK",
        "actual_outcome": "legitimate",
    })
    after = client.get("/outcomes/stats").json()["false_positives"]
    assert after == before + 1
