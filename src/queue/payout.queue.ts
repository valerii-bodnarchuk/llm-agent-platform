import { Queue, Worker } from 'bullmq';
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
};

@Injectable()
export class PayoutQueue implements OnModuleInit, OnModuleDestroy {
  private queue: Queue;
  private worker!: Worker;

  constructor() {
    this.queue = new Queue('payouts', { connection });
  }

  async onModuleInit() {
    // Worker будет создан в PayoutProcessor
  }

  async onModuleDestroy() {
    await this.queue.close();
    if (this.worker) await this.worker.close();
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