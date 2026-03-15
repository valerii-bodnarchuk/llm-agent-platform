import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

interface Entry {
  accountId: number;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
}

export interface LedgerIntegrityReport {
  balanced: boolean;
  globalDebits: number;
  globalCredits: number;
  globalDiff: number;
  unbalancedTransactions: number[];
  orphanedEntries: number[];
  checkedAt: Date;
}

@Injectable()
export class LedgerService {
  constructor(
    private prisma: PrismaService,
    @InjectPinoLogger(LedgerService.name)
    private readonly logger: PinoLogger,
  ) {}

  async createTransaction(params: {
    description: string;
    entries: Entry[];
    stripePaymentIntentId?: string;
  }) {
    if (params.entries.length < 2) {
      throw new Error('Minimum 2 entries required');
    }

    let sumOfDebit = 0;
    let sumOfCredit = 0;

    for (const entry of params.entries) {
      if (entry.type === 'CREDIT') sumOfCredit += entry.amount;
      if (entry.type === 'DEBIT') sumOfDebit += entry.amount;
    }

    if (sumOfDebit !== sumOfCredit) {
      throw new Error('Ledger is not balanced');
    }

     // Check sufficient balance for DEBIT entries
    for (const entry of params.entries) {
      if (entry.type === 'DEBIT') {
        const account = await this.prisma.account.findUnique({
          where: { id: entry.accountId },
        });

        if (!account) {
          throw new Error(`Account ${entry.accountId} not found`);
        }

        const { balance } = await this.getAccountBalance(entry.accountId);

        const wouldBeBalance = balance - entry.amount;

        if (wouldBeBalance < 0 && !account.allowNegative) {
          throw new Error(
            `Insufficient funds in account ${entry.accountId}. Balance: ${balance}, Required: ${entry.amount}`,
          );
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: { 
          description: params.description,
          stripePaymentIntentId: params.stripePaymentIntentId,
        },
      });

      await tx.entry.createMany({
        data: params.entries.map((entry) => ({
          transactionId: transaction.id,
          accountId: entry.accountId,
          amount: entry.amount,
          type: entry.type,
        })),
      });

      return transaction;
    });
  }

  async releasePayout(params: {
    amount: number;
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    platformFeePercent: number;
  }) {
    const fee = params.amount * (params.platformFeePercent / 100);
    const sellerAmount = params.amount - fee;

    return this.createTransaction({
      description: `Payout to seller (${params.amount}, fee: ${fee})`,
      entries: [
        { accountId: params.escrowAccountId, amount: params.amount, type: 'DEBIT' },
        { accountId: params.sellerAccountId, amount: sellerAmount, type: 'CREDIT' },
        { accountId: params.platformFeeAccountId, amount: fee, type: 'CREDIT' },
      ],
    });
  }

  async getAccountBalance(accountId: number) {
    const result = await this.prisma.$queryRaw<[{ balance: string }]>`
      SELECT COALESCE(
        SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END),
        0
      )::text AS balance
      FROM "Entry"
      WHERE "accountId" = ${accountId}
    `;

    return { accountId, balance: Number(result[0].balance) };
  }

  async getAccountTransactions(accountId: number) {
    const entries = await this.prisma.entry.findMany({
      where: { accountId },
      include: {
        transaction: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return entries.map(entry => ({
      transactionId: entry.transaction.id,
      description: entry.transaction.description,
      amount: entry.amount,
      type: entry.type,
      status: entry.transaction.status,
      createdAt: entry.transaction.createdAt,
    }));
  }

  async getAllAccounts() {
    const accounts = await this.prisma.account.findMany({
      orderBy: { id: 'asc' },
    });

    const accountsWithBalances = await Promise.all(
      accounts.map(async (account) => {
        const { balance } = await this.getAccountBalance(account.id);
        return {
          id: account.id,
          name: account.name,
          type: account.type,
          balance,
          createdAt: account.createdAt,
        };
      })
    );

    return accountsWithBalances;
  }

  async reversePayout(params: {
    amount: number;
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    platformFeePercent: number;
    reason: string;
  }) {
    const fee = params.amount * (params.platformFeePercent / 100);
    const sellerAmount = params.amount - fee;

    return this.createTransaction({
      description: `REVERSAL: ${params.reason}`,
      entries: [
        { accountId: params.sellerAccountId, amount: sellerAmount, type: 'DEBIT' },
        { accountId: params.platformFeeAccountId, amount: fee, type: 'DEBIT' },
        { accountId: params.escrowAccountId, amount: params.amount, type: 'CREDIT' },
      ],
    });
  }

  async verifyIntegrity(): Promise<LedgerIntegrityReport> {
    // Check 1: Global debit/credit totals across all entries
    const [globalRow] = await this.prisma.$queryRaw<
      [{ global_debits: number; global_credits: number }]
    >`
      SELECT
        COALESCE(SUM(CASE WHEN type = 'DEBIT'  THEN amount ELSE 0 END), 0)::float AS global_debits,
        COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0)::float AS global_credits
      FROM "Entry"
    `;

    // Check 2: Any transaction where debits ≠ credits
    const unbalancedRows = await this.prisma.$queryRaw<
      Array<{ transaction_id: number }>
    >`
      SELECT "transactionId" AS transaction_id
      FROM "Entry"
      GROUP BY "transactionId"
      HAVING SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END)
          != SUM(CASE WHEN type = 'DEBIT'  THEN amount ELSE 0 END)
    `;

    // Check 3: Entries whose parent transaction no longer exists (defensive; FK should prevent this)
    const orphanedRows = await this.prisma.$queryRaw<
      Array<{ entry_id: number }>
    >`
      SELECT e.id AS entry_id
      FROM "Entry" e
      LEFT JOIN "Transaction" t ON e."transactionId" = t.id
      WHERE t.id IS NULL
    `;

    const globalDebits = globalRow.global_debits;
    const globalCredits = globalRow.global_credits;
    const globalDiff = Math.abs(globalDebits - globalCredits);
    const balanced = globalDiff <= 0.001 && unbalancedRows.length === 0;

    const report: LedgerIntegrityReport = {
      balanced,
      globalDebits,
      globalCredits,
      globalDiff,
      unbalancedTransactions: unbalancedRows.map((r) => Number(r.transaction_id)),
      orphanedEntries: orphanedRows.map((r) => Number(r.entry_id)),
      checkedAt: new Date(),
    };

    if (!balanced) {
      this.logger.warn({ report }, 'Ledger integrity check FAILED');
    } else {
      this.logger.info({ checkedAt: report.checkedAt }, 'Ledger integrity check passed');
    }

    return report;
  }
}