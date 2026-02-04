import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';

@Injectable()
export class ReconciliationScheduler {
  constructor(private reconciliation: ReconciliationService) {}

  // Every hour: reconcile recent pending transactions
  @Cron(CronExpression.EVERY_HOUR)
  async hourlyReconciliation() {
    console.log('Starting hourly reconciliation...');
    const result = await this.reconciliation.reconcileRecent();
    
    if (result.summary.fixed > 0) {
      console.warn(`⚠️  Fixed ${result.summary.fixed} transactions`);
    }
    
    if (result.summary.errors > 0) {
      console.error(`❌ ${result.summary.errors} errors during reconciliation`);
    }
  }

  // Every day at 3 AM: deep reconciliation of all payments
  @Cron('0 3 * * *')
  async dailyDeepReconciliation() {
    console.log('Starting daily deep reconciliation...');
    const result = await this.reconciliation.reconcileAll();
    
    if (result.summary.fixed > 0) {
      console.warn(`⚠️  Deep reconciliation fixed ${result.summary.fixed} transactions`);
    }
  }
}