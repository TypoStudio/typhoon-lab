import type { HistoricEnvironment } from '../types';
import { typhoonById } from '../data/typhoons';
import { BOUNDS, GRID_COLS, GRID_STEP, trackAt } from './engine';
import { clamp, offsetKm, wrapLon } from './geo';

/** Window fields over the dataset's cells (row-major, row 0 southernmost); NaN = missing, keep the game's own value. */
export interface HistoricFields { t: Float64Array; air: Float64Array; h: Float64Array; p: Float64Array; u: Float64Array; v: Float64Array }

const DAY_MS = 86_400_000;
const MAX_CACHED = 8;

interface Cache { cells: Int32Array; weights: Float64Array; day0: number; frames: Map<number, HistoricFields> }
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
    const weights = new Float64Array(cells.length);
    data.lats.forEach((lat, r) => data.lons.forEach((lon, i) => { weights[r * cols + i] = windowWeight(data, lon, lat); }));
    c = { cells, weights, day0: Date.parse(`${data.days[0]}T00:00:00Z`), frames: new Map() };
    caches.set(data, c);
  }
  return c;
}

/** Width (degrees) of the band inside the window's edge over which the recorded fields fade into the game's own. */
export const HISTORIC_BLEND_DEG = 10;

/** Window position of a point in cell units (x along longitude across the dateline, y along latitude), or null when it is beyond the window's outer half cell. */
function windowPosition(data: HistoricEnvironment, lon: number, lat: number): { fx: number; fy: number } | null {
  const cols = data.lons.length;
  const rows = data.lats.length;
  let fx = (((wrapLon(lon) - data.lons[0]) % 360) + 360) % 360 / GRID_STEP;
  if (fx >= GRID_COLS - 0.5) fx -= GRID_COLS; // window west of its first centre wraps round
  const fy = (lat - data.lats[0]) / GRID_STEP;
  return fx < -0.5 || fx > cols - 0.5 || fy < -0.5 || fy > rows - 0.5 ? null : { fx, fy };
}

/** How much of the recorded environment applies at a point: 1 well inside the window, falling by smoothstep to 0 at its edge over HISTORIC_BLEND_DEG (less for a window too small to hold the whole band), 0 outside. */
export function windowWeight(data: HistoricEnvironment, lon: number, lat: number): number {
  const pos = windowPosition(data, lon, lat);
  return pos ? weightAt(data, pos.fx, pos.fy) : 0;
}

function weightAt(data: HistoricEnvironment, fx: number, fy: number): number {
  const cols = data.lons.length;
  const rows = data.lats.length;
  const inside = Math.min(fx + 0.5, cols - 0.5 - fx, fy + 0.5, rows - 0.5 - fy) * GRID_STEP; // degrees to the nearest edge
  const band = Math.min(HISTORIC_BLEND_DEG, (Math.min(cols, rows) * GRID_STEP) / 2);
  const x = clamp(inside / band, 0, 1);
  return x * x * (3 - 2 * x);
}

/** Recorded-environment weight (see windowWeight) of each window cell, row-major, parallel to windowCells. */
export function windowWeights(data: HistoricEnvironment): Float64Array {
  return cacheFor(data).weights;
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

/** Vortex relocation: within RELOCATE_FULL_KM of the best-track position the reanalysis keeps none of its own vortex, and the replacement fades out by RELOCATE_EDGE_KM. */
export const RELOCATE_FULL_KM = 400;
export const RELOCATE_EDGE_KM = 700;
/** Cells between RELOCATE_EDGE_KM and this distance give the environmental background; with fewer than RELOCATE_MIN_CELLS of them the field is left alone. */
const RELOCATE_ANNULUS_KM = 1100;
const RELOCATE_MIN_CELLS = 8;

/** Least-squares plane a + b·x + c·y through the points (x, y in 1000 km); null when degenerate. */
function fitPlane(pts: number[][]): ((x: number, y: number) => number) | null {
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (const [x, y, z] of pts) { n++; sx += x; sy += y; sz += z; sxx += x * x; sxy += x * y; syy += y * y; sxz += x * z; syz += y * z; }
  const det = n * (sxx * syy - sxy * sxy) - sx * (sx * syy - sxy * sy) + sy * (sx * sxy - sxx * sy);
  if (Math.abs(det) < 1e-9) return null;
  const solve = (r0: number, r1: number, r2: number, col: 0 | 1 | 2): number => {
    const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]];
    const b = [r0, r1, r2];
    for (let k = 0; k < 3; k++) m[k][col] = b[k];
    return (m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])) / det;
  };
  const a = solve(sz, sxz, syz, 0), bx = solve(sz, sxz, syz, 1), by = solve(sz, sxz, syz, 2);
  return (x, y) => a + bx * x + by * y;
}

/**
 * Replaces the reanalysis's own (coarse, often misplaced) vortex around the typhoon's best-track position, for sea-level pressure and wind: inside the
 * relocation radius each field takes the plane fitted to the cells of the surrounding annulus, so the large-scale environment stays recorded and the
 * game's own storm profile, added at the recorded position, is the only vortex there. `hours` is after the typhoon's first point.
 */
function relocateVortex(data: HistoricEnvironment, frame: HistoricFields, hours: number): void {
  const typhoon = typhoonById(data.typhoonId);
  const at = typhoon && trackAt(typhoon, hours);
  if (!at) return;
  const cols = data.lons.length;
  const near: { k: number; w: number }[] = [];
  const ring: { x: number; y: number; k: number }[] = [];
  data.lats.forEach((lat, r) => data.lons.forEach((lon, i) => {
    const { dx, dy } = offsetKm(at.lon, at.lat, lon, lat);
    const d = Math.hypot(dx, dy);
    const k = r * cols + i;
    if (d < RELOCATE_EDGE_KM) { const x = clamp((d - RELOCATE_FULL_KM) / (RELOCATE_EDGE_KM - RELOCATE_FULL_KM), 0, 1); near.push({ k, w: 1 - x * x * (3 - 2 * x) }); }
    else if (d <= RELOCATE_ANNULUS_KM) ring.push({ x: dx / 1000, y: dy / 1000, k });
  }));
  if (near.length === 0) return;
  for (const field of [frame.p, frame.u, frame.v]) {
    const pts = ring.filter(c => !Number.isNaN(field[c.k])).map(c => [c.x, c.y, field[c.k]]);
    if (pts.length < RELOCATE_MIN_CELLS) continue;
    const plane = fitPlane(pts);
    if (!plane) continue;
    for (const { k, w } of near) {
      if (Number.isNaN(field[k])) continue;
      const { dx, dy } = offsetKm(at.lon, at.lat, data.lons[k % cols], data.lats[Math.floor(k / cols)]);
      field[k] += w * (plane(dx / 1000, dy / 1000) - field[k]);
    }
  }
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
  relocateVortex(data, frame, (c.day0 + (day + f + 0.5) * DAY_MS - Date.parse(startIso)) / 3_600_000);
  if (c.frames.size >= MAX_CACHED) c.frames.delete(c.frames.keys().next().value!);
  c.frames.set(key, frame);
  return frame;
}

export interface HistoricSample { w: number; t: number; air: number; h: number; p: number; u: number; v: number }

/** Bilinear sample between cell centres, with the recorded-environment weight `w`; null outside the window (half a cell beyond the outer centres counts as inside) or where that weight is 0. Missing corners are skipped per field (NaN if all are missing). */
export function sampleHistoric(data: HistoricEnvironment, hours: number, startIso: string, lon: number, lat: number): HistoricSample | null {
  const cols = data.lons.length;
  const rows = data.lats.length;
  const pos = windowPosition(data, lon, lat);
  if (!pos) return null;
  const { fx, fy } = pos;
  const w = weightAt(data, fx, fy);
  if (w <= 0) return null;
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
  return { w, t: mix(f.t), air: mix(f.air), h: mix(f.h), p: mix(f.p), u: mix(f.u), v: mix(f.v) };
}
