"""
conftest.py — fixtures for E2E integration tests.

Provides:
- nestjs_client: httpx.AsyncClient connected to real NestJS server (localhost:3000)
- seed_blocked_payout: inserts a complete set of test records into PostgreSQL
  (seller + transaction + payout) and tears them down after the session.

Requirements before running:
  npm run docker:dev       # PostgreSQL + Redis
  npm run start:dev        # NestJS on :3000
  uvicorn app.main:app --reload --port 8000  # fraud engine on :8000
  npm run prisma:seed      # platform accounts must exist
"""
from __future__ import annotations

import dataclasses
import os
import uuid
from collections.abc import AsyncGenerator

import asyncpg
import httpx
import pytest
import pytest_asyncio

# ── Config ────────────────────────────────────────────────────────────────────

NESTJS_BASE_URL = os.getenv("NESTJS_BASE_URL", "http://localhost:3000")
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@127.0.0.1:5432/payment_system",
)


# ── Result type ───────────────────────────────────────────────────────────────

@dataclasses.dataclass(frozen=True)
class SeedResult:
    """IDs the tests need to address the seeded records."""
    transaction_id: int
    seller_id: int
    escrow_account_id: int   # platform ESCROW ledger account (pre-existing)
    seller_account_id: int   # seller's personal SELLER ledger account (created)


# ── Fixtures ──────────────────────────────────────────────────────────────────

@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def nestjs_client() -> AsyncGenerator[httpx.AsyncClient, None]:
    """
    Session-scoped httpx client pointing at the real NestJS server.
    Skips the whole session if the server is unreachable rather than failing
    each test individually.
    """
    async with httpx.AsyncClient(
        base_url=NESTJS_BASE_URL,
        timeout=15.0,
        headers={"Accept": "application/json"},
    ) as client:
        try:
            resp = await client.get("/health")
            resp.raise_for_status()
        except (httpx.RequestError, httpx.HTTPStatusError) as exc:
            pytest.skip(
                f"NestJS server not reachable at {NESTJS_BASE_URL}: {exc}. "
                "Start the server before running E2E tests."
            )
        yield client


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def seed_blocked_payout(nestjs_client: httpx.AsyncClient) -> AsyncGenerator[SeedResult, None]:  # noqa: ARG001
    """
    Inserts a complete test scenario into the database:

    - A fresh SELLER account + seller entity (ACTIVE, payoutsEnabled=True)
    - A COMPLETED transaction with balanced DEBIT/CREDIT ledger entries
    - A PENDING payout on that transaction with fraudDecision='BLOCK'

    The payout represents the typical fraud-blocked case the agent investigates.
    All created records are deleted during teardown.
    """
    conn = await asyncpg.connect(DATABASE_URL)
    suffix = uuid.uuid4().hex[:8]

    created: dict = {
        "payout_id": None,
        "entry_ids": [],
        "transaction_id": None,
        "seller_id": None,
        "seller_account_id": None,
        "buyer_account_id": None,
    }

    try:
        # ── Lookup pre-existing platform accounts ──────────────────────────
        escrow_row = await conn.fetchrow(
            'SELECT id FROM "Account" WHERE type = $1 ORDER BY id LIMIT 1',
            "ESCROW",
        )
        if not escrow_row:
            pytest.fail(
                "Platform ESCROW account not found. "
                "Run `npm run prisma:seed` to initialise the database."
            )
        escrow_account_id: int = escrow_row["id"]

        fee_row = await conn.fetchrow(
            'SELECT id FROM "Account" WHERE type = $1 ORDER BY id LIMIT 1',
            "PLATFORM_FEE",
        )
        if not fee_row:
            pytest.fail("Platform FEE account not found. Run `npm run prisma:seed`.")
        platform_fee_account_id: int = fee_row["id"]

        # ── Create test data inside a transaction ──────────────────────────
        async with conn.transaction():

            # Buyer account (DEBIT source)
            buyer_row = await conn.fetchrow(
                """
                INSERT INTO "Account" (name, type, "allowNegative", "createdAt")
                VALUES ($1, $2, TRUE, NOW())
                RETURNING id
                """,
                f"E2E Buyer {suffix}",
                "BUYER",
            )
            created["buyer_account_id"] = buyer_row["id"]

            # Seller ledger account
            seller_account_row = await conn.fetchrow(
                """
                INSERT INTO "Account" (name, type, "allowNegative", "createdAt")
                VALUES ($1, $2, TRUE, NOW())
                RETURNING id
                """,
                f"E2E Seller {suffix}",
                "SELLER",
            )
            seller_account_id: int = seller_account_row["id"]
            created["seller_account_id"] = seller_account_id

            # Seller entity (ACTIVE so risk-profile and timeline endpoints work)
            seller_row = await conn.fetchrow(
                """
                INSERT INTO "Seller" (
                    name, email, status, "accountId",
                    "stripeAccountId", "chargesEnabled", "payoutsEnabled",
                    "payoutsBlocked", "negativeBalance",
                    "createdAt", "updatedAt"
                ) VALUES (
                    $1, $2, 'ACTIVE', $3,
                    $4, TRUE, TRUE,
                    FALSE, 0,
                    NOW(), NOW()
                ) RETURNING id
                """,
                f"E2E Seller {suffix}",
                f"e2e-{suffix}@test.invalid",
                seller_account_id,
                f"acct_e2e_{suffix}",
            )
            seller_id: int = seller_row["id"]
            created["seller_id"] = seller_id

            # COMPLETED transaction
            tx_row = await conn.fetchrow(
                """
                INSERT INTO "Transaction" (description, status, "createdAt")
                VALUES ($1, 'COMPLETED', NOW())
                RETURNING id
                """,
                f"E2E test transaction {suffix}",
            )
            transaction_id: int = tx_row["id"]
            created["transaction_id"] = transaction_id

            # Balanced ledger entries: buyer DEBIT ↔ escrow CREDIT
            amount = 100_000  # €1 000 in cents
            e1 = await conn.fetchrow(
                """
                INSERT INTO "Entry" ("accountId", "transactionId", amount, type, "createdAt")
                VALUES ($1, $2, $3, 'DEBIT', NOW())
                RETURNING id
                """,
                created["buyer_account_id"],
                transaction_id,
                amount,
            )
            e2 = await conn.fetchrow(
                """
                INSERT INTO "Entry" ("accountId", "transactionId", amount, type, "createdAt")
                VALUES ($1, $2, $3, 'CREDIT', NOW())
                RETURNING id
                """,
                escrow_account_id,
                transaction_id,
                amount,
            )
            created["entry_ids"] = [e1["id"], e2["id"]]

            # PENDING payout with fraud decision recorded (BLOCK scenario)
            payout_amount = 50_000   # €500
            platform_fee = 2_500     # 5 %
            seller_amount = payout_amount - platform_fee

            payout_row = await conn.fetchrow(
                """
                INSERT INTO "Payout" (
                    status, amount, "platformFee", "sellerAmount",
                    "transactionId", "sellerId",
                    "escrowAccountId", "platformFeeAccountId",
                    attempts, "maxAttempts",
                    "fraudDecision", "fraudScore",
                    "createdAt", "updatedAt"
                ) VALUES (
                    'PENDING', $1, $2, $3,
                    $4, $5,
                    $6, $7,
                    0, 3,
                    'BLOCK', 0.85,
                    NOW(), NOW()
                ) RETURNING id
                """,
                payout_amount, platform_fee, seller_amount,
                transaction_id, seller_id,
                escrow_account_id, platform_fee_account_id,
            )
            created["payout_id"] = payout_row["id"]

        yield SeedResult(
            transaction_id=transaction_id,
            seller_id=seller_id,
            escrow_account_id=escrow_account_id,
            seller_account_id=seller_account_id,
        )

    finally:
        # Teardown — delete in reverse FK order
        async with conn.transaction():
            if created["payout_id"]:
                await conn.execute(
                    'DELETE FROM "Payout" WHERE id = $1',
                    created["payout_id"],
                )
            if created["entry_ids"]:
                await conn.execute(
                    'DELETE FROM "Entry" WHERE id = ANY($1::int[])',
                    created["entry_ids"],
                )
            if created["transaction_id"]:
                await conn.execute(
                    'DELETE FROM "Transaction" WHERE id = $1',
                    created["transaction_id"],
                )
            if created["seller_id"]:
                await conn.execute(
                    'DELETE FROM "Seller" WHERE id = $1',
                    created["seller_id"],
                )
            for account_id in (created["seller_account_id"], created["buyer_account_id"]):
                if account_id:
                    await conn.execute(
                        'DELETE FROM "Account" WHERE id = $1',
                        account_id,
                    )
        await conn.close()
