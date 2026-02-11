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

    return this.prisma.payout.create({
      data: {
        amount: params.amount,
        platformFee,
        sellerAmount,
        transactionId: params.transactionId,
        sellerId: params.sellerId,
        escrowAccountId: seller.accountId,
        platformFeeAccountId: 1, // TODO: resolve from config
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
}