import { Module, Global } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PayoutQueue } from './payout.queue';
import { PayoutProcessor } from './payout.processor';
import { QueueController } from './queue.controller';
import { PayoutScheduler } from './payout.scheduler';
import { PayoutModule } from '../payout/payout.module';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [ScheduleModule.forRoot(), PayoutModule, PrismaModule],
  controllers: [QueueController],
  providers: [PayoutQueue, PayoutProcessor, PayoutScheduler],
  exports: [PayoutQueue],
})
export class QueueModule {}