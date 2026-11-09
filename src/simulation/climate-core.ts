import { equatorNormalSst, normalSst } from '../data/climate-normals';
import { clamp, hash01, smoothstep } from './geo';

/**
 * Stage-1 ENSO core: an anomaly-only, deterministic model of intermediate complexity, stepped once per model day.
 *   winds -> equatorial Kelvin/Rossby waves (1-D ocean) -> thermocline depth -> SST anomaly -> convective heating
 *   -> steady Matsuno-Gill atmosphere -> winds.
 * Pure functions on plain data (typed arrays); all randomness is hash01(seed, day, stream), so a run is replayable
 * from (seed, start day, player actions) alone. Longitudes are degrees east (0..360).
 */

// ---- Ocean (equatorial strip, 120E..280E) ----
export const OCEAN_LON0 = 120; // deg E, west wall
export const OCEAN_DLON = 2.5; // deg, cell size
export const OCEAN_N = 64; // cells; centres 121.25..278.75 E
const KM_PER_DEG = 111.32;
const DX_M = OCEAN_DLON * KM_PER_DEG * 1000; // m
const DAY_S = 86400;
export const KELVIN_C = 2.3; // m/s, first-baroclinic Kelvin speed (observed 2.4-2.8); Rossby n=1 is c/3
const REDUCED_G = 0.026; // m/s^2, reduced gravity g'
const MEAN_DEPTH = KELVIN_C ** 2 / REDUCED_G; // m, equivalent depth H of the first baroclinic mode, so that c^2 = g'H (about 203 m at c = 2.3)
const RHO_W = 1025; // kg/m^3
/** m/s of thermocline tendency per N/m^2 of wind stress: (c/g')/(2 rho H), which equals 1/(2 rho c) because c^2 = g'H. */
const KAPPA = KELVIN_C / REDUCED_G / (2 * RHO_W * MEAN_DEPTH);
/** Dimensionless gain on the wind forcing kappa tau of K and R, relative to the physical kappa = 1/(2 rho c); tuned. A value of 1.75 means the modelled ocean is forced 1.75 times harder than that physical value. */
const WIND_PROJECTION = 1.753;
/**
 * Share of the wind-forced Rossby response carried by a slow n=3 mode (speed c/7, off-equatorial maxima near 5 deg,
 * negligible equatorial thermocline signal): the 1-D stand-in for the off-equatorial Rossby waves that recharge and
 * discharge the equatorial heat content, re-entering the equator as Kelvin waves at the western wall. Kelvin, n=1 and
 * n=3 carry 1, 3 and 7 times their amplitude as meridionally integrated volume, so the forcing split
 * (kappa, (1 - share) kappa/3, share kappa/7) is mass-neutral and the wall reflections conserve volume flux.
 */
const ROSSBY3_SHARE = 0.773;
const ROSSBY3_DIV = 7; // its speed is c / (2n + 1) = c/7, about 0.34 m/s, near observed off-equatorial Rossby speeds
const REFLECT_W = 0.776; // K = rW R at the western wall (gappy wall: Indonesian passages leak part of the mass)
const REFLECT_E = 0.387; // R = rE K at the eastern wall (the rest leaves poleward as coastal Kelvin waves); tuned low: at 0.8 the model with bursts replaced by their expectation no longer decays from +2.5 C
const OCEAN_DAMP_DAYS = 3.394 * 365; // tau_o, linear thermocline damping
const CFL_K = (KELVIN_C * DAY_S) / DX_M;
/** m: the thermocline anomaly cannot shoal through the surface (limit follows the observed mean depth, about 170 m west to 50 m east) or deepen past the lower thermocline. */
const THERMO_DEPTH_W = 170;
const THERMO_DEPTH_E = 50;
const THERMO_SHOAL_FRACTION = 0.85; // of the mean depth
const THERMO_DEEP_LIMIT = 120; // m
const WAVE_MAX = 150; // m, bound on each wave amplitude (the wave-guide mass a single mode can carry)
const WIND_CAP = 25; // m/s, bound on the total surface-wind anomaly that forces the ocean (stronger winds do not persist over the equator)
const CFL_R = CFL_K / 3;
const CFL_R3 = CFL_K / ROSSBY3_DIV;
const U_PER_M = REDUCED_G / KELVIN_C; // m/s of zonal current anomaly per metre of (K - R)

// ---- SST anomaly equation ----
const UPWELL_MAX = 0.45; // m/day, mean upwelling east of 170W
const UPWELL_WEST = 0.4; // fraction of the mean upwelling kept in the warm pool (west of 160E): weak vertical coupling there
const UPWELL_RAMP_LO = 128; // deg E where the upwelling ramps from its warm-pool to its full value (over 30 deg)
const UPWELL_EAST = 0.45; // extra fractional upwelling in the eastern cold tongue (east of ~230E)
const MIXED_DEPTH = 50.022; // m, Hm
const SST_DAMP_DAYS = 112.819; // 1/alpha, surface heat-flux damping
const TSUB_POS = 5.217; // degC, warm-branch sub-surface temperature scale
const TSUB_NEG = 1.412; // degC, cold-branch scale (weaker: El Nino can exceed La Nina)
const TSUB_H = 23.723; // m, tanh scale of the thermocline-depth response
const TSUB_REF_H = 10; // m, typical thermocline-depth std used to remove the mean of the asymmetric Tsub
const SEASON_AMP = 0.785; // a in s(month) = 1 + a cos(2 pi (month - 8.5)/12): seasonal cold-tongue upwelling, strongest Aug-Sep
const ADV_GAIN = 1; // scales the zonal advective feedback
const SST_NOISE = 0.015; // degC/day, uniform-width white noise on each cell
const HOLD_DAYS = 10; // e-folding of the Nino-3.4 hold experiment
const SST_CEIL = 33.5; // degC, surface temperature limit: evaporation and cloud shading stop SST far above the warm-pool maximum
const SST_FLOOR = 18; // degC, cold limit of the equatorial surface: temperature of the upwelled water

// ---- Atmosphere (steady Gill on a 5 deg periodic ring) ----
export const ATM_N = 72;
const ATM_DLON = 5;
const BETA = 2.29e-11; // 1/(m s)
const ATM_C = 50; // m/s
const GILL_L = Math.sqrt(ATM_C / (2 * BETA)); // ~1045 km, Gill's (1980) length (c/2beta)^0.5: the e^{-y^2/4} modal forms below need y in this unit
const GILL_EPS = 0.1; // nondimensional damping: ~2.4 days in Gill's time unit (2 beta c)^-0.5
const ATM_DX = (ATM_DLON * KM_PER_DEG * 1000) / GILL_L;
const A_K = Math.exp(-GILL_EPS * ATM_DX);
const A_R = Math.exp(-3 * GILL_EPS * ATM_DX);
/** m/s of equatorial surface zonal wind per nondimensional Gill velocity. */
const WIND_PER_ND = 0.6;
/** Fraction of the steady Gill (lower-tropospheric) wind that acts as surface stress on the ocean; bursts and noise are surface winds already. */
const GILL_STRESS_EFF = 0.549;
/** hPa per nondimensional Gill pressure. Calibrated so Tahiti minus Darwin regresses on monthly Nino 3.4 at about -1.5 hPa per degC, the observed NCEP/NCAR slope (tests/climate-core.test.ts, "Gill pressure scale"); it was 1.6, which gave -2.95 hPa per degC (SOI about -15 per degC, twice the observed). Pressure does not feed back on the ocean, so this changes SLP, SOI and the pressure-driven coupling only. */
const HPA_PER_ND = 0.8;
const MM_DAY_PER_ND = 5; // mm/day of rain per nondimensional heating
/**
 * Walker compensation: heating west of ~160E is reduced by WALKER_COMP times the mean heating anomaly of 160E-280E
 * (descending branch of the shifted Walker cell). The compensating region is 8 cells wide and the averaging region 24,
 * so a mass-balanced cell would need 3; this value compensates about 75% of the heating. It is not a small fraction:
 * during warm events it can turn the heating west of 160E negative even where the local SST anomaly is warm.
 */
const WALKER_COMP = 2.247;
/**
 * Convective heating is a function of total SST: Q(S) = integral of smoothstep(CONV_LO, CONV_HI): zero below CONV_LO,
 * slope 1 per degC above CONV_HI (deep convection only over water warmer than ~28 C; Graham & Barnett 1987).
 * The heating anomaly Q(Tbar + T) - Q(Tbar) is linear in the warm pool and switches on in the cold tongue only when
 * T lifts the total SST over the threshold, which makes large warm events disproportionately strong.
 */
const CONV_LO = 26.265; // degC
const CONV_HI = 29.283; // degC
/** Above SAT_LO the moisture supply limits convection: the heating slope falls to zero at SAT_HI, so wind anomalies cannot grow without bound. */
const SAT_LO = 30.547; // degC
const SAT_HI = 33.567; // degC
/** degC: SST-anomaly std (west, east) assumed when removing the climatological mean of the convex heating (observed ~0.4 warm pool, ~1 Nino 3). */
const HEAT_REF_SD_W = 0.4;
const HEAT_REF_SD_E = 1.0;
const HEAT_MAX = 4; // nondimensional, about 20 mm/day: the column's moisture supply limits the convective heating anomaly a stacked SST forcing can drive
const RHO_AIR = 1.2;
const DRAG_CD = 1.3e-3;
const DRAG_U0 = 6; // m/s
const STRESS_PER_MS = RHO_AIR * DRAG_CD * DRAG_U0; // N/m^2 per m/s of wind anomaly

// ---- Stochastic forcing: state-dependent westerly wind bursts ----
export const MAX_BURSTS = 24;
const NATURAL_BURST_RESERVE = 8; // slots a player can never take, so natural bursts keep occurring
const BURST_SIGMA = 12; // deg lon, Gaussian half-width
const WWB_PER_YEAR = 5.404; // neutral-state burst rate (observed ~5-8 per year)
const WWB_RATE_PER_C = 0.466; // fractional rate increase per degC of Nino 4 (Levine & Jin 2016 multiplicative noise)
const WWB_AMP_PER_C = 0.064; // fractional speed increase per degC of Nino 4
const WWB_SPEED = 6; // m/s, mean neutral burst speed (uniform 4..8)
const WWB_DAYS = 12.5; // days, mean burst duration (uniform 5..20)
const WARM_POOL_SST = 28.5; // degC, total SST that defines the warm-pool edge
const WWB_EDGE_OFFSET = 28.033; // deg, bursts are centred this far west of the warm-pool edge (within the convecting pool)
const WWB_LON_SPREAD = 20; // deg, full width of the uniform random scatter of burst centres
const WWB_REF_SD_N4 = 0.6; // degC, Nino-4 std assumed when removing the expected burst wind (observed ~0.6)
const wwbRateOf = (n4: number): number => (WWB_PER_YEAR / 365) * clamp(1 + WWB_RATE_PER_C * n4, 0.2, 4); // per day
const wwbAmpOf = (n4: number): number => clamp(1 + WWB_AMP_PER_C * n4, 0.3, 3);
const RED_NOISE_DAYS = 12; // AR(1) e-folding of the background wind noise
const RED_NOISE_STD = 0.902; // m/s, stationary std of the background zonal wind noise
const RED_NOISE_LON = 170; // deg E, centre of its Gaussian envelope (sigma 40)

// ---- Player SST patches ----
const PULSE_WINDOW_DAYS = 30;
const MAX_RECENT_PULSES = 4; // thermocline pulses a player may apply within PULSE_WINDOW_DAYS
const MAX_PULSE_LOG = 300; // entries of the pulse log (three numbers each pulse)
export const MAX_PATCHES = 8;
/** Atmosphere-only heating patches (placed weather conditions): they heat or cool the Gill atmosphere directly and have no ocean footprint of their own. */
export const MAX_HEAT_PATCHES = 16;
/** Peak heating of one (merged) patch in nondimensional Gill units (5 units = 25 mm/day of rain). It equals HEAT_MAX, so stacking cannot exceed what a column's moisture supply allows. */
const HEAT_PATCH_MAX = HEAT_MAX;
const PATCH_NUDGE_DAYS = 2; // days, strong nudging of the ocean strip toward the imposed anomaly
const PATCH_EDGE = 0.05; // fraction of the peak below which a patch does not touch a cell
const PATCH_DECAY_DAYS = 45; // days, e-folding of the off-strip (no ocean model there) anomaly after release: mixed-layer heat-flux damping
const STRIP_LAT_E_FOLD = 9; // deg, meridional e-folding of the SST anomaly the equatorial strip represents

/** SOI scaling: SOI = 10 * (dP - mean)/sigma with dP = Tahiti - Darwin Gill SLP anomaly (mean 0 by construction); sigma ~ the observed monthly std of Tahiti-Darwin SLP (hPa). */
export const SOI_SIGMA_HPA = 2.0;

const BOXES = { nino4: [160, 210], nino34: [190, 240], nino3: [210, 270] } as const;
const TAHITI = { lon: 210.4, lat: -17.5 };
const DARWIN = { lon: 130.9, lat: -12.4 };

export interface ClimateState {
  /** false switches off wind bursts, background wind noise and SST noise (deterministic experiments). */
  readonly stochastic: boolean;
  day: number;
  seed: number;
  startDayOfYear: number;
  startYear: number;
  K: Float64Array; // Kelvin amplitude (m)
  R: Float64Array; // Rossby n=1 amplitude, equatorial value (m)
  R3: Float64Array; // slow off-equatorial Rossby (n=3) amplitude, n=1-equivalent metres
  T: Float64Array; // SST anomaly (degC)
  /** Last day's SST tendency terms per cell, degC/day. */
  tAdv: Float64Array;
  tTh: Float64Array;
  tDamp: Float64Array;
  tForce: Float64Array; // noise + hold and patch nudging
  redNoise: number; // m/s, AR(1) background wind
  bursts: Float64Array; // MAX_BURSTS x [lonEast, speed m/s, days, startDay]
  nBursts: number;
  /** Count of stochastic bursts spawned so far. */
  burstCount: number;
  tradeAnomaly: number; // m/s, easterly(+)
  hold: number | null; // degC target for Nino 3.4, or null
  patches: Float64Array; // MAX_PATCHES x [lonEast, lat, radiusDeg, deltaC, startDay, days]
  nPatches: number;
  heat: Float64Array; // MAX_HEAT_PATCHES x [lonEast, lat, radiusDeg, strength (nondimensional heating, cooling < 0), startDay, days]
  /** 1 where the patch comes from a pressure tool (low, high), which has its own pressure system in the weather layer; 0 for the others. */
  heatOwn: Float64Array;
  nHeat: number;
  pulses: number[]; // log of [day, lonEast, metres] triples
}

export interface ClimateIndices {
  nino34: number;
  nino3: number;
  nino4: number;
  /** Warm water volume: zonal mean of the meridionally integrated upper-layer anomaly, in Kelvin-equivalent metres. */
  wwv: number;
  soi: number;
  /** Nino 3.4 SST tendency budget in degC/month. */
  budget: { tendency: number; advection: number; upwelling: number; damping: number; forcing: number };
}

// ---- Calendar ----
const dayOfYear = (s: ClimateState): number => (s.startDayOfYear - 1 + s.day) % 365;
/** Fractional month 0..12 with Jan 1 = 0. */
const monthOf = (s: ClimateState): number => ((dayOfYear(s) + 0.5) / 365) * 12;
export const climateYear = (s: ClimateState): number => s.startYear + Math.floor((s.startDayOfYear - 1 + s.day) / 365);
/** Fractional month 0..12 (Jan 1 = 0) of the model day, for the monthly statistics maps. */
export const climateMonth = monthOf;

// ---- Climatology tables (lazy; land cells inherit the nearest ocean value) ----
const cellLon = (j: number): number => OCEAN_LON0 + (j + 0.5) * OCEAN_DLON;
/** Convective heating of total SST S (degC-equivalent): zero below CONV_LO, slope 1 between CONV_HI and SAT_LO, saturating at SAT_HI. */
function convHeat(sst: number): number {
  const w = CONV_HI - CONV_LO;
  const x = (sst - CONV_LO) / w;
  if (x <= 0) return 0;
  if (x < 1) return w * x * x * x * (1 - 0.5 * x);
  if (sst <= SAT_LO) return 0.5 * w + (sst - CONV_HI);
  const sw = SAT_HI - SAT_LO, y = Math.min(1, (sst - SAT_LO) / sw);
  return 0.5 * w + (SAT_LO - CONV_HI) + sw * (y - y * y * y + 0.5 * y * y * y * y);
}
/** Gauss-Hermite-like 81-point mean of f(z) over z ~ N(0, 1). */
function gaussMean(f: (z: number) => number): number {
  let sum = 0, w = 0;
  for (let i = -40; i <= 40; i++) { const z = i / 10; const g = Math.exp(-0.5 * z * z); sum += g * f(z); w += g; }
  return sum / w;
}
interface Tables { tbar: Float64Array; dtbar: Float64Array; wbar: Float64Array; qmean: Float64Array; bmean: Float64Array }
let cachedTables: Tables | null = null;
function tables(): Tables {
  if (cachedTables) return cachedTables;
  const tb = new Float64Array(12 * OCEAN_N);
  const dt = new Float64Array(12 * OCEAN_N);
  const wb = new Float64Array(OCEAN_N);
  const qm = new Float64Array(12 * OCEAN_N);
  const bm = new Float64Array(12 * OCEAN_N);
  for (let m = 0; m < 12; m++) {
    const row = tb.subarray(m * OCEAN_N, (m + 1) * OCEAN_N);
    for (let j = 0; j < OCEAN_N; j++) {
      try { row[j] = equatorNormalSst(m, cellLon(j)); } catch { row[j] = NaN; }
    }
    for (let j = 0; j < OCEAN_N; j++) {
      if (!Number.isNaN(row[j])) continue;
      let k = 1;
      while (j - k >= 0 || j + k < OCEAN_N) {
        const a = j - k >= 0 ? row[j - k] : NaN;
        const b = j + k < OCEAN_N ? row[j + k] : NaN;
        if (!Number.isNaN(a)) { row[j] = a; break; }
        if (!Number.isNaN(b)) { row[j] = b; break; }
        k++;
      }
    }
    for (let j = 0; j < OCEAN_N; j++) {
      const a = row[Math.max(0, j - 1)];
      const b = row[Math.min(OCEAN_N - 1, j + 1)];
      dt[m * OCEAN_N + j] = (b - a) / ((Math.min(OCEAN_N - 1, j + 1) - Math.max(0, j - 1)) * DX_M);
      const sd = HEAT_REF_SD_W + (HEAT_REF_SD_E - HEAT_REF_SD_W) * smoothstep(150, 220, cellLon(j));
      qm[m * OCEAN_N + j] = gaussMean((z) => convHeat(row[j] + sd * z)) - convHeat(row[j]);
    }
    // Expected burst wind: average over Nino 4 ~ N(0, WWB_REF_SD_N4) of rate x amplitude, centred on this month's warm-pool edge.
    let e = 0;
    while (e < OCEAN_N - 1 && (cellLon(e) < 150 || row[e] >= WARM_POOL_SST)) e++;
    const centre = cellLon(e) - WWB_EDGE_OFFSET;
    const gain = gaussMean((z) => wwbRateOf(WWB_REF_SD_N4 * z) * wwbAmpOf(WWB_REF_SD_N4 * z)) * WWB_DAYS * WWB_SPEED * (2 / Math.PI); // rate x mean days x mean speed x mean sine envelope
    for (let j = 0; j < OCEAN_N; j++) {
      let g = 0;
      for (let i = 0; i <= 20; i++) g += Math.exp(-0.5 * ((cellLon(j) - centre - WWB_LON_SPREAD * (i / 20 - 0.5)) / BURST_SIGMA) ** 2) / 21;
      bm[m * OCEAN_N + j] = gain * g;
    }
  }
  for (let j = 0; j < OCEAN_N; j++) wb[j] = UPWELL_MAX * (UPWELL_WEST + (1 - UPWELL_WEST) * smoothstep(UPWELL_RAMP_LO, UPWELL_RAMP_LO + 30, cellLon(j))) * (1 + UPWELL_EAST * smoothstep(215, 250, cellLon(j)));
  cachedTables = { tbar: tb, dtbar: dt, wbar: wb, qmean: qm, bmean: bm };
  return cachedTables;
}

// ---- Scratch (single-threaded, reused every day: no per-day allocation) ----
const sTbar = new Float64Array(OCEAN_N);
const sQm = new Float64Array(OCEAN_N);
const sTau = new Float64Array(OCEAN_N);
const aF = new Float64Array(ATM_N); // heating (nondimensional)
const aQ0 = new Float64Array(ATM_N);
const aQ2 = new Float64Array(ATM_N);
const aU = new Float64Array(ATM_N); // equatorial zonal wind, m/s
const sK = new Float64Array(OCEAN_N);
const sR = new Float64Array(OCEAN_N);
const sR3 = new Float64Array(OCEAN_N);
const OCEAN_TO_ATM_I0 = new Int32Array(OCEAN_N);
const OCEAN_TO_ATM_W = new Float64Array(OCEAN_N);
for (let j = 0; j < OCEAN_N; j++) {
  const f = (cellLon(j) - ATM_DLON / 2) / ATM_DLON; // atmosphere cell i is centred at 5i + 2.5
  const i0 = Math.floor(f);
  OCEAN_TO_ATM_I0[j] = i0;
  OCEAN_TO_ATM_W[j] = f - i0;
}
const SHOAL_LIMIT = new Float64Array(OCEAN_N); // m, most negative allowed h at each cell
for (let j = 0; j < OCEAN_N; j++) SHOAL_LIMIT[j] = -THERMO_SHOAL_FRACTION * (THERMO_DEPTH_W + (THERMO_DEPTH_E - THERMO_DEPTH_W) * smoothstep(150, 260, cellLon(j)));
/** Saturation of the wave field: each amplitude is bounded and the thermocline anomaly h = K + R stays inside the layer. */
function limitThermocline(s: ClimateState): void {
  for (let j = 0; j < OCEAN_N; j++) {
    s.K[j] = clamp(s.K[j], -WAVE_MAX, WAVE_MAX); s.R[j] = clamp(s.R[j], -WAVE_MAX, WAVE_MAX); s.R3[j] = clamp(s.R3[j], -WAVE_MAX, WAVE_MAX);
    const h = s.K[j] + s.R[j];
    const excess = h > THERMO_DEEP_LIMIT ? h - THERMO_DEEP_LIMIT : h < SHOAL_LIMIT[j] ? h - SHOAL_LIMIT[j] : 0;
    if (excess !== 0) { s.K[j] -= 0.5 * excess; s.R[j] -= 0.5 * excess; }
  }
}
const inBox = (box: readonly [number, number], j: number): boolean => cellLon(j) >= box[0] && cellLon(j) <= box[1];
/** Strength of the hold nudging: 1 across the Nino 3.4 box, falling off as a Gaussian outside it (sigma 20 degrees of longitude, as the earlier fixed box did), so the held SST has no sharp front. */
const HOLD_TAPER_SIGMA = 20;
const HOLD_WEIGHT = new Float64Array(OCEAN_N);
for (let j = 0; j < OCEAN_N; j++) {
  const d = Math.max(0, BOXES.nino34[0] - cellLon(j), cellLon(j) - BOXES.nino34[1]);
  HOLD_WEIGHT[j] = Math.exp(-((d / HOLD_TAPER_SIGMA) ** 2));
}

// Meridional projection of off-strip heating onto the Gill e^{-y^2/4} structure, on the 5 degree rows within 30 degrees.
const PROJ_ROW0 = 12; // row of 27.5S
const PROJ_ROWS = 12;
const PROJ_W = new Float64Array(PROJ_ROWS); // psi(lat) / sum(strip shape x psi)
const STRIP_SHAPE = new Float64Array(PROJ_ROWS); // e^{-(lat/STRIP_LAT_E_FOLD)^2}
{
  let norm = 0;
  for (let r = 0; r < PROJ_ROWS; r++) {
    const lat = -87.5 + 5 * (PROJ_ROW0 + r);
    const y = (lat * 110.57e3) / GILL_L;
    PROJ_W[r] = Math.exp(-y * y / 4);
    STRIP_SHAPE[r] = Math.exp(-((lat / STRIP_LAT_E_FOLD) ** 2));
    norm += STRIP_SHAPE[r] * PROJ_W[r];
  }
  for (let r = 0; r < PROJ_ROWS; r++) PROJ_W[r] /= norm;
}

const tsubRaw = (h: number): number => (h >= 0 ? TSUB_POS : TSUB_NEG) * Math.tanh(h / TSUB_H);
/** Mean of tsubRaw over h ~ N(0, TSUB_REF_H): subtracted so the asymmetry does not bias the (anomaly-only) mean state. */
const TSUB_BIAS = gaussMean((z) => tsubRaw(z * TSUB_REF_H));

// ---- Creation, calendar, serialisation ----
export function createClimate(seed: number, startDayOfYear = 1, startYear = 2000, stochastic = true): ClimateState {
  const state = {
    stochastic,
    day: 0,
    seed: seed >>> 0,
    startDayOfYear: Number.isFinite(startDayOfYear) ? clamp(Math.floor(startDayOfYear), 1, 365) : 1,
    startYear: Number.isFinite(startYear) ? Math.floor(startYear) : 2000,
    K: new Float64Array(OCEAN_N),
    R: new Float64Array(OCEAN_N),
    R3: new Float64Array(OCEAN_N),
    T: new Float64Array(OCEAN_N),
    tAdv: new Float64Array(OCEAN_N),
    tTh: new Float64Array(OCEAN_N),
    tDamp: new Float64Array(OCEAN_N),
    tForce: new Float64Array(OCEAN_N),
    redNoise: 0,
    bursts: new Float64Array(MAX_BURSTS * 4),
    nBursts: 0,
    burstCount: 0,
    tradeAnomaly: 0,
    hold: null,
    patches: new Float64Array(MAX_PATCHES * 6),
    nPatches: 0,
    heat: new Float64Array(MAX_HEAT_PATCHES * 6),
    heatOwn: new Float64Array(MAX_HEAT_PATCHES),
    nHeat: 0,
    pulses: [],
  };
  Object.defineProperty(state, 'stochastic', { value: stochastic, writable: false, enumerable: true }); // the mode cannot be flipped mid-run
  return state;
}

const ARRAY_KEYS = ['K', 'R', 'R3', 'T', 'tAdv', 'tTh', 'tDamp', 'tForce', 'bursts', 'patches', 'heat', 'heatOwn'] as const;
/** Plain JSON-safe copy of the whole state. */
export function serializeClimate(s: ClimateState): Record<string, unknown> {
  const o: Record<string, unknown> = {
    day: s.day, seed: s.seed, stochastic: s.stochastic, startDayOfYear: s.startDayOfYear, startYear: s.startYear, redNoise: s.redNoise,
    nBursts: s.nBursts, burstCount: s.burstCount, tradeAnomaly: s.tradeAnomaly, hold: s.hold, nPatches: s.nPatches, nHeat: s.nHeat, pulses: s.pulses.slice(),
  };
  for (const k of ARRAY_KEYS) o[k] = Array.from(s[k]);
  return o;
}
/** Rebuilds a state from serializeClimate output; returns null when the data is malformed. */
export function restoreClimate(data: unknown): ClimateState | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!num(d.day) || !num(d.seed) || !num(d.startDayOfYear) || !num(d.startYear) || !num(d.redNoise) || !num(d.nBursts) || !num(d.burstCount) || !num(d.tradeAnomaly) || !num(d.nPatches) || !num(d.nHeat)) return null;
  if (d.hold !== null && (!num(d.hold) || Math.abs(d.hold) > 5)) return null;
  if (Math.abs(d.tradeAnomaly) > 5 || !Number.isInteger(d.nBursts) || !Number.isInteger(d.nPatches) || !Number.isInteger(d.nHeat) || !Number.isInteger(d.day) || d.day < 0 || d.burstCount < 0) return null;
  if (!Array.isArray(d.pulses) || !d.pulses.every(num) || d.pulses.length % 3 !== 0 || d.pulses.length > MAX_PULSE_LOG) return null;
  for (let i = 0; i < d.pulses.length; i += 3) if (d.pulses[i] < 0 || d.pulses[i + 1] < OCEAN_LON0 || d.pulses[i + 1] > 280 || Math.abs(d.pulses[i + 2]) > 60) return null;
  if (typeof d.stochastic !== 'boolean') return null;
  const s = createClimate(d.seed, d.startDayOfYear, d.startYear, d.stochastic);
  for (const k of ARRAY_KEYS) {
    const a = d[k];
    if (!Array.isArray(a) || a.length !== s[k].length || !a.every(num)) return null;
    s[k].set(a as number[]);
  }
  if (d.nBursts < 0 || d.nBursts > MAX_BURSTS || d.nPatches < 0 || d.nPatches > MAX_PATCHES || d.nHeat < 0 || d.nHeat > MAX_HEAT_PATCHES) return null;
  for (let j = 0; j < OCEAN_N; j++) if (Math.abs(s.K[j]) > WAVE_MAX || Math.abs(s.R[j]) > WAVE_MAX || Math.abs(s.R3[j]) > WAVE_MAX || Math.abs(s.T[j]) > SST_CEIL - SST_FLOOR) return null;
  for (let b = 0; b < d.nBursts; b++) {
    const lon = s.bursts[b * 4], speed = s.bursts[b * 4 + 1], days = s.bursts[b * 4 + 2];
    if (lon < 100 || lon > 300 || Math.abs(speed) > 30 || days <= 0 || days > 60) return null;
  }
  for (let p = 0; p < d.nPatches; p++) {
    const o = p * 6, lon = s.patches[o], lat = s.patches[o + 1], r = s.patches[o + 2], dT = s.patches[o + 3], days = s.patches[o + 5];
    if (lon < 0 || lon > 360 || Math.abs(lat) > 30 || r < 2 || r > 40 || dT === 0 || Math.abs(dT) > 6 || days < 1 || days > 730) return null;
  }
  for (let p = 0; p < d.nHeat; p++) if (!isValidHeatPatch(heatPatchOf(s.heat, s.heatOwn, p)) || (s.heatOwn[p] !== 0 && s.heatOwn[p] !== 1)) return null;
  s.day = Math.max(0, Math.floor(d.day));
  s.redNoise = d.redNoise;
  s.nBursts = Math.floor(d.nBursts);
  s.burstCount = Math.floor(d.burstCount);
  s.tradeAnomaly = d.tradeAnomaly;
  s.hold = d.hold;
  s.nPatches = Math.floor(d.nPatches);
  s.nHeat = Math.floor(d.nHeat);
  s.pulses = d.pulses.slice();
  return s;
}

// ---- Player SST patches ----
const wrap180 = (d: number): number => ((((d + 180) % 360) + 360) % 360) - 180;
/** Fraction (0..1) of a patch's anomaly present on `day`: 1 while held, then the off-strip part decays. */
export function patchAmplitude(s: ClimateState, p: number, day: number): number {
  const age = day - s.patches[p * 6 + 4];
  const days = s.patches[p * 6 + 5];
  if (age < 0) return 0;
  return age < days ? 1 : Math.exp(-(age - days) / PATCH_DECAY_DAYS);
}
/** Adds the active patches' combined off-strip anomaly to the Gill heating, projected onto e^{-y^2/4}; month index m0 for the SST normals. */
function addPatchHeating(s: ClimateState, m0: number): void {
  for (let k = 0; k < ATM_N; k++) {
    const pacific = k >= 24 && k < 56;
    const col = (k + 36) % ATM_N; // normals column 0 is centred at 177.5W == 182.5E == atmosphere cell 36
    let q = 0;
    for (let rr = 0; rr < PROJ_ROWS; rr++) {
      const lat = -87.5 + 5 * (PROJ_ROW0 + rr);
      const sst = normalSst(m0, col, PROJ_ROW0 + rr);
      if (sst === null) continue;
      const keep = pacific ? 1 - STRIP_SHAPE[rr] : 1;
      let t = 0;
      for (let p = 0; p < s.nPatches; p++) {
        const o = p * 6;
        const r = s.patches[o + 2], dl = wrap180(ATM_DLON * k + 2.5 - s.patches[o]);
        if (dl * dl > 9 * r * r) continue;
        const amp = patchAmplitude(s, p, s.day);
        if (amp > 0) t += s.patches[o + 3] * amp * Math.exp(-(dl * dl + (lat - s.patches[o + 1]) * (lat - s.patches[o + 1])) / (r * r)) * keep;
      }
      if (t !== 0) q += (convHeat(clamp(sst + t, SST_FLOOR, SST_CEIL)) - convHeat(sst)) * PROJ_W[rr];
    }
    aF[k] += q;
  }
}

// Meridional projection of a heating patch onto the Gill e^{-y^2/4} structure at 1 degree spacing, 30S..30N. Normalised so that a
// field shaped like the SST strip (e-fold STRIP_LAT_E_FOLD) projects to its own equatorial value, like PROJ_W above.
const HEAT_LAT_N = 61;
const HEAT_W = new Float64Array(HEAT_LAT_N);
{
  let norm = 0;
  for (let i = 0; i < HEAT_LAT_N; i++) {
    const lat = i - 30, y = (lat * 110.57e3) / GILL_L;
    HEAT_W[i] = Math.exp(-y * y / 4);
    norm += Math.exp(-((lat / STRIP_LAT_E_FOLD) ** 2)) * HEAT_W[i];
  }
  for (let i = 0; i < HEAT_LAT_N; i++) HEAT_W[i] /= norm;
}
/** days: the atmosphere's own adjustment time, 1/GILL_EPS in Gill's time unit (2 beta c)^-1/2 = 0.242 day: the heating fades like this after its source is gone. */
const HEAT_FADE_DAYS = 0.242 / GILL_EPS;
/** Fraction (0..1) of a heat patch's strength present on `day`: 1 while its source is there, then fading with the atmosphere's adjustment time. */
const heatAmplitude = (s: ClimateState, p: number, day: number): number => {
  const age = day - s.heat[p * 6 + 4], days = s.heat[p * 6 + 5];
  return age < 0 ? 0 : age < days ? 1 : Math.exp(-(age - days) / HEAT_FADE_DAYS);
};
/** The patch's source is still there (tools placed: the condition has not yet ended). */
export const heatSourceActive = (s: ClimateState, p: number): boolean => {
  const age = s.day - s.heat[p * 6 + 4];
  return age >= 0 && age < s.heat[p * 6 + 5];
};
/** Adds the active heat patches (a Gaussian exp(-(d/r)^2) in longitude and latitude, projected onto the Gill structure within 30 degrees of the equator) to the Gill heating aF. */
function addHeatPatches(s: ClimateState, skipOwn: boolean): void {
  for (let p = 0; p < s.nHeat; p++) {
    if (skipOwn && s.heatOwn[p] === 1) continue;
    const amp = heatAmplitude(s, p, s.day);
    if (amp < 0.01) continue;
    const o = p * 6, lon0 = s.heat[o], lat0 = s.heat[o + 1], r = s.heat[o + 2], r2 = r * r;
    let lat = 0;
    for (let i = 0; i < HEAT_LAT_N; i++) { const dy = i - 30 - lat0; lat += Math.exp(-(dy * dy) / r2) * HEAT_W[i]; }
    lat *= s.heat[o + 3] * amp;
    for (let k = 0; k < ATM_N; k++) {
      const dl = wrap180(ATM_DLON * k + 2.5 - lon0);
      if (dl * dl > 9 * r2) continue;
      let lonSum = 0;
      for (let sub = -2; sub <= 2; sub++) lonSum += Math.exp(-((dl + sub) * (dl + sub)) / r2); // mean over the 5 degree cell
      aF[k] += (lat * lonSum) / 5;
    }
  }
}

// ---- Atmosphere ----
/** Fills aF/aQ0/aQ2/aU (and sTbar/sQm) from the state's SST anomaly and patches; `heat` picks which heat patches count: all, none, or all but those of pressure tools. */
function solveGill(s: ClimateState, month: number, heat: 'all' | 'none' | 'notOwn' = 'all'): void {
  const { tbar: tb, qmean: qm } = tables();
  const mf = month - 0.5 < 0 ? month + 11.5 : month - 0.5;
  const m0 = Math.floor(mf) % 12;
  const m1 = (m0 + 1) % 12;
  const w = mf - Math.floor(mf);
  for (let j = 0; j < OCEAN_N; j++) {
    sTbar[j] = tb[m0 * OCEAN_N + j] * (1 - w) + tb[m1 * OCEAN_N + j] * w;
    sQm[j] = qm[m0 * OCEAN_N + j] * (1 - w) + qm[m1 * OCEAN_N + j] * w;
  }
  aF.fill(0);
  for (let k = 24; k < 56; k++) { // Pacific strip: atmosphere cell k spans ocean cells 2(k-24), 2(k-24)+1
    const j = 2 * (k - 24);
    let q = 0;
    for (let jj = j; jj <= j + 1; jj++) q += 0.5 * (convHeat(sTbar[jj] + s.T[jj]) - convHeat(sTbar[jj]) - (s.stochastic ? sQm[jj] : 0));
    aF[k] = q;
  }
  if (s.nPatches > 0) addPatchHeating(s, w < 0.5 ? m0 : m1);
  if (heat !== 'none' && s.nHeat > 0) addHeatPatches(s, heat === 'notOwn');
  for (let k = 0; k < ATM_N; k++) aF[k] = clamp(aF[k], -HEAT_MAX, HEAT_MAX);
  let fc = 0;
  for (let k = 32; k < 56; k++) fc += aF[k]; // 160E..280E
  fc /= 24;
  for (let k = 24; k < 34; k++) aF[k] -= WALKER_COMP * fc * (1 - smoothstep(150, 170, ATM_DLON * k + 2.5));
  // Kelvin q0 (eastward): eps q + dq/dx = -F; Rossby q2 (westward): 3 eps q - dq/dx = -F. Exact periodic closed form.
  const cK = (1 - A_K) / GILL_EPS;
  const cR = (1 - A_R) / (3 * GILL_EPS);
  let q = 0;
  for (let n = 0; n < ATM_N; n++) q = A_K * q - cK * 0.5 * (aF[n] + aF[(n + ATM_N - 1) % ATM_N]);
  q = q / (1 - Math.pow(A_K, ATM_N)); // value at cell ATM_N-1 == cell -1
  for (let n = 0; n < ATM_N; n++) { q = A_K * q - cK * 0.5 * (aF[n] + aF[(n + ATM_N - 1) % ATM_N]); aQ0[n] = q; }
  q = 0;
  for (let n = ATM_N - 1; n >= 0; n--) q = A_R * q - cR * 0.5 * (aF[n] + aF[(n + 1) % ATM_N]);
  q = q / (1 - Math.pow(A_R, ATM_N)); // value at cell 0 == cell ATM_N
  for (let n = ATM_N - 1; n >= 0; n--) { q = A_R * q - cR * 0.5 * (aF[n] + aF[(n + 1) % ATM_N]); aQ2[n] = q; }
  for (let n = 0; n < ATM_N; n++) aU[n] = WIND_PER_ND * (0.5 * aQ0[n] - 1.5 * aQ2[n]);
}

/** Gill SLP anomaly (hPa) at a longitude (deg E) and latitude (deg), from the current aQ0/aQ2. */
function gillPressure(lonEast: number, latDeg: number): number {
  const y = (latDeg * 110.57e3) / GILL_L;
  const f = (((lonEast % 360) + 360) % 360 - ATM_DLON / 2) / ATM_DLON;
  const i0 = Math.floor(f);
  const w = f - i0;
  const a = ((i0 % ATM_N) + ATM_N) % ATM_N;
  const b = (a + 1) % ATM_N;
  const q0 = aQ0[a] * (1 - w) + aQ0[b] * w;
  const q2 = aQ2[a] * (1 - w) + aQ2[b] * w;
  return HPA_PER_ND * 0.5 * (q0 + q2 * (1 + y * y)) * Math.exp(-y * y / 4);
}

// ---- Daily step ----
let sN4 = 0, sBurstCentre = 0;
/** Nino 4 and the burst centre implied by SST anomaly T (needs sTbar from solveGill): the warm-pool state that sets the burst statistics. */
function warmPoolState(T: Float64Array): void {
  let n4 = 0, c4 = 0;
  for (let j = 0; j < OCEAN_N; j++) if (cellLon(j) >= BOXES.nino4[0] && cellLon(j) <= BOXES.nino4[1]) { n4 += T[j]; c4++; }
  sN4 = n4 / c4;
  let e = 0;
  while (e < OCEAN_N - 1 && (cellLon(e) < 150 || sTbar[e] + T[e] >= WARM_POOL_SST)) e++;
  sBurstCentre = cellLon(e) - WWB_EDGE_OFFSET;
}

/** Advance one model day. */
export function stepClimateDay(s: ClimateState): void {
  const { dtbar: dtb, wbar: wb, bmean: bm } = tables();
  const month = monthOf(s);
  solveGill(s, month);
  const mf = month - 0.5 < 0 ? month + 11.5 : month - 0.5;
  const m0 = Math.floor(mf) % 12;
  const m1 = (m0 + 1) % 12;
  const mw = mf - Math.floor(mf);
  const day = s.day;

  const T = s.T;
  if (s.stochastic) warmPoolState(T);

  // Wind anomaly (m/s, westerly +) at each ocean cell: Gill + trades + bursts minus their climatological expectation
  // + red noise. Deterministic runs have no random bursts and drop the noise-rectification corrections (TSUB_BIAS,
  // qmean, bmean), so T = 0 is their equilibrium.
  if (s.stochastic) s.redNoise = s.redNoise * Math.exp(-1 / RED_NOISE_DAYS) + RED_NOISE_STD * Math.sqrt(1 - Math.exp(-2 / RED_NOISE_DAYS)) * (hash01(s.seed, day, 5) + hash01(s.seed, day, 6) + hash01(s.seed, day, 7) - 1.5) * 2;
  for (let j = 0; j < OCEAN_N; j++) {
    const lon = cellLon(j);
    const f = OCEAN_TO_ATM_W[j];
    const i0 = OCEAN_TO_ATM_I0[j];
    let u = GILL_STRESS_EFF * (aU[i0] * (1 - f) + aU[i0 + 1] * f) - s.tradeAnomaly;
    if (s.stochastic) u -= bm[m0 * OCEAN_N + j] * (1 - mw) + bm[m1 * OCEAN_N + j] * mw;
    const dn = (lon - RED_NOISE_LON) / 40;
    u += s.redNoise * Math.exp(-dn * dn);
    sTau[j] = u;
  }
  let nb = 0;
  for (let b = 0; b < s.nBursts; b++) {
    const o = b * 4;
    const age = day - s.bursts[o + 3];
    if (age >= s.bursts[o + 2]) continue; // expired
    if (nb !== b) for (let q = 0; q < 4; q++) s.bursts[nb * 4 + q] = s.bursts[o + q];
    nb++;
    if (age < 0) continue;
    const amp = s.bursts[o + 1] * Math.sin((Math.PI * (age + 0.5)) / s.bursts[o + 2]);
    const lon0 = s.bursts[o];
    for (let j = 0; j < OCEAN_N; j++) {
      const d = (cellLon(j) - lon0) / BURST_SIGMA;
      if (d > -3.5 && d < 3.5) sTau[j] += amp * Math.exp(-0.5 * d * d);
    }
  }
  s.nBursts = nb;
  for (let j = 0; j < OCEAN_N; j++) sTau[j] = clamp(sTau[j], -WIND_CAP, WIND_CAP);

  // Ocean waves (upwind, dt = 1 day).
  const K = s.K, R = s.R, R3 = s.R3;
  sK.set(K); sR.set(R); sR3.set(R3);
  const damp = 1 / OCEAN_DAMP_DAYS;
  K[0] = REFLECT_W * (sR[0] + sR3[0]); // western wall
  for (let j = 1; j < OCEAN_N; j++) {
    const force = KAPPA * WIND_PROJECTION * STRESS_PER_MS * sTau[j] * DAY_S;
    K[j] = sK[j] - CFL_K * (sK[j] - sK[j - 1]) + force - sK[j] * damp;
  }
  for (let j = 0; j < OCEAN_N - 1; j++) {
    const force = KAPPA * WIND_PROJECTION * STRESS_PER_MS * sTau[j] * DAY_S;
    R[j] = sR[j] + CFL_R * (sR[j + 1] - sR[j]) - ((1 - ROSSBY3_SHARE) / 3) * force - sR[j] * damp;
    R3[j] = sR3[j] + CFL_R3 * (sR3[j + 1] - sR3[j]) - (ROSSBY3_SHARE / ROSSBY3_DIV) * force - sR3[j] * damp;
  }
  R[OCEAN_N - 1] = REFLECT_E * (1 - ROSSBY3_SHARE) * sK[OCEAN_N - 1]; // eastern wall
  R3[OCEAN_N - 1] = REFLECT_E * ROSSBY3_SHARE * sK[OCEAN_N - 1];
  limitThermocline(s);

  // SST anomaly (explicit Euler on the pre-step h, u_o).
  const seasonal = 1 + SEASON_AMP * Math.cos((2 * Math.PI * (month - 8.5)) / 12);
  const alpha = 1 / SST_DAMP_DAYS;
  let holdT = 0;
  if (s.hold !== null) holdT = s.hold;
  for (let j = 0; j < OCEAN_N; j++) {
    const h = sK[j] + sR[j];
    const uo = U_PER_M * (sK[j] - sR[j]);
    const dTbarDx = dtb[m0 * OCEAN_N + j] * (1 - mw) + dtb[m1 * OCEAN_N + j] * mw;
    const adv = -ADV_GAIN * uo * dTbarDx * DAY_S;
    const tsub = tsubRaw(h) - (s.stochastic ? TSUB_BIAS : 0);
    const th = -((wb[j] * seasonal) / MIXED_DEPTH) * (T[j] - tsub);
    const dmp = -alpha * T[j];
    let force = s.stochastic ? SST_NOISE * Math.sqrt(12) * (hash01(s.seed, day, 100 + j) - 0.5) : 0;
    if (s.hold !== null) force -= HOLD_WEIGHT[j] * (T[j] - holdT * HOLD_WEIGHT[j]) / HOLD_DAYS;
    let target = 0;
    for (let p = 0; p < s.nPatches; p++) {
      const o = p * 6;
      const age = day - s.patches[o + 4];
      if (age < 0 || age >= s.patches[o + 5]) continue;
      const dl = wrap180(cellLon(j) - s.patches[o]), r = s.patches[o + 2];
      const g = Math.exp(-(dl * dl + s.patches[o + 1] * s.patches[o + 1]) / (r * r));
      if (g >= PATCH_EDGE) target += s.patches[o + 3] * g; // overlapping patches add up, then nudge once (a sum of nudges would be unstable)
    }
    // One-sided: a warm patch only raises T to its target, a cold one only lowers it.
    if ((target > 0 && T[j] < target) || (target < 0 && T[j] > target)) force -= (T[j] - clamp(sTbar[j] + target, SST_FLOOR, SST_CEIL) + sTbar[j]) / PATCH_NUDGE_DAYS;
    s.tAdv[j] = adv; s.tTh[j] = th; s.tDamp[j] = dmp; s.tForce[j] = force;
    T[j] = clamp(T[j] + adv + th + dmp + force, SST_FLOOR - sTbar[j], SST_CEIL - sTbar[j]);
  }

  // Expire patches whose off-strip anomaly has decayed.
  let np = 0;
  for (let p = 0; p < s.nPatches; p++) {
    if (patchAmplitude(s, p, day + 1) < 0.01 && day + 1 - s.patches[p * 6 + 4] >= s.patches[p * 6 + 5]) continue;
    if (np !== p) for (let q = 0; q < 6; q++) s.patches[np * 6 + q] = s.patches[p * 6 + q];
    np++;
  }
  for (let q = np * 6; q < s.nPatches * 6; q++) s.patches[q] = 0;
  s.nPatches = np;

  // Expire heat patches once their fade-out is below 1 %.
  let nh = 0;
  for (let p = 0; p < s.nHeat; p++) {
    if (heatAmplitude(s, p, day + 1) < 0.01) continue;
    if (nh !== p) { for (let q = 0; q < 6; q++) s.heat[nh * 6 + q] = s.heat[p * 6 + q]; s.heatOwn[nh] = s.heatOwn[p]; }
    nh++;
  }
  for (let q = nh * 6; q < s.nHeat * 6; q++) s.heat[q] = 0;
  for (let q = nh; q < s.nHeat; q++) s.heatOwn[q] = 0;
  s.nHeat = nh;

  // Westerly wind bursts (multiplicative noise): rate and speed grow with Nino 4, centres follow the warm-pool edge.
  if (s.stochastic && hash01(s.seed, day, 1) < wwbRateOf(sN4) && s.nBursts < MAX_BURSTS) {
    const o = s.nBursts * 4;
    s.bursts[o] = sBurstCentre + (hash01(s.seed, day, 2) - 0.5) * WWB_LON_SPREAD;
    s.bursts[o + 1] = WWB_SPEED * (2 / 3 + (2 / 3) * hash01(s.seed, day, 4)) * wwbAmpOf(sN4);
    s.bursts[o + 2] = 5 + 15 * hash01(s.seed, day, 3);
    s.bursts[o + 3] = day + 1;
    s.nBursts++;
    s.burstCount++;
  }
  s.day = day + 1;
}

// ---- Player causes ----
/** Westerly (speed > 0) or easterly burst starting next day. Returns false and changes nothing when the input is invalid. */
function isValidBurst(b: { lonEast: number; speed: number; days: number }): boolean {
  if (!b || !Number.isFinite(b.lonEast) || !Number.isFinite(b.speed) || !Number.isFinite(b.days)) return false;
  return b.lonEast >= OCEAN_LON0 && b.lonEast <= 280 && Math.abs(b.speed) <= 15 && b.days >= 1 && b.days <= 60;
}
export function addWesterlyBurst(s: ClimateState, b: { lonEast: number; speed: number; days: number }): boolean {
  if (!isValidBurst(b)) return false;
  if (s.nBursts >= MAX_BURSTS - NATURAL_BURST_RESERVE) return false;
  const o = s.nBursts * 4;
  s.bursts[o] = b.lonEast; s.bursts[o + 1] = b.speed; s.bursts[o + 2] = b.days; s.bursts[o + 3] = s.day;
  s.nBursts++;
  return true;
}
/** Persistent trade-wind anomaly in m/s, easterly (strengthened trades) positive. */
const isValidTradeWind = (mPerS: number): boolean => typeof mPerS === 'number' && Number.isFinite(mPerS) && Math.abs(mPerS) <= 5;
export function setTradeWindAnomaly(s: ClimateState, mPerS: number): boolean {
  if (!isValidTradeWind(mPerS)) return false;
  s.tradeAnomaly = mPerS;
  return true;
}
/** Instant Gaussian (sigma 15 deg) thermocline-depth anomaly of the given peak metres, split equally into Kelvin and (n=1) Rossby parts. */
const isValidPulse = (p: { lonEast: number; metres: number }): boolean =>
  !!p && Number.isFinite(p.lonEast) && Number.isFinite(p.metres) && p.lonEast >= OCEAN_LON0 && p.lonEast <= 280 && Math.abs(p.metres) <= 60;
export function addThermoclinePulse(s: ClimateState, p: { lonEast: number; metres: number }): boolean {
  if (!isValidPulse(p)) return false;
  let recent = 0;
  for (let i = 0; i < s.pulses.length; i += 3) if (s.day - s.pulses[i] < PULSE_WINDOW_DAYS) recent++;
  if (recent >= MAX_RECENT_PULSES) return false;
  for (let j = 0; j < OCEAN_N; j++) {
    const d = (cellLon(j) - p.lonEast) / 15;
    const g = 0.5 * p.metres * Math.exp(-0.5 * d * d);
    s.K[j] += g; s.R[j] += g;
  }
  limitThermocline(s);
  s.pulses.push(s.day, p.lonEast, p.metres);
  if (s.pulses.length > MAX_PULSE_LOG) s.pulses.splice(0, s.pulses.length - MAX_PULSE_LOG);
  return true;
}
/** Nudges Nino 3.4 SST toward `value` (degC, 10-day timescale); null releases it. */
export function setSstHold(s: ClimateState, value: number | null): boolean {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 5)) return false;
  s.hold = value;
  return true;
}
/**
 * Imposes a Gaussian SST anomaly deltaC * exp(-(d/radiusDeg)^2) (d in degrees) from the next day for `days` days.
 * In the equatorial ocean strip the anomaly is a floor (warm) or ceiling (cold) enforced by 2-day nudging, then released;
 * everywhere else in the tropics it heats (or cools) the Gill atmosphere directly and decays after release.
 * Returns false and changes nothing when the input is invalid or MAX_PATCHES are active.
 */
export function addSstPatch(s: ClimateState, p: { lonEast: number; lat: number; radiusDeg: number; deltaC: number; days: number }): boolean {
  if (!p || ![p.lonEast, p.lat, p.radiusDeg, p.deltaC, p.days].every(Number.isFinite)) return false;
  if (p.lonEast < 0 || p.lonEast > 360 || Math.abs(p.lat) > 30 || p.radiusDeg < 2 || p.radiusDeg > 40 || p.deltaC === 0 || Math.abs(p.deltaC) > 6 || p.days < 1 || p.days > 730) return false;
  if (s.nPatches >= MAX_PATCHES) return false;
  const o = s.nPatches * 6;
  s.patches[o] = p.lonEast; s.patches[o + 1] = p.lat; s.patches[o + 2] = p.radiusDeg; s.patches[o + 3] = p.deltaC;
  s.patches[o + 4] = s.day; s.patches[o + 5] = Math.floor(p.days);
  s.nPatches++;
  return true;
}

/**
 * Like addSstPatch, but a patch that overlaps an active (not yet released) patch of the same sign merges with it
 * instead of taking a new slot: the anomalies add (up to the 6 C limit), the area adds (radius = root of the summed
 * squares, up to 40 degrees), the centre moves toward the stronger patch and the hold lasts as long as the longer of the two
 * (the remaining time of the old patch and the days of the new one). Stacking therefore escalates a local patch into a basin-wide one; the merged patch stays inside the
 * limits that restoreClimate checks. Falls back to addSstPatch otherwise.
 */
export function stackSstPatch(s: ClimateState, p: { lonEast: number; lat: number; radiusDeg: number; deltaC: number; days: number }): boolean {
  if (!p || ![p.lonEast, p.lat, p.radiusDeg, p.deltaC, p.days].every(Number.isFinite)) return false;
  if (p.lonEast < 0 || p.lonEast > 360 || Math.abs(p.lat) > 30 || p.radiusDeg < 2 || p.radiusDeg > 40 || p.deltaC === 0 || Math.abs(p.deltaC) > 6 || p.days < 1 || p.days > 730) return false;
  for (let i = 0; i < s.nPatches; i++) {
    const o = i * 6;
    const remaining = s.patches[o + 4] + s.patches[o + 5] - s.day;
    if (remaining <= 0 || Math.sign(s.patches[o + 3]) !== Math.sign(p.deltaC)) continue;
    const dl = wrap180(p.lonEast - s.patches[o]), dy = p.lat - s.patches[o + 1];
    if (Math.hypot(dl, dy) > s.patches[o + 2] + p.radiusDeg) continue;
    const w1 = Math.abs(s.patches[o + 3]), w2 = Math.abs(p.deltaC), f = w2 / (w1 + w2);
    s.patches[o] = (((s.patches[o] + dl * f) % 360) + 360) % 360;
    s.patches[o + 1] = s.patches[o + 1] + dy * f;
    s.patches[o + 2] = Math.min(40, Math.hypot(s.patches[o + 2], p.radiusDeg));
    s.patches[o + 3] = clamp(s.patches[o + 3] + p.deltaC, -6, 6);
    s.patches[o + 4] = s.day;
    s.patches[o + 5] = Math.min(730, Math.floor(Math.max(remaining, p.days))); // simultaneous patches do not extend each other
    return true;
  }
  return addSstPatch(s, p);
}

// ---- Atmosphere-only heating patches ----
export interface HeatPatch {
  lonEast: number; lat: number; radiusDeg: number; strength: number; days: number;
  /** The patch comes from a pressure tool (low, high) whose own pressure system the weather layer already holds; only these have their Gill pressure left out inside the footprint. */
  own?: boolean;
}
const heatPatchOf = (a: Float64Array, own: Float64Array, p: number): HeatPatch => ({ lonEast: a[p * 6], lat: a[p * 6 + 1], radiusDeg: a[p * 6 + 2], strength: a[p * 6 + 3], days: a[p * 6 + 5], own: own[p] === 1 });
export function isValidHeatPatch(p: HeatPatch): boolean {
  return !!p && [p.lonEast, p.lat, p.radiusDeg, p.strength, p.days].every(Number.isFinite)
    && p.lonEast >= 0 && p.lonEast <= 360 && Math.abs(p.lat) <= 30 && p.radiusDeg >= 2 && p.radiusDeg <= 40
    && p.strength !== 0 && Math.abs(p.strength) <= HEAT_PATCH_MAX && p.days >= 1 && p.days <= 730;
}
/**
 * Heats (strength > 0) or cools (< 0) the Gill atmosphere from the next day for `days` days with the Gaussian
 * strength * exp(-(d/radiusDeg)^2), d in degrees. Nothing happens to the ocean directly: the response is the wind, which the ocean then feels.
 * Returns false and changes nothing when the input is invalid or MAX_HEAT_PATCHES are active.
 */
export function addHeatPatch(s: ClimateState, p: HeatPatch): boolean {
  if (!isValidHeatPatch(p) || s.nHeat >= MAX_HEAT_PATCHES) return false;
  const o = s.nHeat * 6;
  s.heat[o] = p.lonEast; s.heat[o + 1] = p.lat; s.heat[o + 2] = p.radiusDeg; s.heat[o + 3] = p.strength;
  s.heat[o + 4] = s.day; s.heat[o + 5] = Math.floor(p.days);
  s.heatOwn[s.nHeat] = p.own ? 1 : 0;
  s.nHeat++;
  return true;
}
function removeHeatPatch(s: ClimateState, i: number): void {
  for (let k = i; k < s.nHeat - 1; k++) { for (let q = 0; q < 6; q++) s.heat[k * 6 + q] = s.heat[(k + 1) * 6 + q]; s.heatOwn[k] = s.heatOwn[k + 1]; }
  for (let q = (s.nHeat - 1) * 6; q < s.nHeat * 6; q++) s.heat[q] = 0;
  s.heatOwn[s.nHeat - 1] = 0;
  s.nHeat--;
}
function mergeHeatPatch(s: ClimateState, i: number, p: HeatPatch): void {
  const o = i * 6, remaining = Math.max(0, s.heat[o + 4] + s.heat[o + 5] - s.day);
  const dl = wrap180(p.lonEast - s.heat[o]), dy = p.lat - s.heat[o + 1];
  const w1 = Math.abs(s.heat[o + 3]), w2 = Math.abs(p.strength), f = w2 / (w1 + w2);
  s.heat[o] = (((s.heat[o] + dl * f) % 360) + 360) % 360;
  s.heat[o + 1] = s.heat[o + 1] + dy * f;
  s.heat[o + 2] = Math.min(40, Math.hypot(s.heat[o + 2], p.radiusDeg));
  s.heat[o + 3] = clamp(s.heat[o + 3] + p.strength, -HEAT_PATCH_MAX, HEAT_PATCH_MAX);
  s.heat[o + 4] = s.day;
  s.heat[o + 5] = Math.min(730, Math.floor(Math.max(remaining, p.days)));
}
/**
 * Like addHeatPatch, but a patch that overlaps an active patch of the same sign and kind (pressure tool or not) merges with it (the rule of stackSstPatch):
 * the strengths add (up to HEAT_PATCH_MAX), the areas add (radius = root of the summed squares, up to 40 degrees), the centre moves toward the stronger
 * patch and the heating lasts as long as the longer of the remaining time and the new days. A single patch stays local; stacked ones turn into one basin-wide forcing.
 * When all MAX_HEAT_PATCHES slots are in use, the patch takes the slot of the weakest fading one, or else merges into the nearest active patch of the same sign and kind.
 */
export function stackHeatPatch(s: ClimateState, p: HeatPatch): boolean {
  if (!isValidHeatPatch(p)) return false;
  const own = p.own ? 1 : 0;
  let nearest = -1, nearestDist = Infinity;
  for (let i = 0; i < s.nHeat; i++) {
    const o = i * 6;
    if (s.heatOwn[i] !== own || Math.sign(s.heat[o + 3]) !== Math.sign(p.strength) || s.heat[o + 4] + s.heat[o + 5] - s.day <= 0) continue;
    const d = Math.hypot(wrap180(p.lonEast - s.heat[o]), p.lat - s.heat[o + 1]);
    if (d <= s.heat[o + 2] + p.radiusDeg) { mergeHeatPatch(s, i, p); return true; }
    if (d < nearestDist) { nearestDist = d; nearest = i; }
  }
  if (s.nHeat < MAX_HEAT_PATCHES) return addHeatPatch(s, p);
  let weakest = -1, weakestAmp = Infinity;
  for (let i = 0; i < s.nHeat; i++) {
    if (heatSourceActive(s, i)) continue;
    const a = heatAmplitude(s, i, s.day);
    if (a < weakestAmp) { weakestAmp = a; weakest = i; }
  }
  if (weakest >= 0) { removeHeatPatch(s, weakest); return addHeatPatch(s, p); }
  if (nearest >= 0) { mergeHeatPatch(s, nearest, p); return true; }
  return false;
}
/**
 * Ends the patches that placed tools made, now: an SST or heat patch whose source is still there is released (its off-strip anomaly and its heating then fade out as after any
 * release); one placed within the current day is removed. Used when the fast climate path wipes the tools; the ENSO hold is not a tool and stays.
 */
export function releaseToolPatches(s: ClimateState): void {
  for (let i = s.nPatches - 1; i >= 0; i--) {
    const o = i * 6, age = s.day - s.patches[o + 4];
    if (age >= s.patches[o + 5]) continue;
    if (age < 1) { for (let k = i; k < s.nPatches - 1; k++) for (let q = 0; q < 6; q++) s.patches[k * 6 + q] = s.patches[(k + 1) * 6 + q]; for (let q = (s.nPatches - 1) * 6; q < s.nPatches * 6; q++) s.patches[q] = 0; s.nPatches--; }
    else s.patches[o + 5] = age;
  }
  for (let i = s.nHeat - 1; i >= 0; i--) {
    const age = s.day - s.heat[i * 6 + 4];
    if (age >= s.heat[i * 6 + 5]) continue;
    if (age < 1) removeHeatPatch(s, i); else s.heat[i * 6 + 5] = age;
  }
}

/**
 * Starts the ocean from an observed equatorial SST anomaly (degC per ocean cell, smoothed by the caller): sets T and puts
 * the thermocline where the Tsub relation balances it (the inverse of tsubRaw), ramped in east of 165E where upwelling
 * couples the surface to the thermocline; zero elsewhere. A live game uses this so the real ENSO state carries on.
 */
export function initialiseFromSstAnomaly(s: ClimateState, anomaly: ArrayLike<number>): void {
  const { tbar: tb } = tables();
  const month = monthOf(s);
  const mf = month - 0.5 < 0 ? month + 11.5 : month - 0.5;
  const m0 = Math.floor(mf) % 12, m1 = (m0 + 1) % 12, w = mf - Math.floor(mf);
  for (let j = 0; j < OCEAN_N; j++) {
    const t = tb[m0 * OCEAN_N + j] * (1 - w) + tb[m1 * OCEAN_N + j] * w;
    const T = clamp(Number.isFinite(anomaly[j]) ? anomaly[j] : 0, SST_FLOOR - t, SST_CEIL - t);
    s.T[j] = T;
    const x = T + (s.stochastic ? TSUB_BIAS : 0);
    const h = x >= 0 ? TSUB_H * Math.atanh(Math.min(0.95, x / TSUB_POS)) : TSUB_H * Math.atanh(Math.max(-0.95, x / TSUB_NEG));
    const ramp = smoothstep(165, 200, cellLon(j));
    s.K[j] = 0.5 * h * ramp; s.R[j] = 0.5 * h * ramp; s.R3[j] = 0;
  }
  limitThermocline(s);
}

// ---- Diagnostics ----
/** Thermocline depth (m: mean depth plus anomaly) and anomaly (m, deeper positive, K + R) at a longitude (deg E) of the equatorial strip, interpolated between cell centres; null outside 120E..280E. */
export function thermoclineAt(s: ClimateState, lonEast: number): { depth: number; anomaly: number } | null {
  if (!Number.isFinite(lonEast)) return null;
  const lon = ((lonEast % 360) + 360) % 360;
  if (lon < OCEAN_LON0 || lon > 280) return null;
  const f = clamp((lon - OCEAN_LON0) / OCEAN_DLON - 0.5, 0, OCEAN_N - 1);
  const j = Math.min(OCEAN_N - 2, Math.floor(f)), w = f - j;
  const anomaly = (s.K[j] + s.R[j]) * (1 - w) + (s.K[j + 1] + s.R[j + 1]) * w;
  return { depth: thermoclineMeanDepth(lon) + anomaly, anomaly };
}
/** Mean thermocline depth (m) at a longitude (deg E): the profile the anomaly is added to; also what a world without an ENSO layer has. */
export const thermoclineMeanDepth = (lonEast: number): number => THERMO_DEPTH_W + (THERMO_DEPTH_E - THERMO_DEPTH_W) * smoothstep(150, 260, lonEast);
/** Expected burst wind (m/s, from rate x amplitude x mean duration x mean speed x sine envelope) and its centre, given the current SST. */
export function expectedBurst(s: ClimateState): { lonEast: number; speed: number } {
  solveGill(s, monthOf(s));
  warmPoolState(s.T);
  return { lonEast: sBurstCentre, speed: wwbRateOf(sN4) * wwbAmpOf(sN4) * WWB_DAYS * WWB_SPEED * (2 / Math.PI) };
}
function boxMean(a: Float64Array, box: readonly [number, number]): number {
  let sum = 0, n = 0;
  for (let j = 0; j < OCEAN_N; j++) if (inBox(box, j)) { sum += a[j]; n++; }
  return sum / n;
}
/** Nino 3.4 (degC): the mean SST anomaly of the box. Allocation-free, for per-day use. */
export function nino34Of(s: ClimateState): number {
  return boxMean(s.T, BOXES.nino34);
}
function newClimateIndices(): ClimateIndices {
  return { nino34: 0, nino3: 0, nino4: 0, wwv: 0, soi: 0, budget: { tendency: 0, advection: 0, upwelling: 0, damping: 0, forcing: 0 } };
}
/** Fills `out` with the indices of the current state (reuses `out` and its budget object: no allocation). */
function climateIndicesInto(s: ClimateState, out: ClimateIndices): ClimateIndices {
  solveGill(s, monthOf(s));
  let wwv = 0;
  for (let j = 0; j < OCEAN_N; j++) wwv += s.K[j] + 3 * s.R[j] + ROSSBY3_DIV * s.R3[j]; // volume weights, see ROSSBY3_SHARE
  const dp = gillPressure(TAHITI.lon, TAHITI.lat) - gillPressure(DARWIN.lon, DARWIN.lat);
  const M = 30.4;
  const adv = boxMean(s.tAdv, BOXES.nino34) * M, th = boxMean(s.tTh, BOXES.nino34) * M;
  const dmp = boxMean(s.tDamp, BOXES.nino34) * M, frc = boxMean(s.tForce, BOXES.nino34) * M;
  out.nino34 = boxMean(s.T, BOXES.nino34);
  out.nino3 = boxMean(s.T, BOXES.nino3);
  out.nino4 = boxMean(s.T, BOXES.nino4);
  out.wwv = wwv / OCEAN_N;
  out.soi = (10 * dp) / SOI_SIGMA_HPA;
  const b = out.budget;
  b.tendency = adv + th + dmp + frc; b.advection = adv; b.upwelling = th; b.damping = dmp; b.forcing = frc;
  return out;
}
export function climateIndices(s: ClimateState): ClimateIndices {
  return climateIndicesInto(s, newClimateIndices());
}

// ---- Global 5 degree fields ----
export const FIELD_COLS = 72;
export const FIELD_ROWS = 36;
export interface ClimateFields { sst: Float32Array; slp: Float32Array; u: Float32Array; v: Float32Array; precip: Float32Array }
/**
 * SST (degC), SLP (hPa), zonal/meridional wind (m/s) and precipitation (mm/day) anomalies on the 72x36 5-degree grid
 * (index row*72+col, row south to north, col centres from -177.5 E). Zero poleward of 30 degrees. Reuses `out` buffers.
 * With `heatSlp` (same grid), also fills the part of the SLP anomaly that the pressure tools' (low, high) heat patches cause (full solution minus the solution without them).
 */
export function climateFields(s: ClimateState, out?: ClimateFields, heatSlp?: Float32Array): ClimateFields {
  const size = FIELD_COLS * FIELD_ROWS;
  const f = out ?? { sst: new Float32Array(size), slp: new Float32Array(size), u: new Float32Array(size), v: new Float32Array(size), precip: new Float32Array(size) };
  f.sst.fill(0); f.slp.fill(0); f.u.fill(0); f.v.fill(0); f.precip.fill(0);
  const month = monthOf(s);
  let own = false;
  for (let p = 0; p < s.nHeat; p++) if (s.heatOwn[p] === 1) own = true;
  const wantHeat = !!heatSlp && own;
  if (heatSlp) heatSlp.fill(0);
  if (wantHeat) { // the pressure of everything but the pressure tools' heat patches, to be subtracted below
    solveGill(s, month, 'notOwn');
    for (let row = 0; row < FIELD_ROWS; row++) {
      const lat = -87.5 + 5 * row, taper = 1 - smoothstep(22, 30, Math.abs(lat));
      if (taper <= 0) continue;
      const y = (lat * 110.57e3) / GILL_L, psi = Math.exp(-y * y / 4);
      for (let col = 0; col < FIELD_COLS; col++) { const i = (col + 36) % ATM_N; heatSlp![row * FIELD_COLS + col] = -taper * HPA_PER_ND * 0.5 * (aQ0[i] + aQ2[i] * (1 + y * y)) * psi; }
    }
  }
  solveGill(s, month);
  const m0 = Math.floor(month - 0.5 < 0 ? month + 11.5 : month - 0.5) % 12;
  for (let row = 0; row < FIELD_ROWS; row++) {
    const lat = -87.5 + 5 * row;
    const taper = 1 - smoothstep(22, 30, Math.abs(lat));
    if (taper <= 0) continue;
    const y = (lat * 110.57e3) / GILL_L;
    const psi = Math.exp(-y * y / 4);
    for (let col = 0; col < FIELD_COLS; col++) {
      const i = (col + 36) % ATM_N; // lon -177.5 + 5 col  ==  182.5 + 5 col  ==  atmosphere cell 36 + col
      const q0 = aQ0[i], q2 = aQ2[i], F = aF[i];
      const idx = row * FIELD_COLS + col;
      f.slp[idx] = taper * HPA_PER_ND * 0.5 * (q0 + q2 * (1 + y * y)) * psi;
      if (wantHeat) heatSlp![idx] += f.slp[idx];
      f.u[idx] = taper * WIND_PER_ND * 0.5 * (q0 + q2 * (y * y - 3)) * psi;
      f.v[idx] = taper * WIND_PER_ND * (F + 4 * GILL_EPS * q2) * y * psi;
      f.precip[idx] = taper * MM_DAY_PER_ND * F * psi;
      if (normalSst(m0, col, row) === null) continue;
      const pacific = i >= 24 && i < 56;
      const shape = Math.exp(-((lat / STRIP_LAT_E_FOLD) ** 2));
      let t = 0;
      if (pacific) { const j = 2 * (i - 24); t = 0.5 * (s.T[j] + s.T[j + 1]) * shape; }
      for (let p = 0; p < s.nPatches; p++) {
        const amp = patchAmplitude(s, p, s.day);
        if (amp <= 0) continue;
        const o = p * 6;
        const dl = wrap180(ATM_DLON * i + 2.5 - s.patches[o]), dy = lat - s.patches[o + 1], r = s.patches[o + 2];
        t += s.patches[o + 3] * amp * Math.exp(-(dl * dl + dy * dy) / (r * r)) * (pacific ? 1 - shape : 1);
      }
      const sst = normalSst(m0, col, row)!;
      f.sst[idx] = (clamp(sst + t, SST_FLOOR, SST_CEIL) - clamp(sst, SST_FLOOR, SST_CEIL)) * taper; // a normal outside the clamp range is not an anomaly
    }
  }
  return f;
}
