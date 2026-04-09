"""
Tests for agent tools — unit tests with mocked NestJS responses.
These run without a real NestJS server or OpenAI key.
"""
import pytest
import httpx
from unittest.mock import AsyncMock, MagicMock, patch

from agent.tools.transaction import get_transaction_context
from agent.tools.seller import get_seller_risk_profile
from agent.tools.timeline import get_payout_timeline
from agent.tools.ledger import check_ledger_consistency
from agent.tools.fraud_score import get_fraud_score_explanation


# ── Fixtures ─────────────────────────────────────────────────────

MOCK_TRANSACTION = {
    "transactionId": 1,
    "transactionStatus": "COMPLETED",
    "hasPayouts": True,
    "payoutReports": [
        {
            "payoutId": 1,
            "sellerId": 1,
            "payoutStatus": "FAILED",
            "amount": 50000,
            "findings": [{"rule": "fraud_blocked", "severity": "critical"}],
        }
    ],
}

MOCK_RISK_PROFILE = {
    "seller": {
        "id": 1,
        "name": "Test Seller",
        "status": "ACTIVE",
        "payoutsBlocked": False,
        "accountAgeDays": 90,
    },
    "ledger": {"accountId": 2, "balance": 50000},
    "riskMetrics": {
        "totalPayouts": 10,
        "paidPayouts": 8,
        "failedPayouts": 2,
        "payoutVelocity24h": 1,
        "totalDisputes": 0,
    },
}

MOCK_TIMELINE = {
    "timeline": [
        {"payoutId": 1, "amount": 50000, "status": "PAID", "fraudDecision": None},
    ],
    "summary": {
        "totalCount": 1,
        "statusDistribution": {"PAID": 1},
        "avgAmount": 50000,
        "trend": "stable",
    },
}


# ── Tool Tests ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_transaction_context_success():
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()
        mock_response = MagicMock()  # sync: .json() and .raise_for_status() are not coroutines
        mock_response.json.return_value = MOCK_TRANSACTION
        mock_response.raise_for_status = lambda: None
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await get_transaction_context.ainvoke({"transaction_id": 1})

    assert result["transactionId"] == 1
    assert result["hasPayouts"] is True


@pytest.mark.asyncio
async def test_get_transaction_context_not_found():
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.status_code = 404
        mock_response.text = "Not found"
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            "Not found", request=MagicMock(), response=mock_response
        )
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await get_transaction_context.ainvoke({"transaction_id": 99999})

    assert result["error"] is True


@pytest.mark.asyncio
async def test_get_seller_risk_profile_success():
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.json.return_value = MOCK_RISK_PROFILE
        mock_response.raise_for_status = lambda: None
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await get_seller_risk_profile.ainvoke({"seller_id": 1})

    assert result["seller"]["id"] == 1
    assert result["riskMetrics"]["totalPayouts"] == 10


@pytest.mark.asyncio
async def test_get_payout_timeline_success():
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()
        mock_response = MagicMock()
        mock_response.json.return_value = MOCK_TIMELINE
        mock_response.raise_for_status = lambda: None
        mock_client.get = AsyncMock(return_value=mock_response)
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await get_payout_timeline.ainvoke({"seller_id": 1, "days_back": 30})

    assert result["summary"]["trend"] == "stable"
    assert len(result["timeline"]) == 1


@pytest.mark.asyncio
async def test_check_ledger_consistency_success():
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()

        integrity_resp = MagicMock()
        integrity_resp.json.return_value = {"balanced": True, "globalDiff": 0}
        integrity_resp.raise_for_status = lambda: None

        balance_resp = MagicMock()
        balance_resp.json.return_value = {"accountId": 3, "balance": 50000}
        balance_resp.raise_for_status = lambda: None

        mock_client.get = AsyncMock(side_effect=[integrity_resp, balance_resp, balance_resp])
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await check_ledger_consistency.ainvoke({
            "escrow_account_id": 3,
            "seller_account_id": 2,
        })

    assert result["integrity"]["balanced"] is True


@pytest.mark.asyncio
async def test_get_fraud_score_explanation_success():
    mock_response_data = {
        "transaction_id": 1,
        "risk_score": 0.85,
        "decision": "BLOCK",
        "all_rules": [],
        "score_breakdown": {},
        "config_version": "1.0.0",
        "explanation": "Blocked: high risk",
    }

    with patch("httpx.AsyncClient") as MockAsyncClient:
        mock_instance = AsyncMock()
        mock_resp = MagicMock()  # httpx.Response.json() is sync
        mock_resp.json.return_value = mock_response_data
        mock_resp.raise_for_status = lambda: None
        mock_instance.post = AsyncMock(return_value=mock_resp)
        mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
        mock_instance.__aexit__ = AsyncMock(return_value=None)
        MockAsyncClient.return_value = mock_instance

        result = await get_fraud_score_explanation.ainvoke({
            "transaction_id": 1,
            "seller_id": 1,
            "amount": 50000,
        })

    assert result["decision"] == "BLOCK"
    assert result["risk_score"] == 0.85


@pytest.mark.asyncio
async def test_tool_handles_connection_error():
    """All tools should return error dict on connection failure, never raise."""
    with patch("agent.tools.nestjs_client.get_client") as mock_client_fn:
        mock_client = AsyncMock()
        mock_client.get.side_effect = httpx.ConnectError("Connection refused")
        mock_client.is_closed = False
        mock_client_fn.return_value = mock_client

        result = await get_transaction_context.ainvoke({"transaction_id": 1})

    assert result["error"] is True
    assert "Connection" in result["detail"]
