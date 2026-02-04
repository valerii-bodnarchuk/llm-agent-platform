import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';

export interface ReconciliationResult {
  transactionId: number;
  status: 'ok' | 'fixed' | 'error' | 'skipped';
  details?: any;
}

@Injectable()
export class ReconciliationService {
  constructor(
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

    console.log(`Reconciling ${transactions.length} recent pending transactions`);

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

    console.log('Reconciliation summary:', summary);
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

    console.log(`Deep reconciliation: ${transactions.length} total payment transactions`);

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

    console.log('Deep reconciliation summary:', summary);
    return { results, summary };
  }
}