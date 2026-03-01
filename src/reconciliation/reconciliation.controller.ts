import { Controller, Post, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ReconciliationService } from './reconciliation.service';

@ApiTags('Reconciliation')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private reconciliation: ReconciliationService) {}

  @Post('recent')
  async reconcileRecent() {
    return this.reconciliation.reconcileRecent();
  }

  @Post('all')
  async reconcileAll() {
    return this.reconciliation.reconcileAll();
  }

  @Post('transaction/:id')
  async reconcileOne(@Param('id') id: string) {
    return this.reconciliation.reconcileTransaction(parseInt(id));
  }

  @Post('payouts')
  async reconcilePayouts() {
    return this.reconciliation.reconcilePayouts();
  }

  @Post('ledger')
  async reconcileLedger() {
    return this.reconciliation.reconcileLedger();
  }
}