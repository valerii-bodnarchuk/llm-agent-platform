import { BadRequestException } from '@nestjs/common';
import { PayoutStatus } from '@prisma/client';

const VALID_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  PENDING: ['ELIGIBLE'],
  ELIGIBLE: ['PROCESSING'],
  PROCESSING: ['PAID', 'FAILED'],
  PAID: ['REVERSED'],
  FAILED: ['PROCESSING'],
  REVERSED: [],
};

export function validateTransition(
  current: PayoutStatus,
  next: PayoutStatus,
): void {
  const allowed = VALID_TRANSITIONS[current];

  if (!allowed.includes(next)) {
    throw new BadRequestException(
      `Invalid payout transition: ${current} → ${next}. Allowed: ${allowed.join(', ') || 'none (terminal state)'}`,
    );
  }
}