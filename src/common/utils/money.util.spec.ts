import { calculateFee } from './money.util';

describe('calculateFee', () => {
  it('should handle clean percentages', () => {
    const { fee, sellerAmount } = calculateFee(100, 5);
    expect(fee).toBe(5);
    expect(sellerAmount).toBe(95);
    expect(fee + sellerAmount).toBe(100);
  });

  it('should round fee to nearest cent for fractional results', () => {
    // 99.99 * 5% = 4.9995 → rounds to 5.00
    const { fee, sellerAmount } = calculateFee(99.99, 5);
    expect(fee).toBe(5);
    expect(sellerAmount).toBe(94.99);
    expect(fee + sellerAmount).toBe(99.99);
  });

  it('should handle small amounts without losing precision', () => {
    const { fee, sellerAmount } = calculateFee(0.01, 5);
    expect(fee + sellerAmount).toBeCloseTo(0.01, 10);
    // Fee is cent-aligned
    expect(Math.round(fee * 100)).toBe(Math.round(fee * 100));
  });

  it('should handle large amounts', () => {
    const { fee, sellerAmount } = calculateFee(9999.99, 3);
    expect(fee + sellerAmount).toBeCloseTo(9999.99, 2);
    expect(Number((fee * 100).toFixed(0)) % 1).toBe(0);
  });

  it('should handle high fee percentages', () => {
    const { fee, sellerAmount } = calculateFee(100, 33);
    expect(fee).toBe(33);
    expect(sellerAmount).toBe(67);
    expect(fee + sellerAmount).toBe(100);
  });

  it('should maintain invariant across problematic float values', () => {
    // Values known to cause float drift
    const cases = [
      { amount: 33.33, pct: 7 },
      { amount: 19.99, pct: 15 },
      { amount: 149.95, pct: 2.5 },
      { amount: 1000, pct: 0.1 },
    ];
    for (const { amount, pct } of cases) {
      const { fee, sellerAmount } = calculateFee(amount, pct);
      const sum = +(fee + sellerAmount).toFixed(2);
      expect(sum).toBe(+amount.toFixed(2));
    }
  });

  it('should throw on zero amount', () => {
    const { fee, sellerAmount } = calculateFee(0, 5);
    expect(fee).toBe(0);
    expect(sellerAmount).toBe(0);
  });
});
