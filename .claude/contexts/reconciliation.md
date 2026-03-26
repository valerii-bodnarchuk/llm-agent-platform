# Reconciliation Context

## Overview

Three reconciliation surfaces, each with its own method and schedule:

| Surface | Method | Schedule |
|---------|--------|----------|
| Payment transactions vs Stripe PaymentIntents | `reconcileRecent()` / `reconcileAll()` | Hourly (24h window) / Daily (all-time) |
| Payout ledger vs Stripe Transfers | `reconcilePayouts()` | Daily |
| Ledger internal integrity | `reconcileLedger()` → `LedgerService.verifyIntegrity()` | On demand / daily |

## Files

```
src/reconciliation/
  reconciliation.service.ts      # Core logic
  reconciliation.controller.ts   # REST endpoints
  reconciliation.scheduler.ts    # Cron triggers
  reconciliation.module.ts
```

## Payment Reconciliation (`reconcileTransaction`)

Matches internal `Transaction.status` against Stripe `PaymentIntent.status`.

**Auto-fix cases**:
- Stripe `succeeded` + ours `PENDING` → update to `COMPLETED`
- Stripe `canceled`/`requires_payment_method` + ours `PENDING` → update to `FAILED`

**Skip condition**: transaction description doesn't contain a `pi_*` payment intent ID.

**Result statuses**: `ok` | `fixed` | `error` | `skipped`

## Payout Reconciliation (`reconcilePayouts`)

Compares `Payout.sellerAmount` (cents) against `Transfer.amount` (cents) from Stripe.

**Mismatch cases detected**:
1. `stripeAmount !== ourAmount` — amount mismatch
2. `transfer.reversed === true` + payout still `PAID` — orphaned reversal
3. Payout `FAILED` but has `stripeTransferId` — **critical**: money moved, ledger didn't post
4. Payout `PAID` but `stripeTransferId` is null — data integrity issue

Case 3 is the critical failure mode from `processPayout()` — Stripe succeeded but ledger `releasePayout()` threw. These require manual correction.

## Ledger Integrity (`reconcileLedger` → `verifyIntegrity`)

Three `$queryRaw` checks:
1. **Global balance**: `SUM(DEBIT) === SUM(CREDIT)` across all entries
2. **Per-transaction balance**: `GROUP BY transactionId HAVING debit != credit`
3. **Orphaned entries**: entries whose parent transaction was deleted (FK should prevent, defensive check)

Returns `LedgerIntegrityReport`:
```typescript
{
  balanced: boolean;
  globalDebits: number;
  globalCredits: number;
  globalDiff: number;
  unbalancedTransactions: number[];
  orphanedEntries: number[];
  checkedAt: Date;
}
```

Logs `warn` on imbalance, `info` on clean.

## REST Endpoints

```
GET  /reconciliation/recent        # Hourly scope (24h)
GET  /reconciliation/all           # Full history
GET  /reconciliation/payouts       # Payout vs Stripe check
GET  /reconciliation/ledger        # Ledger integrity report
GET  /ledger/integrity             # Direct integrity shortcut
```

## Cron Schedule (ReconciliationScheduler)

- Hourly: `reconcileRecent()`
- Daily: `reconcileAll()` + `reconcilePayouts()`

## Key Invariants

- Reconciliation only **reads** Stripe — never writes to it
- Payment fixes (`PENDING → COMPLETED/FAILED`) are the only auto-mutations
- Payout mismatches are flagged as `needs_manual_review` — never auto-corrected
- Ledger entries are immutable — integrity check only detects, never repairs
