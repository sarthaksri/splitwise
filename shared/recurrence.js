/**
 * Recurrence scheduling.
 *
 * All date arithmetic here is done in UTC on whole days. Recurring rent must
 * land on the same calendar day regardless of daylight saving or the server's
 * timezone, and UTC is the only way to get that for free.
 *
 * The subtle part is monthly-style recurrence. The rule is that the *original*
 * day of the month is the anchor, and short months clamp without losing it:
 *
 *   31 Jan -> 28 Feb -> 31 Mar        (correct: anchor stays 31)
 *   31 Jan -> 28 Feb -> 28 Mar        (wrong: the clamp became the new anchor)
 *
 * Everything below is pure, so both the server and the browser can predict the
 * same schedule.
 */

export const FREQUENCIES = /** @type {const} */ ({
  DAILY: 'daily',
  WEEKLY: 'weekly',
  FORTNIGHTLY: 'fortnightly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  YEARLY: 'yearly',
});

export const FREQUENCY_LIST = Object.values(FREQUENCIES);

export const FREQUENCY_LABELS = {
  daily: 'Daily',
  weekly: 'Weekly',
  fortnightly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Every 3 months',
  yearly: 'Yearly',
};

/**
 * How many times each frequency occurs in a year, as an exact fraction. Used to
 * express every recurring item in the same per-month unit for the netting view.
 * Fractions rather than floats so the arithmetic stays exact.
 */
const PER_YEAR = {
  daily: [365, 1],
  weekly: [52, 1],
  fortnightly: [26, 1],
  monthly: [12, 1],
  quarterly: [4, 1],
  yearly: [1, 1],
};

const DAY_MS = 86_400_000;

/** Strip any time-of-day, keeping the UTC calendar date. */
export function startOfUTCDay(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) throw new TypeError(`Invalid date: ${date}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const addDays = (date, n) => new Date(startOfUTCDay(date).getTime() + n * DAY_MS);

/** Days in a given UTC month (month is 0-based and may be out of range). */
function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Add whole months, clamping to the end of short months but keeping `anchorDay`
 * as the day we aim for — that's what stops 31 Jan degrading to the 28th
 * permanently.
 */
function addMonths(date, months, anchorDay) {
  const d = startOfUTCDay(date);
  const day = anchorDay ?? d.getUTCDate();
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  return new Date(Date.UTC(year, month, Math.min(day, daysInMonth(year, month))));
}

function normalizeRule(rule) {
  const frequency = rule?.frequency;
  if (!FREQUENCY_LIST.includes(frequency)) {
    throw new Error(`Unknown recurrence frequency "${frequency}"`);
  }
  const interval = rule.interval == null ? 1 : Number(rule.interval);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error('Recurrence interval must be a whole number of 1 or more');
  }
  return { frequency, interval };
}

/**
 * The occurrence immediately after `date` for this rule.
 *
 * @param {Date|string|number} date
 * @param {{frequency: string, interval?: number}} rule
 * @param {number} [anchorDay] day-of-month the series is anchored to
 */
export function nextOccurrence(date, rule, anchorDay) {
  const { frequency, interval } = normalizeRule(rule);
  switch (frequency) {
    case FREQUENCIES.DAILY:
      return addDays(date, interval);
    case FREQUENCIES.WEEKLY:
      return addDays(date, 7 * interval);
    case FREQUENCIES.FORTNIGHTLY:
      return addDays(date, 14 * interval);
    case FREQUENCIES.MONTHLY:
      return addMonths(date, interval, anchorDay);
    case FREQUENCIES.QUARTERLY:
      return addMonths(date, 3 * interval, anchorDay);
    case FREQUENCIES.YEARLY:
      return addMonths(date, 12 * interval, anchorDay);
    default:
      throw new Error(`Unknown recurrence frequency "${frequency}"`);
  }
}

/**
 * Every occurrence from `startDate` up to and including `until`.
 *
 * This is what drives backfill: if nobody opened the app for three months, this
 * returns all three missed rent days so the ledger tells the truth.
 *
 * @param {object} schedule
 * @param {Date|string} schedule.startDate  first occurrence (inclusive)
 * @param {Date|string} [schedule.endDate]  series stops after this (inclusive)
 * @param {string} schedule.frequency
 * @param {number} [schedule.interval]
 * @param {Date|string} until               generate up to this date (inclusive)
 * @param {object} [opts]
 * @param {Date|string} [opts.after]        only occurrences strictly after this
 * @param {number} [opts.limit]             safety cap on how many to return
 * @returns {Date[]} occurrence dates, ascending
 */
export function occurrencesUpTo(schedule, until, { after = null, limit = 600 } = {}) {
  const rule = normalizeRule(schedule);
  const start = startOfUTCDay(schedule.startDate);
  const end = startOfUTCDay(until);
  const seriesEnd = schedule.endDate ? startOfUTCDay(schedule.endDate) : null;
  const afterDay = after ? startOfUTCDay(after) : null;

  // Monthly-style series stay anchored to the day they started on.
  const anchorDay = start.getUTCDate();

  const out = [];
  let cursor = start;
  let guard = 0;

  while (cursor <= end) {
    if (seriesEnd && cursor > seriesEnd) break;
    if (!afterDay || cursor > afterDay) {
      out.push(cursor);
      if (out.length >= limit) break;
    }

    const next = nextOccurrence(cursor, rule, anchorDay);
    // Defensive: a rule that fails to advance would spin forever.
    if (next <= cursor) throw new Error('Recurrence rule did not advance');
    cursor = next;

    guard += 1;
    if (guard > 100_000) throw new Error('Recurrence expansion ran away');
  }

  return out;
}

/**
 * A stable identifier for one occurrence ("2026-03-01"). Paired with a unique
 * index, this is what makes generation exactly-once: a second attempt at the
 * same cycle collides instead of charging everybody twice.
 */
export function cycleKey(date) {
  return startOfUTCDay(date).toISOString().slice(0, 10);
}

/**
 * Scale an amount to its per-month equivalent, exactly.
 *
 * A weekly ₹100 is ₹433.33/month (100 × 52 ÷ 12), not ₹400 — using "4 weeks in
 * a month" quietly loses a month's worth of money every year.
 *
 * @returns {number} integer minor units, rounded half-up
 */
export function toMonthlyCents(amountCents, { frequency, interval = 1 } = {}) {
  const [times, per] = PER_YEAR[frequency] ?? [];
  if (!times) throw new Error(`Unknown recurrence frequency "${frequency}"`);
  if (!Number.isInteger(interval) || interval < 1) {
    throw new Error('Recurrence interval must be a whole number of 1 or more');
  }
  // amount × (occurrences per year ÷ interval) ÷ 12 months
  const numerator = amountCents * times;
  const denominator = per * interval * 12;
  return Math.round(numerator / denominator);
}

/** Human summary of a schedule, e.g. "Monthly on the 1st". */
export function describeSchedule({ frequency, interval = 1, startDate }) {
  const every = interval === 1 ? FREQUENCY_LABELS[frequency] : `Every ${interval} × ${FREQUENCY_LABELS[frequency].toLowerCase()}`;
  if (!startDate) return every;

  const d = startOfUTCDay(startDate);
  if ([FREQUENCIES.MONTHLY, FREQUENCIES.QUARTERLY].includes(frequency)) {
    const day = d.getUTCDate();
    const suffix = day % 10 === 1 && day !== 11 ? 'st'
      : day % 10 === 2 && day !== 12 ? 'nd'
        : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
    return `${every} on the ${day}${suffix}`;
  }
  if ([FREQUENCIES.WEEKLY, FREQUENCIES.FORTNIGHTLY].includes(frequency)) {
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      d.getUTCDay()
    ];
    return `${every} on ${weekday}`;
  }
  return every;
}
