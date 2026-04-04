import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { LedgerService, LedgerIntegrityReport } from '../ledger/ledger.service';

export interface ReconciliationResult {
  transactionId: number;
  status: 'ok' | 'fixed' | 'error' | 'skipped';
  details?: Record<string, unknown>;
}

export interface PayoutReconciliationResult {
  payoutId: number;
  status: 'ok' | 'mismatch' | 'error';
  details?: Record<string, unknown>;
}

export interface LedgerReconciliationResult {
  accountId: number;
  name: string | null;
  type: string;
  debits: number;
  credits: number;
  balance: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    @InjectPinoLogger(ReconciliationService.name)
    private readonly logger: PinoLogger,
    private prisma: PrismaService,
    private stripe: StripeService,
    private ledger: LedgerService,
  ) {}

  async reconcileTransaction(transactionId: number): Promise<ReconciliationResult> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const paymentIntentId = transaction.stripePaymentIntentId;

    if (!paymentIntentId) {
      return {
        transactionId,
        status: 'skipped',
        details: { reason: 'No Stripe payment intent linked' },
      };
    }

    try {
      const paymentIntent = await this.stripe.getStripe().paymentIntents.retrieve(paymentIntentId);
      const stripeStatus = paymentIntent.status;
      const ourStatus = transaction.status;

      // Stripe succeeded but we're still pending
      if (stripeStatus === 'succeeded' && ourStatus === 'PENDING') {
        await this.prisma.transaction.update({
          where: { id: transactionId },
          data: { status: 'COMPLETED' },
        });
        return { 
          transactionId, 
          status: 'fixed', 
          details: { from: 'PENDING', to: 'COMPLETED', stripeStatus }
        };
      }

      // Stripe canceled/failed but we're still pending
      if ((stripeStatus === 'canceled' || stripeStatus === 'requires_payment_method') && ourStatus === 'PENDING') {
        await this.prisma.transaction.update({
          where: { id: transactionId },
          data: { status: 'FAILED' },
        });
        return { 
          transactionId, 
          status: 'fixed', 
          details: { from: 'PENDING', to: 'FAILED', stripeStatus }
        };
      }

      // Statuses match or acceptable state
      return { 
        transactionId, 
        status: 'ok', 
        details: { stripeStatus, ourStatus }
      };
    } catch (error) {
        return { 
            transactionId, 
            status: 'error', 
            details: { 
                error: error instanceof Error ? error.message : String(error) 
            }
        };
    }
  }

  // Hourly: recent pending transactions
  async reconcileRecent() {
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const transactions = await this.prisma.transaction.findMany({
      where: {
        stripePaymentIntentId: { not: null },
        status: 'PENDING',
        createdAt: { gte: twentyFourHoursAgo },
      },
      orderBy: { createdAt: 'desc' },
    });

    this.logger.info(`Reconciling ${transactions.length} recent pending transactions`);

    const results: ReconciliationResult[] = [];
    for (const transaction of transactions) {
      const result = await this.reconcileTransaction(transaction.id);
      results.push(result);
    }

    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      fixed: results.filter(r => r.status === 'fixed').length,
      errors: results.filter(r => r.status === 'error').length,
    };

    this.logger.info('Reconciliation summary:', summary);
    return { results, summary };
  }

  // Daily: deep reconciliation of all payments
  async reconcileAll() {
    const transactions = await this.prisma.transaction.findMany({
      where: {
        stripePaymentIntentId: { not: null },
      },
      orderBy: { createdAt: 'desc' },
    });

    this.logger.info(`Deep reconciliation: ${transactions.length} total payment transactions`);

    const results: ReconciliationResult[] = [];
    for (const transaction of transactions) {
      const result = await this.reconcileTransaction(transaction.id);
      results.push(result);
    }

    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      fixed: results.filter(r => r.status === 'fixed').length,
      errors: results.filter(r => r.status === 'error').length,
      skipped: results.filter(r => r.status === 'skipped').length,
    };

    this.logger.info('Deep reconciliation summary:', summary);
    return { results, summary };
  }

// Reconcile payouts: compare internal PAID payouts with Stripe transfers
  async reconcilePayouts() {
    const paidPayouts = await this.prisma.payout.findMany({
      where: { status: 'PAID', stripeTransferId: { not: null } },
      include: { seller: true },
    });

    this.logger.info({ count: paidPayouts.length }, 'Reconciling paid payouts against Stripe');

    const results: PayoutReconciliationResult[] = [];

    for (const payout of paidPayouts) {
      try {
        const transfer = await this.stripe.getStripe().transfers.retrieve(
          payout.stripeTransferId!,
        );

        const stripeAmount = transfer.amount; // cents
        const ourAmount = payout.sellerAmount; // cents
        const amountMatch = stripeAmount === ourAmount;

        const stripeReversed = transfer.reversed;

        if (stripeReversed && payout.status === 'PAID') {
          results.push({
            payoutId: payout.id,
            status: 'mismatch',
            details: {
              issue: 'Stripe transfer reversed but payout still PAID',
              stripeTransferId: payout.stripeTransferId,
              action: 'needs_manual_review',
            },
          });
        } else if (!amountMatch) {
          results.push({
            payoutId: payout.id,
            status: 'mismatch',
            details: {
              issue: 'Amount mismatch',
              stripeAmount,
              ourAmount,
              difference: stripeAmount - ourAmount,
            },
          });
        } else {
          results.push({
            payoutId: payout.id,
            status: 'ok',
            details: { stripeAmount, ourAmount },
          });
        }
      } catch (error) {
        results.push({
          payoutId: payout.id,
          status: 'error',
          details: {
            error: error instanceof Error ? error.message : String(error),
            stripeTransferId: payout.stripeTransferId,
          },
        });
      }
    }

    // Check for FAILED payouts that have a Stripe transfer ID — money may have moved
    // but ledger posting failed (the critical failure mode from processPayout)
    const inconsistent = await this.prisma.payout.findMany({
      where: { status: 'FAILED', stripeTransferId: { not: null } },
    });

    for (const payout of inconsistent) {
      results.push({
        payoutId: payout.id,
        status: 'mismatch',
        details: {
          issue: 'Payout FAILED but has Stripe transfer — money may have been sent without ledger posting',
          stripeTransferId: payout.stripeTransferId,
          failureReason: payout.failureReason,
          action: 'needs_manual_review_and_ledger_correction',
        },
      });
    }

    // Check for orphaned payouts (PAID but no Stripe transfer ID)
    const orphaned = await this.prisma.payout.findMany({
      where: { status: 'PAID', stripeTransferId: null },
    });

    for (const payout of orphaned) {
      results.push({
        payoutId: payout.id,
        status: 'mismatch',
        details: {
          issue: 'Payout marked PAID but no Stripe transfer ID',
          action: 'needs_manual_review',
        },
      });
    }

    const summary = {
      total: results.length,
      ok: results.filter(r => r.status === 'ok').length,
      mismatches: results.filter(r => r.status === 'mismatch').length,
      errors: results.filter(r => r.status === 'error').length,
      orphaned: orphaned.length,
    };

    this.logger.info({ summary }, 'Payout reconciliation complete');
    return { results, summary };
  }

  // Ledger integrity: delegates to LedgerService.verifyIntegrity()
  async reconcileLedger(): Promise<LedgerIntegrityReport> {
    return this.ledger.verifyIntegrity();
  }
}