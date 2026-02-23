import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StripeService } from '../stripe/stripe.service';
import { SellerStatus } from '@prisma/client';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

@Injectable()
export class SellerService {
  constructor(
    @InjectPinoLogger(SellerService.name)
    private readonly logger: PinoLogger,
    private prisma: PrismaService,
    private stripe: StripeService,
  ) {}

  /** Register new seller → create account + Stripe Connect account */
  async registerSeller(params: { name: string; email: string }) {
    // Check email uniqueness
    const existing = await this.prisma.seller.findUnique({
      where: { email: params.email },
    });
    if (existing) {
      throw new BadRequestException(`Seller with email ${params.email} already exists`);
    }
    const account = await this.prisma.account.create({
      data: {
        name: params.name,
        type: 'SELLER',
        allowNegative: true,
      },
    });

    // Create Stripe Connect account
    const stripeAccount = await this.stripe.createConnectAccount(
      params.email,
      params.name,
    );

    // Create seller record
    return this.prisma.seller.create({
      data: {
        name: params.name,
        email: params.email,
        accountId: account.id,
        stripeAccountId: stripeAccount.id,
        status: 'ONBOARDING',
      },
    });
  }

  /** Get onboarding link for seller to complete KYC on Stripe */
  async getOnboardingLink(sellerId: number, returnUrl: string) {
    const seller = await this.getSeller(sellerId);

    if (!seller.stripeAccountId) {
      throw new BadRequestException('Seller has no Stripe account');
    }

    if (seller.status === 'ACTIVE') {
      throw new BadRequestException('Seller is already fully onboarded');
    }

    const link = await this.stripe.createOnboardingLink(
      seller.stripeAccountId,
      returnUrl,
    );

    // Update status if still ONBOARDING
    if (seller.status === 'ONBOARDING') {
      await this.prisma.seller.update({
        where: { id: sellerId },
        data: { status: 'PENDING_VERIFICATION' },
      });
    }

    return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
  }

  /** Called by webhook when Stripe sends account.updated */
  async syncStripeStatus(stripeAccountId: string) {
    const seller = await this.prisma.seller.findUnique({
      where: { stripeAccountId },
    });

    if (!seller) {
      this.logger.warn(`No seller found for Stripe account ${stripeAccountId}`);
      return;
    }

    const account = await this.stripe.getConnectAccount(stripeAccountId);

    // Determine seller status from Stripe account state
    let status: SellerStatus;
    if (account.charges_enabled && account.payouts_enabled) {
      status = 'ACTIVE';
    } else if (account.requirements?.disabled_reason) {
      status = 'RESTRICTED';
    } else {
      status = 'PENDING_VERIFICATION';
    }

    return this.prisma.seller.update({
      where: { id: seller.id },
      data: {
        status,
        chargesEnabled: account.charges_enabled ?? false,
        payoutsEnabled: account.payouts_enabled ?? false,
        requirementsDue: account.requirements?.currently_due ?? [],
      },
    });
  }

  async getSeller(sellerId: number) {
    const seller = await this.prisma.seller.findUnique({
      where: { id: sellerId },
      include: { account: true },
    });

    if (!seller) {
      throw new NotFoundException(`Seller ${sellerId} not found`);
    }

    return seller;
  }

  async listSellers(status?: SellerStatus) {
    return this.prisma.seller.findMany({
      where: status ? { status } : undefined,
      include: { account: true },
      orderBy: { createdAt: 'desc' },
    });
  }
}