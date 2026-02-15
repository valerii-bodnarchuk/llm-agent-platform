import { validateDisputeTransition } from './dispute-state-machine';

describe('DisputeStateMachine', () => {
  describe('valid transitions', () => {
    it('OPEN → UNDER_REVIEW', () => {
      expect(() => validateDisputeTransition('OPEN', 'UNDER_REVIEW')).not.toThrow();
    });

    it('UNDER_REVIEW → WON', () => {
      expect(() => validateDisputeTransition('UNDER_REVIEW', 'WON')).not.toThrow();
    });

    it('UNDER_REVIEW → LOST', () => {
      expect(() => validateDisputeTransition('UNDER_REVIEW', 'LOST')).not.toThrow();
    });

    it('UNDER_REVIEW → REFUNDED', () => {
      expect(() => validateDisputeTransition('UNDER_REVIEW', 'REFUNDED')).not.toThrow();
    });
  });

  describe('invalid transitions', () => {
    it('OPEN → WON (skip review)', () => {
      expect(() => validateDisputeTransition('OPEN', 'WON')).toThrow('Invalid dispute transition');
    });

    it('OPEN → REFUNDED (skip review)', () => {
      expect(() => validateDisputeTransition('OPEN', 'REFUNDED')).toThrow('Invalid dispute transition');
    });

    it('WON → OPEN (terminal state)', () => {
      expect(() => validateDisputeTransition('WON', 'OPEN')).toThrow('Invalid dispute transition');
    });

    it('LOST → UNDER_REVIEW (terminal state)', () => {
      expect(() => validateDisputeTransition('LOST', 'UNDER_REVIEW')).toThrow('Invalid dispute transition');
    });

    it('REFUNDED → OPEN (terminal state)', () => {
      expect(() => validateDisputeTransition('REFUNDED', 'OPEN')).toThrow('Invalid dispute transition');
    });
  });
});