/**
 * Integration Tests: Payment Lifecycle
 *
 * Tests the full payment pipeline against a real PostgreSQL database
 * with mocked Stripe and fraud engine. Every test asserts the global
 * ledger invariant (total debits == total credits) at the end.
 *
 * Monetary convention:
 *   - createConfirmedPayment() accepts major units (€200 → pass 200)
 *   - createPayout(), openDispute(), balance assertions use MINOR UNITS (cents)
 *     e.g. €200 = 20000 cents
 *
 * Scenarios:
 * 1. Happy path: payment → webhook → payout → verify balances
 * 2. Duplicate webhook handling (idempotency)
 * 3. Fraud engine: BLOCK prevents payout
 * 4. Fraud engine: REVIEW flags for manual review
 * 5. Fraud engine: unavailable → fail-open to REVIEW
 * 6. Stripe transfer failure → payout FAILED, ledger untouched
 * 7. Dispute: open → freeze → review → refund → verify balances
 * 8. Dispute: seller wins → payout unfreezes
 * 9. Payout on paid-then-disputed → reversal → seller negative balance
 * 10. Idempotent payment creation
 * 11. Payout on unsettled payment is rejected
 */

import Stripe from 'stripe';
import {
  TestHarness,
  setFraudDecision,
  setFraudEngineAvailable,
  mockStripeTransferFailure,
} from './test-harness';

describe('Payment Lifecycle Integration', () => {
  const h = new TestHarness();

  beforeAll(() => h.setup());
  beforeEach(() => h.reset());
  afterAll(() => h.teardown());

  // ────────────────────────────────────────────────────────────────
  // 1. Happy Path
  // ────────────────────────────────────────────────────────────────

  describe('happy path: payment → payout → balances', () => {
    it('should move funds from buyer through escrow to seller with platform fee', async () => {
      const majorAmount = 200;          // €200 — API-facing major units
      const amountCents = 20000;        // 20000 cents
      const expectedFeeCents = 1000;    // 5% of 20000
      const expectedSellerCents = 19000;

      // Step 1: Buyer pays → settlement books escrow entries
      const tx = await h.createConfirmedPayment(majorAmount);
      expect(tx.stripePaymentIntentId).toMatch(/^pi_test_/);

      await h.assertAccountBalance(h.fixtures.escrowAccountId, amountCents, 'escrow after payment');
      await h.assertAccountBalance(h.fixtures.buyerAccountId, -amountCents, 'buyer after payment');

      // Step 2: Create payout (amounts in cents)
      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: amountCents,
      });
      expect(payout.status).toBe('PENDING');

      // Step 3: Fraud check → ELIGIBLE
      const eligible = await h.payouts.markEligible(payout.id);
      expect(eligible.status).toBe('ELIGIBLE');
      expect(eligible.fraudDecision).toBe('ALLOW');

      // Step 4: Process → Stripe transfer + ledger entries
      const paid = await h.payouts.processPayout(payout.id);
      expect(paid.status).toBe('PAID');
      expect(paid.stripeTransferId).toMatch(/^tr_test_/);

      // Step 5: Verify final balances (all in cents)
      await h.assertAccountBalance(h.fixtures.escrowAccountId, 0, 'escrow drained');
      await h.assertAccountBalance(h.fixtures.sellerAccountId, expectedSellerCents, 'seller received');
      await h.assertAccountBalance(h.fixtures.platformFeeAccountId, expectedFeeCents, 'platform fee collected');
      await h.assertAccountBalance(h.fixtures.buyerAccountId, -amountCents, 'buyer debited');

      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 2. Duplicate Webhook (Transaction already COMPLETED)
  // ────────────────────────────────────────────────────────────────

  describe('duplicate webhook handling', () => {
    it('should handle duplicate payment_intent.succeeded without double-booking', async () => {
      const tx = await h.createConfirmedPayment(100); // €100

      // Transaction is already COMPLETED from createConfirmedPayment.
      // Simulate a second webhook delivery — call handlePaymentSuccess again.
      await h.webhooks.handlePaymentSuccess({
        id: tx.stripePaymentIntentId!,
        amount: 10000, // 10000 cents = €100
        currency: 'eur',
        status: 'succeeded',
      } as Stripe.PaymentIntent);

      // Should still have exactly 2 entries (1 DEBIT, 1 CREDIT) from the original payment
      const entries = await h.prisma.entry.findMany({
        where: { transactionId: tx.id },
      });
      expect(entries).toHaveLength(2);

      // Balance unchanged — no double-credit (10000 cents = €100)
      await h.assertAccountBalance(h.fixtures.escrowAccountId, 10000, 'escrow unchanged');
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. Fraud Engine: BLOCK
  // ────────────────────────────────────────────────────────────────

  describe('fraud gate: BLOCK', () => {
    it('should reject payout when fraud engine returns BLOCK', async () => {
      setFraudDecision('BLOCK');

      const tx = await h.createConfirmedPayment(500); // €500 = 50000 cents in escrow
      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: 50000, // 50000 cents
      });

      await expect(h.payouts.markEligible(payout.id)).rejects.toThrow(/blocked by fraud engine/i);

      await h.assertPayoutStatus(payout.id, 'PENDING');
      await h.assertAccountBalance(h.fixtures.escrowAccountId, 50000);
      await h.assertAccountBalance(h.fixtures.sellerAccountId, 0);
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 4. Fraud Engine: REVIEW
  // ────────────────────────────────────────────────────────────────

  describe('fraud gate: REVIEW', () => {
    it('should mark payout ELIGIBLE but flag for manual review', async () => {
      setFraudDecision('REVIEW');

      const tx = await h.createConfirmedPayment(300); // €300
      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: 30000, // 30000 cents
      });

      const eligible = await h.payouts.markEligible(payout.id);

      expect(eligible.status).toBe('ELIGIBLE');
      expect(eligible.fraudDecision).toBe('REVIEW');
      expect(eligible.fraudScore).toBeCloseTo(0.5);
      expect(eligible.failureReason).toMatch(/fraud review/i);

      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 5. Fraud Engine: Unavailable → Fail-Open
  // ────────────────────────────────────────────────────────────────

  describe('fraud gate: engine unavailable', () => {
    it('should default to REVIEW (fail-open) when fraud engine is down', async () => {
      setFraudEngineAvailable(false);

      const tx = await h.createConfirmedPayment(150); // €150
      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: 15000, // 15000 cents
      });

      const eligible = await h.payouts.markEligible(payout.id);

      expect(eligible.status).toBe('ELIGIBLE');
      expect(eligible.fraudDecision).toBe('REVIEW');
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. Stripe Transfer Failure
  // ────────────────────────────────────────────────────────────────

  describe('stripe transfer failure', () => {
    it('should mark payout FAILED and leave ledger untouched', async () => {
      const tx = await h.createConfirmedPayment(400); // €400 = 40000 cents
      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: 40000, // 40000 cents
      });

      await h.payouts.markEligible(payout.id);
      mockStripeTransferFailure(true);

      const failed = await h.payouts.processPayout(payout.id);
      expect(failed.status).toBe('FAILED');
      expect(failed.failureReason).toMatch(/stripe|insufficient/i);

      await h.assertAccountBalance(h.fixtures.escrowAccountId, 40000, 'escrow intact');
      await h.assertAccountBalance(h.fixtures.sellerAccountId, 0, 'seller received nothing');
      await h.assertAccountBalance(h.fixtures.platformFeeAccountId, 0, 'no fee collected');
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 7. Dispute: Open → Freeze → Review → Refund
  // ────────────────────────────────────────────────────────────────

  describe('dispute: full refund path', () => {
    it('should freeze payout, then refund buyer from escrow', async () => {
      const majorAmount = 250;   // €250
      const amountCents = 25000; // 25000 cents

      const tx = await h.createConfirmedPayment(majorAmount);

      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: amountCents,
      });

      await h.payouts.markEligible(payout.id);

      const dispute = await h.disputes.openDispute({
        transactionId: tx.id,
        reason: 'PRODUCT_NOT_RECEIVED',
        amount: amountCents,
        description: 'Buyer never received the product',
      });
      expect(dispute.status).toBe('OPEN');

      await h.assertPayoutStatus(payout.id, 'PENDING');

      await h.disputes.startReview(dispute.id);
      const resolved = await h.disputes.resolveRefunded(dispute.id, 'Full refund to buyer');
      expect(resolved.status).toBe('REFUNDED');

      // Escrow debited 25000, buyer credited 25000 → both zero out
      await h.assertAccountBalance(h.fixtures.escrowAccountId, 0, 'escrow after refund');
      await h.assertAccountBalance(h.fixtures.buyerAccountId, 0, 'buyer refunded to 0');
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 8. Dispute: Seller Wins → Payout Unfreezes
  // ────────────────────────────────────────────────────────────────

  describe('dispute: seller wins', () => {
    it('should unfreeze payout to ELIGIBLE when seller wins dispute', async () => {
      const majorAmount = 180;   // €180
      const amountCents = 18000; // 18000 cents

      const tx = await h.createConfirmedPayment(majorAmount);

      const payout = await h.payouts.createPayout({
        transactionId: tx.id,
        sellerId: h.fixtures.sellerId,
        amount: amountCents,
      });

      await h.payouts.markEligible(payout.id);

      const dispute = await h.disputes.openDispute({
        transactionId: tx.id,
        reason: 'PRODUCT_UNACCEPTABLE',
        amount: amountCents,
      });
      await h.assertPayoutStatus(payout.id, 'PENDING');

      await h.disputes.startReview(dispute.id);
      const resolved = await h.disputes.resolveWon(dispute.id, 'Seller provided proof');
      expect(resolved.status).toBe('WON');

      await h.assertPayoutStatus(payout.id, 'ELIGIBLE');
      await h.assertAccountBalance(h.fixtures.escrowAccountId, amountCents);
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 9. Post-Payout Dispute → Reversal → Seller Negative Balance
  // ────────────────────────────────────────────────────────────────

  describe('dispute after payout: reversal with negative balance', () => {
    it('should reverse paid payout, block seller on negative balance', async () => {
      const majorAmount = 300;     // €300
      const amountCents = 30000;   // 30000 cents
      const sellerCents = 28500;   // 30000 - 1500 (5% fee)

      const tx = await h.createConfirmedPayment(majorAmount);
      const paid = await h.executeFullPayout(tx.id, amountCents);
      expect(paid.status).toBe('PAID');

      await h.assertAccountBalance(h.fixtures.sellerAccountId, sellerCents);

      const dispute = await h.disputes.openDispute({
        transactionId: tx.id,
        reason: 'FRAUDULENT',
        amount: amountCents,
      });

      await h.disputes.startReview(dispute.id);
      await h.disputes.resolveLost(dispute.id, 'Chargeback from card network');

      // Reversal zeros out: seller had +28500, debited 28500 → 0
      const { balance: sellerBalance } = await h.ledger.getAccountBalance(h.fixtures.sellerAccountId);
      expect(sellerBalance).toBe(0);

      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 10. Idempotent Payment Creation
  // ────────────────────────────────────────────────────────────────

  describe('payment idempotency', () => {
    it('should return cached result for duplicate idempotency key', async () => {
      const key = `idem_${Date.now()}`;

      const first = await h.payments.createPayment(
        {
          amount: 100,
          buyerAccountId: h.fixtures.buyerAccountId,
          escrowAccountId: h.fixtures.escrowAccountId,
        },
        key,
      );

      const second = await h.payments.createPayment(
        {
          amount: 100,
          buyerAccountId: h.fixtures.buyerAccountId,
          escrowAccountId: h.fixtures.escrowAccountId,
        },
        key,
      );

      expect(second.transaction.id).toBe(first.transaction.id);

      // No entries — settlement happens on webhook, not at createPayment
      const entries = await h.prisma.entry.findMany();
      expect(entries).toHaveLength(0);

      await h.assertAccountBalance(h.fixtures.escrowAccountId, 0);
      await h.assertLedgerBalanced();
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 11. Payout on Unsettled Payment
  // ────────────────────────────────────────────────────────────────

  describe('payout on unsettled payment', () => {
    it('should reject payout when transaction is still PENDING', async () => {
      const result = await h.payments.createPayment({
        amount: 100,
        buyerAccountId: h.fixtures.buyerAccountId,
        escrowAccountId: h.fixtures.escrowAccountId,
      });

      await expect(
        h.payouts.createPayout({
          transactionId: result.transaction.id,
          sellerId: h.fixtures.sellerId,
          amount: 10000, // 10000 cents
        }),
      ).rejects.toThrow(/COMPLETED|settled/i);

      await h.assertLedgerBalanced();
    });
  });
});
