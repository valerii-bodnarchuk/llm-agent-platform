import { ApiProperty } from '@nestjs/swagger';
import { DisputeReason } from '@prisma/client';

export class OpenDisputeDto {
  @ApiProperty()
  transactionId!: number;

  @ApiProperty({ enum: DisputeReason })
  reason!: DisputeReason;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ required: false })
  description?: string;
}