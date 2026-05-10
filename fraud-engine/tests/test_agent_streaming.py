"""
Tests for the investigation streaming endpoint.

Exercises the real FastAPI app, real LangGraph compilation and traversal, and
real SSE wire format — only the LLM and the NestJS HTTP client are mocked.
"""
from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from httpx import ASGITransport
from langchain_core.messages import AIMessage


# ─── SSE parser helper ───────────────────────────────────────────────


def _parse_sse_stream(body: str) -> list[dict]:
    """Parse a raw SSE response body into a list of {event, data} dicts.

    Frames are separated by a blank line; within a frame each line is either
    `event: <name>` or `data: <json>`. We only emit frames that have both.
    """
    events: list[dict] = []
    for raw_frame in body.split("\n\n"):
        if not raw_frame.strip():
            continue
        event_name: str | None = None
        data_lines: list[str] = []
        for line in raw_frame.splitlines():
            if line.startswith("event: "):
                event_name = line[len("event: ") :]
            elif line.startswith("data: "):
                data_lines.append(line[len("data: ") :])
        if event_name is None or not data_lines:
            continue
        events.append({
            "event": event_name,
            "data": json.loads("\n".join(data_lines)),
        })
    return events


# ─── LLM script helpers ──────────────────────────────────────────────


def _tool_call_message(name: str, args: dict, call_id: str = "call_1") -> AIMessage:
    return AIMessage(
        content="",
        tool_calls=[{"name": name, "args": args, "id": call_id}],
    )


def _completion_message() -> AIMessage:
    return AIMessage(content="INVESTIGATION_COMPLETE")


def _verdict_message(verdict: str = "FALSE_POSITIVE", confidence: float = 0.85) -> AIMessage:
    return AIMessage(content=json.dumps({
        "verdict": verdict,
        "confidence": confidence,
        "risk_level": "low",
        "summary": "Streaming test verdict.",
        "key_findings": ["finding-1"],
        "evidence": [{"source": "tool", "fact": "x", "significance": "y"}],
        "recommended_actions": ["approve"],
    }))


# ─── NestJS mock ─────────────────────────────────────────────────────


async def _mock_nestjs_get(path: str, params: dict | None = None):  # noqa: ARG001
    if path.startswith("/investigate/transaction/"):
        return {
            "transactionId": 123,
            "transactionStatus": "COMPLETED",
            "hasPayouts": True,
            "payoutReports": [{"sellerId": 7, "findings": []}],
        }
    if path == "/admin/sellers/7/risk-profile":
        return {"seller": {"id": 7}, "riskMetrics": {"totalDisputes": 0}}
    if path == "/admin/sellers/7/payout-timeline":
        return {"timeline": [], "summary": {"totalCount": 0, "trend": "stable"}}
    return {"error": True, "detail": f"unexpected path {path}"}


# ─── Tests ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stream_emits_node_events_in_graph_order():
    """The endpoint streams `start` → multiple `node` events → `done`, with the
    verdict appearing both inside the synthesize node delta and the terminal
    done event."""

    call_count = 0

    async def mock_ainvoke(messages, *args, **kwargs):  # noqa: ARG001
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return _tool_call_message(
                "find_similar_cases",
                {
                    "transaction_id": 123,
                    "fraud_decision": "REVIEW",
                    "fraud_score": 0.45,
                    "findings": ["amount_threshold"],
                    "limit": 2,
                },
            )
        if call_count == 2:
            return _completion_message()
        return _verdict_message("FALSE_POSITIVE", 0.85)

    mock_llm = AsyncMock()
    mock_llm.ainvoke = mock_ainvoke
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)

    with patch("agent.nodes._get_llm", return_value=mock_llm), \
            patch("agent.nodes.nestjs_get", side_effect=_mock_nestjs_get):
        from app.main import app

        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            resp = await client.post(
                "/investigate/stream",
                json={"transaction_id": 123, "trigger": "REVIEW"},
            )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")

    events = _parse_sse_stream(resp.text)
    assert events, "stream produced no parseable events"

    # ── Boundary events ──
    assert events[0]["event"] == "start"
    assert events[0]["data"]["transaction_id"] == 123
    assert events[0]["data"]["trigger"] == "REVIEW"

    assert events[-1]["event"] == "done"
    done = events[-1]["data"]
    assert done["transaction_id"] == 123
    assert done["verdict"]["verdict"] == "FALSE_POSITIVE"
    assert done["verdict"]["confidence"] == 0.85
    assert done["iterations_used"] >= 2

    # ── Node events ──
    node_events = [e for e in events if e["event"] == "node"]
    node_names = [e["data"]["node"] for e in node_events]

    # Graph topology: start → collect → reason → tools → reason → synthesize → audit
    for required in ("start", "collect", "reason", "synthesize", "audit"):
        assert required in node_names, f"node {required!r} missing from stream: {node_names}"

    # The synthesize node delta should carry the verdict on the wire so a
    # client can render the result before `done` arrives.
    synthesize_event = next(
        e for e in node_events if e["data"]["node"] == "synthesize"
    )
    assert synthesize_event["data"].get("verdict", {}).get("verdict") == "FALSE_POSITIVE"


@pytest.mark.asyncio
async def test_stream_emits_error_event_on_graph_failure():
    """If the underlying graph raises before producing a verdict, the stream
    should close with a single `error` event rather than a 500."""

    broken_graph = MagicMock()

    async def explode(*args, **kwargs):  # noqa: ARG001
        # Async generators can't `yield` after a raise; we want astream itself
        # to fail so the handler's try/except kicks in.
        raise RuntimeError("graph compilation poisoned")
        yield  # pragma: no cover — make this an async generator

    broken_graph.astream = explode

    with patch("agent.graph.investigation_graph", broken_graph):
        from app.main import app

        async with httpx.AsyncClient(
            transport=ASGITransport(app=app),
            base_url="http://test",
        ) as client:
            resp = await client.post(
                "/investigate/stream",
                json={"transaction_id": 999, "trigger": "MANUAL"},
            )

    assert resp.status_code == 200  # SSE responses always 200; errors ride the stream
    events = _parse_sse_stream(resp.text)

    # First event is still `start` — clients can render the request was accepted
    assert events[0]["event"] == "start"

    error_events = [e for e in events if e["event"] == "error"]
    assert len(error_events) == 1
    assert error_events[0]["data"]["transaction_id"] == 999
    assert "graph compilation poisoned" in error_events[0]["data"]["detail"]

    # No `done` event — the stream terminated on error
    assert not any(e["event"] == "done" for e in events)
