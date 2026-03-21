import { Test, TestingModule } from '@nestjs/testing';
import { InvestigationService } from './investigation.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { getLoggerToken } from 'nestjs-pino';

describe('InvestigationService', () => {
  let service: InvestigationService;
  let prisma: PrismaService;

  // Account IDs re-seeded before each test
  let buyerAccountId: number;
  let sellerAccountId: number;
  let escrowAccountId: number;
  let platformFeeAccountId: number;
  let sellerId: number;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvestigationService,
        LedgerService,
        PrismaService,
        {
          provide: getLoggerToken(LedgerService.name),
          useValue: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(InvestigationService);
    prisma = module.get(PrismaService);
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;

    const buyer = await prisma.account.create({ data: { name: 'Buyer', type: 'BUYER', allowNegative: true } });
    const sellerAccount = await prisma.account.create({ data: { name: 'Seller', type: 'SELLER', allowNegative: true } });
    const escrow = await prisma.account.create({ data: { name: 'Escrow', type: 'ESCROW' } });
    const platformFee = await prisma.account.create({ data: { name: 'Platform Fee', type: 'PLATFORM_FEE' } });

    buyerAccountId = buyer.id;
    sellerAccountId = sellerAccount.id;
    escrowAccountId = escrow.id;
    platformFeeAccountId = platformFee.id;

    const seller = await prisma.seller.create({
      data: {
        name: 'Test Seller',
        email: `seller-${Date.now()}@test.com`,
        accountId: sellerAccountId,
        status: 'ACTIVE',
        chargesEnabled: true,
        payoutsEnabled: true,
        stripeAccountId: `acct_test_${Date.now()}`,
      },
    });
    sellerId = seller.id;
  });

  afterAll(async () => {
    await prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    await prisma.$disconnect();
  });

  /** Helper: create a COMPLETED transaction with escrow funding */
  async function fundEscrow(amount: number) {
    return prisma.transaction.create({
      data: {
        description: `Payment ${Date.now()}`,
        status: 'COMPLETED',
        stripePaymentIntentId: `pi_test_${Date.now()}`,
        entries: {
          create: [
            { accountId: buyerAccountId, amount, type: 'DEBIT' },
            { accountId: escrowAccountId, amount, type: 'CREDIT' },
          ],
        },
      },
    });
  }

  /** Helper: create a payout record with given overrides */
  async function createPayout(
    transactionId: number,
    amount: number,
    overrides: Partial<{
      status: string;
      fraudDecision: string;
      fraudScore: number;
      failureReason: string;
      attempts: number;
    }> = {},
  ) {
    return prisma.payout.create({
      data: {
        amount,
        platformFee: amount * 0.05,
        sellerAmount: amount * 0.95,
        status: (overrides.status as any) ?? 'PAID',
        fraudDecision: (overrides.fraudDecision as any) ?? null,
        fraudScore: overrides.fraudScore ?? null,
        failureReason: overrides.failureReason ?? null,
        attempts: overrides.attempts ?? 1,
        maxAttempts: 3,
        transactionId,
        sellerId,
        escrowAccountId,
        platformFeeAccountId,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 1. Healthy payout
  // ─────────────────────────────────────────────────────────────────

  it('should report no findings for a healthy paid payout', async () => {
    const tx = await fundEscrow(200);
    const payout = await createPayout(tx.id, 200);

    const report = await service.investigatePayout(payout.id);

    expect(report.payoutId).toBe(payout.id);
    expect(report.findings).toHaveLength(0);
    expect(report.confidence).toBe('high');
    expect(report.probableCause).toMatch(/no issues/i);
    expect(report.recommendedActions).toHaveLength(0);
    expect(report.context.escrowBalance).toBe(200);
    expect(report.context.ledgerBalanced).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────
  // 2. Fraud block
  // ─────────────────────────────────────────────────────────────────

  it('should report fraud_blocked finding for a payout blocked by fraud engine', async () => {
    const tx = await fundEscrow(500);
    const payout = await createPayout(tx.id, 500, {
      status: 'FAILED',
      fraudDecision: 'BLOCK',
      fraudScore: 0.85,
    });

    const report = await service.investigatePayout(payout.id);

    const fraudFinding = report.findings.find((f) => f.rule === 'fraud_blocked');
    expect(fraudFinding).toBeDefined();
    expect(fraudFinding!.severity).toBe('critical');
    expect(report.probableCause).toMatch(/blocked by fraud engine/i);
    expect(report.confidence).toBe('high');
    expect(report.recommendedActions).toContain(
      'Review fraud engine decision. If false positive, manually approve via admin endpoint.',
    );
  });

  // ─────────────────────────────────────────────────────────────────
  // 3. Insufficient escrow
  // ─────────────────────────────────────────────────────────────────

  it('should report insufficient_escrow when escrow has no funds', async () => {
    // Transaction exists but no escrow entries (escrow balance = 0)
    const tx = await prisma.transaction.create({
      data: {
        description: 'Empty payment',
        status: 'PENDING',
        stripePaymentIntentId: `pi_empty_${Date.now()}`,
      },
    });
    const payout = await createPayout(tx.id, 100, { status: 'FAILED' });

    const report = await service.investigatePayout(payout.id);

    const escrowFinding = report.findings.find((f) => f.rule === 'insufficient_escrow');
    expect(escrowFinding).toBeDefined();
    expect(escrowFinding!.severity).toBe('critical');
    expect(escrowFinding!.evidence).toMatchObject({ escrowBalance: 0, payoutAmount: 100 });
  });

  // ─────────────────────────────────────────────────────────────────
  // 4. Blocked seller
  // ─────────────────────────────────────────────────────────────────

  it('should report seller_blocked finding when seller has payoutsBlocked', async () => {
    await prisma.seller.update({
      where: { id: sellerId },
      data: { payoutsBlocked: true },
    });

    const tx = await fundEscrow(150);
    const payout = await createPayout(tx.id, 150, { status: 'FAILED' });

    const report = await service.investigatePayout(payout.id);

    const finding = report.findings.find((f) => f.rule === 'seller_blocked');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('critical');
    expect(report.probableCause).toMatch(/blocked/i);
  });

  // ─────────────────────────────────────────────────────────────────
  // 5. Multiple issues → confidence medium
  // ─────────────────────────────────────────────────────────────────

  it('should report multiple findings and medium confidence for fraud REVIEW + active dispute', async () => {
    const tx = await fundEscrow(300);
    const payout = await createPayout(tx.id, 300, {
      status: 'ELIGIBLE',
      fraudDecision: 'REVIEW',
      fraudScore: 0.5,
    });

    // Open a dispute on the transaction
    await prisma.dispute.create({
      data: {
        transactionId: tx.id,
        reason: 'PRODUCT_NOT_RECEIVED',
        amount: 300,
        status: 'OPEN',
      },
    });

    const report = await service.investigatePayout(payout.id);

    const ruleNames = report.findings.map((f) => f.rule);
    expect(ruleNames).toContain('fraud_review');
    expect(ruleNames).toContain('active_dispute');
    expect(report.findings.length).toBeGreaterThanOrEqual(2);
    expect(report.confidence).toBe('medium');
  });
});
