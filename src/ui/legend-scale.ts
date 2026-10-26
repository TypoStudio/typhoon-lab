/** Where a value falls along a legend colour bar. Pure so it can be unit tested. */

export interface ScaleTick { label: string; pos: number }

/** Reads a tick label such as "0", "40+", "30k" or "15M" as a number; NaN if it is not one. */
export function tickValue(label: string): number {
  const match = /^(\d+(?:\.\d+)?)([kM]?)\+?$/.exec(label);
  return match ? Number(match[1]) * (match[2] === 'k' ? 1e3 : match[2] === 'M' ? 1e6 : 1) : NaN;
}

/**
 * Bar position (0..1) of `value`, interpolated between the labelled ticks (on log10 when `log`).
 * Null when the value is below the first tick (or not a number); above the last tick it stays at the last tick.
 */
export function tickPosition(ticks: readonly ScaleTick[], value: number, log = false): number | null {
  const values = ticks.map(t => tickValue(t.label));
  if (!ticks.length || values.some(Number.isNaN) || Number.isNaN(value) || (log && value <= 0)) return null;
  const scale = (n: number): number => (log ? Math.log10(n) : n);
  const v = scale(value);
  if (v < scale(values[0])) return null;
  for (let i = 1; i < ticks.length; i++) {
    const lo = scale(values[i - 1]);
    const hi = scale(values[i]);
    if (v <= hi) return ticks[i - 1].pos + (ticks[i].pos - ticks[i - 1].pos) * ((v - lo) / (hi - lo));
  }
  return ticks[ticks.length - 1].pos;
}
