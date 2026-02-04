import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { ReconciliationController } from './reconciliation.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { StripeModule } from '../stripe/stripe.module';

@Module({
  imports: [ScheduleModule.forRoot(), PrismaModule, StripeModule],
  controllers: [ReconciliationController],
  providers: [ReconciliationService, ReconciliationScheduler],
  exports: [ReconciliationService],
})
export class ReconciliationModule {}