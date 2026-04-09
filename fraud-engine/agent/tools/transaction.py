"""
Tool: get_transaction_context

Fetches full transaction context from the existing NestJS investigation endpoint.
This is the primary data-loading tool — gives the agent the full picture of
one transaction including payouts, ledger entries, and disputes.
"""
from langchain_core.tools import tool

from agent.tools.nestjs_client import nestjs_get


@tool
async def get_transaction_context(transaction_id: int) -> dict:
    """Fetch full transaction context: transaction record, all payouts,
    ledger entries, and disputes for a given transaction_id.
    Use this first to understand what happened with a transaction."""

    result = await nestjs_get(f"/investigate/transaction/{transaction_id}")

    if isinstance(result, dict) and result.get("error"):
        return {
            "error": True,
            "tool": "get_transaction_context",
            "detail": result.get("detail", "Unknown error"),
        }

    return result
