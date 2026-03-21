import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PayoutQueue } from './payout.queue';
import { PrismaService } from '../prisma/prisma.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class PayoutScheduler {
  constructor(
    @InjectPinoLogger(PayoutScheduler.name)
    private readonly logger: PinoLogger,
    private payoutQueue: PayoutQueue,
    private prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async scheduleDailyPayouts() {
    this.logger.info('Running daily payout scheduler...');

    // Find all completed transactions that need payout
    const completedTransactions = await this.prisma.transaction.findMany({
      where: {
        status: 'COMPLETED',
        description: { contains: 'Payment' }, // Only payment transactions
      },
      include: { entries: true },
    });

    for (const transaction of completedTransactions) {
      // Extract amount from entries (escrow CREDIT entry)
      const escrowEntry = transaction.entries.find(
        (e) => e.type === 'CREDIT' && e.accountId === 7, // escrow account
      );

      if (escrowEntry) {
        await this.payoutQueue.addPayoutJob({
          amount: escrowEntry.amount,
          escrowAccountId: 7,
          sellerAccountId: 6,
          platformFeeAccountId: 8,
        });
      }
    }

    this.logger.info(`Added ${completedTransactions.length} payout jobs to queue`);
  }
}