"""
Manual indexer for completed durable investigation runs.

This creates a deterministic JSON corpus that LocalCaseStore can load alongside
static seed cases. It does not use embeddings, ChromaDB, OpenAI, or network IO.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import asyncpg

from agent.config import DATABASE_URL, RAG_INDEX_PATH
from agent.rag.store import _risk_bucket


KEYWORD_SIGNALS = {
    "amount_threshold": "rule:amount_threshold",
    "velocity": "rule:velocity",
    "failed_history": "rule:failed_history",
    "new_account": "rule:new_account",
    "dispute_rate": "rule:dispute_rate",
    "active_dispute": "rule:active_dispute",
    "ledger_imbalanced": "rule:ledger_imbalanced",
    "ledger_inconsistency": "rule:ledger_inconsistency",
    "insufficient_escrow": "rule:insufficient_escrow",
    "seller_blocked": "rule:seller_blocked",
}


def _safe_json(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, str):
        return json.loads(value)
    return value


def _text_blob(verdict_payload: dict) -> str:
    parts = [
        verdict_payload.get("summary", ""),
        *verdict_payload.get("key_findings", []),
        *verdict_payload.get("recommended_actions", []),
    ]
    for evidence in verdict_payload.get("evidence", []):
        if isinstance(evidence, dict):
            parts.extend([
                evidence.get("source", ""),
                evidence.get("fact", ""),
                evidence.get("significance", ""),
            ])
    return " ".join(str(part) for part in parts).lower().replace(" ", "_")


def _signals_from_tool_calls(tool_calls: list[dict]) -> set[str]:
    signals: set[str] = set()
    for call in tool_calls:
        args = call.get("args") or {}
        fraud_decision = args.get("fraud_decision")
        if fraud_decision:
            signals.add(f"decision:{str(fraud_decision).strip().upper()}")

        risk = _risk_bucket(args.get("fraud_score"))
        if risk:
            signals.add(risk)

        for finding in args.get("findings") or []:
            normalized = str(finding).strip().lower().replace(" ", "_")
            if normalized:
                signals.add(normalized if ":" in normalized else f"rule:{normalized}")

    return signals


def build_case_from_run(row: dict) -> dict:
    verdict_payload = _safe_json(row.get("verdictPayload")) or {}
    tool_calls = _safe_json(row.get("toolCalls")) or []
    signals = _signals_from_tool_calls(tool_calls)

    risk_level = (row.get("riskLevel") or verdict_payload.get("risk_level") or "MEDIUM").upper()
    signals.add(f"risk:{risk_level.lower()}")

    blob = _text_blob(verdict_payload)
    for keyword, signal in KEYWORD_SIGNALS.items():
        if keyword in blob:
            signals.add(signal)

    if not signals:
        signals.add("data:partial")

    summary = (
        row.get("summary")
        or verdict_payload.get("summary")
        or f"Persisted investigation run #{row['id']}"
    )

    return {
        "case_id": f"run_{row['id']}",
        "verdict": row.get("verdict") or verdict_payload.get("verdict") or "INCONCLUSIVE",
        "risk_level": risk_level,
        "summary": summary,
        "signals": sorted(signals),
        "recommended_actions": verdict_payload.get("recommended_actions", []),
        "source": "investigation_run",
        "transaction_id": row.get("transactionId"),
        "completed_at": str(row.get("completedAt")) if row.get("completedAt") else None,
    }


async def index_completed_investigations(
    database_url: str | None = None,
    output_path: str | Path | None = None,
    limit: int = 500,
) -> dict:
    db_url = database_url if database_url is not None else DATABASE_URL
    if not db_url:
        return {"indexed": 0, "written": False, "reason": "DATABASE_URL not configured"}

    conn = await asyncpg.connect(db_url)
    try:
        rows = await conn.fetch(
            """
            SELECT id, "transactionId", trigger, verdict, confidence, "riskLevel",
                   summary, "verdictPayload", "toolCalls", "completedAt"
            FROM "InvestigationRun"
            WHERE verdict IS NOT NULL
            ORDER BY "completedAt" DESC
            LIMIT $1
            """,
            limit,
        )
    finally:
        await conn.close()

    cases = [build_case_from_run(dict(row)) for row in rows]
    target = Path(output_path or RAG_INDEX_PATH)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "InvestigationRun",
        "cases": cases,
    }, indent=2, default=str))

    return {"indexed": len(cases), "written": True, "path": str(target)}
