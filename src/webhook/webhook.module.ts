import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { StripeModule } from '../stripe/stripe.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SellerModule } from '../seller/seller.module';
import { DisputeModule } from '../dispute/dispute.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [StripeModule, PrismaModule, SellerModule, DisputeModule, LedgerModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}