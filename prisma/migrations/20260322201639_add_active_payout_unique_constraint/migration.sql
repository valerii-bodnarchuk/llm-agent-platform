-- Partial unique index: at most one non-terminal payout per transaction.
-- Terminal states (PAID, FAILED) are excluded so that:
-- 1. A PAID payout doesn't block the index (application guard handles that case).
-- 2. FAILED payouts can coexist (retries create new records).
-- This prevents two concurrent PENDING/ELIGIBLE/PROCESSING payouts for the same transaction.
CREATE UNIQUE INDEX "Payout_active_per_transaction"
  ON "Payout" ("transactionId")
  WHERE status NOT IN ('PAID', 'FAILED');