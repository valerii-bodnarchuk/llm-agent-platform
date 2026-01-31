import 'reflect-metadata';
import { Test, TestingModule } from "@nestjs/testing";
import { LedgerService } from "./ledger.service";
import { PrismaService } from "../prisma/prisma.service";

describe('LedgerService', () => {
    let service: LedgerService;
    let prisma: PrismaService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                LedgerService,
                {
                    provide: PrismaService,
                    useValue: {
                        $transaction: jest.fn(),
                    },
                },
            ],
        }).compile();       

        service = module.get<LedgerService>(LedgerService);
        prisma = module.get<PrismaService>(PrismaService);
    });

    it('should create transaction with balanced entries', async () => {
        (prisma.$transaction as jest.Mock).mockImplementation(async (fn) => fn({
            transaction: { create: jest.fn().mockResolvedValue({ id: 1, description: 'transaction 1' }) },
             entry: { createMany: jest.fn() },
        }));

        const result = await service.createTransaction({ description: "transaction 1", entries: [
            { amount: 100, accountId: 1, type: 'DEBIT' },
            { amount: 100, accountId: 2, type: 'CREDIT' }
        ] })

        expect(result).toEqual({ id: 1, description: 'transaction 1' });
        expect(prisma.$transaction).toHaveBeenCalled();
    })

    it('should throw if debit !== credit', async () => {
        await expect(service.createTransaction({ description: "transaction 1", entries: [
            { amount: 100, accountId: 1, type: 'CREDIT' },
            { amount: 100, accountId: 2, type: 'CREDIT' }
        ] })).rejects.toThrow('Ledger is not balanced')
    });

    it('should throw if less than 2 entries', async () => {
        await expect(service.createTransaction({ description: "transaction 1", entries: [] })).rejects.toThrow('Minimum 2 entries required')
    });
})