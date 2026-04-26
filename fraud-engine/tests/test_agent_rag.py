"""
Tests for deterministic similar-case retrieval.

These tests use the local seed store only: no ChromaDB, embeddings, OpenAI,
NestJS server, or network dependency.
"""
import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from langchain_core.messages import AIMessage

from agent.rag.store import LocalCaseStore, SimilarCaseQuery
from agent.tools.registry import ALL_TOOLS
from agent.tools.similar_cases import find_similar_cases


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


def test_empty_query_returns_no_matches():
    store = LocalCaseStore()

    result = store.search(SimilarCaseQuery(transaction_id=1))

    assert result == {"cases": [], "count": 0}


def test_ranked_matching_returns_most_relevant_case_first():
    store = LocalCaseStore()

    result = store.search(SimilarCaseQuery(
        transaction_id=1,
        seller_id=42,
        fraud_decision="REVIEW",
        fraud_score=0.45,
        findings=["amount_threshold"],
        limit=3,
    ))

    assert result["count"] >= 1
    assert result["cases"][0]["case_id"] == "case_amount_threshold_false_positive"
    assert result["cases"][0]["verdict"] == "FALSE_POSITIVE"
    assert "rule:amount_threshold" in result["cases"][0]["matched_signals"]


@pytest.mark.asyncio
async def test_tool_returns_structured_error_on_store_failure():
    broken_store = MagicMock()
    broken_store.search.side_effect = RuntimeError("store unavailable")

    with patch("agent.tools.similar_cases.get_case_store", return_value=broken_store):
        result = await find_similar_cases.ainvoke({
            "transaction_id": 1,
            "fraud_decision": "BLOCK",
            "findings": ["velocity"],
        })

    assert result["error"] is True
    assert result["tool"] == "find_similar_cases"
    assert result["cases"] == []
    assert result["count"] == 0
    assert "store unavailable" in result["detail"]


def test_registry_includes_find_similar_cases():
    tool_names = {tool.name for tool in ALL_TOOLS}

    assert "find_similar_cases" in tool_names


@pytest.mark.asyncio
async def test_graph_executes_mocked_llm_similar_cases_tool_call():
    call_count = 0

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
            patch("agent.nodes.nestjs_get", side_effect=mock_nestjs_get):
        from agent.graph import build_investigation_graph
        graph = build_investigation_graph()

        result = await graph.ainvoke({
            "transaction_id": 123,
            "trigger": "REVIEW",
        })

    assert result["verdict"]["verdict"] == "FALSE_POSITIVE"
    assert result["iteration"] == 2
    tool_messages = [
        msg for msg in result["messages"]
        if getattr(msg, "name", None) == "find_similar_cases"
    ]
    assert tool_messages
    assert "case_amount_threshold_false_positive" in tool_messages[0].content

