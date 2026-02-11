import { ApiProperty } from '@nestjs/swagger';

export class CreatePayoutDto {
  @ApiProperty()
  transactionId!: number;

  @ApiProperty()
  sellerId!: number;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ required: false, default: 5 })
  platformFeePercent?: number;
}