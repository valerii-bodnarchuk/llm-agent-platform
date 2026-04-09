"""
Graph nodes — each function is a node in the LangGraph state machine.

Nodes:
- start_node: validates input, initializes state
- collect_node: parallel data fetch (transaction + seller + timeline)
- reason_node: LLM ReAct step — analyze data, decide next action
- synthesize_node: LLM produces structured verdict
- audit_node: persists the audit trail
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone

from langchain_core.messages import HumanMessage, SystemMessage

from agent.config import MAX_ITERATIONS, OPENAI_MODEL
from agent.prompts import REACT_SYSTEM_PROMPT, SYNTHESIS_PROMPT
from agent.state import InvestigationState
from agent.tools.nestjs_client import nestjs_get
from agent.tools.registry import ALL_TOOLS

logger = logging.getLogger("agent.nodes")


def _get_llm():
    """Lazy LLM init — avoids import-time API key requirement for tests."""
    from langchain_openai import ChatOpenAI
    return ChatOpenAI(model=OPENAI_MODEL, temperature=0)


# ── Start ────────────────────────────────────────────────────────

async def start_node(state: InvestigationState) -> dict:
    """Validate input and initialize tracking fields."""
    tx_id = state["transaction_id"]
    trigger = state.get("trigger", "MANUAL")

    logger.info(f"Starting investigation for transaction {tx_id} (trigger: {trigger})")

    return {
        "iteration": 0,
        "audit_trail": [
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "action": "investigation_started",
                "transaction_id": tx_id,
                "trigger": trigger,
            }
        ],
        "verdict": None,
        "transaction_data": None,
        "seller_profile": None,
        "payout_timeline": None,
        "fraud_score_detail": None,
        "ledger_check": None,
    }


# ── Collect ──────────────────────────────────────────────────────

async def collect_node(state: InvestigationState) -> dict:
    """
    Parallel data fetch — get transaction context before the reasoning loop.
    This is deterministic, not LLM-driven. Every investigation needs this data.
    """
    import asyncio

    tx_id = state["transaction_id"]

    # Fetch transaction context (includes payouts, entries, disputes)
    tx_data = await nestjs_get(f"/investigate/transaction/{tx_id}")

    # Extract seller_id from first payout if available
    seller_id = None
    if tx_data and not tx_data.get("error") and tx_data.get("payoutReports"):
        seller_id = tx_data["payoutReports"][0].get("sellerId")
    elif tx_data and not tx_data.get("error") and tx_data.get("hasPayouts") is False:
        pass  # No payouts — seller_id stays None

    # Parallel fetch seller profile + timeline if we have a seller
    seller_profile = None
    payout_timeline = None
    if seller_id:
        seller_profile, payout_timeline = await asyncio.gather(
            nestjs_get(f"/admin/sellers/{seller_id}/risk-profile"),
            nestjs_get(f"/admin/sellers/{seller_id}/payout-timeline"),
        )

    # Build initial context message for the LLM
    context_parts = [f"## Investigation: Transaction #{tx_id}\n"]
    context_parts.append(f"**Trigger:** {state.get('trigger', 'MANUAL')}\n")

    if tx_data and not tx_data.get("error"):
        context_parts.append(f"**Transaction data:**\n```json\n{json.dumps(tx_data, indent=2, default=str)[:3000]}\n```\n")
    else:
        context_parts.append(f"**Transaction data:** ERROR — {tx_data}\n")

    if seller_profile and not seller_profile.get("error"):
        context_parts.append(f"**Seller risk profile:**\n```json\n{json.dumps(seller_profile, indent=2, default=str)[:2000]}\n```\n")

    if payout_timeline and not payout_timeline.get("error"):
        context_parts.append(f"**Payout timeline:**\n```json\n{json.dumps(payout_timeline, indent=2, default=str)[:2000]}\n```\n")

    context_parts.append(
        "\nAnalyze this data. If you need more information, call a tool. "
        "If you have enough to form a verdict, respond with INVESTIGATION_COMPLETE."
    )

    context_message = HumanMessage(content="\n".join(context_parts))

    audit_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "context_collected",
        "transaction_data_loaded": tx_data is not None and not tx_data.get("error"),
        "seller_profile_loaded": seller_profile is not None and not (seller_profile or {}).get("error"),
        "payout_timeline_loaded": payout_timeline is not None and not (payout_timeline or {}).get("error"),
    }

    return {
        "transaction_data": tx_data,
        "seller_profile": seller_profile,
        "payout_timeline": payout_timeline,
        "messages": [
            SystemMessage(content=REACT_SYSTEM_PROMPT.format(max_iterations=MAX_ITERATIONS)),
            context_message,
        ],
        "audit_trail": state.get("audit_trail", []) + [audit_entry],
    }


# ── Reason (ReAct) ───────────────────────────────────────────────

async def reason_node(state: InvestigationState) -> dict:
    """
    LLM reasoning step. The model either:
    1. Calls a tool → routed to tool execution → loops back here
    2. Says INVESTIGATION_COMPLETE → routed to synthesize
    3. Hits iteration cap → forced to synthesize
    """
    llm = _get_llm().bind_tools(ALL_TOOLS)
    response = await llm.ainvoke(state["messages"])

    new_iteration = state.get("iteration", 0) + 1

    audit_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "llm_reasoning",
        "iteration": new_iteration,
        "has_tool_calls": bool(response.tool_calls),
        "content_preview": (response.content or "")[:200],
    }

    return {
        "messages": [response],
        "iteration": new_iteration,
        "audit_trail": state.get("audit_trail", []) + [audit_entry],
    }


# ── Synthesize ───────────────────────────────────────────────────

async def synthesize_node(state: InvestigationState) -> dict:
    """
    Final verdict generation. Uses a separate prompt that forces
    structured JSON output. Does NOT have tool access.
    """
    llm = _get_llm()

    # Build synthesis request with all collected data
    synthesis_messages = [
        SystemMessage(content=SYNTHESIS_PROMPT),
        HumanMessage(content=(
            "Here is the full investigation context from the reasoning steps:\n\n"
            + "\n".join(
                msg.content or ""
                for msg in state.get("messages", [])
                if hasattr(msg, "content") and msg.content
            )[-6000:]  # trim to last ~6k chars to fit context
        )),
    ]

    response = await llm.ainvoke(synthesis_messages)

    # Parse the JSON verdict
    verdict = None
    try:
        raw = response.content.strip()
        # Strip markdown fences if the LLM wraps them anyway
        if raw.startswith("```"):
            raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        verdict = json.loads(raw.strip())
    except (json.JSONDecodeError, IndexError):
        logger.error(f"Failed to parse verdict JSON: {response.content[:500]}")
        verdict = {
            "verdict": "INCONCLUSIVE",
            "confidence": 0.1,
            "risk_level": "medium",
            "summary": "Agent failed to produce structured output. Raw response available in audit trail.",
            "key_findings": [],
            "evidence": [],
            "recommended_actions": ["Manual review required — agent output parsing failed."],
        }

    audit_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "verdict_produced",
        "verdict": verdict.get("verdict"),
        "confidence": verdict.get("confidence"),
        "risk_level": verdict.get("risk_level"),
    }

    return {
        "verdict": verdict,
        "audit_trail": state.get("audit_trail", []) + [audit_entry],
    }


# ── Audit ────────────────────────────────────────────────────────

async def audit_node(state: InvestigationState) -> dict:
    """
    Persist audit trail. For v1: log to stdout (structured JSON).
    Production: append to PostgreSQL audit table or append-only file.
    """
    trail = state.get("audit_trail", [])

    final_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "action": "investigation_complete",
        "transaction_id": state["transaction_id"],
        "verdict": state.get("verdict", {}).get("verdict"),
        "total_iterations": state.get("iteration", 0),
        "total_audit_entries": len(trail) + 1,
    }

    full_trail = trail + [final_entry]

    logger.info(
        json.dumps({
            "audit_trail": full_trail,
            "transaction_id": state["transaction_id"],
        }, default=str)
    )

    return {"audit_trail": full_trail}
