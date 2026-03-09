-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "fraudDecision" TEXT,
ADD COLUMN     "fraudScore" DOUBLE PRECISION;
