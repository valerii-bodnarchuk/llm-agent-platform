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
