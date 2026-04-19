import { Controller, Get, Post, Param, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InvestigationService } from './investigation.service';

@ApiTags('Investigation')
@Controller('investigate')
export class InvestigationController {
  constructor(private investigationService: InvestigationService) {}

  @Get('payout/:id')
  @Post('payout/:id')
  @ApiOperation({ summary: 'Investigate a specific payout — returns structured root cause report' })
  investigatePayout(@Param('id', ParseIntPipe) id: number) {
    return this.investigationService.investigatePayout(id);
  }

  @Get('transaction/:id')
  @Post('transaction/:id')
  @ApiOperation({ summary: 'Investigate all payouts for a transaction' })
  investigateTransaction(@Param('id', ParseIntPipe) id: number) {
    return this.investigationService.investigateTransaction(id);
  }
}
