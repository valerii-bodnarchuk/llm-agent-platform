import { Controller, Post, Get, Param, Body, Query, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiQuery } from '@nestjs/swagger';
import { SellerService } from './seller.service';
import { SellerStatus } from '@prisma/client';
import { RegisterSellerDto } from './dto/register-seller.dto';
import { OnboardingLinkDto } from './dto/onboarding-link.dto';

@ApiTags('Sellers')
@Controller('sellers')
export class SellerController {
  constructor(private sellerService: SellerService) {}

  @Post('register')
  async register(@Body() body: RegisterSellerDto) {
    return this.sellerService.registerSeller(body);
  }

  @Post(':id/onboarding-link')
  async getOnboardingLink(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: OnboardingLinkDto,
  ) {
    return this.sellerService.getOnboardingLink(id, body.returnUrl);
  }

  @Post(':id/sync')
  async syncStatus(@Param('id', ParseIntPipe) id: number) {
    const seller = await this.sellerService.getSeller(id);
    if (!seller.stripeAccountId) {
      return { error: 'No Stripe account' };
    }
    return this.sellerService.syncStripeStatus(seller.stripeAccountId);
  }

  @Get(':id')
  async getSeller(@Param('id', ParseIntPipe) id: number) {
    return this.sellerService.getSeller(id);
  }

  @Get()
  @ApiQuery({ name: 'status', enum: SellerStatus, required: false })
  async listSellers(@Query('status') status?: SellerStatus) {
    return this.sellerService.listSellers(status);
  }
}