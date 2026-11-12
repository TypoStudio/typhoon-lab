/** Layout of a 5 degree climatology grid: row 0 at `latStart`, column 0 at `lonStart` (cell centres), 12 months stored one after another. */
export interface ClimatologyLayout { cols: number; rows: number; step: number; lonStart: number; latStart: number }

/** Grid of the live weather (2 degrees, row 0 at 89S, column 0 at 179W), the same layout as `LIVE_WEATHER_COLS` x `LIVE_WEATHER_ROWS`. */
export const WEATHER_COLS = 180;
export const WEATHER_ROWS = 90;
export const WEATHER_SIZE = WEATHER_COLS * WEATHER_ROWS;

/**
 * Month grids on the weather grid, built once: bilinear in longitude (wrapping) and latitude (clamped at the outermost box centres).
 * `value(i)` is the physical value of stored index i; a NaN neighbour is left out and the others re-weighted, NaN only when all four are NaN.
 */
export function buildMonthGrids(layout: ClimatologyLayout, value: (index: number) => number): Float32Array[] {
  const { cols, rows, step } = layout;
  const colAt = new Int32Array(WEATHER_COLS * 2), colT = new Float64Array(WEATHER_COLS);
  for (let c = 0; c < WEATHER_COLS; c++) {
    const f = (((-179 + c * 2 - layout.lonStart) / step) % cols + cols) % cols;
    colAt[2 * c] = Math.floor(f) % cols; colAt[2 * c + 1] = (Math.floor(f) + 1) % cols; colT[c] = f - Math.floor(f);
  }
  const months: Float32Array[] = [];
  for (let m = 0; m < 12; m++) {
    const grid = new Float32Array(WEATHER_SIZE), base = m * cols * rows;
    for (let r = 0; r < WEATHER_ROWS; r++) {
      const f = Math.max(0, Math.min(rows - 1, (-89 + r * 2 - layout.latStart) / step));
      const r0 = Math.min(rows - 2, Math.floor(f)), ty = f - r0;
      for (let c = 0; c < WEATHER_COLS; c++) {
        const tx = colT[c], c0 = colAt[2 * c], c1 = colAt[2 * c + 1];
        const v00 = value(base + r0 * cols + c0), v10 = value(base + r0 * cols + c1);
        const v01 = value(base + (r0 + 1) * cols + c0), v11 = value(base + (r0 + 1) * cols + c1);
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        let sum = 0, weight = 0;
        if (v00 === v00) { sum += v00 * w00; weight += w00; }
        if (v10 === v10) { sum += v10 * w10; weight += w10; }
        if (v01 === v01) { sum += v01 * w01; weight += w01; }
        if (v11 === v11) { sum += v11 * w11; weight += w11; }
        grid[r * WEATHER_COLS + c] = weight > 0 ? sum / weight : NaN;
      }
    }
    months.push(grid);
  }
  return months;
}

/** Fills `out` with the climatology for a day of the year (1 = Jan 1, fractional, wraps over the 365.25-day year): linear between month centres, cyclic from December to January. */
export function blendMonthsInto(months: Float32Array[], dayOfYear: number, out: Float32Array | number[]): void {
  const p = ((((dayOfYear - 1) / 365.25) * 12 - 0.5) % 12 + 12) % 12; // month centres at integers
  const m0 = Math.floor(p) % 12, m1 = (m0 + 1) % 12, f = p - Math.floor(p);
  const a = months[m0], b = months[m1], g = 1 - f;
  for (let i = 0; i < WEATHER_SIZE; i++) out[i] = a[i] * g + b[i] * f;
}
