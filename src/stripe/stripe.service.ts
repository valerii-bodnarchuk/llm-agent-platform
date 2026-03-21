import Stripe from 'stripe';
import { Injectable } from '@nestjs/common';
import { withRetry } from '../common/utils/retry.util';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-01-28.clover',
    });
  }

  async createPaymentIntent(amount: number, currency: string = 'eur', metadata?: Record<string, string>) {
    return withRetry(
      () =>
        this.stripe.paymentIntents.create({
          amount: Math.round(amount * 100),
          currency,
          metadata,
        }),
      { maxAttempts: 3, delayMs: 1000 },
    );
  }

  /** Create Stripe Connect Express account */
  async createConnectAccount(email: string, name: string) {
    return withRetry(
      () =>
        this.stripe.accounts.create({
          type: 'express',
          email,
          capabilities: {
            transfers: { requested: true },
          },
          metadata: { sellerName: name },
        }),
      { maxAttempts: 3, delayMs: 1000 },
    );
  }

  /** Generate onboarding link for seller to complete KYC */
  async createOnboardingLink(stripeAccountId: string, returnUrl: string) {
    return this.stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${returnUrl}?refresh=true`,
      return_url: `${returnUrl}?success=true`,
      type: 'account_onboarding',
    });
  }

  /** Fetch account status from Stripe */
  async getConnectAccount(stripeAccountId: string) {
    return this.stripe.accounts.retrieve(stripeAccountId);
  }

  getStripe() {
    return this.stripe;
  }
}