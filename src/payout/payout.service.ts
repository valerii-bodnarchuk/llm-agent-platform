import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { StripeService } from '../stripe/stripe.service';
import { PayoutStatus } from '@prisma/client';
import { validateTransition } from './payout-state-machine';

@Injectable()
export class PayoutService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
    private stripe: StripeService,
  ) {}

  /** Create a payout request (PENDING) */
  async createPayout(params: {
    transactionId: number;
    sellerId: number;
    amount: number;
    platformFeePercent?: number;
  }) {
    const feePercent = params.platformFeePercent || 5;
    const platformFee = params.amount * (feePercent / 100);
    const sellerAmount = params.amount - platformFee;

    const seller = await this.prisma.seller.findUnique({
      where: { id: params.sellerId },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${params.sellerId} not found`);
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

  /** PENDING → ELIGIBLE (check seller is verified) */
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

    return this.prisma.payout.update({
      where: { id: payoutId },
      data: { status: 'ELIGIBLE' },
    });
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

    // Update status + increment attempts
    await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PROCESSING',
        attempts: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    try {
      // Check escrow balance before sending to Stripe
      const { balance } = await this.ledger.getAccountBalance(payout.escrowAccountId);
      if (balance < Number(payout.amount)) {
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

      // Transfer from platform to connected account
      const transfer = await this.stripe.getStripe().transfers.create({
        amount: Math.round(Number(payout.sellerAmount) * 100),
        currency: 'eur',
        destination: seller.stripeAccountId,
        metadata: { payoutId: String(payoutId) },
      });

      // Ledger entries: escrow → seller + platform fee
      await this.ledger.releasePayout({
        amount: Number(payout.amount),
        escrowAccountId: payout.escrowAccountId,
        sellerAccountId: seller.accountId,
        platformFeeAccountId: payout.platformFeeAccountId,
        platformFeePercent: Number(payout.platformFee) / Number(payout.amount) * 100,
      });

      // PROCESSING → PAID
      return this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'PAID',
          stripeTransferId: transfer.id,
          paidAt: new Date(),
        },
      });
    } catch (error) {
      // PROCESSING → FAILED
      const reason = error instanceof Error ? error.message : 'Unknown error';

      return this.prisma.payout.update({
        where: { id: payoutId },
        data: {
          status: 'FAILED',
          failureReason: reason,
        },
      });
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

    return this.ledger.releasePayout({
      amount: params.amount,
      escrowAccountId: params.escrowAccountId,
      sellerAccountId: params.sellerAccountId,
      platformFeeAccountId: params.platformFeeAccountId,
      platformFeePercent: feePercent,
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

    // Reverse Stripe transfer
    if (payout.stripeTransferId) {
      try {
        await this.stripe.getStripe().transfers.createReversal(
          payout.stripeTransferId,
        );
      } catch (error) {
        const reason = error instanceof Error ? error.message : 'Unknown error';
        throw new BadRequestException(`Stripe reversal failed: ${reason}`);
      }
    }

    // Reverse ledger entries
    await this.ledger.reversePayout({
      amount: Number(payout.amount),
      escrowAccountId: payout.escrowAccountId,
      sellerAccountId: seller.accountId,
      platformFeeAccountId: payout.platformFeeAccountId,
      platformFeePercent: Number(payout.platformFee) / Number(payout.amount) * 100,
      reason: `Reversal of payout #${payoutId}`,
    });

    return this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'FAILED',
        failureReason: 'Manually reversed',
      },
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
        paidToSellers: Number(totalPaid._sum.sellerAmount || 0),
        platformFees: Number(totalPaid._sum.platformFee || 0),
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
}