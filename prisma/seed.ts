import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Clear existing data (order matters for foreign keys)
  await prisma.entry.deleteMany();
  await prisma.dispute.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.seller.deleteMany();
  await prisma.account.deleteMany();

  // Core platform accounts
  const escrow = await prisma.account.create({
    data: { name: 'Platform Escrow', type: 'ESCROW' },
  });

  const platformFee = await prisma.account.create({
    data: { name: 'Platform Fee', type: 'PLATFORM_FEE' },
  });

  // Test buyer (allowNegative: buyer account tracks external charges)
  const buyer = await prisma.account.create({
    data: { name: 'Test Buyer', type: 'BUYER', allowNegative: true },
  });

  // Test seller with account
  const sellerAccount = await prisma.account.create({
    data: { name: 'Test Seller', type: 'SELLER', allowNegative: true },
  });

  const seller = await prisma.seller.create({
    data: {
      name: 'Test Seller',
      email: 'seller@test.com',
      accountId: sellerAccount.id,
      status: 'ACTIVE',
      chargesEnabled: true,
      payoutsEnabled: true,
      stripeAccountId: null, // no real Stripe account in seed
    },
  });

  // Fund buyer with initial balance (buyer CREDIT = money in)
  // And put money into escrow (simulating a completed payment)
  const fundingTx = await prisma.transaction.create({
    data: {
      description: 'Seed: initial buyer payment to escrow',
      status: 'COMPLETED',
      entries: {
        create: [
          { accountId: buyer.id, amount: 100000, type: 'DEBIT' },
          { accountId: escrow.id, amount: 100000, type: 'CREDIT' },
        ],
      },
    },
  });

  console.log('Seed complete:');
  console.log(`  Escrow account:       #${escrow.id}`);
  console.log(`  Platform Fee account: #${platformFee.id}`);
  console.log(`  Buyer account:        #${buyer.id} (balance: -100000 cents = -€1000)`);
  console.log(`  Seller account:       #${sellerAccount.id}`);
  console.log(`  Seller entity:        #${seller.id} (${seller.email})`);
  console.log(`  Escrow funded:        100000 cents = €1000 (from tx #${fundingTx.id})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });