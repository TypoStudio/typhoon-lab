import data from './generated/nino34-observed.json';

/** Observed monthly Nino 3.4 anomaly (NOAA ERSST v5, relative to 1991-2020), January 1950 onward; see scripts/prepare-climate.mjs. */
const FIRST_YEAR = Number(data.start.slice(0, 4));
const values: number[] = data.nino34;
export const OBSERVED_LAST_YEAR = FIRST_YEAR + Math.floor(values.length / 12) - 1;

/** The `months` monthly values from January of `year` (fewer when the record ends first; empty for a year outside it). */
export function observedNino34From(year: number, months: number): number[] {
  const start = (year - FIRST_YEAR) * 12;
  if (!Number.isInteger(start) || start < 0 || start >= values.length) return [];
  return values.slice(start, start + months);
}
