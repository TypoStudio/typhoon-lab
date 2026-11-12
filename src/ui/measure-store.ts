/**
 * Time series behind the Measure tab. Pure data, no DOM: every sample is (model days, value).
 * Read-only with respect to the simulation: nothing here is written to actions or replays.
 */

/** Points kept per line before older points are merged in pairs. */
export const MAX_POINTS = 720;
/** Shortest model time between two samples of a line (30 model minutes), so a fast speed does not over-sample. */
export const MIN_SPACING_DAYS = 1 / 48;
export const DAYS_PER_YEAR = 365;
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

export interface Series {
  /** Model days since the world began (hours / 24 plus the days the fast climate path added). */
  t: number[];
  v: number[];
  /** Current minimum spacing; doubles every time the line is merged. */
  stride: number;
}

export const createSeries = (): Series => ({ t: [], v: [], stride: MIN_SPACING_DAYS });

const mean = (a: number, b: number): number => (Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2);

/** True when a sample at `t` is due: at least the line's spacing after the last one (a hair of slack for float error). */
export const isDue = (s: Series, t: number): boolean => !s.t.length || t - s.t[s.t.length - 1] >= s.stride - 1e-9;

/** Merges neighbouring points in pairs (times and values averaged, gaps ignored) and doubles the spacing. The first point keeps the run's true start. */
export function halve(s: Series): void {
  const t: number[] = [], v: number[] = [];
  for (let i = 0; i + 1 < s.t.length; i += 2) {
    t.push(i === 0 ? s.t[0] : (s.t[i] + s.t[i + 1]) / 2);
    v.push(mean(s.v[i], s.v[i + 1]));
  }
  if (s.t.length % 2) { t.push(s.t[s.t.length - 1]); v.push(s.v[s.v.length - 1]); }
  s.t = t; s.v = v; s.stride *= 2;
}

/**
 * Adds a sample unless it is closer than the line's spacing to the last one (or older than it: time only moves forward).
 * Returns whether the line changed. A jump ahead in time is just a long step; the line stays monotonic.
 */
export function addSample(s: Series, t: number, value: number, cap = MAX_POINTS): boolean {
  if (!Number.isFinite(t)) return false;
  const n = s.t.length;
  if (n && !isDue(s, t)) return false;
  s.t.push(t);
  s.v.push(Number.isFinite(value) ? value : NaN);
  if (s.t.length > cap) halve(s);
  return true;
}

/** Index of the point nearest to `t` (the series must not be empty). */
export function nearestIndex(s: Series, t: number): number {
  let lo = 0, hi = s.t.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s.t[mid] <= t) lo = mid; else hi = mid;
  }
  return Math.abs(s.t[lo] - t) <= Math.abs(s.t[hi] - t) ? lo : hi;
}

export function lastValue(s: Series | undefined): number {
  if (!s) return NaN;
  for (let i = s.v.length - 1; i >= 0; i--) if (!Number.isNaN(s.v[i])) return s.v[i];
  return NaN;
}

// ---- Time axis ----------------------------------------------------------------------------------

export type AxisUnit = 'h' | 'd' | 'mo' | 'y';
/** One axis mark: `frac` is its place along the span (0 to 1), `value` the elapsed time in `unit`, rounded to one decimal. */
export interface AxisTick { frac: number; value: number; unit: AxisUnit }

const UNIT_DAYS: Record<AxisUnit, number> = { h: 1 / 24, d: 1, mo: DAYS_PER_MONTH, y: DAYS_PER_YEAR };

/** One unit for the whole axis, chosen by the elapsed span: hours up to 2 days, days up to 60, months up to 2 years, then years. */
export function axisUnit(spanDays: number): AxisUnit {
  return spanDays <= 2 ? 'h' : spanDays <= 60 ? 'd' : spanDays <= 2 * DAYS_PER_YEAR ? 'mo' : 'y';
}

/** Elapsed time rounded to one decimal, with no trailing ".0". */
export const trimNumber = (v: number): string => String(Math.round(v * 10) / 10);

/** Exactly `count` evenly spaced marks from 0 to `spanDays` of elapsed time, all in the same unit. */
export function elapsedTicks(spanDays: number, count = 5): AxisTick[] {
  const unit = axisUnit(spanDays);
  return Array.from({ length: count }, (_, k) => {
    const frac = k / (count - 1);
    return { frac, value: Math.round((spanDays * frac) / UNIT_DAYS[unit] * 10) / 10, unit };
  });
}

/** The least a y axis may span, so an ordinary wiggle is not drawn as a cliff. */
export interface MinSpan {
  /** Smallest span, in the plot's unit. */
  min: number;
  /** Pad symmetrically about this value (0 for anomalies and indices) instead of about the data. */
  center?: number;
  /** The quantity cannot go below this (0 for rates and concentrations): a short range starts here. */
  floor?: number;
  /** The quantity cannot go above this (100 for humidity): a padded range slides down to stay inside. */
  ceil?: number;
}

/** Widens [lo, hi] to at least `span.min`: centred on the data, symmetric about `center`, or starting at `floor`. A wider range is returned unchanged. */
export function padSpan(lo: number, hi: number, span: MinSpan | undefined): [number, number] {
  if (!span || !Number.isFinite(lo) || !Number.isFinite(hi)) return [lo, hi];
  if (span.center !== undefined) {
    const half = Math.max(span.min / 2, Math.abs(lo - span.center), Math.abs(hi - span.center));
    return [span.center - half, span.center + half];
  }
  if (hi - lo >= span.min) return [lo, hi];
  if (span.floor !== undefined && lo - (span.min - (hi - lo)) / 2 < span.floor) { lo = span.floor; return [lo, Math.max(hi, lo + span.min)]; }
  const mid = (lo + hi) / 2;
  lo = mid - span.min / 2; hi = mid + span.min / 2;
  if (span.ceil !== undefined && hi > span.ceil) { lo -= hi - span.ceil; hi = span.ceil; }
  return [lo, hi];
}

/** Y axis: a rounded range containing [lo, hi] and about `count` tick values. */
export function niceRange(lo: number, hi: number, count = 4): { min: number; max: number; ticks: number[] } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { min: 0, max: 1, ticks: [0, 1] };
  if (hi - lo < 1e-9) { const pad = Math.max(Math.abs(lo) * 0.05, 0.5); lo -= pad; hi += pad; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find(m => m * mag >= raw) ?? 10) * mag;
  const min = Math.floor(lo / step + 1e-9) * step, max = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { min, max, ticks };
}
