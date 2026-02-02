import { ApiProperty } from '@nestjs/swagger';

export class AddPayoutJobDto {
  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 7 })
  escrowAccountId!: number;

  @ApiProperty({ example: 6 })
  sellerAccountId!: number;

  @ApiProperty({ example: 8 })
  platformFeeAccountId!: number;
}