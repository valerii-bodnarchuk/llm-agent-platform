import { Controller, Get, Post, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PayoutService } from '../payout/payout.service';
import { SellerService } from '../seller/seller.service';

@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(
    private payoutService: PayoutService,
    private sellerService: SellerService,
  ) {}

  @Get('stats')
  async getStats() {
    return this.payoutService.getPayoutStats();
  }

  @Get('payouts/failed')
  async getFailedPayouts() {
    return this.payoutService.getPayoutsByStatus('FAILED');
  }

  @Get('payouts/review')
  async getPayoutsForReview() {
    return this.payoutService.getPayoutsByFraudDecision('REVIEW');
  }

  @Get('payouts/blocked')
  async getBlockedPayouts() {
    const failed = await this.payoutService.getPayoutsByStatus('FAILED');
    return failed.filter((p) => p.attempts >= p.maxAttempts);
  }

  @Post('payouts/:id/force-retry')
  async forceRetry(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.forceRetry(id);
  }

  @Post('payouts/:id/reverse')
  async reversePayout(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.reversePayout(id);
  }

  @Get('sellers/restricted')
  async getRestrictedSellers() {
    return this.sellerService.listSellers('RESTRICTED');
  }

  @Post('sellers/:id/force-sync')
  async forceSyncSeller(@Param('id', ParseIntPipe) id: number) {
    const seller = await this.sellerService.getSeller(id);
    if (!seller.stripeAccountId) {
      return { error: 'No Stripe account' };
    }
    return this.sellerService.syncStripeStatus(seller.stripeAccountId);
  }
}