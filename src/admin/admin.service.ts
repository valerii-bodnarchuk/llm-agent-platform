import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class AdminService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
  ) {}

  /**
   * Aggregate all risk-relevant data for a seller into a single response.
   * Designed for fraud investigation — combines seller record, ledger balance,
   * and computed risk metrics in one round-trip.
   */
  async getSellerRiskProfile(sellerId: number) {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${sellerId} not found`);
    }

    const now = Date.now();
    const twentyFourHoursAgo = new Date(now - 24 * 60 * 60 * 1000);

    // Parallel queries — all independent, no reason to serialize
    const [
      allPayouts,
      payouts24h,
      allDisputes,
      lostDisputes,
      { balance },
    ] = await Promise.all([
      this.prisma.payout.findMany({
        where: { sellerId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.payout.findMany({
        where: {
          sellerId,
          createdAt: { gte: twentyFourHoursAgo },
        },
      }),
      this.prisma.dispute.count({
        where: {
          transaction: { payouts: { some: { sellerId } } },
        },
      }),
      this.prisma.dispute.count({
        where: {
          status: 'LOST',
          transaction: { payouts: { some: { sellerId } } },
        },
      }),
      this.ledger.getAccountBalance(seller.accountId),
    ]);

    const statusCounts = { paid: 0, failed: 0, reversed: 0 };
    let totalVolumeLifetime = 0;
    let lastFailureDate: Date | null = null;

    for (const p of allPayouts) {
      if (p.status === 'PAID') statusCounts.paid++;
      if (p.status === 'FAILED') {
        statusCounts.failed++;
        if (!lastFailureDate || p.createdAt > lastFailureDate) {
          lastFailureDate = p.createdAt;
        }
      }
      if (p.status === 'REVERSED') statusCounts.reversed++;
      totalVolumeLifetime += p.amount;
    }

    const totalVolume24h = payouts24h.reduce((sum, p) => sum + p.amount, 0);
    const accountAgeDays = Math.floor(
      (now - seller.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    );

    const firstPayout = allPayouts.length > 0 ? allPayouts[0] : null;

    let timeSinceLastFailure: string | null = null;
    if (lastFailureDate) {
      const diffMs = now - lastFailureDate.getTime();
      const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
      const diffDays = Math.floor(diffHours / 24);
      timeSinceLastFailure =
        diffDays > 0 ? `${diffDays}d ${diffHours % 24}h` : `${diffHours}h`;
    }

    return {
      seller: {
        id: seller.id,
        name: seller.name,
        email: seller.email,
        status: seller.status,
        stripeAccountId: seller.stripeAccountId,
        chargesEnabled: seller.chargesEnabled,
        payoutsEnabled: seller.payoutsEnabled,
        payoutsBlocked: seller.payoutsBlocked,
        negativeBalance: seller.negativeBalance,
        accountAgeDays,
        createdAt: seller.createdAt.toISOString(),
      },
      ledger: {
        accountId: seller.accountId,
        balance,
      },
      riskMetrics: {
        totalPayouts: allPayouts.length,
        paidPayouts: statusCounts.paid,
        failedPayouts: statusCounts.failed,
        reversedPayouts: statusCounts.reversed,
        totalDisputes: allDisputes,
        lostDisputes,
        payoutVelocity24h: payouts24h.length,
        totalVolume24h,
        totalVolumeLifetime,
        avgPayoutAmount:
          allPayouts.length > 0
            ? Math.round(totalVolumeLifetime / allPayouts.length)
            : 0,
        accountAgeDays,
        firstPayoutDate: firstPayout ? firstPayout.createdAt.toISOString() : null,
        timeSinceLastFailure,
      },
    };
  }

  /**
   * Chronological timeline of seller's payouts with computed metadata.
   * Designed for pattern detection — trend analysis, velocity spikes,
   * failure clustering.
   */
  async getPayoutTimeline(sellerId: number, daysBack = 30) {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${sellerId} not found`);
    }

    const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);

    const payouts = await this.prisma.payout.findMany({
      where: {
        sellerId,
        createdAt: { gte: since },
      },
      orderBy: { createdAt: 'desc' },
    });

    const terminalStatuses = new Set(['PAID', 'FAILED', 'REVERSED']);

    const timeline = payouts.map((p) => {
      let timeToCompletion: string | null = null;
      if (terminalStatuses.has(p.status)) {
        const endTime = p.paidAt ?? p.updatedAt;
        const diffMs = endTime.getTime() - p.createdAt.getTime();
        const diffMinutes = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMinutes / 60);
        timeToCompletion =
          diffHours > 0
            ? `${diffHours}h ${diffMinutes % 60}m`
            : `${diffMinutes}m`;
      }

      return {
        payoutId: p.id,
        createdAt: p.createdAt.toISOString(),
        amount: p.amount,
        sellerAmount: p.sellerAmount,
        status: p.status,
        fraudDecision: p.fraudDecision,
        fraudScore: p.fraudScore,
        failureReason: p.failureReason,
        timeToCompletion,
        transactionId: p.transactionId,
        attempts: p.attempts,
      };
    });

    // Status distribution
    const statusDistribution: Record<string, number> = {};
    for (const p of payouts) {
      statusDistribution[p.status] = (statusDistribution[p.status] || 0) + 1;
    }

    // Trend: compare volume in the older half vs the recent half of the window
    const midpoint = new Date(since.getTime() + (Date.now() - since.getTime()) / 2);
    let olderVolume = 0;
    let recentVolume = 0;
    for (const p of payouts) {
      if (p.createdAt < midpoint) olderVolume += p.amount;
      else recentVolume += p.amount;
    }

    let trend: 'increasing' | 'stable' | 'decreasing';
    if (olderVolume === 0 && recentVolume === 0) {
      trend = 'stable';
    } else if (olderVolume === 0 && recentVolume === 0) {
      trend = 'increasing';
    } else {
      const ratio = recentVolume / olderVolume;
      if (ratio > 1.3) trend = 'increasing';
      else if (ratio < 0.7) trend = 'decreasing';
      else trend = 'stable';
    }

    const totalAmount = payouts.reduce((sum, p) => sum + p.amount, 0);

    return {
      timeline,
      summary: {
        totalCount: payouts.length,
        statusDistribution,
        avgAmount: payouts.length > 0 ? Math.round(totalAmount / payouts.length) : 0,
        trend,
      },
    };
  }
}
