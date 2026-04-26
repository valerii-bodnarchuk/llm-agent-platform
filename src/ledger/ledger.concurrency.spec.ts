/**
 * Ledger concurrency tests — real PostgreSQL, no mocks.
 *
 * Run against an isolated test database:
 *
 *   DATABASE_URL=postgresql://postgres:postgres@localhost:5432/payment_system_test \
 *     npx jest --testPathPatterns="ledger.concurrency" --runInBand --verbose
 *
 * Three scenarios:
 *   A. Concurrent balanced mutations — 50 parallel credits / 30 parallel mixed ops
 *   B. Overspend protection under contention — concurrent debits must never push a
 *      non-negative account below zero
 *   C. Idempotency under contention — N parallel calls sharing one stripePaymentIntentId
 *      must commit exactly one transaction (DB-level unique-constraint enforcement)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { LedgerService } from './ledger.service';
import { PrismaService } from '../prisma/prisma.service';
import { MetricsService } from '../metrics/metrics.service';
import { getLoggerToken } from 'nestjs-pino';

describe('LedgerService — concurrency', () => {
  let service: LedgerService;
  let prisma: PrismaService;

  let buyerId: number;
  let escrowId: number;
  let sellerId: number;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LedgerService,
        PrismaService,
        {
          provide: getLoggerToken(LedgerService.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
        {
          provide: MetricsService,
          useValue: { ledgerTransactionsTotal: { inc: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get<LedgerService>(LedgerService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;

    const buyer = await prisma.account.create({
      data: { name: 'Buyer', type: 'BUYER', allowNegative: true },
    });
    const escrow = await prisma.account.create({
      data: { name: 'Escrow', type: 'ESCROW' },
    });
    const seller = await prisma.account.create({
      data: { name: 'Seller', type: 'SELLER', allowNegative: true },
    });
    await prisma.account.create({
      data: { name: 'Fee', type: 'PLATFORM_FEE' },
    });

    buyerId = buyer.id;
    escrowId = escrow.id;
    sellerId = seller.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    await prisma.$disconnect();
  });

  // ── A. Concurrent balanced mutations ────────────────────────────────────────

  describe('A. concurrent balanced mutations', () => {
    it('sums 50 parallel credits deterministically and keeps the ledger balanced', async () => {
      const N = 50;
      const amount = 100; // cents

      // 50 concurrent ops: buyer (allowNegative) DEBIT → escrow CREDIT
      await Promise.all(
        Array.from({ length: N }, () =>
          service.createTransaction({
            description: 'Parallel credit',
            entries: [
              { accountId: buyerId, amount, type: 'DEBIT' },
              { accountId: escrowId, amount, type: 'CREDIT' },
            ],
          }),
        ),
      );

      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: buyerBalance } = await service.getAccountBalance(buyerId);

      // Every credit must have landed — no dropped writes, no double-counts
      expect(escrowBalance).toBe(N * amount);
      expect(buyerBalance).toBe(-(N * amount));

      const report = await service.verifyIntegrity();
      expect(report.balanced).toBe(true);
      expect(report.unbalancedTransactions).toHaveLength(0);
    });

    it('handles 30 parallel mixed debits/credits on a funded account without drift', async () => {
      const SEED = 10_000; // cents — enough to cover all concurrent debits
      const N = 30;
      const amount = 100;

      // Seed escrow directly — bypasses service to avoid chicken-and-egg on balance
      await prisma.transaction.create({
        data: {
          description: 'Seed funding',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: SEED, type: 'DEBIT' },
              { accountId: escrowId, amount: SEED, type: 'CREDIT' },
            ],
          },
        },
      });

      // N/2 debits (escrow → seller) and N/2 credits (buyer → escrow) in parallel
      const ops = [
        ...Array.from({ length: N / 2 }, () =>
          service.createTransaction({
            description: 'Debit escrow',
            entries: [
              { accountId: escrowId, amount, type: 'DEBIT' },
              { accountId: sellerId, amount, type: 'CREDIT' },
            ],
          }),
        ),
        ...Array.from({ length: N / 2 }, () =>
          service.createTransaction({
            description: 'Credit escrow',
            entries: [
              { accountId: buyerId, amount, type: 'DEBIT' },
              { accountId: escrowId, amount, type: 'CREDIT' },
            ],
          }),
        ),
      ];

      await Promise.all(ops);

      // Net effect on escrow is zero: (N/2) credits cancel (N/2) debits
      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      expect(escrowBalance).toBe(SEED);

      const report = await service.verifyIntegrity();
      expect(report.balanced).toBe(true);
      expect(report.unbalancedTransactions).toHaveLength(0);
    });
  });

  // ── B. Overspend protection under contention ────────────────────────────────

  describe('B. overspend protection under contention', () => {
    it('never lets a non-negative account go negative when concurrent debits exceed balance', async () => {
      const OPENING = 500; // cents in escrow
      const DEBIT_AMOUNT = 100; // cents per debit
      const CONCURRENT = 20;
      const EXPECTED_SUCCESSES = OPENING / DEBIT_AMOUNT; // 5

      // Seed escrow — direct insert to bypass balance guard (buyer is allowNegative)
      await prisma.transaction.create({
        data: {
          description: 'Seed escrow',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: OPENING, type: 'DEBIT' },
              { accountId: escrowId, amount: OPENING, type: 'CREDIT' },
            ],
          },
        },
      });

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, () =>
          service.createTransaction({
            description: 'Concurrent debit',
            entries: [
              { accountId: escrowId, amount: DEBIT_AMOUNT, type: 'DEBIT' },
              { accountId: sellerId, amount: DEBIT_AMOUNT, type: 'CREDIT' },
            ],
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly as many debits succeed as escrow can fund
      expect(succeeded).toHaveLength(EXPECTED_SUCCESSES);
      expect(rejected).toHaveLength(CONCURRENT - EXPECTED_SUCCESSES);

      // Every rejection must be the controlled "Insufficient funds" error —
      // never a deadlock, serialisation failure, or unhandled exception
      for (const r of rejected) {
        expect((r as PromiseRejectedResult).reason.message).toMatch(/Insufficient funds/);
      }

      // Escrow is exactly drained — no cents leaked or double-spent
      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      expect(escrowBalance).toBe(0);

      // Global double-entry invariant holds
      const report = await service.verifyIntegrity();
      expect(report.balanced).toBe(true);
      expect(report.unbalancedTransactions).toHaveLength(0);
    });
  });

  // ── C. Idempotency under contention ─────────────────────────────────────────

  describe('C. idempotency under contention (unique stripePaymentIntentId)', () => {
    it('commits exactly one ledger mutation when N parallel calls share the same idempotency key', async () => {
      const CONCURRENT = 15;
      const AMOUNT = 1_000; // cents
      const KEY = `pi_test_idempotent_${Date.now()}`;

      // Fund escrow generously — we want failures only from the unique-key constraint,
      // not from insufficient balance
      const SEED = AMOUNT * CONCURRENT;
      await prisma.transaction.create({
        data: {
          description: 'Seed for idempotency test',
          status: 'COMPLETED',
          entries: {
            create: [
              { accountId: buyerId, amount: SEED, type: 'DEBIT' },
              { accountId: escrowId, amount: SEED, type: 'CREDIT' },
            ],
          },
        },
      });

      const results = await Promise.allSettled(
        Array.from({ length: CONCURRENT }, () =>
          service.createTransaction({
            description: 'Idempotent transfer',
            stripePaymentIntentId: KEY,
            entries: [
              { accountId: escrowId, amount: AMOUNT, type: 'DEBIT' },
              { accountId: sellerId, amount: AMOUNT, type: 'CREDIT' },
            ],
          }),
        ),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      // Exactly one transaction must commit
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(CONCURRENT - 1);

      // Balances reflect exactly one operation, not N
      const { balance: escrowBalance } = await service.getAccountBalance(escrowId);
      const { balance: sellerBalance } = await service.getAccountBalance(sellerId);

      expect(escrowBalance).toBe(SEED - AMOUNT);
      expect(sellerBalance).toBe(AMOUNT);

      // Exactly one Transaction row carries the idempotency key
      const txCount = await prisma.transaction.count({
        where: { stripePaymentIntentId: KEY },
      });
      expect(txCount).toBe(1);

      // Ledger still balanced
      const report = await service.verifyIntegrity();
      expect(report.balanced).toBe(true);
      expect(report.unbalancedTransactions).toHaveLength(0);
    });
  });
});
