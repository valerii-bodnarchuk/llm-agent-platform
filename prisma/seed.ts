import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const buyer = await prisma.account.create({
    data: { name: 'Test Buyer', type: 'BUYER' },
  });

  const seller = await prisma.account.create({
    data: { name: 'Test Seller', type: 'SELLER' },
  });

  const escrow = await prisma.account.create({
    data: { name: 'Platform Escrow', type: 'ESCROW' },
  });

  const platformFee = await prisma.account.create({
    data: { name: 'Platform Fee', type: 'PLATFORM_FEE' },
  });

  console.log('Created accounts:', { buyer, seller, escrow, platformFee });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
