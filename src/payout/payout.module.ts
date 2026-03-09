import { Module } from '@nestjs/common';
import { PayoutService } from './payout.service';
import { PayoutController } from './payout.controller';
import { LedgerModule } from '../ledger/ledger.module';
import { StripeModule } from '../stripe/stripe.module';
import { PrismaModule } from '../prisma/prisma.module';
import { FraudModule } from '../fraud/fraud.module';

@Module({
  imports: [LedgerModule, StripeModule, PrismaModule, FraudModule],
  controllers: [PayoutController],
  providers: [PayoutService],
  exports: [PayoutService],
})
export class PayoutModule {}