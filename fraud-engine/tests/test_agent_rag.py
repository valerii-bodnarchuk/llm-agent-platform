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
from agent.rag.indexer import build_case_from_run, index_completed_investigations
from agent.persistence.audit import persist_investigation_run
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


def test_local_store_loads_indexed_cases(tmp_path):
    index_path = tmp_path / "indexed_cases.json"
    store = LocalCaseStore(cases=[], index_path=index_path)
    assert store.search(SimilarCaseQuery(
        transaction_id=99,
        fraud_decision="BLOCK",
        fraud_score=0.75,
        findings=["velocity"],
    )) == {"cases": [], "count": 0}

    index_path.write_text(json.dumps({
        "cases": [
            {
                "case_id": "run_42",
                "verdict": "TRUE_POSITIVE",
                "risk_level": "HIGH",
                "summary": "Persisted velocity investigation.",
                "signals": ["decision:BLOCK", "rule:velocity", "risk:high"],
                "recommended_actions": ["Keep payout blocked."],
            }
        ],
    }))

    result = store.search(SimilarCaseQuery(
        transaction_id=99,
        fraud_decision="BLOCK",
        fraud_score=0.75,
        findings=["velocity"],
    ))

    assert result["count"] == 1
    assert result["cases"][0]["case_id"] == "run_42"


def test_build_case_from_run_extracts_normalized_signals():
    case = build_case_from_run({
        "id": 7,
        "transactionId": 123,
        "verdict": "TRUE_POSITIVE",
        "riskLevel": "HIGH",
        "summary": "Velocity and failed history investigation.",
        "verdictPayload": {
            "summary": "Velocity spike with failed_history signals.",
            "key_findings": ["amount threshold also triggered"],
            "recommended_actions": ["Keep payout blocked."],
        },
        "toolCalls": [
            {
                "args": {
                    "fraud_decision": "BLOCK",
                    "fraud_score": 0.81,
                    "findings": ["velocity"],
                },
            }
        ],
        "completedAt": "2026-05-03T00:00:00",
    })

    assert case["case_id"] == "run_7"
    assert case["transaction_id"] == 123
    assert "decision:BLOCK" in case["signals"]
    assert "risk:high" in case["signals"]
    assert "rule:velocity" in case["signals"]
    assert "rule:failed_history" in case["signals"]
    assert "rule:amount_threshold" in case["signals"]


@pytest.mark.asyncio
async def test_persist_investigation_run_skips_without_database_url():
    result = await persist_investigation_run(
        {
            "transaction_id": 123,
            "trigger": "MANUAL",
            "verdict": {"verdict": "INCONCLUSIVE", "confidence": 0.1},
            "messages": [],
        },
        [{"timestamp": "2026-05-03T00:00:00+00:00", "action": "investigation_complete"}],
        database_url="",
    )

    assert result == {"persisted": False, "reason": "DATABASE_URL not configured"}


@pytest.mark.asyncio
async def test_index_completed_investigations_skips_without_database_url(tmp_path):
    result = await index_completed_investigations(
        database_url="",
        output_path=tmp_path / "indexed_cases.json",
    )

    assert result == {
        "indexed": 0,
        "written": False,
        "reason": "DATABASE_URL not configured",
    }


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
