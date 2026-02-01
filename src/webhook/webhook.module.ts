import { Module } from '@nestjs/common';
import { WebhookController } from './webhook.controller';
import { WebhookService } from './webhook.service';
import { StripeModule } from '../stripe/stripe.module';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [StripeModule, PrismaModule],
  controllers: [WebhookController],
  providers: [WebhookService],
})
export class WebhookModule {}