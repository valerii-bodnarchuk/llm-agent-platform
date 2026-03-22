-- Update partial unique index to also exclude REVERSED.
-- Must be a separate migration from the ALTER TYPE ADD VALUE because PostgreSQL
-- does not allow referencing a new enum value in the same transaction it was added.
DROP INDEX IF EXISTS "Payout_active_per_transaction";
CREATE UNIQUE INDEX "Payout_active_per_transaction"
  ON "Payout" ("transactionId")
  WHERE status NOT IN ('PAID', 'FAILED', 'REVERSED');