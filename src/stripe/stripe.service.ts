import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';
import { withRetry } from '../common/utils/retry.util';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-01-28.clover',
    });
  }

  async createPaymentIntent(amount: number, currency: string = 'eur') {
    return withRetry(
      () =>
        this.stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency,
        }),
      { maxAttempts: 3, delayMs: 1000 },
    );
  }

  getStripe() {
    return this.stripe;
  }
}