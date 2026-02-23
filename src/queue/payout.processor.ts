import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { PayoutService } from '../payout/payout.service';
import { RedisService } from '../redis/redis.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class PayoutProcessor implements OnModuleInit, OnModuleDestroy {
  private worker!: Worker;

  constructor(
    @InjectPinoLogger(PayoutProcessor.name)
    private readonly logger: PinoLogger,
    private payoutService: PayoutService,
    private redisService: RedisService,
  ) {}

  onModuleInit() {
    this.worker = new Worker(
      'payouts',
      async (job) => {
        this.logger.info(`Processing payout job ${job.id}`, job.data);

        await this.payoutService.releasePayout({
          amount: job.data.amount,
          escrowAccountId: job.data.escrowAccountId,
          sellerAccountId: job.data.sellerAccountId,
          platformFeeAccountId: job.data.platformFeeAccountId,
        });

        return { success: true };
      },
      { connection: this.redisService.getConnectionConfig() },
    );

    this.worker.on('completed', (job) => {
      this.logger.info(`Payout job ${job.id} completed`);
    });

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Payout job ${job?.id} failed:`, err);
    });
  }

  async onModuleDestroy() {
    await this.worker.close();
  }
}
