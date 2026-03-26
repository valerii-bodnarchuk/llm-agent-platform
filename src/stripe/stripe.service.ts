import Stripe from 'stripe';
import { Injectable } from '@nestjs/common';
import { withRetry } from '../common/utils/retry.util';
import { assertMinorUnits } from '../common/money';

@Injectable()
export class StripeService {
  private stripe: Stripe;

  constructor() {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-01-28.clover',
    });
  }

  async createPaymentIntent(
    amountCents: number,
    currency: string = 'eur',
    metadata?: Record<string, string>,
    applicationFeeAmount?: number,
  ) {
    assertMinorUnits(amountCents, 'PaymentIntent amount');
    if (applicationFeeAmount !== undefined) {
      assertMinorUnits(applicationFeeAmount, 'Application fee amount');
    }

    return withRetry(
      () =>
        this.stripe.paymentIntents.create({
          amount: amountCents,
          currency,
          metadata,
          ...(applicationFeeAmount !== undefined && { application_fee_amount: applicationFeeAmount }),
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