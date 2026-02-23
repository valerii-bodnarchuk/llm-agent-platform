import { Injectable } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class ReconciliationScheduler {
  constructor(
    @InjectPinoLogger(ReconciliationScheduler.name)
    private readonly logger: PinoLogger,
    private reconciliation: ReconciliationService
  ) {}

  // Every hour: reconcile recent pending transactions
  @Cron(CronExpression.EVERY_HOUR)
  async hourlyReconciliation() {
    this.logger.info('Starting hourly reconciliation...');
    const result = await this.reconciliation.reconcileRecent();
    
    if (result.summary.fixed > 0) {
      this.logger.warn(`⚠️  Fixed ${result.summary.fixed} transactions`);
    }
    
    if (result.summary.errors > 0) {
      this.logger.error(`❌ ${result.summary.errors} errors during reconciliation`);
    }
  }

  // Every day at 3 AM: deep reconciliation of all payments
  @Cron('0 3 * * *')
  async dailyDeepReconciliation() {
    this.logger.info('Starting daily deep reconciliation...');
    const result = await this.reconciliation.reconcileAll();
    
    if (result.summary.fixed > 0) {
      this.logger.warn(`⚠️  Deep reconciliation fixed ${result.summary.fixed} transactions`);
    }
  }
}