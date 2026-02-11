import { Controller, Post, Req, Headers, RawBodyRequest, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { WebhookService } from './webhook.service';
import { Request } from 'express';
import Stripe from 'stripe';

@Controller('webhooks')
export class WebhookController {
  constructor(private webhookService: WebhookService) {}

  @Post('stripe')
  @Throttle({ default: { limit: 50, ttl: 60000 } })
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    if (!signature) {
      throw new BadRequestException('Missing stripe-signature header');
    }

    const rawBody = req.rawBody as Buffer;

    const event = await this.webhookService.verifyAndParseWebhook(
      rawBody,
      signature,
    );

    switch (event.type) {
      case 'payment_intent.succeeded':
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await this.webhookService.handlePaymentSuccess(paymentIntent);
        break;

      case 'account.updated':
        const account = event.data.object as Stripe.Account;
        await this.webhookService.handleAccountUpdated(account);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return { received: true };
  }
}