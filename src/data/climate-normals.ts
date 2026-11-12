import data from './generated/climate-normals.json';
import { blendMonthsInto, buildMonthGrids } from './climate-grid';

/** 1991-2020 monthly SST climatology (NOAA ERSST v5) on a global 5 degree grid; see scripts/prepare-climate.mjs. */
export const NORMALS_COLS: number = data.cols;
export const NORMALS_ROWS: number = data.rows;
export const NORMALS_STEP: number = data.step;

const sst: number[] = data.sst;
const MONTH_SIZE = NORMALS_COLS * NORMALS_ROWS;

/** Climatological SST in degrees C for month 0..11, column 0..71 (west to east from 180W) and row 0..35 (south to north); null over land or ice. */
export function normalSst(month: number, col: number, row: number): number | null {
  const v = sst[month * MONTH_SIZE + row * NORMALS_COLS + col];
  return v === data.missing ? null : v * data.scale;
}

// Equatorial (5S-5N) mean per month and column: the two rows centred at 2.5S and 2.5N, weighted by cos(latitude). NaN over land.
const EQ_SOUTH_ROW = NORMALS_ROWS / 2 - 1;
const EQ_WEIGHT = Math.cos((2.5 * Math.PI) / 180); // equal for both rows
const equator = new Float64Array(12 * NORMALS_COLS);
for (let m = 0; m < 12; m++) {
  for (let c = 0; c < NORMALS_COLS; c++) {
    const s = normalSst(m, c, EQ_SOUTH_ROW);
    const n = normalSst(m, c, EQ_SOUTH_ROW + 1);
    equator[m * NORMALS_COLS + c] = s === null || n === null ? NaN : (s * EQ_WEIGHT + n * EQ_WEIGHT) / (2 * EQ_WEIGHT);
  }
}

function equatorMonth(m: number, lonEast: number): number {
  const f = ((((lonEast - data.lonStart) % 360) + 360) % 360) / NORMALS_STEP;
  const c0 = Math.floor(f) % NORMALS_COLS;
  const c1 = (c0 + 1) % NORMALS_COLS;
  const t = f - Math.floor(f);
  const a = equator[m * NORMALS_COLS + c0];
  const b = equator[m * NORMALS_COLS + c1];
  // A zero-weight neighbour is not consulted, so a point exactly on a column centre next to land still works.
  if (t === 0) return a;
  return a * (1 - t) + b * t;
}

/** 5S-5N mean climatological SST in degrees C at a longitude in degrees east (0..360). `month` is 0..12 and may be fractional; it wraps cyclically. Throws over land. */
export function equatorNormalSst(month: number, lonEast: number): number {
  const mf = ((month % 12) + 12) % 12;
  const m0 = Math.floor(mf);
  const t = mf - m0;
  const a = equatorMonth(m0, lonEast);
  const v = t === 0 ? a : a * (1 - t) + equatorMonth((m0 + 1) % 12, lonEast) * t;
  if (Number.isNaN(v)) throw new Error(`equatorNormalSst: land at ${lonEast}E`);
  return v;
}

let sstMonths: Float32Array[] | undefined;

/**
 * Fills `out` (180 x 90 weather grid, degC) with the 1991-2020 SST normal for a day of the year (same interpolation as the air climatology).
 * NaN where all four surrounding boxes are land or ice: callers treat that as "no sea".
 */
export function sstClimatologyInto(dayOfYear: number, out: Float32Array | number[]): void {
  sstMonths ??= buildMonthGrids(data, i => (data.sst[i] === data.missing ? NaN : data.sst[i] * data.scale));
  blendMonthsInto(sstMonths, dayOfYear, out);
}
