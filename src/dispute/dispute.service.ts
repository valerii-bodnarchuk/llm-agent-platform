import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { PayoutService } from '../payout/payout.service';
import { DisputeStatus, DisputeReason } from '@prisma/client';
import { validateDisputeTransition } from './dispute-state-machine';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class DisputeService {
  constructor(
    @InjectPinoLogger(DisputeService.name)
    private readonly logger: PinoLogger,
    private prisma: PrismaService,
    private ledger: LedgerService,
    private payoutService: PayoutService,
  ) {}

  /** Open a dispute — freezes any pending payout */
  async openDispute(params: {
    transactionId: number;
    reason: DisputeReason;
    amount: number;
    description?: string;
    stripeDisputeId?: string;
  }) {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: params.transactionId },
      include: { payouts: true },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${params.transactionId} not found`);
    }

    // Find and freeze any pending/eligible payouts for this transaction
    const freezablePayout = transaction.payouts.find(
      (p) => p.status === 'PENDING' || p.status === 'ELIGIBLE',
    );

    const dispute = await this.prisma.dispute.create({
      data: {
        transactionId: params.transactionId,
        reason: params.reason,
        amount: params.amount,
        description: params.description,
        stripeDisputeId: params.stripeDisputeId,
        payoutId: freezablePayout?.id,
        status: 'OPEN',
      },
    });

    // Freeze the payout — move back to PENDING so it can't be processed
    if (freezablePayout && freezablePayout.status === 'ELIGIBLE') {
      await this.prisma.payout.update({
        where: { id: freezablePayout.id },
        data: {
          status: 'PENDING',
          failureReason: `Frozen: dispute #${dispute.id} opened`,
        },
      });
    }

    return dispute;
  }

  /** OPEN → UNDER_REVIEW */
  async startReview(disputeId: number) {
    const dispute = await this.getDispute(disputeId);
    validateDisputeTransition(dispute.status, 'UNDER_REVIEW');

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: { status: 'UNDER_REVIEW' },
    });
  }

  /** UNDER_REVIEW → WON (seller wins, release payout) */
  async resolveWon(disputeId: number, note?: string) {
    const dispute = await this.getDispute(disputeId);
    validateDisputeTransition(dispute.status, 'WON');

    // Unfreeze payout if it was frozen
    if (dispute.payoutId) {
      const payout = await this.prisma.payout.findUnique({
        where: { id: dispute.payoutId },
      });

      if (payout && payout.status === 'PENDING') {
        await this.prisma.payout.update({
          where: { id: dispute.payoutId },
          data: {
            status: 'PENDING',
            failureReason: null,
          },
        });
      }
    }

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: 'WON',
        resolvedAt: new Date(),
        resolutionNote: note || 'Dispute resolved in favor of seller',
      },
    });
  }

  /** UNDER_REVIEW → LOST (buyer wins, reverse payout if paid) */
  async resolveLost(disputeId: number, note?: string) {
      const dispute = await this.getDispute(disputeId);
      validateDisputeTransition(dispute.status, 'LOST');

      // Find the payout to reverse — either linked or by transaction
      let payoutToReverse = dispute.payoutId
        ? await this.prisma.payout.findUnique({ where: { id: dispute.payoutId } })
        : null;

      if (!payoutToReverse) {
        payoutToReverse = await this.prisma.payout.findFirst({
          where: { transactionId: dispute.transactionId, status: 'PAID' },
        });
      }

      if (payoutToReverse && payoutToReverse.status === 'PAID') {
        await this.payoutService.reversePayout(payoutToReverse.id);
        await this.updateSellerNegativeBalance(payoutToReverse.sellerId);
      }

      return this.prisma.dispute.update({
        where: { id: disputeId },
        data: {
          status: 'LOST',
          resolvedAt: new Date(),
          resolutionNote: note || 'Dispute resolved in favor of buyer',
        },
      });
    }

  /** UNDER_REVIEW → REFUNDED (full refund to buyer) */
  async resolveRefunded(disputeId: number, note?: string) {
    const dispute = await this.getDispute(disputeId);
    validateDisputeTransition(dispute.status, 'REFUNDED');

    // Reverse payout if paid
    let payoutToReverse = dispute.payoutId
      ? await this.prisma.payout.findUnique({ where: { id: dispute.payoutId } })
      : null;

    if (!payoutToReverse) {
      payoutToReverse = await this.prisma.payout.findFirst({
        where: { transactionId: dispute.transactionId, status: 'PAID' },
      });
    }

    if (payoutToReverse && payoutToReverse.status === 'PAID') {
      await this.payoutService.reversePayout(payoutToReverse.id);

      await this.updateSellerNegativeBalance(payoutToReverse.sellerId);
    }

    // Refund: escrow → buyer
    const escrowAccount = await this.prisma.account.findFirst({
      where: { type: 'ESCROW' },
      orderBy: { id: 'asc' },
    });

    const transaction = await this.prisma.transaction.findUnique({
      where: { id: dispute.transactionId },
      include: { entries: true },
    });

    if (escrowAccount && transaction) {
      // Find the buyer from the original transaction (the DEBIT entry)
      const buyerEntry = transaction.entries.find((e) => e.type === 'DEBIT');

      if (buyerEntry) {
        await this.ledger.createTransaction({
          description: `REFUND: dispute #${disputeId}`,
          entries: [
            { accountId: escrowAccount.id, amount: Number(dispute.amount), type: 'DEBIT' },
            { accountId: buyerEntry.accountId, amount: Number(dispute.amount), type: 'CREDIT' },
          ],
        });
      }
    }

    return this.prisma.dispute.update({
      where: { id: disputeId },
      data: {
        status: 'REFUNDED',
        resolvedAt: new Date(),
        resolutionNote: note || 'Full refund issued to buyer',
      },
    });
  }

  async getDispute(disputeId: number) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });

    if (!dispute) {
      throw new NotFoundException(`Dispute ${disputeId} not found`);
    }

    return dispute;
  }

  async listDisputes(status?: DisputeStatus) {
    return this.prisma.dispute.findMany({
      where: status ? { status } : undefined,
      include: { transaction: true, payout: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Check seller balance after reversal, block if negative */
  private async updateSellerNegativeBalance(sellerId: number) {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      include: { account: true },
    });

    if (!seller) return;

    const { balance } = await this.ledger.getAccountBalance(seller.accountId);

    if (balance < 0) {
      await this.prisma.seller.update({
        where: { id: sellerId },
        data: {
          negativeBalance: Math.abs(balance),
          payoutsBlocked: true,
        },
      });
      this.logger.info(`Seller ${sellerId} blocked: negative balance ${balance}`);
    }
  }
}