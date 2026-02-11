import { ApiProperty } from '@nestjs/swagger';

export class RegisterSellerDto {
  @ApiProperty({ example: 'John Shop' })
  name!: string;

  @ApiProperty({ example: 'john@shop.com' })
  email!: string;
}