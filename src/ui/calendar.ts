/** UI-side calendar helpers. The simulation only knows a day-of-year number (1 = Jan 1); the real clock is read here, never in the engine. */
export const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Day of the year (1 = Jan 1, 365 = Dec 31) of a month (0-11) and day, in a 365-day year; Feb 29 counts as Feb 28. */
export function dayOfYearFor(month: number, day: number): number {
  return MONTH_DAYS.slice(0, month).reduce((a, b) => a + b, 0) + Math.min(day, MONTH_DAYS[month]);
}

/** Month (0-11) and day of month for a day of the year; any real number is wrapped into the 365-day year. */
export function monthDayOf(doy: number): { month: number; day: number } {
  let left = ((Math.floor(doy) - 1) % 365 + 365) % 365;
  for (let month = 0; month < 12; month++) {
    if (left < MONTH_DAYS[month]) return { month, day: left + 1 };
    left -= MONTH_DAYS[month];
  }
  return { month: 11, day: 31 };
}

/** Today's date as a day of the year, from the real clock (UTC). Only the UI calls this. */
export function realDayOfYear(now: Date = new Date()): number {
  return dayOfYearFor(now.getUTCMonth(), now.getUTCDate());
}

/** `?start=YYYY-MM-DD` or `?doy=NNN` from a query string (to pin the calendar in tests); null when absent or invalid. */
export function parseStartParam(search: string): number | null {
  const params = new URLSearchParams(search);
  const start = params.get('start');
  if (start !== null) {
    const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(start);
    if (!m) return null;
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    return month >= 0 && month < 12 && day >= 1 && day <= MONTH_DAYS[month] + (month === 1 ? 1 : 0) ? dayOfYearFor(month, day) : null;
  }
  const doy = params.get('doy');
  if (doy !== null && /^\d+$/.test(doy)) {
    const n = Number(doy);
    return n >= 1 && n <= 366 ? Math.min(n, 365) : null;
  }
  return null;
}

/** The season buttons: northern-hemisphere names, each set to the middle of its season (the south is opposite). */
export const SEASONS = [
  { id: 'spring', label: 'Spring', doy: dayOfYearFor(3, 15) },
  { id: 'summer', label: 'Summer', doy: dayOfYearFor(6, 15) },
  { id: 'autumn', label: 'Autumn', doy: dayOfYearFor(9, 15) },
  { id: 'winter', label: 'Winter', doy: dayOfYearFor(0, 15) },
] as const;
export type SeasonId = (typeof SEASONS)[number]['id'];

/** Northern-hemisphere meteorological season of a day of the year (Mar-May spring, Jun-Aug summer, Sep-Nov autumn, Dec-Feb winter). */
export function seasonIdOf(doy: number): SeasonId {
  const { month } = monthDayOf(doy);
  return month >= 2 && month <= 4 ? 'spring' : month >= 5 && month <= 7 ? 'summer' : month >= 8 && month <= 10 ? 'autumn' : 'winter';
}

/** `Oct 26` */
export function fmtMonthDay(doy: number): string {
  const { month, day } = monthDayOf(doy);
  return `${MONTH_ABBR[month]} ${day}`;
}
