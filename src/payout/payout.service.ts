import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { StripeService } from '../stripe/stripe.service';
import { PayoutStatus } from '@prisma/client';
import { validateTransition } from './payout-state-machine';
import { FraudService } from '../fraud/fraud.service';
import { assertMinorUnits } from '../common/money';
import { calculateFee } from '../common/utils/money.util';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class PayoutService {
  constructor(
    @InjectPinoLogger(PayoutService.name)
    private readonly logger: PinoLogger,
    private prisma: PrismaService,
    private ledger: LedgerService,
    private stripe: StripeService,
    private fraud: FraudService,
  ) {}

  /** Create a payout request (PENDING) */
  async createPayout(params: {
    transactionId: number;
    sellerId: number;
    amount: number;  // minor units (cents)
    platformFeePercent?: number;
  }) {
    assertMinorUnits(params.amount, 'Payout amount');
    const feePercent = params.platformFeePercent || 5;
    const { fee: platformFee, sellerAmount } = calculateFee(params.amount, feePercent);

    // === Duplicate payout protection ===
    const existingPayouts = await this.prisma.payout.findMany({
      where: { transactionId: params.transactionId },
    });

    const hasPaid = existingPayouts.some((p) => p.status === 'PAID');
    if (hasPaid) {
      throw new BadRequestException(
        `Transaction ${params.transactionId} already has a completed payout`,
      );
    }

    const hasActive = existingPayouts.some((p) =>
      ['PENDING', 'ELIGIBLE', 'PROCESSING'].includes(p.status),
    );
    if (hasActive) {
      throw new BadRequestException(
        `Transaction ${params.transactionId} already has an active payout`,
      );
    }

    const seller = await this.prisma.seller.findUnique({
      where: { id: params.sellerId },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${params.sellerId} not found`);
    }

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: params.transactionId },
    });

    if (!transaction || transaction.status !== 'COMPLETED') {
      throw new BadRequestException(
        `Cannot create payout: transaction ${params.transactionId} is ${transaction?.status ?? 'not found'}, requires COMPLETED`,
      );
    }

    const platformFeeAccount = await this.prisma.account.findFirst({
      where: { type: 'PLATFORM_FEE' },
      orderBy: { id: 'asc' },
    });

    if (!platformFeeAccount) {
      throw new NotFoundException('Platform fee account not found');
    }

    const escrowAccount = await this.prisma.account.findFirst({
      where: { type: 'ESCROW' },
      orderBy: { id: 'asc' },
    });

    if (!escrowAccount) {
      throw new NotFoundException('Escrow account not found');
    }

    return this.prisma.payout.create({
      data: {
        amount: params.amount,
        platformFee,
        sellerAmount,
        transactionId: params.transactionId,
        sellerId: params.sellerId,
        escrowAccountId: escrowAccount.id,
        platformFeeAccountId: platformFeeAccount.id,
        status: 'PENDING',
      },
    });
  }

  /** PENDING → ELIGIBLE (check seller is verified + fraud check) */
  async markEligible(payoutId: number) {
    const payout = await this.getPayout(payoutId);
    validateTransition(payout.status, 'ELIGIBLE');

    const seller = await this.prisma.seller.findUnique({
      where: { id: payout.sellerId },
    });

    if (!seller?.payoutsEnabled) {
      throw new BadRequestException(
        `Seller ${payout.sellerId} is not eligible for payouts (payoutsEnabled: false)`,
      );
    }

    if (seller.payoutsBlocked) {
      throw new BadRequestException(
        `Seller ${payout.sellerId} payouts are blocked (negative balance: ${seller.negativeBalance})`,
      );
    }

    const { balance } = await this.ledger.getAccountBalance(seller.accountId);

    if (balance < 0) {
      throw new BadRequestException(
        `Seller ${seller.id} has negative balance (${balance})`,
      );
    }

    // Fraud check — gate before eligibility
    const payoutCount24h = await this.prisma.payout.count({
      where: {
        sellerId: payout.sellerId,
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
    });

    const paidPayouts24h = await this.prisma.payout.aggregate({
      where: {
        sellerId: payout.sellerId,
        status: 'PAID',
        paidAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      _sum: { sellerAmount: true },
    });

    const failedPayouts7d = await this.prisma.payout.count({
      where: {
        sellerId: payout.sellerId,
        status: 'FAILED',
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    });

    const disputeCount = await this.prisma.dispute.count({
      where: {
        transaction: { payouts: { some: { sellerId: payout.sellerId } } },
      },
    });

    const accountAgeDays = Math.floor(
      (Date.now() - seller.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    );

    const fraudResult = await this.fraud.checkTransaction({
      transaction_id: payout.transactionId,
      seller_id: payout.sellerId,
      amount: payout.amount,
      seller_payout_count_24h: payoutCount24h,
      seller_total_amount_24h: paidPayouts24h._sum.sellerAmount || 0,
      seller_failed_payouts_7d: failedPayouts7d,
      seller_account_age_days: accountAgeDays,
      seller_dispute_count: disputeCount,
    });

    if (fraudResult.decision === 'BLOCK') {
      throw new BadRequestException(
        `Payout blocked by fraud engine (score: ${fraudResult.risk_score}, rules: ${fraudResult.rules_triggered.map(r => r.rule).join(', ')})`,
      );
    }

    const eligibleData =
      fraudResult.decision === 'REVIEW'
        ? {
            status: 'ELIGIBLE' as const,
            fraudScore: fraudResult.risk_score,
            fraudDecision: fraudResult.decision,
            failureReason: `Fraud review: ${fraudResult.rules_triggered.map((r) => r.rule).join(', ')}`,
          }
        : {
            status: 'ELIGIBLE' as const,
            fraudScore: fraudResult.risk_score,
            fraudDecision: fraudResult.decision,
          };

    // Optimistic lock: only update if still PENDING (guards concurrent calls)
    const updated = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: 'PENDING' },
      data: eligibleData,
    });

    if (updated.count === 0) {
      throw new BadRequestException(
        `Payout ${payoutId} is no longer PENDING (concurrent transition)`,
      );
    }

    return this.prisma.payout.findUniqueOrThrow({ where: { id: payoutId } });
  }

  /** ELIGIBLE → PROCESSING (send to Stripe) */
  async processPayout(payoutId: number) {
    const payout = await this.getPayout(payoutId);
    validateTransition(payout.status, 'PROCESSING');

    const seller = await this.prisma.seller.findUnique({
      where: { id: payout.sellerId },
    });

    if (!seller?.stripeAccountId) {
      throw new BadRequestException(`Seller ${payout.sellerId} has no Stripe account`);
    }

    // Phase 1: Optimistic lock — claim the payout atomically.
    // Use payout.status (not hardcoded 'ELIGIBLE') so retries from FAILED also work.
    const claimed = await this.prisma.payout.updateMany({
      where: { id: payoutId, status: payout.status },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      throw new BadRequestException(
        `Payout ${payoutId} is already being processed (concurrent transition)`,
      );
    }

    // Phase 2: Stripe transfer.
    // Idempotency key = payout ID + attempt so retries hit the same Stripe transfer.
    const idempotencyKey = `payout-${payoutId}-attempt-${payout.attempts + 1}`;

    // Check escrow balance before touching Stripe
    const { balance } = await this.ledger.getAccountBalance(payout.escrowAccountId);
    if (balance < payout.amount) {
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'FAILED',
          failureReason: `Insufficient escrow balance: ${balance}, required: ${payout.amount}`,
        },
      });
      throw new BadRequestException(
        `Insufficient escrow balance: ${balance}, required: ${payout.amount}`,
      );
    }

    let transfer: { id: string };
    try {
      transfer = await this.stripe.getStripe().transfers.create(
        {
          amount: payout.sellerAmount,
          currency: 'eur',
          destination: seller.stripeAccountId,
          metadata: { payoutId: String(payoutId) },
        },
        { idempotencyKey },
      );
    } catch (error) {
      // Stripe failed — no money moved, safe to mark FAILED and return.
      // This is an expected business outcome (insufficient funds, Stripe outage, etc.).
      const reason = error instanceof Error ? error.message : 'Unknown Stripe error';
      return this.prisma.payout.update({
        where: { id: payoutId },
        data: { status: 'FAILED', failureReason: reason },
      });
    }

    // Phase 3: Persist transfer ID immediately — CRITICAL.
    // If ledger posting crashes after this, reconciliation can detect the orphaned transfer
    // via the stripeTransferId on a FAILED payout record.
    await this.prisma.payout.update({
      where: { id: payoutId },
      data: { stripeTransferId: transfer.id },
    });

    // Phase 4: Ledger posting + final status.
    try {
      await this.ledger.releasePayout({
        amount: payout.amount,
        feeAmount: payout.platformFee,
        sellerAmount: payout.sellerAmount,
        escrowAccountId: payout.escrowAccountId,
        sellerAccountId: seller.accountId,
        platformFeeAccountId: payout.platformFeeAccountId,
      });

      return this.prisma.payout.update({
        where: { id: payoutId },
        data: { status: 'PAID', paidAt: new Date() },
      });
    } catch (error) {
      // Stripe transfer succeeded but ledger posting failed.
      // Money moved but our books don't reflect it — requires manual reconciliation.
      const reason = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(
        { payoutId, stripeTransferId: transfer.id, error: reason },
        'CRITICAL: Stripe transfer succeeded but ledger posting failed. Manual reconciliation required.',
      );
      await this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'FAILED',
          failureReason: `Ledger posting failed after Stripe transfer ${transfer.id}: ${reason}`,
        },
      });
      throw new Error(
        `Payout ${payoutId}: Stripe transfer ${transfer.id} succeeded but ledger posting failed. Requires manual reconciliation.`,
      );
    }
  }

  /** FAILED → PROCESSING (retry) */
  async retryPayout(payoutId: number) {
    const payout = await this.getPayout(payoutId);

    if (payout.attempts >= payout.maxAttempts) {
      throw new BadRequestException(
        `Payout ${payoutId} exceeded max attempts (${payout.maxAttempts})`,
      );
    }

    // FAILED → PROCESSING (validateTransition handles the check)
    return this.processPayout(payoutId);
  }

  /** Get payout by ID */
  async getPayout(payoutId: number) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });

    if (!payout) {
      throw new NotFoundException(`Payout ${payoutId} not found`);
    }

    return payout;
  }

  /** List payouts by status */
  async getPayoutsByStatus(status: PayoutStatus) {
    return this.prisma.payout.findMany({
      where: { status },
      include: { seller: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Legacy method — kept for queue processor compatibility */
  async releasePayout(params: {
    amount: number;
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    platformFeePercent?: number;
  }) {
    const feePercent = params.platformFeePercent || 5;
    const { fee: feeAmount, sellerAmount } = calculateFee(params.amount, feePercent);

    return this.ledger.releasePayout({
      amount: params.amount,
      feeAmount,
      sellerAmount,
      escrowAccountId: params.escrowAccountId,
      sellerAccountId: params.sellerAccountId,
      platformFeeAccountId: params.platformFeeAccountId,
    });
  }

  /** Reverse a PAID payout (Stripe refund/reversal) */
  async reversePayout(payoutId: number) {
    const payout = await this.getPayout(payoutId);

    if (payout.status !== 'PAID') {
      throw new BadRequestException(
        `Can only reverse PAID payouts (current: ${payout.status})`,
      );
    }

    const seller = await this.prisma.seller.findUnique({
      where: { id: payout.sellerId },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${payout.sellerId} not found`);
    }

    // Reverse Stripe transfer — idempotent via reversal-scoped key
    if (payout.stripeTransferId) {
      try {
        await this.stripe.getStripe().transfers.createReversal(
          payout.stripeTransferId,
          {},
          { idempotencyKey: `reversal-${payoutId}` },
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        throw new BadRequestException(`Stripe reversal failed: ${reason}`);
      }
    }

    // Reverse ledger entries
    await this.ledger.reversePayout({
      amount: payout.amount,
      feeAmount: payout.platformFee,
      sellerAmount: payout.sellerAmount,
      escrowAccountId: payout.escrowAccountId,
      sellerAccountId: seller.accountId,
      platformFeeAccountId: payout.platformFeeAccountId,
      reason: `Reversal of payout #${payoutId}`,
    });

    return this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: 'REVERSED' },
    });
  }

  /** Admin: get payout stats summary */
  async getPayoutStats() {
    const [pending, eligible, processing, paid, failed] = await Promise.all([
      this.prisma.payout.count({ where: { status: 'PENDING' } }),
      this.prisma.payout.count({ where: { status: 'ELIGIBLE' } }),
      this.prisma.payout.count({ where: { status: 'PROCESSING' } }),
      this.prisma.payout.count({ where: { status: 'PAID' } }),
      this.prisma.payout.count({ where: { status: 'FAILED' } }),
    ]);

    const blocked = await this.prisma.payout.count({
      where: {
        status: 'FAILED',
        attempts: { gte: 3 },
      },
    });

    const totalPaid = await this.prisma.payout.aggregate({
      where: { status: 'PAID' },
      _sum: { sellerAmount: true, platformFee: true },
    });

    return {
      counts: { pending, eligible, processing, paid, failed, blocked },
      totals: {
        paidToSellers: totalPaid._sum.sellerAmount || 0,
        platformFees: totalPaid._sum.platformFee || 0,
      },
    };
  }

  async forceRetry(payoutId: number) {
    const payout = await this.getPayout(payoutId);

    if (payout.status !== 'FAILED') {
      throw new BadRequestException(
        `Can only force-retry FAILED payouts (current: ${payout.status})`,
      );
    }

    // Reset attempts to allow retry
    await this.prisma.payout.update({
      where: { id: payoutId },
      data: { attempts: 0 },
    });

    return this.processPayout(payoutId);
  }

  async getPayoutsByFraudDecision(decision: string) {
    return this.prisma.payout.findMany({
      where: { fraudDecision: decision as any },
      include: { seller: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}