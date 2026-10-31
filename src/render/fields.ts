import type { EnvironmentCell, Layer, MapOverlays } from '../types';
import { BOUNDS, GRID_COLS, GRID_ROWS, GRID_STEP } from '../simulation/engine';
import { smoothstep } from '../simulation/geo';
import { hexAlpha } from './hexes';
import type { Theme } from './theme';

/** Typed copy of state.grid (regular 2° cell centres, row-major from the south-west). */
export interface FieldData {
  cols: number; rows: number;
  u: Float32Array; v: Float32Array; speed: Float32Array;
  pressure: Float32Array; temperature: Float32Array; airTemperature: Float32Array; updraft: Float32Array; humidity: Float32Array; rain: Float32Array; snow: Float32Array; snowCm: Float32Array; population: Float32Array;
  land: Uint8Array; blizzard: Uint8Array;
  /** blizzard as 0/1 floats, so particles can sample it bilinearly. */
  blizzardF: Float32Array;
  maxSpeed: number;
  /** Resolves cyclone cores below the grid spacing, using the same snapshot as their icons. */
  windAt?: (lon: number, lat: number, out: Float64Array) => void;
  /** Effective distance to the nearest cyclone centre, for display-only angular speed limits. */
  windAnimationRadiusKm?: (lon: number, lat: number) => number;
  /** Display visibility inside a mature cyclone's calm eye (0) and at its eyewall (1). */
  windVisibilityAt?: (lon: number, lat: number) => number;
}

export function buildFieldData(grid: EnvironmentCell[]): FieldData | null {
  const n = GRID_COLS * GRID_ROWS;
  if (!Array.isArray(grid) || grid.length !== n) return null;
  const f: FieldData = {
    cols: GRID_COLS, rows: GRID_ROWS,
    u: new Float32Array(n), v: new Float32Array(n), speed: new Float32Array(n),
    pressure: new Float32Array(n), temperature: new Float32Array(n), airTemperature: new Float32Array(n), updraft: new Float32Array(n), humidity: new Float32Array(n), rain: new Float32Array(n), snow: new Float32Array(n), snowCm: new Float32Array(n), population: new Float32Array(n),
    land: new Uint8Array(n), blizzard: new Uint8Array(n), blizzardF: new Float32Array(n), maxSpeed: 0,
  };
  for (let k = 0; k < n; k++) {
    const c = grid[k];
    f.u[k] = c.u;
    f.v[k] = c.v;
    const s = Math.hypot(c.u, c.v);
    f.speed[k] = s;
    if (s > f.maxSpeed) f.maxSpeed = s;
    f.pressure[k] = c.pressure;
    f.temperature[k] = c.temperature;
    f.airTemperature[k] = c.airTemperature;
    f.updraft[k] = c.updraft;
    f.humidity[k] = c.humidity;
    f.rain[k] = c.rain;
    f.snow[k] = c.snow;
    f.snowCm[k] = c.snowCm;
    f.blizzard[k] = c.blizzard ? 1 : 0;
    f.blizzardF[k] = f.blizzard[k];
    f.population[k] = c.population;
    f.land[k] = c.land ? 1 : 0;
  }
  return f;
}

/** Bilinear sample of a cell-centred array at (lon, lat); wraps across the dateline, clamps at the poles. */
export function sampleGrid(f: FieldData, arr: Float32Array, lon: number, lat: number): number {
  let gx = (lon - BOUNDS.west) / GRID_STEP - 0.5;
  gx = ((gx % f.cols) + f.cols) % f.cols;
  let gy = (lat - BOUNDS.south) / GRID_STEP - 0.5;
  gy = gy < 0 ? 0 : gy > f.rows - 1 ? f.rows - 1 : gy;
  const i = Math.floor(gx);
  const i2 = i + 1 >= f.cols ? 0 : i + 1;
  const j = Math.min(f.rows - 2, Math.floor(gy));
  const tx = gx - i;
  const ty = gy - j;
  const r0 = j * f.cols;
  const r1 = r0 + f.cols;
  const a = arr[r0 + i] + (arr[r0 + i2] - arr[r0 + i]) * tx;
  const b = arr[r1 + i] + (arr[r1 + i2] - arr[r1 + i]) * tx;
  return a + (b - a) * ty;
}

/** Shared by particle movement, streak direction, lifetime and map inspection. */
export function sampleWind(f: FieldData, lon: number, lat: number, out: Float64Array): void {
  if (f.windAt) { f.windAt(lon, lat, out); return; }
  out[0] = sampleGrid(f, f.u, lon, lat);
  out[1] = sampleGrid(f, f.v, lon, lat);
}

/** Monotone cubic interpolation: smooth slopes without ringing or negative rainfall. */
function monotoneCubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const slope = (a: number, b: number) => a * b <= 0 ? 0 : 2 * a * b / (a + b);
  const d = p2 - p1, m1 = slope(p1 - p0, d), m2 = slope(d, p3 - p2);
  const t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p1 + (t3 - 2 * t2 + t) * m1
    + (-2 * t3 + 3 * t2) * p2 + (t3 - t2) * m2;
}

/** Smooth display-only sampling; physical wind and inspection values keep bilinear sampling. */
export function sampleSmoothGrid(f: FieldData, arr: Float32Array, lon: number, lat: number): number {
  const gx = (((lon - BOUNDS.west) / GRID_STEP - 0.5) % f.cols + f.cols) % f.cols;
  const gy = Math.max(0, Math.min(f.rows - 1, (lat - BOUNDS.south) / GRID_STEP - 0.5));
  const i = Math.floor(gx), j = Math.floor(gy), tx = gx - i;
  const row = (offset: number) => {
    const r = Math.max(0, Math.min(f.rows - 1, j + offset)) * f.cols;
    const at = (column: number) => arr[r + ((column % f.cols) + f.cols) % f.cols];
    return monotoneCubic(at(i - 1), at(i), at(i + 1), at(i + 2), tx);
  };
  return monotoneCubic(row(-1), row(0), row(1), row(2), gy - j);
}

/**
 * Builds the RGBA image (cols × rows, row 0 = southernmost) for the active layer. Cells that are
 * transparent still carry a nearby ramp colour so bilinear filtering does not create dark halos.
 */
export function buildLayerImage(f: FieldData, layer: Layer, theme: Theme, out: Uint8Array): void {
  const n = f.cols * f.rows;
  const { ramps } = theme;
  for (let k = 0; k < n; k++) {
    const o = k * 4;
    switch (layer) {
      case 'wind': {
        const s = f.speed[k];
        ramps.wind.at(s, out, o);
        out[o + 3] = Math.round(255 * (0.08 + 0.4 * Math.min(1, s / 40)));
        break;
      }
      case 'pressure': {
        ramps.pressure.at(f.pressure[k], out, o);
        const d = Math.abs(f.pressure[k] - 1010);
        out[o + 3] = Math.round(255 * (0.22 + 0.55 * Math.min(1, d / 30)));
        break;
      }
      case 'temperature': {
        ramps.temperature.at(f.temperature[k], out, o);
        out[o + 3] = f.land[k] ? 0 : 64;
        break;
      }
      case 'population': {
        const p = f.population[k];
        const lg = p > 1 ? Math.log10(p) : 0;
        ramps.population.at(lg, out, o);
        const t = Math.min(1, Math.max(0, (lg - 4.5) / (7.2 - 4.5)));
        out[o + 3] = p > 0 ? Math.round(255 * (0.08 + 0.27 * t)) : 0;
        break;
      }
    }
  }
}

/** One-degree, world-anchored colour field; the camera only transforms this texture. */
export const FIELD_IMAGE_COLS = 360;
export const FIELD_IMAGE_ROWS = 180;
const POPULATION_SPREAD = 2 / 5;

/** Compact display kernels; population totals and damage still use the original grid. */
function samplePopulationTint(f: FieldData, lon: number, lat: number): number {
  const gx = ((lon - BOUNDS.west) / GRID_STEP - 0.5 + f.cols) % f.cols;
  const gy = Math.max(0, Math.min(f.rows - 1, (lat - BOUNDS.south) / GRID_STEP - 0.5));
  const col = Math.floor(gx), row = Math.floor(gy);
  let population = 0;
  for (let y = row; y <= Math.min(row + 1, f.rows - 1); y++) {
    const wy = Math.max(0, 1 - Math.abs(gy - y) / POPULATION_SPREAD);
    for (let x = col; x <= col + 1; x++) {
      const wx = Math.max(0, 1 - Math.abs(gx - x) / POPULATION_SPREAD);
      population += f.population[y * f.cols + (x % f.cols)] * wx * wy;
    }
  }
  return Math.max(0, population);
}
/** Opaque colours for the existing sea and land surfaces; geometry supplies the coastline mask. */
export function buildSurfaceImages(
  f: FieldData, overlays: MapOverlays, theme: Theme, sea: Uint8Array, land: Uint8Array,
): void {
  const size = FIELD_IMAGE_COLS * FIELD_IMAGE_ROWS * 4;
  if (sea.length !== size || land.length !== size) throw new RangeError('Invalid surface image size');
  const rgb = new Uint8Array(3);
  for (let j = 0; j < FIELD_IMAGE_ROWS; j++) {
    const lat = -90 + j + 0.5;
    for (let i = 0; i < FIELD_IMAGE_COLS; i++) {
      const lon = -180 + i + 0.5, offset = (j * FIELD_IMAGE_COLS + i) * 4;
      if (overlays.temperature) theme.ramps.airTemperature.at(sampleGrid(f, f.temperature, lon, lat), rgb, 0);
      for (let channel = 0; channel < 3; channel++) {
        sea[offset + channel] = overlays.temperature
          ? Math.round(theme.rgb.sea[channel] * 0.45 + rgb[channel] * 0.55) : theme.rgb.sea[channel];
        land[offset + channel] = theme.rgb.land[channel];
      }
      if (overlays.temperature) {
        theme.ramps.airTemperature.at(sampleGrid(f, f.airTemperature, lon, lat), rgb, 0);
        for (let channel = 0; channel < 3; channel++) {
          land[offset + channel] = Math.round(theme.rgb.land[channel] * 0.45 + rgb[channel] * 0.55);
        }
      }
      if (overlays.population) {
        const population = samplePopulationTint(f, lon, lat);
        const density = Math.min(1, Math.max(0, (Math.log10(Math.max(1, population)) - 4.5) / 2.7));
        const strength = smoothstep(20_000, 250_000, population) * (0.12 + 0.3 * density);
        theme.ramps.population.at(Math.log10(Math.max(1, population)), rgb, 0);
        for (let channel = 0; channel < 3; channel++) {
          land[offset + channel] = Math.round(land[offset + channel] * (1 - strength) + rgb[channel] * strength);
        }
      }
      sea[offset + 3] = 255; land[offset + 3] = 255;
    }
  }
}

/** Only atmospheric precipitation is painted over the surface. */
export function buildCombinedImage(f: FieldData, overlays: MapOverlays, theme: Theme, out: Uint8Array): void {
  if (out.length !== FIELD_IMAGE_COLS * FIELD_IMAGE_ROWS * 4) throw new RangeError('Invalid field image size');
  out.fill(0);
  if (!overlays.rain) return;
  const rgb = new Uint8Array(3), snowRgb = new Uint8Array(3);
  for (let j = 0; j < FIELD_IMAGE_ROWS; j++) {
    const lat = -90 + j + 0.5;
    for (let i = 0; i < FIELD_IMAGE_COLS; i++) {
      const offset = (j * FIELD_IMAGE_COLS + i) * 4, lon = -180 + i + 0.5;
      const rain = Math.max(0, Math.min(60, sampleSmoothGrid(f, f.rain, lon, lat)));
      if (rain <= 0) continue;
      const snowMix = 1 - smoothstep(-1, 1, sampleSmoothGrid(f, f.airTemperature, lon, lat));
      theme.ramps.rain.at(rain, rgb, 0);
      theme.ramps.snow.at(rain, snowRgb, 0);
      const alpha = Math.min(1, rain / 0.5) * (hexAlpha(rain, false) * (1 - snowMix) + hexAlpha(rain, true) * snowMix);
      for (let channel = 0; channel < 3; channel++) {
        out[offset + channel] = Math.round(rgb[channel] + (snowRgb[channel] - rgb[channel]) * snowMix);
      }
      out[offset + 3] = Math.round(alpha * 255);
    }
  }
}

/** `minor`/`major` are flat lon/lat segments for drawing; `lines` keeps each isobar whole with its level, for labels. */
export interface Contours { minor: Float32Array; major: Float32Array; lines: Isobar[] }

/** Display isobar spacing: sparse inside deep lows so a typhoon shows a few rings, not dozens. */
export const ISOBAR_STEP_HPA = 8;
export const DEEP_ISOBAR_STEP_HPA = 20;
export const DEEP_ISOBAR_BELOW_HPA = 1000;

/** Display levels within [lo, hi]: every 8 hPa from 1000 hPa up, every 20 hPa below (980, 960…). */
export function isobarLevels(lo: number, hi: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [];
  const levels: number[] = [];
  for (let L = Math.ceil(lo / DEEP_ISOBAR_STEP_HPA) * DEEP_ISOBAR_STEP_HPA; L < DEEP_ISOBAR_BELOW_HPA && L <= hi; L += DEEP_ISOBAR_STEP_HPA) levels.push(L);
  const first = Math.max(DEEP_ISOBAR_BELOW_HPA, Math.ceil(lo / ISOBAR_STEP_HPA) * ISOBAR_STEP_HPA);
  for (let L = first; L <= hi; L += ISOBAR_STEP_HPA) levels.push(L);
  return levels;
}

/** One isobar as a polyline of lon,lat pairs; longitudes are unwrapped so the path never jumps at ±180°. */
export interface Isobar { level: number; closed: boolean; points: Float64Array }

/**
 * Marching squares on the 2° cell-centre lattice, with segments chained through shared cell edges
 * (edge identities, so paths join across the dateline) and Chaikin-smoothed twice. Lines are kept
 * whole, never clipped, so a closed low stays a closed ring. Non-finite cells are skipped.
 */
export function buildIsobars(f: FieldData, smoothing = 2): Isobar[] {
  const { cols, rows, pressure: p } = f;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < p.length; k++) { const v = p[k]; if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }
  const lonOf = (x: number) => BOUNDS.west + (x + 0.5) * GRID_STEP;
  const latOf = (y: number) => BOUNDS.south + (y + 0.5) * GRID_STEP;
  // Edge ids: horizontal edge from node (i, j) eastward = 2(j·cols+i); vertical edge from (i, j) northward = +1.
  const edges = 2 * cols * rows;
  const ex = new Float64Array(edges);
  const ey = new Float64Array(edges);
  const nb0 = new Int32Array(edges).fill(-1);
  const nb1 = new Int32Array(edges).fill(-1);
  const seen = new Uint8Array(edges);
  const touched: number[] = [];
  const link = (a: number, b: number) => {
    if (nb0[a] < 0) { nb0[a] = b; touched.push(a); } else nb1[a] = b;
    if (nb0[b] < 0) { nb0[b] = a; touched.push(b); } else nb1[b] = a;
  };
  const lines: Isobar[] = [];
  for (const L of isobarLevels(lo, hi)) {
    for (let j = 0; j < rows - 1; j++) {
      for (let i = 0; i < cols; i++) {
        const i2 = i + 1 < cols ? i + 1 : 0;
        const k = j * cols + i;
        const v0 = p[k]; const v1 = p[j * cols + i2]; const v2 = p[(j + 1) * cols + i2]; const v3 = p[k + cols];
        if (!(Number.isFinite(v0) && Number.isFinite(v1) && Number.isFinite(v2) && Number.isFinite(v3))) continue;
        const a0 = v0 >= L; const a1 = v1 >= L; const a2 = v2 >= L; const a3 = v3 >= L;
        if (a0 === a1 && a1 === a2 && a2 === a3) continue;
        const B = 2 * k; const T = 2 * (k + cols); const W = 2 * k + 1; const E = 2 * (j * cols + i2) + 1;
        const hit: number[] = []; // edges in order B, E, T, W
        if (a0 !== a1) { ex[B] = lonOf(i + (L - v0) / (v1 - v0)); ey[B] = latOf(j); hit.push(B); }
        if (a1 !== a2) { ex[E] = lonOf(i + 1); ey[E] = latOf(j + (L - v1) / (v2 - v1)); hit.push(E); }
        if (a3 !== a2) { ex[T] = lonOf(i + (L - v3) / (v2 - v3)); ey[T] = latOf(j + 1); hit.push(T); }
        if (a0 !== a3) { ex[W] = lonOf(i); ey[W] = latOf(j + (L - v0) / (v3 - v0)); hit.push(W); }
        if (hit.length === 2) link(hit[0], hit[1]);
        else if (hit.length === 4) {
          const [b, r, t, l] = hit;
          if (((v0 + v1 + v2 + v3) / 4 >= L) === a0) { link(b, r); link(t, l); } else { link(b, l); link(r, t); }
        }
      }
    }
    const walk = (start: number) => {
      const pts: number[] = [];
      let prev = -1;
      let cur = start;
      let lastLon = ex[start];
      let closed = false;
      while (cur >= 0 && !seen[cur]) {
        seen[cur] = 1;
        let lon = ex[cur];
        while (lon - lastLon > 180) lon -= 360;
        while (lon - lastLon < -180) lon += 360;
        pts.push(lon, ey[cur]);
        lastLon = lon;
        const next = nb0[cur] !== prev ? nb0[cur] : nb1[cur];
        if (next === start && pts.length > 4) closed = true;
        prev = cur; cur = next;
      }
      if (pts.length >= 4) lines.push({ level: L, closed, points: chaikin(pts, closed, smoothing) });
    };
    for (const e of touched) if (!seen[e] && nb1[e] < 0) walk(e); // open lines from their ends
    for (const e of touched) if (!seen[e]) walk(e); // then closed rings
    for (const e of touched) { nb0[e] = -1; nb1[e] = -1; seen[e] = 0; }
    touched.length = 0;
  }
  return lines;
}

function chaikin(pts: number[], closed: boolean, iterations: number): Float64Array {
  let cur = pts;
  for (let it = 0; it < iterations; it++) {
    const n = cur.length / 2;
    if (n < 3) break;
    const next: number[] = closed ? [] : [cur[0], cur[1]];
    const last = closed ? n : n - 1;
    for (let k = 0; k < last; k++) {
      const k2 = (k + 1) % n;
      const ax = cur[2 * k]; const ay = cur[2 * k + 1];
      let bx = cur[2 * k2]; const by = cur[2 * k2 + 1];
      if (bx - ax > 180) bx -= 360; else if (bx - ax < -180) bx += 360; // closing a ring across the seam
      next.push(0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by, 0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by);
    }
    if (!closed) next.push(cur[cur.length - 2], cur[cur.length - 1]);
    cur = next;
  }
  return new Float64Array(cur);
}

/** Display isobars as lon0,lat0,lon1,lat1 segments; 1000 hPa and the sparse deep-low rings are major. */
export function buildContours(f: FieldData): Contours {
  const minor: number[] = [];
  const major: number[] = [];
  const lines = buildIsobars(f);
  for (const line of lines) {
    const out = line.level <= DEEP_ISOBAR_BELOW_HPA ? major : minor;
    const q = line.points;
    const n = q.length / 2;
    for (let k = 0; k < n - 1; k++) out.push(q[2 * k], q[2 * k + 1], q[2 * k + 2], q[2 * k + 3]);
    if (line.closed) {
      let x = q[0];
      if (x - q[2 * n - 2] > 180) x -= 360; else if (x - q[2 * n - 2] < -180) x += 360;
      out.push(q[2 * n - 2], q[2 * n - 1], x, q[1]);
    }
  }
  return { minor: new Float32Array(minor), major: new Float32Array(major), lines };
}

export interface LayerLegend { title: string; unit: string; ticks: { label: string; pos: number }[]; gradient: string; note: string }

export function airTemperatureLegend(): LayerLegend {
  return { title: 'Surface air temperature', unit: '°C',
    ticks: [{ label: '-40', pos: 0 }, { label: '-20', pos: 0.25 }, { label: '0', pos: 0.5 }, { label: '20', pos: 0.75 }, { label: '40', pos: 1 }],
    gradient: 'linear-gradient(to right, var(--ramp-air-temperature-0), var(--ramp-air-temperature-1) 25%, var(--ramp-air-temperature-2) 50%, var(--ramp-air-temperature-3) 62.5%, var(--ramp-air-temperature-4) 75%, var(--ramp-air-temperature-5) 87.5%, var(--ramp-air-temperature-6))',
    note: 'Land colour shows near-surface air temperature. Population adds settlement shading.' };
}

/** Legend text; the gradient uses the same ramp tokens as the map image. Tick positions are 0..1 along the ramp. */
export function layerLegend(layer: Layer): LayerLegend {
  switch (layer) {
    case 'wind':
      return { title: 'Surface wind', unit: 'm/s',
        ticks: [{ label: '0', pos: 0 }, { label: '10', pos: 0.18 }, { label: '20', pos: 0.36 }, { label: '30', pos: 0.55 }, { label: '40+', pos: 0.73 }],
        gradient: 'linear-gradient(to right, var(--ramp-wind-0), var(--ramp-wind-1) 7%, var(--ramp-wind-2) 16%, var(--ramp-wind-3) 27%, var(--ramp-wind-4) 40%, var(--ramp-wind-5) 55%, var(--ramp-wind-6) 73%, var(--ramp-wind-7))',
        note: 'Colour and streaks show wind.' };
    case 'pressure':
      return { title: 'Sea-level pressure', unit: 'hPa',
        ticks: [{ label: '960', pos: 0 }, { label: '985', pos: 0.33 }, { label: '1010', pos: 0.67 }, { label: '1035', pos: 1 }],
        gradient: 'linear-gradient(to right, var(--ramp-pressure-0), var(--ramp-pressure-1) 33%, var(--ramp-pressure-2) 53%, var(--ramp-pressure-3) 67%, var(--ramp-pressure-4) 80%, var(--ramp-pressure-5))',
        note: 'Isobars every 8 hPa from 1000 hPa up, and only every 20 hPa below 1000 (980, 960…), so deep lows show a few rings. 1000 hPa and lower lines are thicker.' };
    case 'temperature':
      return { ...airTemperatureLegend(), title: 'Temperature',
        note: 'Sea and air temperatures share one scale. The upper marker shows air temperature; the lower marker shows water temperature.' };
    case 'population':
      return { title: 'Population per 2° cell', unit: 'people',
        ticks: [{ label: '30k', pos: 0 }, { label: '200k', pos: 0.3 }, { label: '3M', pos: 0.7 }, { label: '15M', pos: 1 }],
        gradient: 'linear-gradient(to right, var(--ramp-population-0), var(--ramp-population-1) 30%, var(--ramp-population-2) 52%, var(--ramp-population-3) 70%, var(--ramp-population-4))',
        note: 'Population by 2° cell, 2025 baseline.' };
    case 'rain':
      return { title: 'Rainfall', unit: 'mm/h',
        ticks: [{ label: '0', pos: 0 }, { label: '5', pos: 0.2 }, { label: '15', pos: 0.4 }, { label: '30', pos: 0.65 }, { label: '50+', pos: 1 }],
        gradient: 'linear-gradient(to right, var(--ramp-rain-0), var(--ramp-rain-1) 20%, var(--ramp-rain-2) 40%, var(--ramp-rain-3) 65%, var(--ramp-rain-4))',
        note: 'Hexagons tile where rain or snow is falling. Wind streaks thicken in heavier rain. Around 0 °C precipitation changes to snow; in a blizzard the wind streaks turn white.' };
  }
}
