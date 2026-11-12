import data from './generated/climate-slp.json';
import { blendMonthsInto, buildMonthGrids } from './climate-grid';

/** 1991-2020 monthly sea-level-pressure climatology (NCEP/NCAR Reanalysis 1) on a global 5 degree grid; see scripts/prepare-teleconnections.mjs. */
const stored: number[] = data.slp;
let months: Float32Array[] | undefined;

/**
 * Fills `out` (180 x 90 weather grid, hPa) with the sea-level-pressure climatology for a day of the year (1 = Jan 1, fractional, wraps
 * over the 365.25-day year), interpolated linearly between month centres and cyclically from December to January. No allocation after the first call.
 */
export function slpClimatologyInto(dayOfYear: number, out: Float32Array | number[]): void {
  months ??= buildMonthGrids(data, i => stored[i] * data.scale + data.offset);
  blendMonthsInto(months, dayOfYear, out);
}
