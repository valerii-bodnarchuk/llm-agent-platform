import { Injectable } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { LedgerService } from '../ledger/ledger.service';
import { IdempotencyService } from '../idempotency/idempotency.service';

@Injectable()
export class PaymentService {
  constructor(
    private stripe: StripeService,
    private ledger: LedgerService,
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

    const paymentIntent = await this.stripe.createPaymentIntent(params.amount);

    const transaction = await this.ledger.createTransaction({
      description: `Payment ${paymentIntent.id}`,
      entries: [
        { accountId: params.buyerAccountId, amount: params.amount, type: 'DEBIT' },
        { accountId: params.escrowAccountId, amount: params.amount, type: 'CREDIT' },
      ],
    });

    const result = { paymentIntent, transaction };

    if (idempotencyKey) {
      await this.idempotency.set(idempotencyKey, JSON.stringify(result));
    }

    return result;
  }
}