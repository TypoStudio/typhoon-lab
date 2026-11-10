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

/** Local calendar date and time, packed into the model's fractional day-of-year start value. */
export function realTimeOfYear(now: Date = new Date()): number {
  return dayOfYearFor(now.getMonth(), now.getDate())
    + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) / 86_400;
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

/** A scenario news date (`year * 400 + day of the year`, see climate-events.ts) as `Sep 15, 1997`, in the browser's wording for the language. */
export function fmtSerialDate(serial: number, language: string): string {
  const year = Math.floor(serial / 400), { month, day } = monthDayOf(serial - year * 400);
  const date = new Date(Date.UTC(2000, month, day));
  date.setUTCFullYear(year);
  try { return new Intl.DateTimeFormat(language, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date); }
  catch { return `${MONTH_ABBR[month]} ${day}, ${year}`; }
}

/** `Oct 26` */
export function fmtMonthDay(doy: number): string {
  const { month, day } = monthDayOf(doy);
  return `${MONTH_ABBR[month]} ${day}`;
}

/** The world's date as a day of the year at a model hour: start day, hours, and the days climate time has added to the calendar. */
export function worldDay(state: { startDayOfYear: number; calendarOffsetDays?: number }, hours: number): number {
  return state.startDayOfYear + hours / 24 + (state.calendarOffsetDays ?? 0);
}

interface DateState { startDayOfYear: number; initialStartDayOfYear?: number; calendarOffsetDays?: number; climateTime?: { active: boolean } | null; initialWeather?: { modelRun: string }; climateScenario?: { year: number; yearStartDay: number } }

/** Model days since the world began: model hours plus the days the fast climate path has added. */
const elapsedDays = (state: DateState, hours: number): number => hours / 24 + (state.calendarOffsetDays ?? 0);

/** The calendar year is shown once a year of model time has passed, and always on the fast climate path where the date moves too quickly for a day to mean anything, and after a climate scenario has set it. */
export function showsYear(state: DateState, hours: number): boolean {
  return !!state.climateTime?.active || !!state.climateScenario || elapsedDays(state, hours) >= 365;
}

/** Calendar year of the world's date: the year of the starting analysis (or this year, for a plain start) plus the 365-day years that have passed since. The real clock is read here, never in the engine. */
export function worldYear(state: DateState, hours: number, now: Date = new Date()): number {
  // A climate scenario names its own year: counted from the 1 January it started on, in the clock's own day count.
  if (state.climateScenario) return state.climateScenario.year + Math.floor((Math.floor(worldDay(state, hours)) - state.climateScenario.yearStartDay) / 365);
  const analysis = state.initialWeather ? new Date(state.initialWeather.modelRun).getUTCFullYear() : NaN;
  const base = Number.isFinite(analysis) ? analysis : now.getUTCFullYear();
  return base + Math.floor((Math.floor((state.initialStartDayOfYear ?? state.startDayOfYear) + elapsedDays(state, hours)) - 1) / 365);
}

/** `March 2031` (`2031년 3월` in Korean, ...) or with the day, `Mar 26, 2031`: the browser's own wording for the language. */
export function fmtDateWithYear(state: DateState, hours: number, language: string, withDay: boolean): string {
  const { month, day } = monthDayOf(worldDay(state, hours));
  const date = new Date(Date.UTC(2000, month, day));
  date.setUTCFullYear(worldYear(state, hours));
  try {
    return new Intl.DateTimeFormat(language, withDay ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' } : { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
  } catch {
    return `${MONTH_ABBR[month]} ${withDay ? `${day}, ` : ''}${date.getUTCFullYear()}`;
  }
}
