import { ApiProperty } from '@nestjs/swagger';

export class CreatePaymentDto {
  @ApiProperty({ example: 100 })
  amount!: number;

  @ApiProperty({ example: 1 })
  buyerAccountId!: number;

  @ApiProperty({ example: 2 })
  escrowAccountId!: number;
}