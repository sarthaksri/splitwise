import { describe, it, expect } from 'vitest';
import { allocate, toCents, fromCents, formatMoney, sumValues } from './money.js';

describe('toCents', () => {
  it('parses numbers and strings into integer minor units', () => {
    expect(toCents(12.34)).toBe(1234);
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('1,234.56')).toBe(123456);
    expect(toCents('₹99')).toBe(9900);
    expect(toCents(0.1 + 0.2)).toBe(30); // the float trap, closed
    expect(toCents('.5')).toBe(50);
  });

  it('returns NaN for junk', () => {
    expect(toCents('abc')).toBeNaN();
    expect(toCents('')).toBeNaN();
    expect(toCents('1.2.3')).toBeNaN();
    expect(toCents(Infinity)).toBeNaN();
    expect(toCents(null)).toBeNaN();
  });

  it('round-trips through fromCents', () => {
    expect(fromCents(toCents('45.67'))).toBeCloseTo(45.67, 10);
  });
});

describe('formatMoney', () => {
  it('formats rupees with a sign when asked', () => {
    expect(formatMoney(123456, 'INR')).toContain('1,234.56');
    expect(formatMoney(-500, 'INR').startsWith('-')).toBe(true);
    expect(formatMoney(500, 'INR', { showSign: true }).startsWith('+')).toBe(true);
  });

  it('falls back gracefully on an unknown currency code', () => {
    expect(formatMoney(1000, 'XYZZY')).toBe('10.00');
  });
});

describe('allocate', () => {
  it('splits evenly when it divides cleanly', () => {
    const out = allocate(3000, ['a', 'b', 'c']);
    expect([...out.values()]).toEqual([1000, 1000, 1000]);
  });

  it('never loses or invents a unit on an indivisible amount', () => {
    const out = allocate(1000, ['a', 'b', 'c']);
    expect(sumValues(out)).toBe(1000);
    expect([...out.values()].sort()).toEqual([333, 333, 334]);
  });

  it('is deterministic: the same input always favours the same party', () => {
    const first = allocate(1000, ['charlie', 'alice', 'bob']);
    const second = allocate(1000, ['charlie', 'alice', 'bob']);
    expect([...first]).toEqual([...second]);
    // With equal remainders the tie breaks on ascending key.
    expect(first.get('alice')).toBe(334);
  });

  it('respects weights', () => {
    const out = allocate(10000, ['a', 'b'], [3, 1]);
    expect(out.get('a')).toBe(7500);
    expect(out.get('b')).toBe(2500);
    expect(sumValues(out)).toBe(10000);
  });

  it('gives a zero-weight party nothing, even when rounding up', () => {
    const out = allocate(1000, ['a', 'b', 'c'], [1, 1, 0]);
    expect(out.get('c')).toBe(0);
    expect(sumValues(out)).toBe(1000);
  });

  it('handles negative totals symmetrically (shared discounts)', () => {
    const out = allocate(-1000, ['a', 'b', 'c']);
    expect(sumValues(out)).toBe(-1000);
    expect([...out.values()].every((v) => v <= 0)).toBe(true);
  });

  it('falls back to an even split when all weights are zero', () => {
    const out = allocate(900, ['a', 'b', 'c'], [0, 0, 0]);
    expect(sumValues(out)).toBe(900);
    expect([...out.values()]).toEqual([300, 300, 300]);
  });

  it('conserves every unit across an exhaustive sweep of totals and party sizes', () => {
    for (let total = 0; total <= 500; total += 1) {
      for (let n = 1; n <= 9; n += 1) {
        const keys = Array.from({ length: n }, (_, i) => `u${i}`);
        const out = allocate(total, keys);
        expect(sumValues(out)).toBe(total);
        // Fairness: no two people differ by more than one minor unit.
        const values = [...out.values()];
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('conserves every unit with random weights too', () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let trial = 0; trial < 300; trial += 1) {
      const n = 2 + Math.floor(rand() * 7);
      const keys = Array.from({ length: n }, (_, i) => `u${i}`);
      const weights = keys.map(() => Math.floor(rand() * 100));
      const total = Math.floor(rand() * 1_000_000);
      const out = allocate(total, keys, weights);
      expect(sumValues(out)).toBe(total);
    }
  });

  it('rejects non-integer totals and bad weights', () => {
    expect(() => allocate(10.5, ['a'])).toThrow(TypeError);
    expect(() => allocate(100, ['a', 'b'], [1])).toThrow(/length/);
    expect(() => allocate(100, ['a'], [-1])).toThrow(/non-negative/);
    expect(() => allocate(100, [])).toThrow(/zero parties/);
    expect(allocate(0, []).size).toBe(0);
  });
});
