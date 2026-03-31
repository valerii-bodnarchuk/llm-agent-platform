# Payment Processing System

Production-grade marketplace payment platform with escrow, seller payouts, and fraud detection.

**Stack:** NestJS · TypeScript · PostgreSQL · Prisma · Redis · BullMQ · Stripe Connect · Docker
**Fraud Engine:** Python · FastAPI · rule-based risk scoring

**Live:** [Swagger API](https://payment-processing-system-production.up.railway.app/api) · [Health Check](https://payment-processing-system-production.up.railway.app/health)

---

## What This Is

A mini payment platform that handles the full lifecycle: payment intake → escrow holding → fraud screening → seller payout → dispute resolution → reconciliation. Built as a portfolio project targeting senior fintech backend roles — every design decision is intentional and defensible.

The system processes payments through Stripe, holds funds in escrow via a double-entry ledger, screens payouts through a Python fraud engine, and reconciles internal state against Stripe on a schedule.

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│   Stripe      │────▶│  Webhooks    │────▶│  State Machine   │
│  (PaymentIntent,   │  (signature   │     │  (payout/dispute │
│   Connect,    │     │   verified)  │     │   transitions)   │
│   Disputes)   │◀────│              │     └────────┬─────────┘
└──────────────┘     └──────────────┘              │
                                                    ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────────┐
│  BullMQ       │────▶│  Payout      │────▶│  Double-Entry    │
│  (async jobs, │     │  Service     │     │  Ledger          │
│   cron,       │     │  (fraud gate,│     │  (immutable,     │
│   retries)    │     │   Stripe xfer│     │   atomic, balanced│
└──────────────┘     └──────┬───────┘     └──────────────────┘
                            │
                            ▼
                     ┌──────────────┐     ┌──────────────────┐
                     │  Fraud Engine │     │  Reconciliation  │
                     │  (Python,    │     │  (hourly + daily, │
                     │   6 rules,   │     │   Stripe vs       │
                     │   fail-open) │     │   ledger vs DB)   │
                     └──────────────┘     └──────────────────┘
```

### Money Flow

1. **Payment intake** — Buyer creates PaymentIntent via Stripe. Ledger books `BUYER DEBIT → ESCROW CREDIT` atomically. Idempotency via Redis (24h TTL).
2. **Webhook confirmation** — Stripe `payment_intent.succeeded` marks transaction COMPLETED. Lookup by `stripePaymentIntentId` (indexed, O(1)).
3. **Payout creation** — Platform creates payout with fee split. Fee calculation uses `calculateFee()` — rounds to nearest cent first, derives seller amount by subtraction. Zero float drift.
4. **Fraud gate** — Python engine scores payout (0.0–1.0). `< 0.3` ALLOW, `0.3–0.7` REVIEW, `≥ 0.7` BLOCK. Fail-open: engine down → REVIEW, not BLOCK.
5. **Stripe transfer** — Escrow balance validated before Stripe Transfer. Ledger books `ESCROW DEBIT → SELLER CREDIT + PLATFORM_FEE CREDIT` only after successful transfer.
6. **Reconciliation** — Hourly (24h window) and daily (all-time) jobs compare internal state vs Stripe. Detects: amount mismatches, orphaned transfers, reversed transfers, ledger imbalances.

### Payout State Machine

```
PENDING ──▶ ELIGIBLE ──▶ PROCESSING ──▶ PAID
                              │
                              ▼
                           FAILED ──▶ PROCESSING (retry, max 3)
```

Transitions enforced by `validateTransition()` — invalid transitions return 400. No implicit state changes.

### Dispute State Machine

```
OPEN ──▶ UNDER_REVIEW ──▶ WON (seller wins, unfreeze payout)
                     ├──▶ LOST (buyer wins, reverse payout)
                     └──▶ REFUNDED (full refund, escrow → buyer)
```

Opening a dispute auto-freezes pending/eligible payouts on that transaction.

---

## Design Decisions & Trade-offs

### Double-entry ledger — why not just track balances?

Balance tracking is simpler but loses auditability. With double-entry, every cent is traceable: you can reconstruct any account's balance from entries alone, detect tampering, and prove correctness. The ledger runs `verifyIntegrity()` checks: total debits must equal total credits across the entire system, and each transaction's entries must balance independently.

**Trade-off:** More writes per operation (N entries vs 1 balance update). Acceptable because financial correctness > write performance at this scale.

### Immutable ledger entries — why not update?

Corrections are appended as reversal entries, never by modifying existing rows. This matches how real accounting systems work: you don't erase history, you record adjustments. Makes audit trails unambiguous and prevents a class of bugs where partial updates leave the ledger inconsistent.

### Fee calculation via `calculateFee()` — why centralize?

Three call sites compute fee splits (createPayout, releasePayout, reversePayout). Before centralization, each did `amount * (percent / 100)` independently — JS float arithmetic. `calculateFee()` rounds fee to nearest cent first, then derives seller amount by subtraction. Invariant enforced: `fee + sellerAmount === amount`. Zero float drift on the entire money pipeline.

**Why not integer cents everywhere?** That requires a DB migration (`Decimal` → `Int`), API contract change, and rewriting all test fixtures. Tracked as a separate work item. The current approach eliminates arithmetic drift without those breaking changes.

### Fail-open fraud engine — why not fail-closed?

If the fraud engine is down and we fail-closed (BLOCK), legitimate sellers can't get paid. Platform revenue stops. Fail-open with REVIEW means payouts queue for manual review rather than being rejected. A human can release them once the engine recovers.

**Why not fail-silent (ALLOW)?** That defeats the purpose of fraud detection. REVIEW is the middle ground: no money moves without either automated approval or human review.

### Synchronous fraud check — why not async?

The fraud check runs in `markEligible()` before the payout enters PROCESSING. Async would mean payouts could enter PROCESSING before fraud scoring completes, requiring a rollback path from PROCESSING → BLOCKED. Synchronous is simpler and the latency (~50ms to the Python service) is acceptable for a batch payout pipeline.

### BullMQ for payout processing — why not process inline?

Stripe transfers can take seconds and may fail transiently. Processing inline in the HTTP request means the caller blocks and retries are the caller's problem. BullMQ gives us: automatic retries with exponential backoff, dead letter queue visibility, cron-scheduled daily batch payouts, and the ability to rate-limit outbound Stripe calls.

### Stripe Connect Express (not Custom) — why?

Express accounts handle KYC/identity verification entirely on Stripe's side. Custom accounts give more control but require the platform to build its own KYC flows — out of scope for this project and a regulatory liability in production. Express is what most marketplaces start with.

### No auth/RBAC — conscious omission

This project focuses on financial correctness, not access control. Auth is well-solved (JWT, OAuth, Passport.js) and doesn't demonstrate fintech-specific engineering. On an interview: "I chose to invest the complexity budget in the ledger, fraud engine, and reconciliation rather than reimplementing JWT auth."

### Integration tests over unit tests — why?

41+ integration test scenarios with real PostgreSQL, mocked Stripe SDK, and mocked fraud engine. These test actual state transitions, ledger balance invariants, and multi-service interactions. A unit test for `calculateFee()` exists because it's a pure function — but testing that `markEligible()` correctly blocks a fraudulent payout requires the full service stack. Every integration test asserts `assertLedgerBalanced()` at the end.

---

## System Invariants

These are enforced at runtime, not just by convention:

| Invariant | Enforcement | Failure Mode |
|-----------|-------------|--------------|
| Ledger always balances (Σ debits = Σ credits) | `verifyIntegrity()` SQL check, `assertLedgerBalanced()` in every integration test | Reconciliation alert |
| Every transaction's entries sum to zero | `createTransaction()` validates before write | Throws, no write |
| Ledger entries are immutable | No UPDATE on Entry table; corrections via reversal entries | Schema + code convention |
| All financial writes in DB transaction | `prisma.$transaction()` wrapping all ledger + state changes | Atomic rollback |
| Idempotent payment creation | Redis key with 24h TTL, checked before Stripe call | Returns cached result |
| Payout state transitions are validated | `validateTransition()` checks allowed transitions map | 400 Bad Request |
| Escrow balance checked before Stripe transfer | Balance query before `transfers.create()` | Payout → FAILED |
| Fee split sums to original amount | `calculateFee()` invariant assertion | Throws |
| Negative seller balance → automatic block | `updateSellerNegativeBalance()` after dispute reversal | `payoutsBlocked = true` |

---

## Failure Modes & Recovery

| Scenario | What Happens | Recovery |
|----------|-------------|----------|
| **Stripe transfer fails** | Payout → FAILED, ledger untouched (entries only created after successful transfer) | Auto-retry via BullMQ (max 3, exponential backoff) or manual `forceRetry` |
| **Fraud engine down** | Fail-open: payout scored as REVIEW (0.5) | Payout queued for manual review; engine recovery clears backlog |
| **Webhook arrives before payment intent created** | Transaction lookup returns null | Webhook logged and skipped; reconciliation catches it later |
| **Duplicate webhook delivery** | Transaction already COMPLETED | Idempotent: status update is a no-op |
| **Dispute on already-paid payout** | Payout reversed: mirror ledger entries, Stripe transfer reversal | If seller balance goes negative → `payoutsBlocked = true`, seller must settle |
| **Dispute on unpaid payout** | Payout frozen (stays PENDING/ELIGIBLE) | Resolution unfreezes (WON) or cancels (LOST/REFUNDED) |
| **Ledger imbalance detected** | `verifyIntegrity()` returns failing accounts/transactions | Manual investigation via admin endpoints; no auto-fix (immutable ledger) |
| **Orphaned Stripe transfer** | Transfer exists in Stripe but no matching payout | Reconciliation flags for manual review |
| **Redis down** | Idempotency checks fail (no cache) | Payments still process but lose duplicate protection; BullMQ jobs pause |

---

## Test Coverage

### Integration Tests (NestJS — `test/integration/`)

Full lifecycle tests with real PostgreSQL, mocked Stripe SDK, mocked fraud engine. Every test runs `assertLedgerBalanced()` after execution.

| Scenario | What It Verifies |
|----------|-----------------|
| Happy path: payment → payout → paid | Full money flow, ledger balances, Stripe transfer |
| Duplicate webhook idempotency | Same webhook twice → single state change |
| Fraud gate: ALLOW | Clean payout passes fraud check, reaches PAID |
| Fraud gate: BLOCK | High-risk payout blocked at eligibility |
| Fraud gate: REVIEW | Mid-risk payout flagged for manual review |
| Fraud engine down (fail-open) | Engine timeout → REVIEW, not BLOCK |
| Stripe transfer failure | Transfer throws → payout FAILED, ledger untouched |
| Dispute: seller wins | Payout unfrozen, seller receives funds |
| Dispute: buyer wins (reverse) | Payout reversed, mirror ledger entries |
| Dispute: full refund | Escrow → buyer, payout reversed if paid |
| Post-payout reversal | Reversal after PAID, seller balance may go negative |
| Payment idempotency | Same idempotency key → cached result returned |

### Unit Tests

| Suite | Count | Focus |
|-------|-------|-------|
| Payout state machine | 10 | Valid/invalid transitions |
| Dispute state machine | 9 | Valid/invalid transitions |
| Ledger service | 8 | Balance calculation, fee split, reversal, insufficient funds |
| Fee calculation | 7 | Float edge cases, invariant enforcement |

### Fraud Engine Tests (Python — `pytest`)

16 tests: individual rule checks (velocity, amount, new account), scoring thresholds (ALLOW/REVIEW/BLOCK), API contract validation.

---

## Modules

| Module | Path | Purpose |
|--------|------|---------|
| Ledger | `src/ledger/` | Double-entry bookkeeping, balance queries, integrity checks |
| Payment | `src/payment/` | Stripe PaymentIntent creation, idempotent intake |
| Payout | `src/payout/` | Full payout lifecycle, fraud gate, Stripe transfers, retry |
| Fraud | `src/fraud/` | HTTP client to Python fraud engine, fail-open fallback |
| Dispute | `src/dispute/` | Chargeback handling, payout freeze/reverse/refund |
| Seller | `src/seller/` | Stripe Connect onboarding, KYC sync |
| Webhook | `src/webhook/` | Stripe event processing (payment, account, dispute) |
| Queue | `src/queue/` | BullMQ async payout processing, daily cron |
| Reconciliation | `src/reconciliation/` | Stripe ↔ ledger ↔ DB sync, orphan detection |
| Admin | `src/admin/` | Payout stats, failed/blocked lists, force-retry, reversal |

---

## Quick Start

### Prerequisites

- Node.js 20+
- Docker & Docker Compose

### Local Development

```bash
# Start infrastructure (PostgreSQL + Redis)
npm run docker:dev

# Configure environment
cp .env.example .env
# Edit .env with your Stripe keys

# Install, generate, migrate, seed
npm install
npx prisma generate
npx prisma migrate deploy
npx prisma db seed

# Start dev server
npm run start:dev
```

Swagger: http://localhost:3000/api

### Fraud Engine

```bash
cd fraud-engine
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

### Run Tests

```bash
# NestJS (requires Docker running for PostgreSQL + Redis)
npm test

# Fraud engine
cd fraud-engine && pytest tests/ -v
```

### CI Pipeline

GitHub Actions runs: `tsc --noEmit` → Jest (with PostgreSQL + Redis service containers) → Docker build validation.

---

## Environment Variables

See `.env.example`. Key variables:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection (production) |
| `REDIS_HOST` / `REDIS_PORT` | Redis connection (local dev) |
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `FRAUD_ENGINE_URL` | Python fraud service (default: `http://localhost:8000`) |

---

## Production Notes

Things this system intentionally does not include (and why):

- **Auth/RBAC** — Solved problem. Complexity budget spent on financial correctness.
- **UUIDs for public IDs** — Autoincrement used for development speed. Production migration is straightforward.
- **NestJS ConfigModule** — `process.env` used directly. ConfigModule adds ceremony without improving correctness for this scope.
- **Separate agents per domain** — The investigation agent covers the full ops narrative. Separate reconciliation/payout/dispute agents would fragment the same data access pattern.
