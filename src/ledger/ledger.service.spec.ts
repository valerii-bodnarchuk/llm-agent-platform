import { Test, TestingModule } from '@nestjs/testing';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { getLoggerToken } from 'nestjs-pino';

describe('LedgerService', () => {
  let service: LedgerService;
  let prisma: PrismaService;

  let buyerId: number;
  let sellerId: number;
  let escrowId: number;
  let platformFeeId: number;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        PrismaService,
        {
          provide: getLoggerToken(LedgerService.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;

    const buyer = await prisma.account.create({
      data: { name: 'Test Buyer', type: 'BUYER' },
    });
    const seller = await prisma.account.create({
      data: { name: 'Test Seller', type: 'SELLER' },
    });
    const escrow = await prisma.account.create({
      data: { name: 'Escrow', type: 'ESCROW' },
    });
    const fee = await prisma.account.create({
      data: { name: 'Platform Fee', type: 'PLATFORM_FEE' },
    });

    buyerId = buyer.id;
    sellerId = seller.id;
    escrowId = escrow.id;
    platformFeeId = fee.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    await prisma.$disconnect();
  });

  describe('createTransaction', () => {
    it('should create a balanced transaction', async () => {
      // Fund escrow: 10000 cents = €100
      await prisma.transaction.create({
        data: {
          description: 'Fund escrow',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 10000, type: 'DEBIT' },
              { accountId: escrowId, amount: 10000, type: 'CREDIT' },
            ],
          },
        },
      });

      // Transfer 5000 cents = €50 from escrow to seller
      const tx = await service.createTransaction({
        description: 'Test transfer',
        entries: [
          { accountId: escrowId, amount: 5000, type: 'DEBIT' },
          { accountId: sellerId, amount: 5000, type: 'CREDIT' },
        ],
      });

      expect(tx).toBeDefined();
      expect(tx.description).toBe('Test transfer');

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);

      expect(escrowBalance).toBe(5000);
      expect(sellerBalance).toBe(5000);
    });

    it('should reject unbalanced transactions', async () => {
      await expect(
        service.createTransaction({
          description: 'Unbalanced',
          entries: [
            { accountId: escrowId, amount: 10000, type: 'DEBIT' },
            { accountId: sellerId, amount: 5000, type: 'CREDIT' },
          ],
        }),
      ).rejects.toThrow('Ledger is not balanced');
    });

    it('should reject transactions with less than 2 entries', async () => {
      await expect(
        service.createTransaction({
          description: 'Single entry',
          entries: [{ accountId: escrowId, amount: 10000, type: 'DEBIT' }],
        }),
      ).rejects.toThrow('Minimum 2 entries required');
    });

    it('should reject debit when insufficient funds', async () => {
      await expect(
        service.createTransaction({
          description: 'Overdraft',
          entries: [
            { accountId: escrowId, amount: 10000, type: 'DEBIT' },
            { accountId: sellerId, amount: 10000, type: 'CREDIT' },
          ],
        }),
      ).rejects.toThrow('Insufficient funds');
    });

    it('should reject non-integer (float) amounts', async () => {
      await expect(
        service.createTransaction({
          description: 'Float amount',
          entries: [
            { accountId: escrowId, amount: 100.5, type: 'DEBIT' },
            { accountId: sellerId, amount: 100.5, type: 'CREDIT' },
          ],
        }),
      ).rejects.toThrow(/minor units/);
    });
  });

  describe('releasePayout', () => {
    it('should split amount between seller and platform fee', async () => {
      // Fund escrow: 10000 cents = €100
      await prisma.transaction.create({
        data: {
          description: 'Fund',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 10000, type: 'DEBIT' },
              { accountId: escrowId, amount: 10000, type: 'CREDIT' },
            ],
          },
        },
      });

      // Release payout: 5% fee → 500 cents fee, 9500 cents to seller
      await service.releasePayout({
        amount: 10000,
        feeAmount: 500,
        sellerAmount: 9500,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
      });

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);
      const { balance: feeBalance } = await service.getAccountBalance(platformFeeId);

      expect(escrowBalance).toBe(0);
      expect(sellerBalance).toBe(9500);
      expect(feeBalance).toBe(500);
    });
  });

  describe('reversePayout', () => {
    it('should reverse a payout and restore escrow balance', async () => {
      await prisma.transaction.create({
        data: {
          description: 'Fund',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 10000, type: 'DEBIT' },
              { accountId: escrowId, amount: 10000, type: 'CREDIT' },
            ],
          },
        },
      });

      await service.releasePayout({
        amount: 10000,
        feeAmount: 500,
        sellerAmount: 9500,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
      });

      await service.reversePayout({
        amount: 10000,
        feeAmount: 500,
        sellerAmount: 9500,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
        reason: 'Test reversal',
      });

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);
      const { balance: feeBalance } = await service.getAccountBalance(platformFeeId);

      expect(escrowBalance).toBe(10000);
      expect(sellerBalance).toBe(0);
      expect(feeBalance).toBe(0);
    });
  });

  describe('verifyIntegrity', () => {
    it('should report clean on empty ledger', async () => {
      const report = await service.verifyIntegrity();

      expect(report.balanced).toBe(true);
      expect(report.globalDebits).toBe(0);
      expect(report.globalCredits).toBe(0);
      expect(report.globalDiff).toBe(0);
      expect(report.unbalancedTransactions).toHaveLength(0);
      expect(report.orphanedEntries).toHaveLength(0);
      expect(report.checkedAt).toBeInstanceOf(Date);
    });

    it('should report balanced: true after valid transactions', async () => {
      await prisma.transaction.create({
        data: {
          description: 'Payment capture',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 10000, type: 'DEBIT' },
              { accountId: escrowId, amount: 10000, type: 'CREDIT' },
            ],
          },
        },
      });

      await prisma.transaction.create({
        data: {
          description: 'Payout release',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: escrowId, amount: 9500, type: 'DEBIT' },
              { accountId: platformFeeId, amount: 500, type: 'DEBIT' },
              { accountId: sellerId, amount: 9500, type: 'CREDIT' },
              { accountId: platformFeeId, amount: 500, type: 'CREDIT' },
            ],
          },
        },
      });

      const report = await service.verifyIntegrity();

      expect(report.balanced).toBe(true);
      expect(report.globalDebits).toBe(report.globalCredits);
      expect(report.unbalancedTransactions).toHaveLength(0);
      expect(report.orphanedEntries).toHaveLength(0);
    });

    it('should detect imbalanced ledger from raw insert bypassing service validation', async () => {
      await prisma.transaction.create({
        data: {
          description: 'Valid tx',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 10000, type: 'DEBIT' },
              { accountId: escrowId, amount: 10000, type: 'CREDIT' },
            ],
          },
        },
      });

      // Bypass service: insert an unbalanced entry directly
      const badTx = await prisma.transaction.create({
        data: { description: 'Unbalanced inject', status: 'COMPLETED' },
      });
      await prisma.$executeRaw`
        INSERT INTO "Entry" ("transactionId", "accountId", amount, type)
        VALUES (${badTx.id}, ${buyerId}, 5000, 'DEBIT'::"CardType")
      `;

      const report = await service.verifyIntegrity();

      expect(report.balanced).toBe(false);
      expect(report.unbalancedTransactions).toContain(badTx.id);
      expect(report.globalDebits).toBeGreaterThan(report.globalCredits);
    });
  });

  describe('getAccountBalance', () => {
    it('should return 0 for new account', async () => {
      const { balance } = await service.getAccountBalance(escrowId);
      expect(balance).toBe(0);
    });

    it('should calculate balance from multiple transactions', async () => {
      await prisma.transaction.create({
        data: {
          description: 'Fund 1',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 5000, type: 'DEBIT' },
              { accountId: escrowId, amount: 5000, type: 'CREDIT' },
            ],
          },
        },
      });

      await prisma.transaction.create({
        data: {
          description: 'Fund 2',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 3000, type: 'DEBIT' },
              { accountId: escrowId, amount: 3000, type: 'CREDIT' },
            ],
          },
        },
      });

      const { balance } = await service.getAccountBalance(escrowId);
      expect(balance).toBe(8000);
    });
  });
});
