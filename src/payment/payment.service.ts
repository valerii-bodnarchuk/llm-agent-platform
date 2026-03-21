import { Injectable } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

@Injectable()
export class PaymentService {
  constructor(
    private stripe: StripeService,
    private prisma: PrismaService,
    private idempotency: IdempotencyService,
  ) {}

  async createPayment(
    params: {
      amount: number;
      buyerAccountId: number;
      escrowAccountId: number;
    },
    idempotencyKey?: string,
  ) {
    if (idempotencyKey) {
      const cached = await this.idempotency.get(idempotencyKey);
      if (cached) {
        return JSON.parse(cached);
      }
    }

    const paymentIntent = await this.stripe.createPaymentIntent(params.amount, 'eur', {
      buyerAccountId: String(params.buyerAccountId),
      escrowAccountId: String(params.escrowAccountId),
    });

    const transaction = await this.prisma.transaction.create({
      data: {
        description: `Payment intent ${paymentIntent.id}`,
        stripePaymentIntentId: paymentIntent.id,
        status: 'PENDING',
      },
    });

    const result = { paymentIntent, transaction };

    if (idempotencyKey) {
      await this.idempotency.set(idempotencyKey, JSON.stringify(result));
    }

    return result;
  }
}
