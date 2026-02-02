import { ApiProperty } from '@nestjs/swagger';

export class ReleasePayoutDto {
  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 7 })
  escrowAccountId!: number;

  @ApiProperty({ example: 6 })
  sellerAccountId!: number;

  @ApiProperty({ example: 8 })
  platformFeeAccountId!: number;

  @ApiProperty({ example: 5, required: false })
  platformFeePercent?: number;
}