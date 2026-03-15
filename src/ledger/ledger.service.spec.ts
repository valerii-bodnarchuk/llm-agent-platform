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
      await prisma.transaction.create({
        data: {
          description: 'Fund escrow',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 100, type: 'DEBIT' },
              { accountId: escrowId, amount: 100, type: 'CREDIT' },
            ],
          },
        },
      });

      const tx = await service.createTransaction({
        description: 'Test transfer',
        entries: [
          { accountId: escrowId, amount: 50, type: 'DEBIT' },
          { accountId: sellerId, amount: 50, type: 'CREDIT' },
        ],
      });

      expect(tx).toBeDefined();
      expect(tx.description).toBe('Test transfer');

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);

      expect(escrowBalance).toBe(50);
      expect(sellerBalance).toBe(50);
    });

    it('should reject unbalanced transactions', async () => {
      await expect(
        service.createTransaction({
          description: 'Unbalanced',
          entries: [
            { accountId: escrowId, amount: 100, type: 'DEBIT' },
            { accountId: sellerId, amount: 50, type: 'CREDIT' },
          ],
        }),
      ).rejects.toThrow('Ledger is not balanced');
    });

    it('should reject transactions with less than 2 entries', async () => {
      await expect(
        service.createTransaction({
          description: 'Single entry',
          entries: [
            { accountId: escrowId, amount: 100, type: 'DEBIT' },
          ],
        }),
      ).rejects.toThrow('Minimum 2 entries required');
    });

    it('should reject debit when insufficient funds', async () => {
      await expect(
        service.createTransaction({
          description: 'Overdraft',
          entries: [
            { accountId: escrowId, amount: 100, type: 'DEBIT' },
            { accountId: sellerId, amount: 100, type: 'CREDIT' },
          ],
        }),
      ).rejects.toThrow('Insufficient funds');
    });
  });

  describe('releasePayout', () => {
    it('should split amount between seller and platform fee', async () => {
      await prisma.transaction.create({
        data: {
          description: 'Fund',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 100, type: 'DEBIT' },
              { accountId: escrowId, amount: 100, type: 'CREDIT' },
            ],
          },
        },
      });

      await service.releasePayout({
        amount: 100,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
        platformFeePercent: 5,
      });

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);
      const { balance: feeBalance } = await service.getAccountBalance(platformFeeId);

      expect(escrowBalance).toBe(0);
      expect(sellerBalance).toBe(95);
      expect(feeBalance).toBe(5);
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
              { accountId: buyerId, amount: 100, type: 'DEBIT' },
              { accountId: escrowId, amount: 100, type: 'CREDIT' },
            ],
          },
        },
      });

      await service.releasePayout({
        amount: 100,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
        platformFeePercent: 5,
      });

      await service.reversePayout({
        amount: 100,
        escrowAccountId: escrowId,
        sellerAccountId: sellerId,
        platformFeeAccountId: platformFeeId,
        platformFeePercent: 5,
        reason: 'Test reversal',
      });

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);
      const { balance: feeBalance } = await service.getAccountBalance(platformFeeId);

      expect(escrowBalance).toBe(100);
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
              { accountId: buyerId, amount: 100, type: 'DEBIT' },
              { accountId: escrowId, amount: 100, type: 'CREDIT' },
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
              { accountId: escrowId, amount: 95, type: 'DEBIT' },
              { accountId: platformFeeId, amount: 5, type: 'DEBIT' },
              { accountId: sellerId, amount: 95, type: 'CREDIT' },
              { accountId: platformFeeId, amount: 5, type: 'CREDIT' },
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
      // Create a valid transaction first so the ledger has a baseline
      await prisma.transaction.create({
        data: {
          description: 'Valid tx',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: 100, type: 'DEBIT' },
              { accountId: escrowId, amount: 100, type: 'CREDIT' },
            ],
          },
        },
      });

      // Insert a transaction with only a DEBIT entry, bypassing service validation
      const badTx = await prisma.transaction.create({
        data: { description: 'Unbalanced inject', status: 'COMPLETED' },
      });
      await prisma.$executeRaw`
        INSERT INTO "Entry" ("transactionId", "accountId", amount, type)
        VALUES (${badTx.id}, ${buyerId}, 50, 'DEBIT'::"CardType")
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
              { accountId: buyerId, amount: 50, type: 'DEBIT' },
              { accountId: escrowId, amount: 50, type: 'CREDIT' },
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
              { accountId: buyerId, amount: 30, type: 'DEBIT' },
              { accountId: escrowId, amount: 30, type: 'CREDIT' },
            ],
          },
        },
      });

      const { balance } = await service.getAccountBalance(escrowId);
      expect(balance).toBe(80);
    });
  });
});