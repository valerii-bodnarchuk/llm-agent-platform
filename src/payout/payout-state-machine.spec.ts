import { validateTransition } from './payout-state-machine';

describe('PayoutStateMachine', () => {
  describe('valid transitions', () => {
    it('PENDING → ELIGIBLE', () => {
      expect(() => validateTransition('PENDING', 'ELIGIBLE')).not.toThrow();
    });

    it('ELIGIBLE → PROCESSING', () => {
      expect(() => validateTransition('ELIGIBLE', 'PROCESSING')).not.toThrow();
    });

    it('PROCESSING → PAID', () => {
      expect(() => validateTransition('PROCESSING', 'PAID')).not.toThrow();
    });

    it('PROCESSING → FAILED', () => {
      expect(() => validateTransition('PROCESSING', 'FAILED')).not.toThrow();
    });

    it('FAILED → PROCESSING (retry)', () => {
      expect(() => validateTransition('FAILED', 'PROCESSING')).not.toThrow();
    });
  });

  describe('invalid transitions', () => {
    it('PENDING → PAID (skip steps)', () => {
      expect(() => validateTransition('PENDING', 'PAID')).toThrow('Invalid payout transition');
    });

    it('PAID → PENDING (reverse terminal)', () => {
      expect(() => validateTransition('PAID', 'PENDING')).toThrow('Invalid payout transition');
    });

    it('PAID → PROCESSING (terminal state)', () => {
      expect(() => validateTransition('PAID', 'PROCESSING')).toThrow('Invalid payout transition');
    });

    it('ELIGIBLE → FAILED (must go through PROCESSING)', () => {
      expect(() => validateTransition('ELIGIBLE', 'FAILED')).toThrow('Invalid payout transition');
    });

    it('PENDING → PROCESSING (must be eligible first)', () => {
      expect(() => validateTransition('PENDING', 'PROCESSING')).toThrow('Invalid payout transition');
    });
  });
});