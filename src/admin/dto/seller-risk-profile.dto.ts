import { ApiProperty } from '@nestjs/swagger';

export class SellerRiskMetricsDto {
  @ApiProperty({ description: 'Total payouts ever created for this seller' })
  totalPayouts!: number;

  @ApiProperty({ description: 'Payouts that reached PAID status' })
  paidPayouts!: number;

  @ApiProperty({ description: 'Payouts that reached FAILED status' })
  failedPayouts!: number;

  @ApiProperty({ description: 'Payouts that were REVERSED' })
  reversedPayouts!: number;

  @ApiProperty({ description: 'Total disputes filed against this seller' })
  totalDisputes!: number;

  @ApiProperty({ description: 'Disputes resolved as LOST (buyer won)' })
  lostDisputes!: number;

  @ApiProperty({ description: 'Payouts created in the last 24 hours' })
  payoutVelocity24h!: number;

  @ApiProperty({ description: 'Total payout volume in cents in the last 24 hours' })
  totalVolume24h!: number;

  @ApiProperty({ description: 'Total lifetime payout volume in cents' })
  totalVolumeLifetime!: number;

  @ApiProperty({ description: 'Average payout amount in cents (0 if no payouts)' })
  avgPayoutAmount!: number;

  @ApiProperty({ description: 'Seller account age in days' })
  accountAgeDays!: number;

  @ApiProperty({ description: 'Date of first payout, null if none', nullable: true })
  firstPayoutDate!: string | null;

  @ApiProperty({ description: 'ISO duration since last FAILED payout, null if none', nullable: true })
  timeSinceLastFailure!: string | null;
}

export class SellerRiskProfileDto {
  @ApiProperty()
  seller!: {
    id: number;
    name: string;
    email: string;
    status: string;
    stripeAccountId: string | null;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    payoutsBlocked: boolean;
    negativeBalance: number;
    accountAgeDays: number;
    createdAt: string;
  };

  @ApiProperty()
  ledger!: {
    accountId: number;
    balance: number;
  };

  @ApiProperty({ type: SellerRiskMetricsDto })
  riskMetrics!: SellerRiskMetricsDto;
}
