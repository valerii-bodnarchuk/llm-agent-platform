import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

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
  ) {}

  async reconcileTransaction(transactionId: number): Promise<ReconciliationResult> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
    });

    if (!transaction) {
      throw new Error(`Transaction ${transactionId} not found`);
    }

    const paymentIntentId = transaction.description.match(/pi_\w+/)?.[0];
    
    if (!paymentIntentId) {
      return { 
        transactionId, 
        status: 'skipped', 
        details: { reason: 'Not a payment transaction' }
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
        description: { contains: 'Payment' },
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
        description: { contains: 'Payment' },
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

        const stripeAmount = transfer.amount / 100; // cents → euros
        const ourAmount = Number(payout.sellerAmount);
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

  // Ledger balance reconciliation: verify debits = credits
  async reconcileLedger() {
    const accounts = await this.prisma.account.findMany();
    const results: LedgerReconciliationResult[] = [];

    let totalDebits = 0;
    let totalCredits = 0;

    for (const account of accounts) {
      const entries = await this.prisma.entry.findMany({
        where: { accountId: account.id },
      });

      const debits = entries
        .filter(e => e.type === 'DEBIT')
        .reduce((sum, e) => sum + Number(e.amount), 0);
      const credits = entries
        .filter(e => e.type === 'CREDIT')
        .reduce((sum, e) => sum + Number(e.amount), 0);

      totalDebits += debits;
      totalCredits += credits;

      results.push({
        accountId: account.id,
        name: account.name,
        type: account.type,
        debits,
        credits,
        balance: credits - debits,
      });
    }

    const balanced = Math.abs(totalDebits - totalCredits) < 0.01;

    const summary = {
      totalDebits,
      totalCredits,
      difference: totalDebits - totalCredits,
      balanced,
      accountCount: accounts.length,
    };

    if (!balanced) {
      this.logger.error({ summary }, 'LEDGER IMBALANCE DETECTED');
    } else {
      this.logger.info({ summary }, 'Ledger reconciliation passed');
    }

    return { accounts: results, summary };
  }
}