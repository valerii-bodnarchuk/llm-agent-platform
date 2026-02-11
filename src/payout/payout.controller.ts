import { Controller, Post, Get, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { PayoutService } from './payout.service';
import { PayoutStatus } from '@prisma/client';
import { CreatePayoutDto } from './dto/create-payout.dto';

@ApiTags('Payouts')
@Controller('payouts')
export class PayoutController {
  constructor(private payoutService: PayoutService) {}

  @Post()
  async createPayout(@Body() body: CreatePayoutDto) {
    return this.payoutService.createPayout(body);
  }

  @Post(':id/eligible')
  async markEligible(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.markEligible(id);
  }

  @Post(':id/process')
  async processPayout(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.processPayout(id);
  }

  @Post(':id/retry')
  async retryPayout(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.retryPayout(id);
  }

  @Get(':id')
  async getPayout(@Param('id', ParseIntPipe) id: number) {
    return this.payoutService.getPayout(id);
  }

  @Get()
  @ApiQuery({ name: 'status', enum: PayoutStatus, required: false })
  async listPayouts(@Query('status') status?: PayoutStatus) {
    if (status) {
      return this.payoutService.getPayoutsByStatus(status);
    }
    return this.payoutService.getPayoutsByStatus('PENDING');
  }
}