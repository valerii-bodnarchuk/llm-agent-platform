"""
End-to-end integration tests for the fraud investigation agent.

Architecture:
- Real NestJS server (localhost:3000) with real PostgreSQL
- Real fraud engine endpoints (localhost:8000)
- Mocked LLM — scripted tool-calling sequences for deterministic tests
- Real LangGraph execution — full graph traversal

What this validates:
1. Tools successfully call NestJS and parse responses
2. Graph state flows correctly through all nodes
3. collect_node front-loads data before reasoning
4. Routing logic works (tool calls → tools → reason loop)
5. Synthesis node produces parseable verdict
6. Audit trail is complete and ordered
7. Error handling when endpoints return 404

These tests are designed to run WITHOUT an OpenAI key.
"""
import json
from datetime import datetime
from unittest.mock import patch, AsyncMock, MagicMock

import httpx
import pytest

from langchain_core.messages import AIMessage


# ─── Helpers ─────────────────────────────────────────────────────


def make_tool_call_message(tool_name: str, args: dict, call_id: str = "call_1") -> AIMessage:
    """Create an AIMessage with a tool call — simulates LLM deciding to use a tool."""
    return AIMessage(
        content="",
        tool_calls=[{
            "name": tool_name,
            "args": args,
            "id": call_id,
        }],
    )


def make_completion_message() -> AIMessage:
    """Create an AIMessage that signals investigation is complete."""
    return AIMessage(content="I have gathered sufficient data.\n\nINVESTIGATION_COMPLETE")


def make_verdict_response(verdict: str = "FALSE_POSITIVE", confidence: float = 0.85) -> AIMessage:
    """Create an AIMessage with a JSON verdict — simulates synthesis output."""
    verdict_json = json.dumps({
        "verdict": verdict,
        "confidence": confidence,
        "risk_level": "low",
        "summary": "Test verdict — established seller with clean history hit an amount threshold.",
        "key_findings": [
            "Seller has 90+ day account age",
            "No disputes on record",
            "Amount threshold triggered at €500",
        ],
        "evidence": [
            {
                "source": "get_seller_risk_profile",
                "fact": "Account age 90 days, 0 disputes",
                "significance": "Established seller with clean record",
            }
        ],
        "recommended_actions": [
            "Consider adjusting amount_threshold for established sellers",
        ],
    })
    return AIMessage(content=verdict_json)


# ─── Tests ───────────────────────────────────────────────────────


@pytest.mark.asyncio
class TestAgentE2ECollectNode:
    """Test that the collect node successfully fetches real data from NestJS."""

    async def test_collect_node_fetches_transaction_data(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """collect_node should populate transaction_data from NestJS."""
        from agent.nodes import collect_node

        state = {
            "transaction_id": seed_blocked_payout.transaction_id,
            "trigger": "MANUAL",
            "audit_trail": [],
        }

        result = await collect_node(state)

        # Transaction data should be populated
        assert result["transaction_data"] is not None
        assert result["transaction_data"].get("error") is not True
        assert result["transaction_data"]["transactionId"] == seed_blocked_payout.transaction_id

    async def test_collect_node_fetches_seller_profile(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """collect_node should populate seller_profile from the risk-profile endpoint."""
        from agent.nodes import collect_node

        state = {
            "transaction_id": seed_blocked_payout.transaction_id,
            "trigger": "BLOCK",
            "audit_trail": [],
        }

        result = await collect_node(state)

        profile = result.get("seller_profile")
        # If the transaction has payouts, seller_profile should be populated
        if result["transaction_data"] and result["transaction_data"].get("hasPayouts"):
            assert profile is not None
            assert profile.get("error") is not True
            assert "seller" in profile
            assert "riskMetrics" in profile

    async def test_collect_node_populates_messages(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """collect_node should add system prompt + context as messages."""
        from agent.nodes import collect_node

        state = {
            "transaction_id": seed_blocked_payout.transaction_id,
            "trigger": "MANUAL",
            "audit_trail": [],
        }

        result = await collect_node(state)

        messages = result["messages"]
        assert len(messages) >= 2  # system + context
        # First should be system prompt
        assert "Senior Fraud Investigator" in messages[0].content
        # Second should contain transaction data
        assert str(seed_blocked_payout.transaction_id) in messages[1].content

    async def test_collect_node_records_audit_entry(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """collect_node should append an audit entry."""
        from agent.nodes import collect_node

        state = {
            "transaction_id": seed_blocked_payout.transaction_id,
            "trigger": "MANUAL",
            "audit_trail": [{"action": "investigation_started"}],
        }

        result = await collect_node(state)

        trail = result["audit_trail"]
        assert len(trail) >= 2
        collect_entry = trail[-1]
        assert collect_entry["action"] == "context_collected"
        assert "transaction_data_loaded" in collect_entry


@pytest.mark.asyncio
class TestAgentE2EToolsLive:
    """Test individual tools against the real NestJS server."""

    async def test_get_transaction_context_real(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """get_transaction_context should return real data from NestJS."""
        from agent.tools.transaction import get_transaction_context

        result = await get_transaction_context.ainvoke({
            "transaction_id": seed_blocked_payout.transaction_id,
        })

        assert result.get("error") is not True
        assert result["transactionId"] == seed_blocked_payout.transaction_id
        assert "transactionStatus" in result

    async def test_get_seller_risk_profile_real(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """get_seller_risk_profile should return real aggregated metrics."""
        from agent.tools.seller import get_seller_risk_profile

        result = await get_seller_risk_profile.ainvoke({
            "seller_id": seed_blocked_payout.seller_id,
        })

        assert result.get("error") is not True
        assert result["seller"]["id"] == seed_blocked_payout.seller_id
        assert "riskMetrics" in result
        assert isinstance(result["riskMetrics"]["totalPayouts"], int)
        assert isinstance(result["riskMetrics"]["accountAgeDays"], int)

    async def test_get_payout_timeline_real(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """get_payout_timeline should return real timeline data."""
        from agent.tools.timeline import get_payout_timeline

        result = await get_payout_timeline.ainvoke({
            "seller_id": seed_blocked_payout.seller_id,
            "days_back": 30,
        })

        assert result.get("error") is not True
        assert "timeline" in result
        assert "summary" in result
        assert result["summary"]["trend"] in ("increasing", "stable", "decreasing")

    async def test_check_ledger_consistency_real(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """check_ledger_consistency should return real integrity data."""
        from agent.tools.ledger import check_ledger_consistency

        result = await check_ledger_consistency.ainvoke({
            "escrow_account_id": seed_blocked_payout.escrow_account_id,
            "seller_account_id": seed_blocked_payout.seller_account_id,
        })

        assert "integrity" in result
        assert "escrow" in result
        assert "seller" in result
        # Seeded data should have balanced ledger
        if not result["integrity"].get("error"):
            assert result["integrity"]["balanced"] is True

    async def test_get_fraud_score_explanation_real(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """get_fraud_score_explanation should return real scoring from fraud engine."""
        from agent.tools.fraud_score import get_fraud_score_explanation

        result = await get_fraud_score_explanation.ainvoke({
            "transaction_id": seed_blocked_payout.transaction_id,
            "seller_id": seed_blocked_payout.seller_id,
            "amount": 50000,
            "seller_account_age_days": 90,
        })

        assert result.get("error") is not True
        assert "risk_score" in result
        assert "decision" in result
        assert "all_rules" in result
        assert len(result["all_rules"]) == 6  # all 6 rules returned

    async def test_tool_returns_error_for_nonexistent_seller(
        self, nestjs_client: httpx.AsyncClient,
    ):
        """Tools should return error dict for 404, not crash."""
        from agent.tools.seller import get_seller_risk_profile

        result = await get_seller_risk_profile.ainvoke({"seller_id": 99999})

        assert result.get("error") is True
        assert result.get("status_code") == 404


@pytest.mark.asyncio
class TestAgentE2EFullGraph:
    """
    Full graph execution with mocked LLM.

    The LLM mock follows a scripted sequence:
    1. First call (reason_node): returns a tool call for get_fraud_score_explanation
    2. Second call (reason_node after tool result): returns INVESTIGATION_COMPLETE
    3. Third call (synthesize_node): returns structured JSON verdict

    Everything else — graph routing, tool execution, HTTP calls, state management — is real.
    """

    async def test_full_investigation_with_mocked_llm(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """Full graph: start → collect → reason → tool → reason → synthesize → audit."""

        call_count = 0

        async def mock_ainvoke(messages, *args, **kwargs):
            nonlocal call_count
            call_count += 1

            if call_count == 1:
                # First reason call: ask for fraud score explanation
                return make_tool_call_message(
                    "get_fraud_score_explanation",
                    {
                        "transaction_id": seed_blocked_payout.transaction_id,
                        "seller_id": seed_blocked_payout.seller_id,
                        "amount": 50000,
                        "seller_account_age_days": 90,
                    },
                    call_id=f"call_{call_count}",
                )
            elif call_count == 2:
                # Second reason call: done investigating
                return make_completion_message()
            else:
                # Synthesis call: return verdict
                return make_verdict_response("FALSE_POSITIVE", 0.85)

        mock_llm = AsyncMock()
        mock_llm.ainvoke = mock_ainvoke
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        with patch("agent.nodes._get_llm", return_value=mock_llm):
            from agent.graph import build_investigation_graph
            graph = build_investigation_graph()

            result = await graph.ainvoke({
                "transaction_id": seed_blocked_payout.transaction_id,
                "trigger": "BLOCK",
            })

        # ── Assert verdict ──
        verdict = result.get("verdict")
        assert verdict is not None, "Graph produced no verdict"
        assert verdict["verdict"] == "FALSE_POSITIVE"
        assert verdict["confidence"] == 0.85
        assert verdict["risk_level"] == "low"
        assert len(verdict["key_findings"]) > 0
        assert len(verdict["evidence"]) > 0
        assert len(verdict["recommended_actions"]) > 0

        # ── Assert audit trail ──
        trail = result.get("audit_trail", [])
        actions = [e["action"] for e in trail]
        assert "investigation_started" in actions
        assert "context_collected" in actions
        assert "llm_reasoning" in actions
        assert "verdict_produced" in actions
        assert "investigation_complete" in actions

        # ── Assert iteration tracking ──
        assert result["iteration"] >= 2  # at least: reason(tool) + reason(complete)
        assert result["iteration"] <= 8  # never exceeds cap

    async def test_graph_handles_max_iterations(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """Graph should force-synthesize when iteration cap is reached."""

        call_count = 0

        async def mock_ainvoke_switch(messages, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count <= 10:
                # Keep calling tools until cap
                return make_tool_call_message(
                    "get_seller_risk_profile",
                    {"seller_id": seed_blocked_payout.seller_id},
                    call_id=f"call_{call_count}",
                )
            # After cap (this should be the synthesize call)
            return make_verdict_response("INCONCLUSIVE", 0.3)

        mock_llm = AsyncMock()
        mock_llm.ainvoke = mock_ainvoke_switch
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        with patch("agent.nodes._get_llm", return_value=mock_llm):
            from agent.graph import build_investigation_graph
            graph = build_investigation_graph()

            result = await graph.ainvoke({
                "transaction_id": seed_blocked_payout.transaction_id,
                "trigger": "MANUAL",
            })

        # Should have a verdict even though LLM never said INVESTIGATION_COMPLETE
        assert result.get("verdict") is not None
        # Iteration should be at or near the cap
        assert result["iteration"] >= 8

    async def test_graph_with_nonexistent_transaction(
        self, nestjs_client: httpx.AsyncClient,
    ):
        """Graph should handle 404 from NestJS gracefully."""

        call_count = 0

        async def mock_ainvoke(messages, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return make_completion_message()
            return make_verdict_response("INCONCLUSIVE", 0.1)

        mock_llm = AsyncMock()
        mock_llm.ainvoke = mock_ainvoke
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        with patch("agent.nodes._get_llm", return_value=mock_llm):
            from agent.graph import build_investigation_graph
            graph = build_investigation_graph()

            result = await graph.ainvoke({
                "transaction_id": 99999,
                "trigger": "MANUAL",
            })

        # Should still produce a verdict (INCONCLUSIVE)
        assert result.get("verdict") is not None
        # Transaction data should contain error
        tx_data = result.get("transaction_data")
        assert tx_data is not None
        assert tx_data.get("error") is True


@pytest.mark.asyncio
class TestAgentE2EAuditTrail:
    """Verify audit trail completeness and ordering."""

    async def test_audit_trail_is_ordered_chronologically(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """Audit entries should have monotonically increasing timestamps."""

        call_count = 0

        async def mock_ainvoke(messages, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return make_completion_message()
            return make_verdict_response()

        mock_llm = AsyncMock()
        mock_llm.ainvoke = mock_ainvoke
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        with patch("agent.nodes._get_llm", return_value=mock_llm):
            from agent.graph import build_investigation_graph
            graph = build_investigation_graph()

            result = await graph.ainvoke({
                "transaction_id": seed_blocked_payout.transaction_id,
                "trigger": "REVIEW",
            })

        trail = result["audit_trail"]
        assert len(trail) >= 4  # started, collected, reasoning, verdict, complete

        timestamps = [
            datetime.fromisoformat(e["timestamp"])
            for e in trail
            if "timestamp" in e
        ]
        for i in range(1, len(timestamps)):
            assert timestamps[i] >= timestamps[i - 1], (
                f"Audit trail not ordered: {timestamps[i-1]} > {timestamps[i]}"
            )

    async def test_audit_trail_contains_transaction_id(
        self, nestjs_client: httpx.AsyncClient, seed_blocked_payout,
    ):
        """Final audit entry should reference the transaction ID."""

        call_count = 0

        async def mock_ainvoke(messages, *args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return make_completion_message()
            return make_verdict_response()

        mock_llm = AsyncMock()
        mock_llm.ainvoke = mock_ainvoke
        mock_llm.bind_tools = MagicMock(return_value=mock_llm)

        with patch("agent.nodes._get_llm", return_value=mock_llm):
            from agent.graph import build_investigation_graph
            graph = build_investigation_graph()

            result = await graph.ainvoke({
                "transaction_id": seed_blocked_payout.transaction_id,
                "trigger": "MANUAL",
            })

        final = result["audit_trail"][-1]
        assert final["action"] == "investigation_complete"
        assert final["transaction_id"] == seed_blocked_payout.transaction_id
