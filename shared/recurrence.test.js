import { describe, it, expect } from 'vitest';
import {
  nextOccurrence,
  occurrencesUpTo,
  cycleKey,
  toMonthlyCents,
  describeSchedule,
  startOfUTCDay,
  FREQUENCIES,
} from './recurrence.js';

const d = (iso) => new Date(`${iso}T00:00:00.000Z`);
const keys = (dates) => dates.map(cycleKey);

describe('nextOccurrence', () => {
  it('advances by days, weeks and fortnights', () => {
    expect(cycleKey(nextOccurrence(d('2026-03-01'), { frequency: 'daily' }))).toBe('2026-03-02');
    expect(cycleKey(nextOccurrence(d('2026-03-01'), { frequency: 'weekly' }))).toBe('2026-03-08');
    expect(cycleKey(nextOccurrence(d('2026-03-01'), { frequency: 'fortnightly' }))).toBe(
      '2026-03-15',
    );
  });

  it('honours an interval', () => {
    expect(cycleKey(nextOccurrence(d('2026-03-01'), { frequency: 'weekly', interval: 3 }))).toBe(
      '2026-03-22',
    );
    expect(cycleKey(nextOccurrence(d('2026-01-15'), { frequency: 'monthly', interval: 2 }))).toBe(
      '2026-03-15',
    );
  });

  it('rolls months, quarters and years over year boundaries', () => {
    expect(cycleKey(nextOccurrence(d('2026-12-10'), { frequency: 'monthly' }))).toBe('2027-01-10');
    expect(cycleKey(nextOccurrence(d('2026-11-05'), { frequency: 'quarterly' }))).toBe('2027-02-05');
    expect(cycleKey(nextOccurrence(d('2026-06-30'), { frequency: 'yearly' }))).toBe('2027-06-30');
  });

  it('clamps into short months', () => {
    expect(cycleKey(nextOccurrence(d('2026-01-31'), { frequency: 'monthly' }))).toBe('2026-02-28');
    expect(cycleKey(nextOccurrence(d('2026-03-31'), { frequency: 'monthly' }))).toBe('2026-04-30');
  });

  it('rejects bad rules', () => {
    expect(() => nextOccurrence(d('2026-01-01'), { frequency: 'hourly' })).toThrow(/Unknown/);
    expect(() => nextOccurrence(d('2026-01-01'), { frequency: 'monthly', interval: 0 })).toThrow(
      /1 or more/,
    );
  });
});

describe('occurrencesUpTo', () => {
  const monthly = (startDate, extra = {}) => ({ startDate, frequency: 'monthly', ...extra });

  it('includes the start date and stops at the cutoff', () => {
    const out = occurrencesUpTo(monthly('2026-01-01'), d('2026-04-15'));
    expect(keys(out)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('returns nothing before the series starts', () => {
    expect(occurrencesUpTo(monthly('2026-06-01'), d('2026-03-01'))).toEqual([]);
  });

  it('keeps the original day as the anchor through short months', () => {
    // The classic bug: Feb must not permanently drag the series to the 28th.
    const out = occurrencesUpTo(monthly('2026-01-31'), d('2026-05-31'));
    expect(keys(out)).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
  });

  it('handles 29 Feb in a leap year and the years around it', () => {
    const out = occurrencesUpTo(
      { startDate: d('2024-02-29'), frequency: 'yearly' },
      d('2028-12-31'),
    );
    expect(keys(out)).toEqual(['2024-02-29', '2025-02-28', '2026-02-28', '2027-02-28', '2028-02-29']);
  });

  it('backfills every missed cycle after a long absence', () => {
    // Nobody opened the app since January; all three months are still owed.
    const missed = occurrencesUpTo(monthly('2026-01-01'), d('2026-04-10'), {
      after: d('2026-01-01'),
    });
    expect(keys(missed)).toEqual(['2026-02-01', '2026-03-01', '2026-04-01']);
  });

  it('generates nothing when already up to date', () => {
    const out = occurrencesUpTo(monthly('2026-01-01'), d('2026-03-20'), { after: d('2026-03-01') });
    expect(out).toEqual([]);
  });

  it('stops at the series end date', () => {
    const out = occurrencesUpTo(monthly('2026-01-01', { endDate: d('2026-03-01') }), d('2026-12-01'));
    expect(keys(out)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('respects the safety cap', () => {
    const out = occurrencesUpTo(
      { startDate: d('2020-01-01'), frequency: 'daily' },
      d('2030-01-01'),
      { limit: 5 },
    );
    expect(out).toHaveLength(5);
  });

  it('ignores the time of day on the boundaries', () => {
    const out = occurrencesUpTo(
      { startDate: new Date('2026-01-01T18:45:00Z'), frequency: 'monthly' },
      new Date('2026-02-01T03:00:00Z'),
    );
    expect(keys(out)).toEqual(['2026-01-01', '2026-02-01']);
  });

  it('never drifts across a DST changeover', () => {
    // Late March and late October are when a local-time implementation slips.
    const out = occurrencesUpTo({ startDate: d('2026-03-28'), frequency: 'daily' }, d('2026-03-31'));
    expect(keys(out)).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31']);
    const autumn = occurrencesUpTo(
      { startDate: d('2026-10-24'), frequency: 'daily' },
      d('2026-10-27'),
    );
    expect(keys(autumn)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
  });
});

describe('startOfUTCDay / cycleKey', () => {
  it('normalises any instant to its UTC calendar day', () => {
    expect(cycleKey(new Date('2026-05-09T23:59:59.999Z'))).toBe('2026-05-09');
    expect(startOfUTCDay('2026-05-09').toISOString()).toBe('2026-05-09T00:00:00.000Z');
  });

  it('rejects nonsense', () => {
    expect(() => startOfUTCDay('not-a-date')).toThrow(TypeError);
  });
});

describe('toMonthlyCents', () => {
  it('converts each frequency to its true monthly cost', () => {
    expect(toMonthlyCents(120_00, { frequency: 'monthly' })).toBe(120_00);
    expect(toMonthlyCents(12_00, { frequency: 'yearly' })).toBe(100);
    expect(toMonthlyCents(300_00, { frequency: 'quarterly' })).toBe(100_00);
    // Weekly is 52/12 a month, not 4 — using 4 loses a month of money a year.
    expect(toMonthlyCents(100_00, { frequency: 'weekly' })).toBe(43333);
    expect(toMonthlyCents(100_00, { frequency: 'fortnightly' })).toBe(21667);
  });

  it('divides by the interval', () => {
    expect(toMonthlyCents(100_00, { frequency: 'monthly', interval: 2 })).toBe(50_00);
    expect(toMonthlyCents(600_00, { frequency: 'quarterly', interval: 2 })).toBe(100_00);
  });

  it('a year of monthly equivalents matches a year of real charges', () => {
    // 52 weekly payments of ₹100 = ₹5,200; 12 monthly equivalents should agree
    // to within rounding, which "4 weeks a month" (₹4,800) badly does not.
    const perMonth = toMonthlyCents(100_00, { frequency: 'weekly' });
    expect(Math.abs(perMonth * 12 - 100_00 * 52)).toBeLessThanOrEqual(12);
  });

  it('rejects unknown frequencies', () => {
    expect(() => toMonthlyCents(100, { frequency: 'hourly' })).toThrow(/Unknown/);
  });
});

describe('describeSchedule', () => {
  it('describes monthly and weekly series readably', () => {
    expect(describeSchedule({ frequency: FREQUENCIES.MONTHLY, startDate: d('2026-03-01') })).toBe(
      'Monthly on the 1st',
    );
    expect(describeSchedule({ frequency: 'monthly', startDate: d('2026-03-22') })).toBe(
      'Monthly on the 22nd',
    );
    expect(describeSchedule({ frequency: 'monthly', startDate: d('2026-03-03') })).toBe(
      'Monthly on the 3rd',
    );
    expect(describeSchedule({ frequency: 'monthly', startDate: d('2026-03-11') })).toBe(
      'Monthly on the 11th',
    );
    // 2026-03-02 is a Monday
    expect(describeSchedule({ frequency: 'weekly', startDate: d('2026-03-02') })).toBe(
      'Weekly on Monday',
    );
  });
});
