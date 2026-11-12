import data from './generated/climate-air.json';
import { blendMonthsInto, buildMonthGrids } from './climate-grid';

/** 1991-2020 monthly near-surface air temperature climatology (NCEP/NCAR Reanalysis 1) on a global 5 degree grid; see scripts/prepare-teleconnections.mjs. */
let months: Float32Array[] | undefined;

/** Month 0 is stored in full and every later month as the change from the month before: undo the running sum once. */
function decode(): Float32Array[] {
  const n = data.cols * data.rows, absolute = new Int16Array(12 * n);
  for (let i = 0; i < 12 * n; i++) absolute[i] = data.air[i] + (i < n ? 0 : absolute[i - n]);
  return buildMonthGrids(data, i => absolute[i] * data.scale);
}

/**
 * Fills `out` (180 x 90 weather grid, degC) with the near-surface air temperature climatology for a day of the year (1 = Jan 1, fractional,
 * wraps over the 365.25-day year), interpolated linearly between month centres and cyclically from December to January. No allocation after the first call.
 */
export function airClimatologyInto(dayOfYear: number, out: Float32Array | number[]): void {
  months ??= decode();
  blendMonthsInto(months, dayOfYear, out);
}
