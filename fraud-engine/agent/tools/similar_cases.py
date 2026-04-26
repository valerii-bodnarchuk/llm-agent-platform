"""
Tool: find_similar_cases

Read-only local retrieval over deterministic seed cases. This provides a
RAG-shaped signal without ChromaDB, embeddings, OpenAI, or network access.
"""
from langchain_core.tools import tool

from agent.config import SIMILAR_CASES_DEFAULT_LIMIT, SIMILAR_CASES_MAX_LIMIT
from agent.rag.store import SimilarCaseQuery, get_case_store


@tool
async def find_similar_cases(
    transaction_id: int,
    seller_id: int | None = None,
    fraud_decision: str | None = None,
    fraud_score: float | None = None,
    findings: list[str] | None = None,
    limit: int = SIMILAR_CASES_DEFAULT_LIMIT,
) -> dict:
    """Find historical cases with overlapping fraud rules, decisions, and risk.
    Use after collecting transaction/seller/fraud context. Results are advisory
    only and must not override hard evidence such as ledger imbalance, active
    dispute, seller block, or insufficient escrow."""

    try:
        bounded_limit = max(0, min(limit, SIMILAR_CASES_MAX_LIMIT))
        query = SimilarCaseQuery(
            transaction_id=transaction_id,
            seller_id=seller_id,
            fraud_decision=fraud_decision,
            fraud_score=fraud_score,
            findings=findings,
            limit=bounded_limit,
        )
        return get_case_store().search(query)
    except Exception as e:
        return {
            "error": True,
            "tool": "find_similar_cases",
            "detail": str(e),
            "cases": [],
            "count": 0,
        }
