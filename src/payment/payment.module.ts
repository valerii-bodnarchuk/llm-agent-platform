import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { StripeModule } from '../stripe/stripe.module';
import { PrismaModule } from '../prisma/prisma.module';
import { PaymentController } from './payment.controller';

@Module({
  imports: [StripeModule, PrismaModule],
  controllers: [PaymentController],
  providers: [PaymentService],
  exports: [PaymentService],
})
export class PaymentModule {}