import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger/ledger.module';
import { StripeModule } from './stripe/stripe.module';
import { PaymentModule } from './payment/payment.module';
import { WebhookModule } from './webhook/webhook.module';

@Module({
  imports: [LedgerModule, StripeModule, PaymentModule, WebhookModule],
})
export class AppModule {}