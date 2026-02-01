import { Controller, Post, Req, Headers, RawBodyRequest, BadRequestException } from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { Request } from 'express';
import Stripe from 'stripe';

@Controller('webhooks')
export class WebhookController {
  constructor(private webhookService: WebhookService) {}

  @Post('stripe')
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

    if (event.type === 'payment_intent.succeeded') {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      await this.webhookService.handlePaymentSuccess(paymentIntent);
    }

    return { received: true };
  }
}