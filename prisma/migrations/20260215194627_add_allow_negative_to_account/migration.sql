-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "allowNegative" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Seller" ADD COLUMN     "negativeBalance" DECIMAL(65,30) NOT NULL DEFAULT 0,
ADD COLUMN     "payoutsBlocked" BOOLEAN NOT NULL DEFAULT false;
