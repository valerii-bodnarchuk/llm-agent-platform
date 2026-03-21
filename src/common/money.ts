/**
 * Money helper — all internal amounts are integer cents (minor units).
 * €1.00 = 100 cents. Never use float arithmetic on money.
 */

/** Convert a major-unit number (e.g. 200.00) to minor units (20000) */
export function toMinorUnits(major: number): number {
  return Math.round(major * 100);
}

/** Convert minor units back to major for display/API responses */
export function toMajorUnits(minor: number): number {
  return minor / 100;
}

/** Calculate fee in minor units. All inputs must be minor units. */
export function calculateFee(amountMinor: number, feePercent: number): number {
  return Math.round((amountMinor * feePercent) / 100);
}

/** Assert a value is a safe integer (not float, not NaN, not too large) */
export function assertMinorUnits(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `${label} must be a non-negative integer (minor units), got: ${value}`,
    );
  }
}
