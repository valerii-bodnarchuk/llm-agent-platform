import { Injectable } from '@nestjs/common';
import { LedgerService } from '../ledger/ledger.service';

@Injectable()
export class PayoutService {
  constructor(private ledger: LedgerService) {}

  async releasePayout(params: {
    amount: number;
    escrowAccountId: number;
    sellerAccountId: number;
    platformFeeAccountId: number;
    platformFeePercent?: number;
  }) {
    const feePercent = params.platformFeePercent || 5; // default 5%
    
    return this.ledger.releasePayout({
      amount: params.amount,
      escrowAccountId: params.escrowAccountId,
      sellerAccountId: params.sellerAccountId,
      platformFeeAccountId: params.platformFeeAccountId,
      platformFeePercent: feePercent,
    });
  }
}