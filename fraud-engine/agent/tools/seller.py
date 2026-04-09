"""
Tool: get_seller_risk_profile

Calls the new /admin/sellers/:id/risk-profile endpoint.
Returns seller record + ledger balance + computed risk metrics in one shot.
"""
from langchain_core.tools import tool

from agent.tools.nestjs_client import nestjs_get


@tool
async def get_seller_risk_profile(seller_id: int) -> dict:
    """Fetch aggregated seller risk profile: account info, ledger balance,
    payout velocity, dispute rate, volume trends, account age.
    Use this to understand the seller's overall risk posture."""

    result = await nestjs_get(f"/admin/sellers/{seller_id}/risk-profile")

    if isinstance(result, dict) and result.get("error"):
        return {
            "error": True,
            "tool": "get_seller_risk_profile",
            "detail": result.get("detail", "Unknown error"),
        }

    return result
