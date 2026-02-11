import { Injectable, BadRequestException } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { SellerService } from '../seller/seller.service';
import Stripe from 'stripe';

@Injectable()
export class WebhookService {
  constructor(
    private stripe: StripeService,
    private prisma: PrismaService,
    private sellerService: SellerService,
  ) {}

  async verifyAndParseWebhook(
    rawBody: Buffer,
    signature: string,
  ): Promise<Stripe.Event> {
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET!;

    try {
      return this.stripe.getStripe().webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      throw new BadRequestException('Webhook signature verification failed');
    }
  }

  async handlePaymentSuccess(paymentIntent: Stripe.PaymentIntent) {
    const transaction = await this.prisma.transaction.findFirst({
      where: {
        description: { contains: paymentIntent.id },
      },
    });

    if (!transaction) {
      console.error(`Transaction not found for ${paymentIntent.id}`);
      return;
    }

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'COMPLETED' },
    });

    console.log(`Transaction ${transaction.id} marked as COMPLETED`);
  }

  async handleAccountUpdated(account: Stripe.Account) {
    console.log(`Stripe account updated: ${account.id}`);
    await this.sellerService.syncStripeStatus(account.id);
  }
} 