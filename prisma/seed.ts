import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const buyer = await prisma.account.create({
    data: { name: 'Test Buyer', type: 'BUYER' },
  });

  const escrow = await prisma.account.create({
    data: { name: 'Platform Escrow', type: 'ESCROW' },
  });

  console.log('Created accounts:', { buyer, escrow });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
