import { Injectable } from '@nestjs/common';
import { StripeService } from '../stripe/stripe.service';
import { LedgerService } from '../ledger/ledger.service';
// import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PaymentService {
  constructor(
    private stripe: StripeService,
    private ledger: LedgerService,
    // private prisma: PrismaService,
  ) {}

  async createPayment(params: {
    amount: number;
    buyerAccountId: number;
    escrowAccountId: number;
  }) {
    const paymentIntent = await this.stripe.createPaymentIntent(params.amount);

    const transaction = await this.ledger.createTransaction({
      description: `Payment ${paymentIntent.id}`,
      entries: [
        { accountId: params.buyerAccountId, amount: params.amount, type: 'DEBIT' },
        { accountId: params.escrowAccountId, amount: params.amount, type: 'CREDIT' },
      ],
    });

    return { paymentIntent, transaction };
  }
}