import data from './generated/climate-teleconnections.json';

/** ENSO teleconnection regression maps (NCEP/NCAR Reanalysis 1 on Nino-3.4); see scripts/prepare-teleconnections.mjs. */
export const TELE_COLS: number = data.cols;
export const TELE_ROWS: number = data.rows;

const SIZE = TELE_COLS * TELE_ROWS;
const slp: number[] = data.slp;
const air: number[] = data.air;
const rhum: number[] = data.rhum;
const shear: number[] = data.shear;
const SLP_SCALE = data.scale;
const AIR_SCALE = data.scale;
const RHUM_SCALE = data.scale / 100; // percent -> fraction

// Season centres are mid-Jan, mid-Apr, mid-Jul, mid-Oct (months 0.5, 3.5, 6.5, 9.5 of 12); season 0 = DJF.
/**
 * Fills 72x36 arrays (index row*72+col, south to north from 180W) with the per-1 degC Nino-3.4 slope of sea-level pressure (hPa),
 * near-surface air temperature (degC) and relative humidity (fraction) and, if given, 200-850 hPa wind shear magnitude (m/s), interpolated linearly in time between season centres. No allocation.
 */
export function teleconnectionInto(month: number, out: { slp: Float32Array; air: Float32Array; rhum: Float32Array; shear?: Float32Array }): void {
  const p = ((((month - 0.5) % 12) + 12) % 12) / 3; // 0..4, season centres at integers
  const s0 = Math.floor(p) % 4;
  const s1 = (s0 + 1) % 4;
  const f = p - Math.floor(p);
  const g = 1 - f;
  const o0 = s0 * SIZE;
  const o1 = s1 * SIZE;
  const outShear = out.shear;
  for (let i = 0; i < SIZE; i++) {
    out.slp[i] = (slp[o0 + i] * g + slp[o1 + i] * f) * SLP_SCALE;
    out.air[i] = (air[o0 + i] * g + air[o1 + i] * f) * AIR_SCALE;
    out.rhum[i] = (rhum[o0 + i] * g + rhum[o1 + i] * f) * RHUM_SCALE;
    if (outShear) outShear[i] = (shear[o0 + i] * g + shear[o1 + i] * f) * AIR_SCALE;
  }
}
