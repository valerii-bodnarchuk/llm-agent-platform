-- AlterEnum
-- Note: REVERSED is added as a terminal state representing intentional payout reversals,
-- distinct from FAILED (Stripe/system error). See next migration for index update.
ALTER TYPE "PayoutStatus" ADD VALUE 'REVERSED';
