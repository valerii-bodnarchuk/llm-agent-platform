import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { StripeModule } from '../stripe/stripe.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SellerModule } from '../seller/seller.module';

@Module({
  imports: [StripeModule, PrismaModule, SellerModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}