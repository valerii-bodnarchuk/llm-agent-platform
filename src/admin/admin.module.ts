import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { PayoutModule } from '../payout/payout.module';
import { SellerModule } from '../seller/seller.module';

@Module({
  imports: [PayoutModule, SellerModule],
  controllers: [AdminController],
})
export class AdminModule {}