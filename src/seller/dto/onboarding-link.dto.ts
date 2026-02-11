import { ApiProperty } from '@nestjs/swagger';

export class OnboardingLinkDto {
  @ApiProperty({ example: 'http://localhost:3000/sellers/onboarding-complete' })
  returnUrl!: string;
}