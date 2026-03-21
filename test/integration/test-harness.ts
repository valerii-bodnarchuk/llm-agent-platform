/**
 * Integration Test Harness
 *
 * Provides:
 * - Real PostgreSQL via Prisma (no DB mocks)
 * - Mocked Stripe SDK (transfers, payment intents)
 * - Mocked fraud engine (configurable decisions)
 * - FK-safe cleanup between tests
 * - Ledger invariant assertions (global debit == credit)
 * - Pre-built accounts, sellers, escrow funding
 */

import { Test, TestingModule } from '@nestjs/testing';
import Stripe from 'stripe';
import { PrismaService } from '../../src/prisma/prisma.service';
import { LedgerService } from '../../src/ledger/ledger.service';
import { PayoutService } from '../../src/payout/payout.service';
import { PaymentService } from '../../src/payment/payment.service';
import { DisputeService } from '../../src/dispute/dispute.service';
import { WebhookService } from '../../src/webhook/webhook.service';
import { StripeService } from '../../src/stripe/stripe.service';
import { FraudCheckRequest, FraudService } from '../../src/fraud/fraud.service';
import { IdempotencyService } from '../../src/idempotency/idempotency.service';
import { SellerService } from '../../src/seller/seller.service';

// ── Stripe Mock ──────────────────────────────────────────────────────

let transferCounter = 0;
let paymentIntentCounter = 0;
let stripeTransferShouldFail = false;

export function mockStripeTransferFailure(shouldFail: boolean) {
  stripeTransferShouldFail = shouldFail;
}

const mockStripe = {
  paymentIntents: {
    create: jest.fn().mockImplementation(async (params: Stripe.PaymentIntentCreateParams) => ({
      id: `pi_test_${++paymentIntentCounter}_${Date.now()}`,
      amount: params.amount,
      currency: params.currency,
      status: 'requires_payment_method',
      metadata: params.metadata || {},
    })),
  },
  transfers: {
    create: jest.fn().mockImplementation(async (params: Stripe.TransferCreateParams) => {
      if (stripeTransferShouldFail) {
        throw new Error('Stripe transfer failed: insufficient_funds');
      }
      return {
        id: `tr_test_${++transferCounter}_${Date.now()}`,
        amount: params.amount,
        destination: params.destination,
      };
    }),
    createReversal: jest.fn().mockImplementation(async () => ({
      id: `trr_test_${Date.now()}`,
    })),
  },
  webhooks: {
    constructEvent: jest.fn().mockImplementation(
      (_body: Buffer, _sig: string, _secret: string) => {
        throw new Error('Use buildWebhookEvent() helper instead');
      },
    ),
  },
  accounts: {
    retrieve: jest.fn().mockImplementation(async (id: string) => ({
      id,
      charges_enabled: true,
      payouts_enabled: true,
      requirements: { currently_due: [] },
    })),
  },
};

// ── Fraud Engine Mock ────────────────────────────────────────────────

let fraudDecisionOverride: 'ALLOW' | 'REVIEW' | 'BLOCK' = 'ALLOW';
let fraudEngineAvailable = true;

export function setFraudDecision(decision: 'ALLOW' | 'REVIEW' | 'BLOCK') {
  fraudDecisionOverride = decision;
}

export function setFraudEngineAvailable(available: boolean) {
  fraudEngineAvailable = available;
}

const mockFraudService = {
  checkTransaction: jest.fn().mockImplementation(async (params: FraudCheckRequest) => {
    if (!fraudEngineAvailable) {
      return {
        transaction_id: params.transaction_id,
        risk_score: 0.5,
        decision: 'REVIEW',
        rules_triggered: [
          { rule: 'engine_unavailable', triggered: true, score: 0.5, reason: 'Fraud engine unreachable' },
        ],
      };
    }

    const scoreMap = { ALLOW: 0.1, REVIEW: 0.5, BLOCK: 0.85 };
    return {
      transaction_id: params.transaction_id,
      risk_score: scoreMap[fraudDecisionOverride],
      decision: fraudDecisionOverride,
      rules_triggered: fraudDecisionOverride !== 'ALLOW'
        ? [{ rule: 'test_override', triggered: true, score: scoreMap[fraudDecisionOverride], reason: `Test: ${fraudDecisionOverride}` }]
        : [],
    };
  }),
};

// ── Idempotency Mock (in-memory) ─────────────────────────────────────

const idempotencyStore = new Map<string, string>();

const mockIdempotencyService = {
  get: jest.fn().mockImplementation(async (key: string) => idempotencyStore.get(key) || null),
  set: jest.fn().mockImplementation(async (key: string, value: string) => {
    idempotencyStore.set(key, value);
  }),
};

// ── Test Fixture Data ────────────────────────────────────────────────

export interface TestFixtures {
  buyerAccountId: number;
  sellerAccountId: number;
  escrowAccountId: number;
  platformFeeAccountId: number;
  sellerId: number;
}

// ── Harness ──────────────────────────────────────────────────────────

export class TestHarness {
  module!: TestingModule;
  prisma!: PrismaService;
  ledger!: LedgerService;
  payouts!: PayoutService;
  payments!: PaymentService;
  disputes!: DisputeService;
  webhooks!: WebhookService;
  fixtures!: TestFixtures;

  async setup(): Promise<void> {
    this.module = await Test.createTestingModule({
      providers: [
        PrismaService,
        LedgerService,
        PayoutService,
        PaymentService,
        DisputeService,
        WebhookService,
        SellerService,
        {
          provide: StripeService,
          useValue: {
            getStripe: () => mockStripe,
            createPaymentIntent: jest.fn().mockImplementation(
              async (amount: number, currency: string = 'eur', metadata?: Record<string, string>) =>
                mockStripe.paymentIntents.create({ amount: Math.round(amount * 100), currency, metadata }),
            ),
          },
        },
        {
          provide: FraudService,
          useValue: mockFraudService,
        },
        {
          provide: IdempotencyService,
          useValue: mockIdempotencyService,
        },
        // Provide a no-op logger to satisfy PinoLogger injection tokens
        {
          provide: 'PinoLogger:LedgerService',
          useValue: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        },
        {
          provide: 'PinoLogger:WebhookService',
          useValue: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        },
        {
          provide: 'PinoLogger:DisputeService',
          useValue: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        },
        {
          provide: 'PinoLogger:FraudService',
          useValue: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        },
        {
          provide: 'PinoLogger:SellerService',
          useValue: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
        },
      ],
    }).compile();

    this.prisma = this.module.get(PrismaService);
    this.ledger = this.module.get(LedgerService);
    this.payouts = this.module.get(PayoutService);
    this.payments = this.module.get(PaymentService);
    this.disputes = this.module.get(DisputeService);
    this.webhooks = this.module.get(WebhookService);
  }

  /**
   * Clean all tables in FK-safe order, then seed base fixtures.
   * Must be called in beforeEach.
   */
  async reset(): Promise<void> {
    await this.prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;

    // Reset mock state
    transferCounter = 0;
    paymentIntentCounter = 0;
    stripeTransferShouldFail = false;
    fraudDecisionOverride = 'ALLOW';
    fraudEngineAvailable = true;
    idempotencyStore.clear();
    jest.clearAllMocks();

    // Seed base accounts
    const buyer = await this.prisma.account.create({
      data: { name: 'Test Buyer', type: 'BUYER', allowNegative: true },
    });
    const sellerAccount = await this.prisma.account.create({
      data: { name: 'Test Seller', type: 'SELLER', allowNegative: true },
    });
    const escrow = await this.prisma.account.create({
      data: { name: 'Platform Escrow', type: 'ESCROW' },
    });
    const platformFee = await this.prisma.account.create({
      data: { name: 'Platform Fee', type: 'PLATFORM_FEE' },
    });

    const seller = await this.prisma.seller.create({
      data: {
        name: 'Test Seller',
        email: `seller-${Date.now()}@test.com`,
        accountId: sellerAccount.id,
        status: 'ACTIVE',
        chargesEnabled: true,
        payoutsEnabled: true,
        stripeAccountId: `acct_test_${Date.now()}`,
      },
    });

    this.fixtures = {
      buyerAccountId: buyer.id,
      sellerAccountId: sellerAccount.id,
      escrowAccountId: escrow.id,
      platformFeeAccountId: platformFee.id,
      sellerId: seller.id,
    };
  }

  async teardown(): Promise<void> {
    await this.prisma.$executeRaw`TRUNCATE "Entry", "Dispute", "Payout", "Transaction", "Seller", "Account" RESTART IDENTITY CASCADE`;
    await this.prisma.$disconnect();
  }

  // ── Scenario Helpers ─────────────────────────────────────────────

  /**
   * Simulate a confirmed payment: create PaymentIntent (no entries), then
   * settle via ledger.settleTransaction() — mirroring the webhook path.
   * @param majorAmount Amount in major units (e.g. 200 for €200). Converted
   *   to minor units (20000 cents) for ledger settlement.
   * Returns the COMPLETED transaction record.
   */
  async createConfirmedPayment(majorAmount: number) {
    const result = await this.payments.createPayment({
      amount: majorAmount,
      buyerAccountId: this.fixtures.buyerAccountId,
      escrowAccountId: this.fixtures.escrowAccountId,
    });

    // StripeService.createPaymentIntent converts major→cents, so paymentIntent.amount is cents
    const amountMinor = result.paymentIntent.amount;

    // Settlement: webhook creates entries + marks COMPLETED
    await this.ledger.settleTransaction({
      transactionId: result.transaction.id,
      entries: [
        {
          accountId: this.fixtures.buyerAccountId,
          amount: amountMinor,
          type: 'DEBIT' as const,
          narrative: `Payment settled: ${result.paymentIntent.id}`,
        },
        {
          accountId: this.fixtures.escrowAccountId,
          amount: amountMinor,
          type: 'CREDIT' as const,
          narrative: `Escrow received: ${result.paymentIntent.id}`,
        },
      ],
    });

    return (await this.prisma.transaction.findUnique({
      where: { id: result.transaction.id },
    }))!;
  }

  /**
   * Full happy-path payout: create → markEligible → process.
   * Returns the paid payout record.
   */
  async executeFullPayout(transactionId: number, amount: number) {
    const payout = await this.payouts.createPayout({
      transactionId,
      sellerId: this.fixtures.sellerId,
      amount,
    });

    await this.payouts.markEligible(payout.id);
    return this.payouts.processPayout(payout.id);
  }

  // ── Assertions ───────────────────────────────────────────────────

  /**
   * Global ledger invariant: sum of all DEBITs must equal sum of all CREDITs.
   * If this fails, the ledger is corrupted.
   */
  async assertLedgerBalanced(): Promise<void> {
    const entries = await this.prisma.entry.findMany();

    let totalDebit = 0;
    let totalCredit = 0;

    for (const entry of entries) {
      if (entry.type === 'CREDIT') {
        totalCredit += Number(entry.amount);
      } else {
        totalDebit += Number(entry.amount);
      }
    }

    // Use tolerance for floating-point (Decimal columns are exact,
    // but Number() conversion can introduce rounding)
    const diff = Math.abs(totalDebit - totalCredit);
    if (diff > 0.001) {
      const entryDetails = entries.map(
        (e) => `  ${e.type} ${e.amount} on account ${e.accountId} (tx ${e.transactionId})`,
      );
      throw new Error(
        `LEDGER IMBALANCED: debits=${totalDebit}, credits=${totalCredit}, diff=${diff}\n` +
          `Entries:\n${entryDetails.join('\n')}`,
      );
    }
  }

  /**
   * Assert a specific account has the expected balance.
   */
  async assertAccountBalance(accountId: number, expected: number, label?: string): Promise<void> {
    const { balance } = await this.ledger.getAccountBalance(accountId);
    expect(balance).toBe(expected);
  }

  /**
   * Assert a payout reached the expected status.
   */
  async assertPayoutStatus(
    payoutId: number,
    expectedStatus: string,
  ): Promise<void> {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    expect(payout).not.toBeNull();
    expect(payout!.status).toBe(expectedStatus);
  }
}
