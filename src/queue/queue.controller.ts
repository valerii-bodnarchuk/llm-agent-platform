import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PayoutQueue } from './payout.queue';
import { AddPayoutJobDto } from './dto/add-payout-job.dto';

@ApiTags('Queue')
@Controller('queue')
export class QueueController {
  constructor(private payoutQueue: PayoutQueue) {}

  @Post('payout')
  async addPayoutJob(@Body() body: AddPayoutJobDto) {
    const job = await this.payoutQueue.addPayoutJob(body);
    return { jobId: job.id, status: 'queued' };
  }
}