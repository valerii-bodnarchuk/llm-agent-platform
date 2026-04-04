import { ApiProperty } from '@nestjs/swagger';

export class PayoutTimelineEntryDto {
  @ApiProperty()
  payoutId!: number;

  @ApiProperty()
  createdAt!: string;

  @ApiProperty({ description: 'Payout amount in cents' })
  amount!: number;

  @ApiProperty({ description: 'Seller receives in cents' })
  sellerAmount!: number;

  @ApiProperty()
  status!: string;

  @ApiProperty({ nullable: true })
  fraudDecision!: string | null;

  @ApiProperty({ nullable: true })
  fraudScore!: number | null;

  @ApiProperty({ nullable: true })
  failureReason!: string | null;

  @ApiProperty({ nullable: true, description: 'Duration from creation to terminal state' })
  timeToCompletion!: string | null;

  @ApiProperty()
  transactionId!: number;

  @ApiProperty()
  attempts!: number;
}

export class PayoutTimelineSummaryDto {
  @ApiProperty()
  totalCount!: number;

  @ApiProperty({ description: 'Count of payouts by status' })
  statusDistribution!: Record<string, number>;

  @ApiProperty({ description: 'Average payout amount in cents (0 if none)' })
  avgAmount!: number;

  @ApiProperty({
    description: 'Volume trend based on comparison of recent vs older period',
    enum: ['increasing', 'stable', 'decreasing'],
  })
  trend!: 'increasing' | 'stable' | 'decreasing';
}

export class PayoutTimelineDto {
  @ApiProperty({ type: [PayoutTimelineEntryDto] })
  timeline!: PayoutTimelineEntryDto[];

  @ApiProperty({ type: PayoutTimelineSummaryDto })
  summary!: PayoutTimelineSummaryDto;
}
