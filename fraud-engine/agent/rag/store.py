"""
Local deterministic similar-case store.

Ranking is based on normalized signal overlap. This avoids network calls,
OpenAI embeddings, and ChromaDB while preserving the agent-facing RAG shape.
"""
from __future__ import annotations

from dataclasses import dataclass

from agent.rag.cases import SEED_CASES


@dataclass(frozen=True)
class SimilarCaseQuery:
    transaction_id: int
    seller_id: int | None = None
    fraud_decision: str | None = None
    fraud_score: float | None = None
    findings: list[str] | None = None
    limit: int = 3


def _normalize_signal(value: str) -> str:
    return value.strip().lower().replace(" ", "_")


def _risk_bucket(score: float | None) -> str | None:
    if score is None:
        return None
    if score >= 0.85:
        return "risk:critical"
    if score >= 0.7:
        return "risk:high"
    if score >= 0.3:
        return "risk:medium"
    return "risk:low"


def build_query_signals(query: SimilarCaseQuery) -> set[str]:
    """Convert tool input into the same signal vocabulary used by seed cases."""
    signals: set[str] = set()

    if query.fraud_decision:
        signals.add(f"decision:{query.fraud_decision.strip().upper()}")

    risk = _risk_bucket(query.fraud_score)
    if risk:
        signals.add(risk)

    for finding in query.findings or []:
        normalized = _normalize_signal(str(finding))
        if not normalized:
            continue
        if ":" in normalized:
            signals.add(normalized)
        else:
            signals.add(f"rule:{normalized}")

    return signals


class LocalCaseStore:
    """Read-only static case store with overlap ranking."""

    def __init__(self, cases: list[dict] | None = None):
        self._cases = cases if cases is not None else SEED_CASES

    def search(self, query: SimilarCaseQuery) -> dict:
        query_signals = build_query_signals(query)
        if not query_signals:
            return {"cases": [], "count": 0}

        ranked: list[dict] = []
        for case in self._cases:
            case_signals = {str(signal) for signal in case.get("signals", [])}
            matched = sorted(query_signals & case_signals)
            if not matched:
                continue

            denominator = len(query_signals | case_signals)
            similarity = round(len(matched) / denominator, 4) if denominator else 0.0
            ranked.append({
                "case_id": case["case_id"],
                "similarity": similarity,
                "verdict": case["verdict"],
                "risk_level": case["risk_level"],
                "summary": case["summary"],
                "matched_signals": matched,
                "recommended_actions": case["recommended_actions"],
            })

        ranked.sort(key=lambda item: (-item["similarity"], item["case_id"]))
        limited = ranked[:max(0, query.limit)]
        return {"cases": limited, "count": len(limited)}


_STORE = LocalCaseStore()


def get_case_store() -> LocalCaseStore:
    return _STORE

