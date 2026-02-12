import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface Entry {
  accountId: number;
  amount: number;
  type: 'DEBIT' | 'CREDIT';
}

@Injectable()
export class LedgerService {
  constructor(private prisma: PrismaService) {}

  async createTransaction(params: {
    description: string;
    entries: Entry[];
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
        const { balance } = await this.getAccountBalance(entry.accountId);
        if (balance < entry.amount) {
          throw new Error(`Insufficient funds in account ${entry.accountId}. Balance: ${balance}, Required: ${entry.amount}`);
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: { description: params.description },
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
    const entries = await this.prisma.entry.findMany({
      where: { accountId },
    });

    const balance = entries.reduce((sum, entry) => {
      return entry.type === 'CREDIT' 
        ? sum + Number(entry.amount)
        : sum - Number(entry.amount);
    }, 0);

    return { accountId, balance };
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
}