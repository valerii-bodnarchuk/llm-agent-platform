import { Controller, Get, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { LedgerService } from './ledger.service';

@ApiTags('Ledger')
@Controller('ledger')
export class LedgerController {
  constructor(private ledger: LedgerService) {}

  @Get('accounts')
  async getAllAccounts() {
    return this.ledger.getAllAccounts();
  }

  @Get('balance/:accountId')
  async getBalance(@Param('accountId') accountId: string) {
    return this.ledger.getAccountBalance(parseInt(accountId));
  }

  @Get('transactions/:accountId')
  async getAccountTransactions(@Param('accountId') accountId: string) {
    return this.ledger.getAccountTransactions(parseInt(accountId));
  }

  @Get('integrity')
  async verifyIntegrity() {
    return this.ledger.verifyIntegrity();
  }
}