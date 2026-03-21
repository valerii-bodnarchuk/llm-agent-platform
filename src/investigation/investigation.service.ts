import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  Finding,
  InvestigationContext,
  InvestigationReport,
  TransactionInvestigationResult,
} from './investigation.types';

@Injectable()
export class InvestigationService {
  constructor(
    private prisma: PrismaService,
    private ledger: LedgerService,
  ) {}

  // ── Data Collection ────────────────────────────────────────────────

  private async collectContext(payoutId: number): Promise<InvestigationContext> {
    const payoutRow = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      include: { seller: true },
    });

    if (!payoutRow) {
      throw new NotFoundException(`Payout ${payoutId} not found`);
    }

    const { seller, ...payout } = payoutRow;

    const [payoutHistory, transaction, disputes, integrity] = await Promise.all([
      this.prisma.payout.findMany({ where: { sellerId: payout.sellerId } }),
      this.prisma.transaction.findUnique({
        where: { id: payout.transactionId },
        include: { entries: true },
      }),
      this.prisma.dispute.findMany({ where: { transactionId: payout.transactionId } }),
      this.ledger.verifyIntegrity(),
    ]);

    if (!transaction) {
      throw new NotFoundException(`Transaction ${payout.transactionId} not found`);
    }

    const [{ balance: escrowBalance }, { balance: sellerBalance }] = await Promise.all([
      this.ledger.getAccountBalance(payout.escrowAccountId),
      this.ledger.getAccountBalance(seller.accountId),
    ]);

    return {
      payout: {
        id: payout.id,
        status: payout.status,
        amount: Number(payout.amount),
        attempts: payout.attempts,
        maxAttempts: payout.maxAttempts,
        failureReason: payout.failureReason,
        fraudDecision: payout.fraudDecision,
        fraudScore: payout.fraudScore,
        escrowAccountId: payout.escrowAccountId,
        transactionId: payout.transactionId,
        sellerId: payout.sellerId,
      },
      seller: {
        id: seller.id,
        accountId: seller.accountId,
        payoutsBlocked: seller.payoutsBlocked,
        payoutsEnabled: seller.payoutsEnabled,
        stripeAccountId: seller.stripeAccountId,
      },
      payoutHistory,
      transaction: {
        id: transaction.id,
        status: transaction.status,
        entries: transaction.entries,
      },
      escrowBalance,
      sellerBalance,
      fraudDecision: payout.fraudDecision,
      fraudScore: payout.fraudScore,
      disputes,
      integrity,
    };
  }

  // ── Analysis Rules ─────────────────────────────────────────────────

  private runRules(ctx: InvestigationContext): Finding[] {
    const findings: Finding[] = [];

    if (ctx.escrowBalance < ctx.payout.amount) {
      findings.push({
        rule: 'insufficient_escrow',
        severity: 'critical',
        description: 'Escrow account has insufficient funds for this payout',
        evidence: { escrowBalance: ctx.escrowBalance, payoutAmount: ctx.payout.amount },
      });
    }

    if (ctx.seller.payoutsBlocked) {
      findings.push({
        rule: 'seller_blocked',
        severity: 'critical',
        description: 'Seller payouts are blocked due to negative balance',
        evidence: { sellerId: ctx.seller.id, sellerBalance: ctx.sellerBalance },
      });
    }

    if (!ctx.seller.payoutsEnabled) {
      findings.push({
        rule: 'seller_not_verified',
        severity: 'critical',
        description: 'Seller has not completed KYC verification',
        evidence: { sellerId: ctx.seller.id, payoutsEnabled: false },
      });
    }

    if (ctx.payout.fraudDecision === 'BLOCK') {
      findings.push({
        rule: 'fraud_blocked',
        severity: 'critical',
        description: 'Payout was blocked by fraud engine',
        evidence: { fraudDecision: ctx.payout.fraudDecision, fraudScore: ctx.payout.fraudScore },
      });
    }

    if (ctx.payout.fraudDecision === 'REVIEW') {
      findings.push({
        rule: 'fraud_review',
        severity: 'warning',
        description: `Payout flagged for manual review by fraud engine (score: ${ctx.payout.fraudScore})`,
        evidence: { fraudDecision: ctx.payout.fraudDecision, fraudScore: ctx.payout.fraudScore },
      });
    }

    const activeDisputes = ctx.disputes.filter(
      (d) => d.status === 'OPEN' || d.status === 'UNDER_REVIEW',
    );
    if (activeDisputes.length > 0) {
      findings.push({
        rule: 'active_dispute',
        severity: 'critical',
        description: 'Active dispute on this transaction',
        evidence: { disputeCount: activeDisputes.length, statuses: activeDisputes.map((d) => d.status) },
      });
    }

    const lostDisputes = ctx.disputes.filter((d) => d.status === 'LOST');
    if (lostDisputes.length > 0) {
      findings.push({
        rule: 'dispute_lost',
        severity: 'warning',
        description: 'Buyer won a dispute on this transaction — funds may have been reversed',
        evidence: { disputeCount: lostDisputes.length },
      });
    }

    if (ctx.payout.attempts >= ctx.payout.maxAttempts) {
      findings.push({
        rule: 'max_retries_exceeded',
        severity: 'warning',
        description: 'Payout exceeded maximum retry attempts',
        evidence: { attempts: ctx.payout.attempts, maxAttempts: ctx.payout.maxAttempts },
      });
    }

    if (
      ctx.payout.failureReason &&
      /stripe|transfer/i.test(ctx.payout.failureReason)
    ) {
      findings.push({
        rule: 'stripe_transfer_failed',
        severity: 'warning',
        description: `Stripe transfer failed: ${ctx.payout.failureReason}`,
        evidence: { failureReason: ctx.payout.failureReason },
      });
    }

    if (!ctx.integrity.balanced) {
      findings.push({
        rule: 'ledger_imbalanced',
        severity: 'critical',
        description: 'LEDGER INTEGRITY FAILURE — debits ≠ credits',
        evidence: {
          globalDebits: ctx.integrity.globalDebits,
          globalCredits: ctx.integrity.globalCredits,
          globalDiff: ctx.integrity.globalDiff,
          unbalancedTransactions: ctx.integrity.unbalancedTransactions,
        },
      });
    }

    if (ctx.transaction.status !== 'COMPLETED') {
      findings.push({
        rule: 'transaction_not_settled',
        severity: 'warning',
        description: `Parent transaction is still ${ctx.transaction.status}, not yet settled`,
        evidence: { transactionId: ctx.transaction.id, status: ctx.transaction.status },
      });
    }

    if (ctx.sellerBalance < 0) {
      findings.push({
        rule: 'seller_negative_balance',
        severity: 'warning',
        description: `Seller has negative balance: ${ctx.sellerBalance}`,
        evidence: { sellerBalance: ctx.sellerBalance, sellerId: ctx.seller.id },
      });
    }

    if (!ctx.seller.stripeAccountId) {
      findings.push({
        rule: 'no_stripe_account',
        severity: 'critical',
        description: 'Seller has no connected Stripe account',
        evidence: { sellerId: ctx.seller.id },
      });
    }

    return findings;
  }

  // ── Report Generation ──────────────────────────────────────────────

  private buildReport(ctx: InvestigationContext, findings: Finding[]): InvestigationReport {
    const criticals = findings.filter((f) => f.severity === 'critical');
    const warnings = findings.filter((f) => f.severity === 'warning');

    let probableCause: string;
    if (criticals.length > 0) {
      probableCause = criticals[0].description;
    } else if (warnings.length > 0) {
      probableCause =
        'Multiple risk factors detected: ' + warnings.map((f) => f.description).join('; ');
    } else {
      probableCause = 'No issues detected — payout appears healthy';
    }

    let confidence: 'high' | 'medium' | 'low';
    if (findings.length === 0) {
      confidence = ctx.payout.status === 'FAILED' ? 'low' : 'high';
    } else if (findings.length === 1 && criticals.length === 1) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    const actionMap: Record<string, string> = {
      insufficient_escrow:
        'Verify payment settlement completed. Check reconciliation for missing webhooks.',
      seller_blocked:
        'Review seller\'s negative balance. Consider manual unblock after recovery.',
      seller_not_verified:
        'Prompt seller to complete Stripe KYC onboarding.',
      fraud_blocked:
        'Review fraud engine decision. If false positive, manually approve via admin endpoint.',
      fraud_review:
        'Ops team should review flagged transaction and approve or reject.',
      active_dispute:
        'Wait for dispute resolution before processing payout.',
      max_retries_exceeded:
        'Investigate Stripe transfer errors. Consider force-retry via admin.',
      ledger_imbalanced:
        'URGENT: Run full reconciliation. Do not process payouts until resolved.',
      transaction_not_settled:
        'Check Stripe webhook delivery. Run reconciliation for this payment intent.',
      no_stripe_account:
        'Seller needs to complete Stripe Connect onboarding.',
    };

    const recommendedActions = findings
      .map((f) => actionMap[f.rule])
      .filter(Boolean);

    return {
      payoutId: ctx.payout.id,
      transactionId: ctx.transaction.id,
      sellerId: ctx.seller.id,
      investigatedAt: new Date(),

      payoutStatus: ctx.payout.status,
      transactionStatus: ctx.transaction.status,
      amount: ctx.payout.amount,

      findings,
      probableCause,
      confidence,
      recommendedActions,

      context: {
        escrowBalance: ctx.escrowBalance,
        sellerBalance: ctx.sellerBalance,
        fraudScore: ctx.fraudScore,
        fraudDecision: ctx.fraudDecision,
        disputeCount: ctx.disputes.length,
        payoutAttempts: ctx.payout.attempts,
        sellerPayoutHistory: ctx.payoutHistory.length,
        ledgerBalanced: ctx.integrity.balanced,
      },
    };
  }

  // ── Public API ─────────────────────────────────────────────────────

  async investigatePayout(payoutId: number): Promise<InvestigationReport> {
    const ctx = await this.collectContext(payoutId);
    const findings = this.runRules(ctx);
    return this.buildReport(ctx, findings);
  }

  async investigateTransaction(transactionId: number): Promise<TransactionInvestigationResult> {
    const transaction = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { entries: true, disputes: true },
    });

    if (!transaction) {
      throw new NotFoundException(`Transaction ${transactionId} not found`);
    }

    const payouts = await this.prisma.payout.findMany({
      where: { transactionId },
    });

    if (payouts.length === 0) {
      return {
        transactionId: transaction.id,
        transactionStatus: transaction.status,
        hasPayouts: false,
        payoutReports: [],
        entries: transaction.entries,
        disputes: transaction.disputes,
      };
    }

    const payoutReports = await Promise.all(
      payouts.map((p) => this.investigatePayout(p.id)),
    );

    return {
      transactionId: transaction.id,
      transactionStatus: transaction.status,
      hasPayouts: true,
      payoutReports,
    };
  }
}
