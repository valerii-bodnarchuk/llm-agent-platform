import { calculateFee, toMinorUnits, toMajorUnits, assertMinorUnits } from './money';

describe('calculateFee', () => {
  it('should calculate 5% fee on a round amount', () => {
    expect(calculateFee(10000, 5)).toBe(500);
  });

  it('should derive seller amount by subtraction (fee + seller === amount)', () => {
    const amount = 10000;
    const fee = calculateFee(amount, 5);
    expect(fee + (amount - fee)).toBe(amount);
  });

  it('should round fee to nearest cent for fractional results', () => {
    // 9999 * 5 / 100 = 499.95 → rounds to 500
    expect(calculateFee(9999, 5)).toBe(500);
    // 101 * 5 / 100 = 5.05 → rounds to 5
    expect(calculateFee(101, 5)).toBe(5);
  });

  it('should return 0 fee on zero amount', () => {
    expect(calculateFee(0, 5)).toBe(0);
  });

  it('should handle high fee percentages', () => {
    expect(calculateFee(10000, 33)).toBe(3300);
  });

  it('should maintain fee + sellerAmount === amount across problematic values', () => {
    const cases = [
      { amount: 3333, pct: 7 },
      { amount: 1999, pct: 15 },
      { amount: 14995, pct: 2.5 },
      { amount: 100000, pct: 0.1 },
      { amount: 1, pct: 5 },
    ];
    for (const { amount, pct } of cases) {
      const fee = calculateFee(amount, pct);
      const sellerAmount = amount - fee;
      expect(fee + sellerAmount).toBe(amount);
      expect(Number.isInteger(fee)).toBe(true);
      expect(Number.isInteger(sellerAmount)).toBe(true);
    }
  });
});

describe('assertMinorUnits', () => {
  it('should pass for non-negative integers', () => {
    expect(() => assertMinorUnits(0, 'amount')).not.toThrow();
    expect(() => assertMinorUnits(10000, 'amount')).not.toThrow();
  });

  it('should throw for floats', () => {
    expect(() => assertMinorUnits(100.5, 'amount')).toThrow(/minor units/);
  });

  it('should throw for negative values', () => {
    expect(() => assertMinorUnits(-1, 'amount')).toThrow(/minor units/);
  });
});

describe('toMinorUnits / toMajorUnits', () => {
  it('should round-trip correctly', () => {
    expect(toMinorUnits(100)).toBe(10000);
    expect(toMajorUnits(10000)).toBe(100);
  });

  it('toMinorUnits should round fractional cents', () => {
    expect(toMinorUnits(99.999)).toBe(10000);
  });
});
