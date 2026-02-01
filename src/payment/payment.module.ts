import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { StripeModule } from '../stripe/stripe.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentController } from './payment.controller';

@Module({
  imports: [StripeModule, LedgerModule, PrismaModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}