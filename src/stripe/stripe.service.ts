import { Injectable } from '@nestjs/common';
import Stripe from 'stripe';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-01-28.clover',
    });
  }

  async createPaymentIntent(amount: number, currency: string = 'eur') {
    return this.stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency,
    });
  }

  getStripe() {
    return this.stripe;
  }
}