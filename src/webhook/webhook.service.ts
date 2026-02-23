import { Injectable, BadRequestException } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { SellerService } from '../seller/seller.service';
import { DisputeService } from '../dispute/dispute.service';
import { PinoLogger, InjectPinoLogger } from 'nestjs-pino';
import { DisputeReason } from '@prisma/client';
import Stripe from 'stripe';

@Injectable()
export class WebhookService {
  constructor(
    @InjectPinoLogger(WebhookService.name)
    private readonly logger: PinoLogger,
    private stripe: StripeService,
    private prisma: PrismaService,
    private sellerService: SellerService,
    private disputeService: DisputeService,
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
      this.logger.error(`Transaction not found for ${paymentIntent.id}`);
      return;
    }

    await this.prisma.transaction.update({
      where: { id: transaction.id },
      data: { status: 'COMPLETED' },
    });

    this.logger.info(`Transaction ${transaction.id} marked as COMPLETED`);
  }

  async handleAccountUpdated(account: Stripe.Account) {
    this.logger.info(`Stripe account updated: ${account.id}`);
    await this.sellerService.syncStripeStatus(account.id);
  }

  async handleDisputeCreated(dispute: Stripe.Dispute) {
    this.logger.info(`Stripe dispute created: ${dispute.id}`);

    // Find transaction by payment intent ID
    const paymentIntentId = typeof dispute.payment_intent === 'string'
      ? dispute.payment_intent
      : dispute.payment_intent?.id;

    if (!paymentIntentId) {
      this.logger.error(`Dispute ${dispute.id} has no payment intent`);
      return;
    }

    const transaction = await this.prisma.transaction.findFirst({
      where: {
        description: { contains: paymentIntentId },
      },
    });

    if (!transaction) {
      this.logger.error(`Transaction not found for payment intent ${paymentIntentId}`);
      return;
    }

    // Map Stripe reason to our enum
    const reasonMap: Record<string, DisputeReason> = {
      'product_not_received': 'PRODUCT_NOT_RECEIVED',
      'product_unacceptable': 'PRODUCT_UNACCEPTABLE',
      'fraudulent': 'FRAUDULENT',
      'duplicate': 'DUPLICATE',
    };

    const reason: DisputeReason = reasonMap[dispute.reason] || 'OTHER';

    await this.disputeService.openDispute({
      transactionId: transaction.id,
      reason,
      amount: dispute.amount / 100, // Stripe uses cents
      description: `Stripe dispute: ${dispute.reason}`,
      stripeDisputeId: dispute.id,
    });

    this.logger.info(`Dispute created for transaction ${transaction.id}`);
  }
} 