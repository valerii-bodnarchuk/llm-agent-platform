import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger/ledger.module';
import { StripeModule } from './stripe/stripe.module';
import { PaymentModule } from './payment/payment.module';
import { WebhookModule } from './webhook/webhook.module';
import { PayoutModule } from './payout/payout.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { QueueModule } from './queue/queue.module';

@Module({
  imports: [QueueModule, IdempotencyModule, LedgerModule, StripeModule, PaymentModule, WebhookModule, PayoutModule],
})
export class AppModule {}