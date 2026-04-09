"""
Tool: get_fraud_score_explanation

Calls the existing /check/explain endpoint on THIS service (fraud-engine).
Returns detailed rule-by-rule breakdown — which rules triggered, weighted scores,
config version. Agent uses this to understand WHY a transaction was flagged.

Note: calls localhost since this runs in the same process as the fraud engine.
"""
import httpx

from langchain_core.tools import tool

from agent.config import FRAUD_ENGINE_URL


@tool
async def get_fraud_score_explanation(
    transaction_id: int,
    seller_id: int,
    amount: int,
    seller_payout_count_24h: int = 0,
    seller_total_amount_24h: int = 0,
    seller_failed_payouts_7d: int = 0,
    seller_account_age_days: int = 0,
    seller_dispute_count: int = 0,
) -> dict:
    """Get detailed fraud score breakdown from the fraud engine.
    Returns risk_score, decision, all 6 rules with triggered/untriggered status,
    weighted score per rule, and human-readable explanation.
    Use this to understand exactly which fraud rules triggered and why."""

    payload = {
        "transaction_id": transaction_id,
        "seller_id": seller_id,
        "amount": amount,
        "seller_payout_count_24h": seller_payout_count_24h,
        "seller_total_amount_24h": seller_total_amount_24h,
        "seller_failed_payouts_7d": seller_failed_payouts_7d,
        "seller_account_age_days": seller_account_age_days,
        "seller_dispute_count": seller_dispute_count,
    }

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{FRAUD_ENGINE_URL}/check/explain",
                json=payload,
            )
            resp.raise_for_status()
            return resp.json()
    except (httpx.HTTPStatusError, httpx.RequestError) as e:
        return {
            "error": True,
            "tool": "get_fraud_score_explanation",
            "detail": str(e),
        }
