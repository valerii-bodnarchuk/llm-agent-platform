import { BadRequestException } from '@nestjs/common';
import { DisputeStatus } from '@prisma/client';

const VALID_TRANSITIONS: Record<DisputeStatus, DisputeStatus[]> = {
  OPEN: ['UNDER_REVIEW'],
  UNDER_REVIEW: ['WON', 'LOST', 'REFUNDED'],
  WON: [],
  LOST: [],
  REFUNDED: [],
};

export function validateDisputeTransition(
  current: DisputeStatus,
  next: DisputeStatus,
): void {
  const allowed = VALID_TRANSITIONS[current];

  if (!allowed.includes(next)) {
    throw new BadRequestException(
      `Invalid dispute transition: ${current} → ${next}. Allowed: ${allowed.join(', ') || 'none (terminal state)'}`,
    );
  }
}