"""
Tool: get_payout_timeline

Calls /admin/sellers/:id/payout-timeline.
Returns chronological payouts with status distribution and trend analysis.
Designed for pattern detection — velocity spikes, failure clustering.
"""
from langchain_core.tools import tool

from agent.tools.nestjs_client import nestjs_get


@tool
async def get_payout_timeline(seller_id: int, days_back: int = 30) -> dict:
    """Fetch chronological payout timeline for a seller.
    Returns time-ordered payouts with fraud decisions, failure reasons,
    time-to-completion, and a summary with status distribution and volume trend.
    Use this to detect temporal patterns — velocity spikes, failure clustering."""

    result = await nestjs_get(
        f"/admin/sellers/{seller_id}/payout-timeline",
        params={"daysBack": days_back},
    )

    if isinstance(result, dict) and result.get("error"):
        return {
            "error": True,
            "tool": "get_payout_timeline",
            "detail": result.get("detail", "Unknown error"),
        }

    return result
