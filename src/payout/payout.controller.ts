import { Controller, Post, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PayoutService } from './payout.service';
import { ReleasePayoutDto } from './dto/release-payout.dto';

@ApiTags('Payout')
@Controller('payouts')
export class PayoutController {
  constructor(private payoutService: PayoutService) {}

  @Post('release')
  async releasePayout(@Body() body: ReleasePayoutDto) {
    return this.payoutService.releasePayout(body);
  }
}