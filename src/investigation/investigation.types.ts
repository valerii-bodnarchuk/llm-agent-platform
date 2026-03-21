import { LedgerIntegrityReport } from '../ledger/ledger.service';

export interface Finding {
  rule: string;
  severity: 'critical' | 'warning' | 'info';
  description: string;
  evidence: Record<string, unknown>;
}

export interface InvestigationContext {
  payout: {
    id: number;
    status: string;
    amount: number;
    attempts: number;
    maxAttempts: number;
    failureReason: string | null;
    fraudDecision: string | null;
    fraudScore: number | null;
    escrowAccountId: number;
    transactionId: number;
    sellerId: number;
  };
  seller: {
    id: number;
    accountId: number;
    payoutsBlocked: boolean;
    payoutsEnabled: boolean;
    stripeAccountId: string | null;
  };
  payoutHistory: unknown[];
  transaction: {
    id: number;
    status: string;
    entries: unknown[];
  };
  escrowBalance: number;
  sellerBalance: number;
  fraudDecision: string | null;
  fraudScore: number | null;
  disputes: { status: string }[];
  integrity: LedgerIntegrityReport;
}

export interface InvestigationReport {
  payoutId: number;
  transactionId: number;
  sellerId: number;
  investigatedAt: Date;

  payoutStatus: string;
  transactionStatus: string;
  amount: number;

  findings: Finding[];
  probableCause: string;
  confidence: 'high' | 'medium' | 'low';

  recommendedActions: string[];

  context: {
    escrowBalance: number;
    sellerBalance: number;
    fraudScore: number | null;
    fraudDecision: string | null;
    disputeCount: number;
    payoutAttempts: number;
    sellerPayoutHistory: number;
    ledgerBalanced: boolean;
  };
}

export interface TransactionInvestigationResult {
  transactionId: number;
  transactionStatus: string;
  hasPayouts: boolean;
  payoutReports: InvestigationReport[];
  entries?: unknown[];
  disputes?: unknown[];
}
