import type { HistoricEnvironment } from '../types';
import { BOUNDS, GRID_COLS, GRID_STEP } from './engine';
import { clamp, wrapLon } from './geo';

/** Window fields over the dataset's cells (row-major, row 0 southernmost); NaN = missing, keep the game's own value. */
export interface HistoricFields { t: Float64Array; air: Float64Array; h: Float64Array; p: Float64Array; u: Float64Array; v: Float64Array }

const DAY_MS = 86_400_000;
const MAX_CACHED = 8;

interface Cache { cells: Int32Array; day0: number; frames: Map<number, HistoricFields> }
const caches = new WeakMap<HistoricEnvironment, Cache>();

function cacheFor(data: HistoricEnvironment): Cache {
  let c = caches.get(data);
  if (!c) {
    const cols = data.lons.length;
    const cells = new Int32Array(cols * data.lats.length);
    data.lats.forEach((lat, r) => data.lons.forEach((lon, i) => {
      const gi = Math.floor((wrapLon(lon) - BOUNDS.west) / GRID_STEP);
      const gj = Math.floor((lat - BOUNDS.south) / GRID_STEP);
      cells[r * cols + i] = gj * GRID_COLS + gi;
    }));
    c = { cells, day0: Date.parse(`${data.days[0]}T00:00:00Z`), frames: new Map() };
    caches.set(data, c);
  }
  return c;
}

/** Game-grid cell index for each window cell (row-major), so callers can write straight into the grid. */
export function windowCells(data: HistoricEnvironment): Int32Array {
  return cacheFor(data).cells;
}

/** Linear blend of two day arrays; any missing end makes the cell missing. */
function blend(a: (number | null)[], b: (number | null)[], f: number, scale: number): Float64Array {
  const out = new Float64Array(a.length);
  for (let w = 0; w < a.length; w++) {
    const x = a[w];
    const y = b[w];
    out[w] = x === null || y === null ? NaN : (x + (y - x) * f) * scale;
  }
  return out;
}

/** Interpolated fields at `hours` after `startIso`. Daily means are taken as valid at 12:00 UTC of their day, so time is shifted half a day before blending, clamped to the dataset's days and cached per (day, 0.01 of a day). */
export function fieldsAt(data: HistoricEnvironment, hours: number, startIso: string): HistoricFields {
  const c = cacheFor(data);
  const last = data.days.length - 1;
  const pos = clamp((Date.parse(startIso) + hours * 3_600_000 - c.day0) / DAY_MS - 0.5, 0, last);
  const day = Math.min(Math.floor(pos), Math.max(0, last - 1));
  const frac = Math.round((pos - day) * 100);
  const key = day * 101 + frac;
  const hit = c.frames.get(key);
  if (hit) return hit;
  const d1 = Math.min(day + 1, last);
  const f = frac / 100;
  const { fields, scale } = data;
  const frame: HistoricFields = {
    t: blend(fields.sst[day], fields.sst[d1], f, scale.sst),
    air: blend(fields.air[day], fields.air[d1], f, scale.air),
    h: blend(fields.rhum[day], fields.rhum[d1], f, scale.rhum / 100),
    p: blend(fields.slp[day], fields.slp[d1], f, scale.slp),
    u: blend(fields.u[day], fields.u[d1], f, scale.u),
    v: blend(fields.v[day], fields.v[d1], f, scale.v),
  };
  if (c.frames.size >= MAX_CACHED) c.frames.delete(c.frames.keys().next().value!);
  c.frames.set(key, frame);
  return frame;
}

export interface HistoricSample { t: number; air: number; h: number; p: number; u: number; v: number }

/** Bilinear sample between cell centres; null outside the window (half a cell beyond the outer centres counts as inside). Missing corners are skipped per field (NaN if all are missing). */
export function sampleHistoric(data: HistoricEnvironment, hours: number, startIso: string, lon: number, lat: number): HistoricSample | null {
  const cols = data.lons.length;
  const rows = data.lats.length;
  let fx = (((wrapLon(lon) - data.lons[0]) % 360) + 360) % 360 / GRID_STEP;
  if (fx >= GRID_COLS - 0.5) fx -= GRID_COLS; // window west of its first centre wraps round
  const fy = (lat - data.lats[0]) / GRID_STEP;
  if (fx < -0.5 || fx > cols - 0.5 || fy < -0.5 || fy > rows - 0.5) return null;
  const x = clamp(fx, 0, cols - 1);
  const y = clamp(fy, 0, rows - 1);
  const i0 = Math.min(Math.floor(x), Math.max(0, cols - 2));
  const j0 = Math.min(Math.floor(y), Math.max(0, rows - 2));
  const i1 = Math.min(i0 + 1, cols - 1);
  const j1 = Math.min(j0 + 1, rows - 1);
  const tx = x - i0;
  const ty = y - j0;
  const corners = [
    { w: (1 - tx) * (1 - ty), n: j0 * cols + i0 }, { w: tx * (1 - ty), n: j0 * cols + i1 },
    { w: (1 - tx) * ty, n: j1 * cols + i0 }, { w: tx * ty, n: j1 * cols + i1 },
  ];
  const f = fieldsAt(data, hours, startIso);
  const mix = (a: Float64Array): number => {
    let sum = 0;
    let weight = 0;
    for (const { w, n } of corners) if (w > 0 && !Number.isNaN(a[n])) { sum += w * a[n]; weight += w; }
    return weight > 0 ? sum / weight : NaN;
  };
  return { t: mix(f.t), air: mix(f.air), h: mix(f.h), p: mix(f.p), u: mix(f.u), v: mix(f.v) };
}
