import { Injectable, BadRequestException } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
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
    private ledger: LedgerService,
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
    const transaction = await this.prisma.transaction.findUnique({
      where: { stripePaymentIntentId: paymentIntent.id },
    });

    if (!transaction) {
      this.logger.error({ paymentIntentId: paymentIntent.id }, 'Transaction not found');
      return;
    }

    // Idempotency: duplicate webhook on already-settled transaction
    if (transaction.status === 'COMPLETED') {
      this.logger.info({ transactionId: transaction.id }, 'Already settled, skipping');
      return;
    }

    const buyerAccountId = parseInt(paymentIntent.metadata?.buyerAccountId);
    const escrowAccountId = parseInt(paymentIntent.metadata?.escrowAccountId);

    if (!buyerAccountId || !escrowAccountId) {
      this.logger.error({ paymentIntentId: paymentIntent.id }, 'Missing account metadata');
      return;
    }

    const amount = paymentIntent.amount / 100; // Stripe cents → euros

    await this.ledger.settleTransaction({
      transactionId: transaction.id,
      entries: [
        { accountId: buyerAccountId, amount, type: 'DEBIT', narrative: `Payment settled: ${paymentIntent.id}` },
        { accountId: escrowAccountId, amount, type: 'CREDIT', narrative: `Escrow received: ${paymentIntent.id}` },
      ],
    });

    this.logger.info({ transactionId: transaction.id, amount }, 'Payment settled');
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

    const transaction = await this.prisma.transaction.findUnique({
      where: {
        stripePaymentIntentId: paymentIntentId,
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