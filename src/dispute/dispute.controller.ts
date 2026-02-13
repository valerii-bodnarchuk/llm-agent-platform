import { Controller, Post, Get, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { DisputeService } from './dispute.service';
import { DisputeStatus } from '@prisma/client';
import { OpenDisputeDto } from './dto/open-dispute.dto';
import { ResolveDisputeDto } from './dto/resolve-dispute.dto';

@ApiTags('Disputes')
@Controller('disputes')
export class DisputeController {
  constructor(private disputeService: DisputeService) {}

  @Post()
  async openDispute(@Body() body: OpenDisputeDto) {
    return this.disputeService.openDispute(body);
  }

  @Post(':id/review')
  async startReview(@Param('id', ParseIntPipe) id: number) {
    return this.disputeService.startReview(id);
  }

  @Post(':id/won')
  async resolveWon(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ResolveDisputeDto,
  ) {
    return this.disputeService.resolveWon(id, body.note);
  }

  @Post(':id/lost')
  async resolveLost(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ResolveDisputeDto,
  ) {
    return this.disputeService.resolveLost(id, body.note);
  }

  @Post(':id/refund')
  async resolveRefunded(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ResolveDisputeDto,
  ) {
    return this.disputeService.resolveRefunded(id, body.note);
  }

  @Get(':id')
  async getDispute(@Param('id', ParseIntPipe) id: number) {
    return this.disputeService.getDispute(id);
  }

  @Get()
  @ApiQuery({ name: 'status', enum: DisputeStatus, required: false })
  async listDisputes(@Query('status') status?: DisputeStatus) {
    return this.disputeService.listDisputes(status);
  }
}