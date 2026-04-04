import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PayoutModule } from '../payout/payout.module';
import { SellerModule } from '../seller/seller.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LedgerModule } from '../ledger/ledger.module';

@Module({
  imports: [PayoutModule, SellerModule, PrismaModule, LedgerModule],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
