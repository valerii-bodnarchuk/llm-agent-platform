import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { PayoutService } from '../payout/payout.service';
import { SellerService } from '../seller/seller.service';
import { AdminService } from './admin.service';

@ApiTags('Admin')
@Controller('admin')
export class AdminController {
  constructor(
    private payoutService: PayoutService,
    private sellerService: SellerService,
    private adminService: AdminService,
  ) {}

  // ── Existing endpoints ────────────────────────────────────────

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

  // ── Investigation endpoints ───────────────────────────────────

  @Get('sellers/:id/risk-profile')
  @ApiOperation({
    summary: 'Aggregated seller risk profile for fraud investigation',
    description:
      'Returns seller record, ledger balance, and computed risk metrics ' +
      '(payout velocity, dispute rate, volume trends) in a single response. ' +
      'Designed for the fraud investigation agent and ops dashboard.',
  })
  async getSellerRiskProfile(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getSellerRiskProfile(id);
  }

  @Get('sellers/:id/payout-timeline')
  @ApiOperation({
    summary: 'Chronological payout timeline for a seller',
    description:
      'Returns time-ordered payouts with status, fraud decision, failure reason, ' +
      'and time-to-completion. Includes summary with status distribution and volume trend. ' +
      'Designed for pattern detection in fraud investigation.',
  })
  @ApiQuery({
    name: 'daysBack',
    required: false,
    type: Number,
    description: 'Number of days to look back (default: 30)',
  })
  async getPayoutTimeline(
    @Param('id', ParseIntPipe) id: number,
    @Query('daysBack', new DefaultValuePipe(30), ParseIntPipe) daysBack: number,
  ) {
    return this.adminService.getPayoutTimeline(id, daysBack);
  }
}
