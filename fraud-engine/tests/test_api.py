import json
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi.testclient import TestClient
from langchain_core.messages import AIMessage

from app.main import app

client = TestClient(app)


def make_tool_call_message(tool_name: str, args: dict, call_id: str = "call_1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{
            "name": tool_name,
            "args": args,
            "id": call_id,
        }],
    )


def make_completion_message() -> AIMessage:
    return AIMessage(content="INVESTIGATION_COMPLETE")


def make_verdict_response() -> AIMessage:
    return AIMessage(content=json.dumps({
        "verdict": "FALSE_POSITIVE",
        "confidence": 0.82,
        "risk_level": "low",
        "summary": "Similar amount-threshold cases supported a false-positive conclusion.",
        "key_findings": ["Amount threshold matched historical false positives."],
        "evidence": [
            {
                "source": "find_similar_cases",
                "fact": "Most similar case was an amount-threshold false positive.",
                "significance": "Supports calibration after direct evidence is checked.",
            }
        ],
        "recommended_actions": ["Manual approval after settlement confirmation."],
    }))


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


def test_investigate_route_uses_similar_cases_tool():
    call_count = 0
    captured_synthesis_prompt = {"content": ""}

    async def mock_ainvoke(messages, *args, **kwargs):
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return make_tool_call_message(
                "find_similar_cases",
                {
                    "transaction_id": 123,
                    "seller_id": 7,
                    "fraud_decision": "REVIEW",
                    "fraud_score": 0.45,
                    "findings": ["amount_threshold"],
                    "limit": 2,
                },
            )
        if call_count == 2:
            return make_completion_message()

        captured_synthesis_prompt["content"] = "\n".join(
            msg.content or ""
            for msg in messages
            if hasattr(msg, "content") and msg.content
        )
        return make_verdict_response()

    async def mock_nestjs_get(path: str, params: dict | None = None):  # noqa: ARG001
        if path == "/investigate/transaction/123":
            return {
                "transactionId": 123,
                "transactionStatus": "COMPLETED",
                "hasPayouts": True,
                "payoutReports": [{"sellerId": 7, "findings": []}],
            }
        if path == "/admin/sellers/7/risk-profile":
            return {"seller": {"id": 7}, "riskMetrics": {"totalDisputes": 0}}
        if path == "/admin/sellers/7/payout-timeline":
            return {"timeline": [], "summary": {"totalCount": 0}}
        return {"error": True, "detail": f"unexpected path {path}"}

    mock_llm = AsyncMock()
    mock_llm.ainvoke = mock_ainvoke
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with patch("agent.nodes._get_llm", return_value=mock_llm), \
            patch("agent.nodes.nestjs_get", new=mock_nestjs_get):
        response = client.post("/investigate", json={
            "transaction_id": 123,
            "trigger": "REVIEW",
        })

    assert response.status_code == 200
    data = response.json()
    assert data["transaction_id"] == 123
    assert data["verdict"]["verdict"] == "FALSE_POSITIVE"
    assert data["verdict"]["evidence"][0]["source"] == "find_similar_cases"
    assert isinstance(data["audit_trail"], list)
    actions = [entry["action"] for entry in data["audit_trail"]]
    assert "investigation_started" in actions
    assert "context_collected" in actions
    assert "llm_reasoning" in actions
    assert actions.count("llm_reasoning") == 2
    assert "verdict_produced" in actions
    assert "investigation_complete" in actions
    assert data["iterations_used"] == 2
    assert "case_amount_threshold_false_positive" in captured_synthesis_prompt["content"]
