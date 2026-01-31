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
}