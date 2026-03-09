/*
  Warnings:

  - The `fraudDecision` column on the `Payout` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "FraudDecision" AS ENUM ('ALLOW', 'REVIEW', 'BLOCK');

-- AlterTable
ALTER TABLE "Payout" DROP COLUMN "fraudDecision",
ADD COLUMN     "fraudDecision" "FraudDecision";
