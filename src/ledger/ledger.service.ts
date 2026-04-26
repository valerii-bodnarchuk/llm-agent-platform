import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { assertMinorUnits } from '../common/money';
import { MetricsService } from '../metrics/metrics.service';

interface Entry {
  accountId: number;
  amount: number;  // integer cents — MUST be validated
  type: 'DEBIT' | 'CREDIT';
  narrative?: string;
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
    private metrics: MetricsService,
  ) {}

  async createTransaction(params: {
    description: string;
    entries: Entry[];
    stripePaymentIntentId?: string;
  }) {
    if (params.entries.length < 2) {
      throw new Error('Minimum 2 entries required');
    }

    for (const entry of params.entries) {
      assertMinorUnits(entry.amount, `Entry amount for account ${entry.accountId}`);
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

    return this.prisma.$transaction(async (tx) => {
      // Acquire FOR NO KEY UPDATE locks on all debited accounts, in ascending id
      // order to guarantee a consistent lock-acquisition order and prevent deadlocks.
      //
      // FOR NO KEY UPDATE (not FOR UPDATE) is intentional: FOR UPDATE conflicts with
      // the FOR KEY SHARE lock that PostgreSQL takes on referenced Account rows when
      // a concurrent Entry INSERT validates its FK, which would cause deadlocks.
      // FOR NO KEY UPDATE does NOT conflict with FOR KEY SHARE, so concurrent Entry
      // inserts for the same account proceed without blocking while we hold our lock.
      const debitAccountIds = [
        ...new Set(
          params.entries
            .filter((e) => e.type === 'DEBIT')
            .map((e) => e.accountId),
        ),
      ].sort((a, b) => a - b);

      for (const accountId of debitAccountIds) {
        // Step 1: Acquire the row lock.
        // FOR NO KEY UPDATE is intentional (not FOR UPDATE): FOR UPDATE conflicts
        // with the FOR KEY SHARE lock PostgreSQL takes on Account rows when
        // validating FK constraints during Entry inserts, causing deadlocks under
        // concurrency.  FOR NO KEY UPDATE serialises balance checks across
        // competing transactions while remaining compatible with FK validation.
        //
        // PostgreSQL does not allow locking clauses together with GROUP BY, so
        // the lock acquisition and the balance aggregation are two separate queries.
        const accountRows = await tx.$queryRaw<
          [{ allow_negative: boolean }]
        >`
          SELECT "allowNegative" AS allow_negative
          FROM "Account"
          WHERE id = ${accountId}
          FOR NO KEY UPDATE
        `;

        if (!accountRows[0]) {
          throw new Error(`Account ${accountId} not found`);
        }

        // Step 2: Read committed balance.  Because we hold FOR NO KEY UPDATE on
        // this Account row, every concurrent writer must also acquire that lock
        // before it can commit new Entry rows, so we see the fully-settled balance.
        const balanceRows = await tx.$queryRaw<[{ balance: string }]>`
          SELECT COALESCE(
            SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0
          )::text AS balance
          FROM "Entry"
          WHERE "accountId" = ${accountId}
        `;

        const balance = parseInt(balanceRows[0].balance, 10);
        const totalDebit = params.entries
          .filter((e) => e.accountId === accountId && e.type === 'DEBIT')
          .reduce((sum, e) => sum + e.amount, 0);
        const wouldBeBalance = balance - totalDebit;

        if (wouldBeBalance < 0 && !accountRows[0].allow_negative) {
          throw new Error(
            `Insufficient funds in account ${accountId}. Balance: ${balance}, Required: ${totalDebit}`,
          );
        }
      }

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

      this.metrics.ledgerTransactionsTotal.inc();
      return transaction;
    });
  }

  async settleTransaction(params: {
    transactionId: number;
    entries: Entry[];
  }) {
    if (params.entries.length < 2) {
      throw new Error('Minimum 2 entries required');
    }

    for (const entry of params.entries) {
      assertMinorUnits(entry.amount, `Entry amount for account ${entry.accountId}`);
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

    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUnique({
        where: { id: params.transactionId },
      });

      if (!transaction) {
        throw new Error(`Transaction ${params.transactionId} not found`);
      }

      if (transaction.status !== 'PENDING') {
        throw new Error(
          `Transaction ${params.transactionId} is ${transaction.status}, expected PENDING`,
        );
      }

      const existingEntries = await tx.entry.count({
        where: { transactionId: params.transactionId },
      });

      if (existingEntries > 0) {
        throw new Error(
          `Transaction ${params.transactionId} already has entries — double settlement prevented`,
        );
      }

      // Same locking strategy as createTransaction: lock debited accounts in
      // ascending id order with FOR NO KEY UPDATE before checking balances.
      const debitAccountIds = [
        ...new Set(
          params.entries
            .filter((e) => e.type === 'DEBIT')
            .map((e) => e.accountId),
        ),
      ].sort((a, b) => a - b);

      for (const accountId of debitAccountIds) {
        const accountRows = await tx.$queryRaw<
          [{ allow_negative: boolean }]
        >`
          SELECT "allowNegative" AS allow_negative
          FROM "Account"
          WHERE id = ${accountId}
          FOR NO KEY UPDATE
        `;

        if (!accountRows[0]) {
          throw new Error(`Account ${accountId} not found`);
        }

        const balanceRows = await tx.$queryRaw<[{ balance: string }]>`
          SELECT COALESCE(
            SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE -amount END), 0
          )::text AS balance
          FROM "Entry"
          WHERE "accountId" = ${accountId}
        `;

        const balance = parseInt(balanceRows[0].balance, 10);
        const totalDebit = params.entries
          .filter((e) => e.accountId === accountId && e.type === 'DEBIT')
          .reduce((sum, e) => sum + e.amount, 0);
        const wouldBeBalance = balance - totalDebit;

        if (wouldBeBalance < 0 && !accountRows[0].allow_negative) {
          throw new Error(
            `Insufficient funds in account ${accountId}. Balance: ${balance}, Required: ${totalDebit}`,
          );
        }
      }

      await tx.entry.createMany({
        data: params.entries.map((entry) => ({
          transactionId: params.transactionId,
          accountId: entry.accountId,
          amount: entry.amount,
          type: entry.type,
        })),
      });

      return tx.transaction.update({
        where: { id: params.transactionId },
        data: { status: 'COMPLETED' },
      });
    });
  }

  async releasePayout(params: {
    amount: number;        // total payout in minor units
    feeAmount: number;     // platform fee in minor units
    sellerAmount: number;  // seller receives in minor units
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
  }) {
    assertMinorUnits(params.amount, 'Payout amount');
    assertMinorUnits(params.feeAmount, 'Fee amount');
    assertMinorUnits(params.sellerAmount, 'Seller amount');

    if (params.feeAmount + params.sellerAmount !== params.amount) {
      throw new Error(
        `Fee split mismatch: fee(${params.feeAmount}) + seller(${params.sellerAmount}) != total(${params.amount})`,
      );
    }

    return this.createTransaction({
      description: `Payout to seller (${params.amount} cents, fee: ${params.feeAmount} cents)`,
      entries: [
        { accountId: params.escrowAccountId, amount: params.amount, type: 'DEBIT' },
        { accountId: params.sellerAccountId, amount: params.sellerAmount, type: 'CREDIT' },
        { accountId: params.platformFeeAccountId, amount: params.feeAmount, type: 'CREDIT' },
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

    return { accountId, balance: parseInt(result[0].balance, 10) };
  }

  async getAccountTransactions(accountId: number) {
    const entries = await this.prisma.entry.findMany({
      where: { accountId },
      include: {
        transaction: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return entries.map((entry) => ({
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
      }),
    );

    return accountsWithBalances;
  }

  async reversePayout(params: {
    amount: number;
    feeAmount: number;
    sellerAmount: number;
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    reason: string;
  }) {
    assertMinorUnits(params.amount, 'Reversal amount');
    assertMinorUnits(params.feeAmount, 'Reversal fee amount');
    assertMinorUnits(params.sellerAmount, 'Reversal seller amount');

    if (params.feeAmount + params.sellerAmount !== params.amount) {
      throw new Error(
        `Reversal split mismatch: fee(${params.feeAmount}) + seller(${params.sellerAmount}) != total(${params.amount})`,
      );
    }

    return this.createTransaction({
      description: `REVERSAL: ${params.reason}`,
      entries: [
        { accountId: params.sellerAccountId, amount: params.sellerAmount, type: 'DEBIT' },
        { accountId: params.platformFeeAccountId, amount: params.feeAmount, type: 'DEBIT' },
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
        COALESCE(SUM(CASE WHEN type = 'DEBIT'  THEN amount ELSE 0 END), 0)::integer AS global_debits,
        COALESCE(SUM(CASE WHEN type = 'CREDIT' THEN amount ELSE 0 END), 0)::integer AS global_credits
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

    const globalDebits = Number(globalRow.global_debits);
    const globalCredits = Number(globalRow.global_credits);
    const globalDiff = Math.abs(globalDebits - globalCredits);
    const balanced = globalDiff === 0 && unbalancedRows.length === 0;

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
