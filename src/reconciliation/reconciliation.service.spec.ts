import { Test, TestingModule } from '@nestjs/testing';
import { ReconciliationService } from './reconciliation.service';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { LedgerService } from '../ledger/ledger.service';
import { MetricsService } from '../metrics/metrics.service';
import { getLoggerToken } from 'nestjs-pino';

const mockPaymentIntents = {
  retrieve: jest.fn(),
};

const mockStripeInstance = {
  paymentIntents: mockPaymentIntents,
};

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let prisma: PrismaService;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        PrismaService,
        {
          provide: StripeService,
          useValue: { getStripe: () => mockStripeInstance },
        },
        {
          provide: LedgerService,
          useValue: { verifyIntegrity: jest.fn() },
        },
        {
          provide: MetricsService,
          useValue: { ledgerTransactionsTotal: { inc: jest.fn() } },
        },
        {
          provide: getLoggerToken(ReconciliationService.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(ReconciliationService);
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    await prisma.$disconnect();
  });

  describe('reconcileTransaction', () => {
    it('should use stripePaymentIntentId field, not description regex', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Some payment without pi_ in text',
          status: 'PENDING',
          stripePaymentIntentId: 'pi_test_reconcile_123',
        },
      });

      mockPaymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_test_reconcile_123',
        status: 'succeeded',
      });

      const result = await service.reconcileTransaction(tx.id);

      // Old regex would have skipped this — description has no pi_ substring
      expect(result.status).toBe('fixed');
      expect(result.details?.from).toBe('PENDING');
      expect(result.details?.to).toBe('COMPLETED');
    });

    it('should skip transactions without stripePaymentIntentId', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Payout to seller (100, fee: 5)',
          status: 'COMPLETED',
          // No stripePaymentIntentId
        },
      });

      const result = await service.reconcileTransaction(tx.id);

      expect(result.status).toBe('skipped');
      expect(result.details?.reason).toBe('No Stripe payment intent linked');
      expect(mockPaymentIntents.retrieve).not.toHaveBeenCalled();
    });

    it('should fix PENDING transaction when Stripe shows succeeded', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Payment',
          status: 'PENDING',
          stripePaymentIntentId: 'pi_test_pending',
        },
      });

      mockPaymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_test_pending',
        status: 'succeeded',
      });

      const result = await service.reconcileTransaction(tx.id);
      expect(result.status).toBe('fixed');
      expect(result.details?.from).toBe('PENDING');
      expect(result.details?.to).toBe('COMPLETED');

      const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
      expect(updated?.status).toBe('COMPLETED');
    });

    it('should mark PENDING as FAILED when Stripe shows canceled', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Payment',
          status: 'PENDING',
          stripePaymentIntentId: 'pi_test_canceled',
        },
      });

      mockPaymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_test_canceled',
        status: 'canceled',
      });

      const result = await service.reconcileTransaction(tx.id);
      expect(result.status).toBe('fixed');
      expect(result.details?.to).toBe('FAILED');

      const updated = await prisma.transaction.findUnique({ where: { id: tx.id } });
      expect(updated?.status).toBe('FAILED');
    });

    it('should return ok when statuses are already in sync', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Payment',
          status: 'COMPLETED',
          stripePaymentIntentId: 'pi_test_synced',
        },
      });

      mockPaymentIntents.retrieve.mockResolvedValueOnce({
        id: 'pi_test_synced',
        status: 'succeeded',
      });

      const result = await service.reconcileTransaction(tx.id);
      expect(result.status).toBe('ok');
    });

    it('should handle Stripe API errors gracefully', async () => {
      const tx = await prisma.transaction.create({
        data: {
          description: 'Payment',
          status: 'PENDING',
          stripePaymentIntentId: 'pi_test_error',
        },
      });

      mockPaymentIntents.retrieve.mockRejectedValueOnce(
        new Error('Stripe API rate limited'),
      );

      const result = await service.reconcileTransaction(tx.id);
      expect(result.status).toBe('error');
      expect(result.details?.error).toContain('rate limited');
    });
  });

  describe('reconcileRecent', () => {
    it('should pick up PENDING transactions by stripePaymentIntentId, not description', async () => {
      // This transaction has no 'Payment' in the description — old filter would miss it
      await prisma.transaction.create({
        data: {
          description: 'Checkout order #1234',
          status: 'PENDING',
          stripePaymentIntentId: 'pi_test_recent_1',
        },
      });

      // This transaction has no PI — should be excluded from the query entirely
      await prisma.transaction.create({
        data: {
          description: 'Payout ledger entry',
          status: 'PENDING',
        },
      });

      mockPaymentIntents.retrieve.mockResolvedValue({ id: 'pi_test_recent_1', status: 'succeeded' });

      const { results, summary } = await service.reconcileRecent();

      expect(summary.total).toBe(1);
      expect(results[0].status).toBe('fixed');
    });
  });
});
