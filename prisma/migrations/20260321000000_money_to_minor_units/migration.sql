-- Convert all monetary columns from major units (Decimal) to minor units (Integer cents)
-- Existing values are multiplied by 100 so €1000.00 → 100000 cents
ALTER TABLE "Entry" ALTER COLUMN "amount" TYPE INTEGER USING (amount * 100)::integer;
ALTER TABLE "Payout" ALTER COLUMN "amount" TYPE INTEGER USING (amount * 100)::integer;
ALTER TABLE "Payout" ALTER COLUMN "platformFee" TYPE INTEGER USING ("platformFee" * 100)::integer;
ALTER TABLE "Payout" ALTER COLUMN "sellerAmount" TYPE INTEGER USING ("sellerAmount" * 100)::integer;
ALTER TABLE "Dispute" ALTER COLUMN "amount" TYPE INTEGER USING (amount * 100)::integer;
ALTER TABLE "Seller" ALTER COLUMN "negativeBalance" TYPE INTEGER USING ("negativeBalance" * 100)::integer;
