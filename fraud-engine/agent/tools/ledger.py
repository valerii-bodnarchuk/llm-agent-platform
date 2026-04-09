"""
Tool: check_ledger_consistency

Calls two NestJS endpoints:
1. GET /ledger/integrity — global ledger balance check
2. GET /ledger/balance/:accountId — per-account balance (for escrow + seller)

Agent uses this when it sees a FAILED payout with stripeTransferId != null
(the critical failure mode where money moved but ledger didn't record it).
"""
from langchain_core.tools import tool

from agent.tools.nestjs_client import nestjs_get


@tool
async def check_ledger_consistency(
    escrow_account_id: int,
    seller_account_id: int,
) -> dict:
    """Check ledger integrity and account balances for the escrow and seller accounts
    involved in a transaction. Returns global balanced status, per-account balances,
    and any unbalanced transactions or orphaned entries.
    Use this when you suspect a ledger inconsistency — especially if a payout
    is FAILED but has a stripeTransferId (money moved without ledger posting)."""

    integrity = await nestjs_get("/ledger/integrity")
    escrow_balance = await nestjs_get(f"/ledger/balance/{escrow_account_id}")
    seller_balance = await nestjs_get(f"/ledger/balance/{seller_account_id}")

    # If any call errored, still return partial data
    return {
        "integrity": integrity,
        "escrow": escrow_balance,
        "seller": seller_balance,
    }
