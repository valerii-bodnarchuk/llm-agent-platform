import { PrismaService } from '../prisma/prisma.service';
interface Entry {
    accountId: number;
    amount: number;
    type: 'DEBIT' | 'CREDIT';
}
export declare class LedgerService {
    private prisma;
    constructor(prisma: PrismaService);
    createTransaction(params: {
        description: string;
        entries: Entry[];
    }): Promise<{
        status: import(".prisma/client").$Enums.TransactionStatus;
        description: string;
        createdAt: Date;
        id: number;
    }>;
}
export {};
