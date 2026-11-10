import { teleconnectionInto } from '../data/climate-teleconnections';
import {
  scriptEndDay, FIELD_COLS, FIELD_ROWS, OCEAN_DLON, OCEAN_LON0, OCEAN_N, climateFields, climateIndices, climateMonth, heatSourceActive, nino34Of, patchAmplitude, createClimate, initialiseFromSstAnomaly, restoreClimate, serializeClimate, stepClimateDay,
  type ClimateFields, type ClimateState,
} from './climate-core';
import { equatorNormalSst } from '../data/climate-normals';
import { createScenarioCore, type ClimateScenarioId } from './climate-scenarios';
import { clamp, smoothstep } from './geo';
import { sampleLiveWeather } from './live-weather';
import type { WeatherField } from '../types';

/**
 * Stage-2 coupling: turns the once-per-day ENSO core (climate-core.ts) into 2 degree anomaly fields the weather engine adds
 * to its SST, air temperature, humidity, pressure, wind and shear. Tropics come from the Matsuno-Gill atmosphere of the core;
 * the extratropics (tapered in from 25 to 35 degrees) and land air temperature come from observed regression maps on a
 * smoothed Nino 3.4. All fields are anomalies relative to the moment the layer started, so an untouched game or a live start
 * (whose real ENSO state is already in its analysis) is not shifted.
 */
export const CLIMATE_SOURCE = {
  tropics: 'Matsuno-Gill model (simulated)',
  remote: 'observed statistics (NCEP/NCAR Reanalysis 1 regression on Nino 3.4)',
} as const;

/** Grid of the engine and of the live weather: 2 degrees, 180 x 90, row 0 at 89S, column 0 at 179W. */
export const COUPLING_COLS = 180;
export const COUPLING_ROWS = 90;
const CELLS = COUPLING_COLS * COUPLING_ROWS;
const NINO_TAU_DAYS = 45; // exponential mean with a 45 day e-fold: about a 90 day running mean
const NINO_ALPHA = 1 - Math.exp(-1 / NINO_TAU_DAYS);
const AIR_PER_SST = 0.7; // marine air temperature anomaly per degC of SST anomaly
const HUM_PER_MM = 0.01; // relative humidity per mm/day of precipitation anomaly
const HUM_TROPICS_MAX = 0.15;
const TELE_LAT_LO = 25; // degrees: observed-statistics maps fade in
const TELE_LAT_HI = 35;
const WIND_LAT_LO = 8; // degrees: the direct (non-geostrophic) tropical wind fades out, where the pressure gradient takes over
const WIND_LAT_HI = 20;
const SHEAR_LIMIT = 25; // m/s, bound on the shear change
const OMEGA2 = 2 * 7.292e-5;
const SIN_FLOOR = Math.sin(10 * (Math.PI / 180));

export interface ClimateLayer {
  core: ClimateState;
  /** Smoothed Nino 3.4 (degC) that scales the observed-statistics maps. */
  nino: number;
  /** Its value when the layer started: only the change since then reaches the weather. */
  nino0: number;
  /** Tropical fields at the start of a live game (the real state, already in the analysis); null in a base world. */
  base: ClimateFields | null;
  /** The layer follows a downloaded analysis: the game's air temperature already tracks its sea surface and its winds follow its pressure. */
  live: boolean;
  /** Current 2 degree anomaly fields; rebuilt once a day and after actions. Stored here so that clones carry them. */
  anomalies: AnomalySet | null;
}

/** 2 degree anomalies (row*180+col, south to north from 179W) that the engine adds. */
export interface AnomalySet {
  /** Counts rebuilds, so consumers that fold the fields into their own arrays know when to refill. */
  rev: number;
  /** Sea-surface temperature (degC), ocean cells only. */
  sst: Float32Array;
  /** Near-surface air temperature (degC). */
  air: Float32Array;
  /** Relative humidity (fraction). */
  hum: Float32Array;
  /** Sea-level pressure (hPa). */
  slp: Float32Array;
  /** Direct tropical wind (m/s), faded out poleward of 8 degrees. */
  u: Float32Array;
  v: Float32Array;
  /** Damped geostrophic wind of `slp`, as the game's own pressure systems make it (a live game derives this itself). */
  ug: Float32Array;
  vg: Float32Array;
  /** Change of the scalar vertical wind shear (m/s). */
  shear: Float32Array;
}
export interface AnomalyPoint { sst: number; air: number; hum: number; slp: number; u: number; v: number; ug: number; vg: number; shear: number }
export interface AnomalyContext {
  /** 1 where the 2 degree cell centre is land. */
  land: Uint8Array;
  /** The engine's climatological shear magnitude (m/s). */
  baseShear: (seed: number, lon: number, lat: number) => number;
}

const newSet = (): AnomalySet => ({
  rev: 0,
  sst: new Float32Array(CELLS), air: new Float32Array(CELLS), hum: new Float32Array(CELLS), slp: new Float32Array(CELLS),
  u: new Float32Array(CELLS), v: new Float32Array(CELLS), ug: new Float32Array(CELLS), vg: new Float32Array(CELLS), shear: new Float32Array(CELLS),
});
export const newAnomalyPoint = (): AnomalyPoint => ({ sst: 0, air: 0, hum: 0, slp: 0, u: 0, v: 0, ug: 0, vg: 0, shear: 0 });

// ---- Layers ----
/** A neutral layer for a base world: deterministic (no natural bursts or noise), so nothing changes until an action drives it. */
export function createClimateLayer(seed: number, startDayOfYear: number, startYear = 2000): ClimateLayer {
  return { core: createClimate(seed, startDayOfYear, startYear, false), nino: 0, nino0: 0, base: null, live: false, anomalies: null };
}

/**
 * A layer for a historic climate scenario: noise-free, its ocean start state and scripted forcing from climate-scenarios.ts, nothing
 * else driving it. Its smoothed Nino 3.4 starts at the core's own value, so a warm start shows its remote effects from the first day.
 */
export function createScenarioLayer(seed: number, id: ClimateScenarioId): ClimateLayer {
  const core = createScenarioCore(seed, id);
  return { core, nino: nino34Of(core), nino0: 0, base: null, live: false, anomalies: null };
}

/**
 * A layer for a live game: the equatorial SST anomaly of the analysis (analysis minus the ERSST normal, smoothed over five
 * cells) and the thermocline that balances it start the core, so the real ENSO state carries on from the first day.
 */
export function createLiveClimateLayer(seed: number, startDayOfYear: number, startYear: number, weather: WeatherField): ClimateLayer {
  const layer: ClimateLayer = { core: createClimate(seed, startDayOfYear, startYear, true), nino: 0, nino0: 0, base: null, live: true, anomalies: null };
  if (weather.seaTemperature) {
    const month = ((startDayOfYear - 0.5) / 365) * 12 - 0.5; // normals are monthly means centred on the month index
    const raw = new Float64Array(OCEAN_N).fill(NaN);
    for (let j = 0; j < OCEAN_N; j++) {
      const lonEast = OCEAN_LON0 + (j + 0.5) * OCEAN_DLON;
      const t = sampleLiveWeather(weather, lonEast > 180 ? lonEast - 360 : lonEast, 0).t;
      if (t !== undefined) { try { raw[j] = t - equatorNormalSst(month, lonEast); } catch { /* land in the normals */ } }
    }
    const anomaly = new Float64Array(OCEAN_N);
    for (let j = 0; j < OCEAN_N; j++) {
      let sum = 0, n = 0;
      for (let d = -2; d <= 2; d++) { const x = raw[j + d]; if (j + d >= 0 && j + d < OCEAN_N && !Number.isNaN(x)) { sum += x; n++; } }
      anomaly[j] = n ? sum / n : 0;
    }
    initialiseFromSstAnomaly(layer.core, anomaly);
  }
  layer.nino = layer.nino0 = climateIndices(layer.core).nino34;
  layer.base = climateFields(layer.core);
  return layer;
}

/** Advance one model day and update the smoothed Nino 3.4. */
export function stepClimateLayer(layer: ClimateLayer): void {
  stepClimateDay(layer.core);
  layer.nino += (nino34Of(layer.core) - layer.nino) * NINO_ALPHA;
}

/** Advances the layer by whole model days without building anomaly fields (the caller rebuilds once at the end) and without allocating. */
export function advanceClimateLayer(layer: ClimateLayer, days: number): void {
  for (let d = 0; d < days; d++) {
    // A scenario's script is over: natural variability starts on the first day after it, whatever the chunking (a function of the core's day only).
    if (!layer.core.stochastic && layer.core.script.length && layer.core.day > scriptEndDay(layer.core)) enableClimateNoise(layer);
    stepClimateLayer(layer);
  }
}

/**
 * Switches a layer to natural variability (westerly wind bursts, background wind and SST noise). A core's `stochastic` flag is
 * fixed for its lifetime, so the core is rebuilt through serialisation with the flag set; every other field carries over. Returns
 * false (and changes nothing) when the core cannot be restored. A layer that is already stochastic, or whose scenario script is still running, is left untouched.
 */
export function enableClimateNoise(layer: ClimateLayer): boolean {
  if (layer.core.stochastic || layer.core.day <= scriptEndDay(layer.core)) return true; // a scenario's story stays noise-free until its script is over: random bursts would change it
  const data = serializeClimate(layer.core);
  data.stochastic = true;
  const core = restoreClimate(data);
  if (!core) return false;
  layer.core = core;
  return true;
}

/** Moves the layer's calendar so that its day of year equals `doy` (1..365) today. */
export function alignClimateCalendar(layer: ClimateLayer, doy: number): void {
  layer.core.startDayOfYear = ((((Math.floor(doy) - 1 - layer.core.day) % 365) + 365) % 365) + 1;
}

// ---- 2 degree interpolation tables (static) ----
// For every 2 degree cell: the four surrounding 5 degree field cells and their weights, and the latitude/longitude tapers.
const I00 = new Int32Array(CELLS), I10 = new Int32Array(CELLS), I01 = new Int32Array(CELLS), I11 = new Int32Array(CELLS);
const WX = new Float32Array(CELLS), WY = new Float32Array(CELLS);
const LON = new Float32Array(CELLS), LAT = new Float32Array(CELLS);
const WT = new Float32Array(CELLS); // weight of the observed-statistics maps
const WTROP = new Float32Array(CELLS); // weight of the same maps for air and humidity: also the tropics outside the Pacific
const WWIND = new Float32Array(CELLS); // weight of the direct tropical wind
{
  for (let r = 0; r < COUPLING_ROWS; r++) {
    const lat = -89 + 2 * r;
    const y = clamp((lat + 87.5) / 5, 0, FIELD_ROWS - 1);
    const j0 = Math.min(FIELD_ROWS - 2, Math.floor(y));
    for (let c = 0; c < COUPLING_COLS; c++) {
      const k = r * COUPLING_COLS + c, lon = -179 + 2 * c;
      const x = (lon + 177.5) / 5;
      const i0 = ((Math.floor(x) % FIELD_COLS) + FIELD_COLS) % FIELD_COLS, i1 = (i0 + 1) % FIELD_COLS;
      I00[k] = j0 * FIELD_COLS + i0; I10[k] = j0 * FIELD_COLS + i1; I01[k] = (j0 + 1) * FIELD_COLS + i0; I11[k] = (j0 + 1) * FIELD_COLS + i1;
      WX[k] = x - Math.floor(x); WY[k] = y - j0;
      LON[k] = lon; LAT[k] = lat;
      const wt = smoothstep(TELE_LAT_LO, TELE_LAT_HI, Math.abs(lat));
      const lonEast = lon < 0 ? lon + 360 : lon;
      const pacific = smoothstep(115, 130, lonEast) * (1 - smoothstep(270, 285, lonEast));
      WT[k] = wt;
      WTROP[k] = wt + (1 - wt) * (1 - pacific);
      WWIND[k] = 1 - smoothstep(WIND_LAT_LO, WIND_LAT_HI, Math.abs(lat));
    }
  }
}
const bil = (a: Float32Array, k: number): number => {
  const tx = WX[k], ty = WY[k];
  return (a[I00[k]] * (1 - tx) + a[I10[k]] * tx) * (1 - ty) + (a[I01[k]] * (1 - tx) + a[I11[k]] * tx) * ty;
};

// ---- Building the anomaly set ----
const size5 = FIELD_COLS * FIELD_ROWS;
const scratchFields: ClimateFields = { sst: new Float32Array(size5), slp: new Float32Array(size5), u: new Float32Array(size5), v: new Float32Array(size5), precip: new Float32Array(size5) };
const scratchTele = { slp: new Float32Array(size5), air: new Float32Array(size5), rhum: new Float32Array(size5), shear: new Float32Array(size5) };
// Observed statistics times the change of Nino 3.4, on the 5 degree grid; slp also holds the Gill pressure.
const comb = { slp: new Float32Array(size5), air: new Float32Array(size5), rhum: new Float32Array(size5), shear: new Float32Array(size5) };
const WT5 = Float32Array.from({ length: size5 }, (_, i) => smoothstep(TELE_LAT_LO, TELE_LAT_HI, Math.abs(-87.5 + 5 * Math.floor(i / FIELD_COLS))));
const patchWeight = new Float32Array(CELLS);
const heatWeight = new Float32Array(CELLS);
const scratchHeatSlp = new Float32Array(size5);
const RAIN_FULL_MM = 1.5; // mm/day of Gill rain anomaly at which the model's humidity replaces the observed map

/**
 * Shear change near a player patch from a baroclinic Gill response: the upper-level wind anomaly is the opposite of the
 * lower-level one, so the shear vector changes by (-2u, -2v). The climatological shear (magnitude `s0`) points east over
 * the Asian monsoon sector in the warm season and west elsewhere; the scalar change is |S0 + dS| - |S0|.
 */
function shearChange(s0: number, lon: number, lat: number, month: number, u: number, v: number): number {
  const easterly = smoothstep(30, 45, lon) * (1 - smoothstep(160, 178, lon)) * smoothstep(-2, 2, lat) * (1 - smoothstep(22, 28, lat))
    * smoothstep(3.5, 5.5, month) * (1 - smoothstep(9.5, 11.5, month));
  const theta = Math.PI * easterly;
  return clamp(Math.hypot(s0 * Math.cos(theta) - 2 * u, s0 * Math.sin(theta) - 2 * v) - s0, -SHEAR_LIMIT, SHEAR_LIMIT);
}

/** Footprint weight (0..1) of the active player patches on each 2 degree cell: exp(-(d/2r)^2), the largest of them, within 4r. */
function fillPatchWeight(core: ClimateState): boolean {
  patchWeight.fill(0);
  let any = false;
  for (let p = 0; p < core.nPatches; p++) {
    const o = p * 6, amp = patchAmplitude(core, p, core.day);
    if (amp <= 0) continue;
    any = true;
    const lon0 = core.patches[o] > 180 ? core.patches[o] - 360 : core.patches[o], lat0 = core.patches[o + 1], r = core.patches[o + 2];
    const reach = Math.min(4 * r, 180);
    const r0 = Math.max(0, Math.floor((lat0 - reach + 89) / 2)), r1 = Math.min(COUNT_ROWS_M1, Math.ceil((lat0 + reach + 89) / 2));
    for (let row = r0; row <= r1; row++) {
      const dy = -89 + 2 * row - lat0;
      for (let col = 0; col < COUPLING_COLS; col++) {
        let dl = Math.abs(-179 + 2 * col - lon0);
        if (dl > 180) dl = 360 - dl;
        const d2 = dl * dl + dy * dy;
        if (d2 > reach * reach) continue;
        const k = row * COUPLING_COLS + col;
        const w = amp * Math.exp(-d2 / (4 * r * r));
        if (w > patchWeight[k]) patchWeight[k] = w;
      }
    }
  }
  return any;
}
const COUNT_ROWS_M1 = COUPLING_ROWS - 1;

/**
 * Footprint weight (0..1) of the active heat patches of pressure tools (low, high) on each 2 degree cell: exp(-(d/r)^2), the largest of them, within 3r. A tool's Gaussian
 * pressure system exp(-d^2/2 sigma^2) is the same shape (r = sigma sqrt 2), so this is where the weather layer already holds the tool's own
 * pressure. Returns false when no patch is active.
 */
function fillHeatWeight(core: ClimateState): boolean {
  heatWeight.fill(0);
  let any = false;
  for (let p = 0; p < core.nHeat; p++) {
    if (core.heatOwn[p] !== 1 || !heatSourceActive(core, p)) continue;
    const o = p * 6;
    any = true;
    const lon0 = core.heat[o] > 180 ? core.heat[o] - 360 : core.heat[o], lat0 = core.heat[o + 1], r = core.heat[o + 2], reach = Math.min(3 * r, 180);
    const r0 = Math.max(0, Math.floor((lat0 - reach + 89) / 2)), r1 = Math.min(COUNT_ROWS_M1, Math.ceil((lat0 + reach + 89) / 2));
    for (let row = r0; row <= r1; row++) {
      const dy = -89 + 2 * row - lat0;
      for (let col = 0; col < COUPLING_COLS; col++) {
        let dl = Math.abs(-179 + 2 * col - lon0);
        if (dl > 180) dl = 360 - dl;
        const d2 = dl * dl + dy * dy;
        if (d2 > reach * reach) continue;
        const k = row * COUPLING_COLS + col, w = Math.exp(-d2 / (r * r));
        if (w > heatWeight[k]) heatWeight[k] = w;
      }
    }
  }
  return any;
}

/** Recomputes the layer's anomaly fields from its current state (once per model day and after every action that changes the core). */
export function rebuildAnomalies(layer: ClimateLayer, ctx: AnomalyContext): AnomalySet {
  const out = layer.anomalies ?? newSet();
  layer.anomalies = out;
  out.rev++;
  const core = layer.core;
  const heated = core.heatOwn.some((v, i) => i < core.nHeat && v === 1);
  const f = climateFields(core, scratchFields, heated ? scratchHeatSlp : undefined);
  const base = layer.base;
  if (base) for (let i = 0; i < size5; i++) { f.sst[i] -= base.sst[i]; f.slp[i] -= base.slp[i]; f.u[i] -= base.u[i]; f.v[i] -= base.v[i]; f.precip[i] -= base.precip[i]; }
  const month = climateMonth(core);
  teleconnectionInto(month, scratchTele);
  const dn = layer.nino - layer.nino0;
  for (let i = 0; i < size5; i++) {
    comb.slp[i] = f.slp[i] + WT5[i] * dn * scratchTele.slp[i];
    comb.air[i] = dn * scratchTele.air[i];
    comb.rhum[i] = dn * scratchTele.rhum[i];
    comb.shear[i] = dn * scratchTele.shear[i];
  }
  const patched = fillPatchWeight(core);
  const footprint = heated && fillHeatWeight(core);
  for (let k = 0; k < CELLS; k++) {
    const land = ctx.land[k] === 1;
    const wt = WT[k], wtrop = WTROP[k];
    const sst = land ? 0 : bil(f.sst, k);
    out.sst[k] = sst;
    // Inside a heat patch's footprint the tool's own pressure system is already in the weather layer: its Gill pressure is left out (wind and remote effects stay).
    out.slp[k] = bil(comb.slp, k) - (footprint && heatWeight[k] > 0 ? heatWeight[k] * bil(scratchHeatSlp, k) : 0);
    const gu = bil(f.u, k), gv = bil(f.v, k);
    out.u[k] = gu * WWIND[k]; out.v[k] = gv * WWIND[k];
    out.air[k] = (land ? 1 : wtrop) * bil(comb.air, k) + (land || layer.live ? 0 : AIR_PER_SST * sst);
    const rain = bil(f.precip, k);
    const observed = wt + (1 - wt) * (1 - Math.min(1, Math.abs(rain) / RAIN_FULL_MM)); // observed humidity map except where the model's own rain anomaly is large
    out.hum[k] = (1 - wt) * clamp(HUM_PER_MM * rain, -HUM_TROPICS_MAX, HUM_TROPICS_MAX) + observed * bil(comb.rhum, k);
    // Shear: the observed map everywhere, plus the Gill baroclinic change close to a player patch.
    out.shear[k] = bil(comb.shear, k) + (patched && patchWeight[k] > 0.01 ? patchWeight[k] * shearChange(ctx.baseShear(core.seed, LON[k], LAT[k]), LON[k], LAT[k], month, gu, gv) : 0);
  }
  // Damped geostrophic wind of the pressure anomaly (same form as the game's pressure systems), central differences.
  const slp = out.slp;
  for (let r = 0; r < COUPLING_ROWS; r++) {
    const lat = -89 + 2 * r, s = Math.sin(lat * (Math.PI / 180));
    const response = (0.45 / 1.2) * (s / (s * s + SIN_FLOOR * SIN_FLOOR)) / OMEGA2;
    const south = Math.max(0, r - 1), north = Math.min(COUPLING_ROWS - 1, r + 1);
    const dx = 4 * 111.32 * Math.max(0.05, Math.cos(lat * (Math.PI / 180))) * 1000, dy = (north - south) * 2 * 110.57 * 1000;
    for (let c = 0; c < COUPLING_COLS; c++) {
      const k = r * COUPLING_COLS + c;
      const gx = (slp[r * COUPLING_COLS + (c + 1) % COUPLING_COLS] - slp[r * COUPLING_COLS + (c + COUPLING_COLS - 1) % COUPLING_COLS]) * 100 / dx;
      const gy = (slp[north * COUPLING_COLS + c] - slp[south * COUPLING_COLS + c]) * 100 / dy;
      out.ug[k] = -response * gy; out.vg[k] = response * gx;
    }
  }
  return out;
}

/** The layer's current anomaly set (built on first use). It is stored on the layer, so a structured clone carries it and no module cache can go stale. */
export function anomaliesFor(layer: ClimateLayer, ctx: AnomalyContext): AnomalySet {
  return layer.anomalies ?? rebuildAnomalies(layer, ctx);
}

/** Bilinear value of every anomaly at a point (longitude -180..180); wraps longitude and clamps the poles like the live weather sampler. */
export function anomalyAt(a: AnomalySet, lon: number, lat: number, out: AnomalyPoint): AnomalyPoint {
  const x = (((lon + 179) / 2) % COUPLING_COLS + COUPLING_COLS) % COUPLING_COLS;
  const y = Math.max(0, Math.min(COUPLING_ROWS - 1, (lat + 89) / 2));
  const x0 = Math.floor(x), x1 = (x0 + 1) % COUPLING_COLS;
  const y0 = Math.min(COUPLING_ROWS - 2, Math.floor(y));
  const tx = x - x0, ty = y - y0;
  const k00 = y0 * COUPLING_COLS + x0, k10 = y0 * COUPLING_COLS + x1, k01 = (y0 + 1) * COUPLING_COLS + x0, k11 = (y0 + 1) * COUPLING_COLS + x1;
  const at = (arr: Float32Array): number => (arr[k00] * (1 - tx) + arr[k10] * tx) * (1 - ty) + (arr[k01] * (1 - tx) + arr[k11] * tx) * ty;
  out.sst = at(a.sst); out.air = at(a.air); out.hum = at(a.hum); out.slp = at(a.slp);
  out.u = at(a.u); out.v = at(a.v); out.ug = at(a.ug); out.vg = at(a.vg); out.shear = at(a.shear);
  return out;
}

/**
 * Change to add to a sea temperature that already holds the player's own warm/cool tools (`tool`, degC) when the climate
 * layer says `anomaly`: the layer's SST patch is the same water as the tool's, so where both have the same sign only the
 * larger counts (no double counting) and the ocean's response beyond the tool footprint is added; opposite signs add.
 */
export function sstUnionAdjustment(tool: number, anomaly: number): number {
  if (tool >= 0 && anomaly >= 0) return Math.max(tool, anomaly) - tool;
  if (tool <= 0 && anomaly <= 0) return Math.min(tool, anomaly) - tool;
  return anomaly;
}
