import { Queue } from 'bullmq';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';

@Injectable()
export class PayoutQueue implements OnModuleDestroy {
  private queue: Queue;

  constructor(private redisService: RedisService) {
    this.queue = new Queue('payouts', {
      connection: this.redisService.getConnectionConfig(),
    });
  }

  async onModuleDestroy() {
    await this.queue.close();
  }

  async addPayoutJob(data: {
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    amount: number;
  }) {
    return this.queue.add('process-payout', data);
  }

  getQueue() {
    return this.queue;
  }
}
