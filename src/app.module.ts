import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger/ledger.module';
import { StripeModule } from './stripe/stripe.module';
import { PaymentModule } from './payment/payment.module';
import { WebhookModule } from './webhook/webhook.module';
import { PayoutModule } from './payout/payout.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { QueueModule } from './queue/queue.module';
import { ReconciliationModule } from './reconciliation/reconciliation.module';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';


@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60000, // 60 seconds
        limit: 100, // 100 requests per minute (global)
      },
    ]),
    ReconciliationModule, // ← убери второй
    QueueModule,
    IdempotencyModule,
    LedgerModule,
    StripeModule,
    PaymentModule,
    WebhookModule,
    PayoutModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}