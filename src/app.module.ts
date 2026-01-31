import { Module } from '@nestjs/common';
import { LedgerModule } from './ledger/ledger.module';

@Module({
  imports: [LedgerModule],
})
export class AppModule {}