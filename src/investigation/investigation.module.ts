import { Module } from '@nestjs/common';
import { InvestigationService } from './investigation.service';
import { InvestigationController } from './investigation.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';
import { PayoutModule } from '../payout/payout.module';

@Module({
  imports: [PrismaModule, LedgerModule, PayoutModule],
  controllers: [InvestigationController],
  providers: [InvestigationService],
})
export class InvestigationModule {}
