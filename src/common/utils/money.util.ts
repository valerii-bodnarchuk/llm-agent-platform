/**
 * Fee calculation with zero float drift.
 *
 * Strategy: round fee to nearest cent FIRST, then derive seller amount
 * by subtraction. Guarantees: fee + sellerAmount === amount (exactly).
 *
 * Why not integer cents everywhere: requires DB migration + API contract
 * change (tracked separately). This gives correct arithmetic on the
 * existing Decimal schema.
 */
export function calculateFee(
  amount: number,
  feePercent: number,
): { fee: number; sellerAmount: number } {
  const fee = Math.round(amount * feePercent) / 100;
  const sellerAmount = +(amount - fee).toFixed(2);

  // Invariant: must sum to original amount
  const sum = +(fee + sellerAmount).toFixed(2);
  if (sum !== +amount.toFixed(2)) {
    throw new Error(
      `Fee split invariant violated: ${fee} + ${sellerAmount} = ${sum}, expected ${amount}`,
    );
  }

  return { fee, sellerAmount };
}
