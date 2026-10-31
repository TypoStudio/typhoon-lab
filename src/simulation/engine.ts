/**
 * Deterministic, physically inspired (not physically exact) worldwide tropical-cyclone sandbox.
 *
 * - Environment = synthetic seeded climate + player effects. Pressure systems are Gaussian
 *   anomalies whose wind is a damped geostrophic estimate with signed Coriolis, so highs turn
 *   clockwise in the north and counter-clockwise in the south (lows the reverse).
 * - Genesis needs a disturbance (a player low) over warm, moist, low-shear ocean away from the
 *   equator. While conditions hold, its candidate accumulates hours; then a depression forms.
 * - Storms move with the storm-free steering flow averaged around them plus a poleward/westward
 *   beta drift, plus bounded mutual rotation and close-range convergence between storms.
 * - Intensity relaxes toward an SST potential intensity reduced by dry air and shear; land decays.
 *   The visible circulation widens with age, so storms grow in wind and size.
 * - Natural ocean weakening is slow, so storms outlive marginal water; player weakening restores
 *   the faster rate.
 * - Thunderstorms: short-lived convective cells start hourly (seeded hash per cell) where warm air
 *   or updraft plus moisture push the convective potential over a threshold, drift with the surface
 *   flow and damage the small share of a cell under them, even without a tropical cyclone. They need
 *   that lift: the three-condition genesis recipe and cyclones alone (no rainbands) start none.
 * - Damage keeps each cell's maximum damage ratio and only adds increases.
 *
 * Grid cells (state.grid) hold the surface field used by rendering *and* damage: u/v and pressure
 * include every storm. sampleEnvironment() returns the storm-free environment.
 */
import type {
  ActionRecord, City, ClimateKey, ClimateState, EnvironmentCell, Effect, FormationKind, GameState, GenesisCandidate, GeoPoint, HistoricEnvironment, HistoricPoint, HistoricTyphoon, NewsItem,
  LiveWeatherSnapshot, PlacementResult, Storm, StormRecord, Thunderstorm, ToolDefinition, ToolType, WeatherField,
} from '../types';
import { CITY_DAMAGE_LEVELS, cityDamageBulletin, estimateCityDamage } from './damage-news';
import { isWeatherHazardKind, WEATHER_HAZARDS } from '../data/weather-hazards';
import { applyHazardField, hazardDamageRatio, hazardInfluence, hazardPressureSystem, hazardWind, stepWeatherHazards } from './weather-hazards';
import { recordDisasterHistory, syncDisasters } from './disasters';
import { moveTornado } from './tornado-motion';
import type { WeatherHazardKind } from '../types';
import { applyTrafficDispatch, createTraffic, stepTraffic, validateTrafficDispatches } from './traffic';
import { CITIES, LAND_POLYGONS, SCENARIO } from '../data/world';
import { AGENCY_NAMES, typhoonById } from '../data/typhoons';
import { fieldsAt, sampleHistoric, windowCells } from './historic';
import { currentWeather, isLiveWeatherSnapshot, sampleLiveWeather, stepLiveWeather } from './live-weather';
import { LandIndex, clamp, cosLat, distanceKm, hash01, moveKm, offsetKm, smoothstep, wrapLon } from './geo';

export const SIMULATION_VERSION = '0.8.0';
export const REPLAY_FILE_VERSION = 6;
export const BOUNDS = { west: -180, east: 180, south: -90, north: 90 } as const;
export const STEP_HOURS = 0.25;
export const TICKS_PER_HOUR = Math.round(1 / STEP_HOURS);
export const GRID_STEP = 2;
export const GRID_COLS = Math.round((BOUNDS.east - BOUNDS.west) / GRID_STEP);
export const GRID_ROWS = Math.round((BOUNDS.north - BOUNDS.south) / GRID_STEP);
/** Live play has no action cap; these bound replay validation work. */
export const REPLAY_MAX_HOURS = 24 * 60;
export const REPLAY_MAX_TICKS = REPLAY_MAX_HOURS * TICKS_PER_HOUR;
export const REPLAY_MAX_ACTIONS = 5000;
export const MAX_ACTIVE_EFFECTS = 64;
export const MIN_HIGH_DISTANCE_KM = 300;
/** Hours of sustained favourable conditions a candidate needs before a depression forms. */
export const GENESIS_HOURS = 12;
/** A dissipated storm's remnant low: wind e-folding time (h), and the age (h since dissipation) at which it is dropped. */
export const REMNANT_TAU_HOURS = 8;
const REMNANT_MAX_HOURS = 48;
export const GENESIS_THRESHOLD = 0.9;
/** Game merger rules, separate from genesis; these are not forecast thresholds. */
export const MERGER_DISTANCE_KM = 100;
export const MERGER_MIN_AGE_HOURS = 24;
export const MERGER_MIN_WIND = 17.2;
/** Tuned game interactions, not observed universal Fujiwhara thresholds. */
export const INTERACTION_RANGE_KM = 1000;
export const MAX_INTERACTION_MS = 8;
export const MAX_NEWS = 60;
const FORECAST_HOURS = 72;
const RAMP_HOURS = 6;
const REFERENCE_PRESSURE = 1010;
const GALE = 17.2;
export const TOOL_TYPES: readonly ToolType[] = ['warm', 'moisture', 'low', 'high', 'warm-air', 'updraft', 'cool', 'dry', 'cold-air', 'downdraft', 'low-shear', 'high-shear', 'unstable-air', 'stable-air'];

// Palette order = keyboard order (1–9, 0, -, =): formation set on the first row, weakening set on the second.
export const TOOLS: ToolDefinition[] = [
  { type: 'warm', name: 'Warm water', radiusKm: 500, durationHours: 96,
    description: 'Raises sea-surface temperature by up to 2 °C and forms a weak thermal low. Ocean only. Raises potential intensity.' },
  { type: 'moisture', name: 'Moisture', radiusKm: 550, durationHours: 72,
    description: 'Moistens the mid-level air. Needed for genesis but cannot create a storm alone.' },
  { type: 'low', name: 'Low pressure', radiusKm: 650, durationHours: 72,
    description: 'Seeds a spinning disturbance. Over warm, moist, low-shear tropical ocean it can become a depression; elsewhere it bends the flow toward it.' },
  { type: 'low-shear', name: 'Low shear', radiusKm: 400, durationHours: 48,
    description: 'Calms the upper winds so a storm can stay upright. Stacking is capped at −60 m/s.' },
  { type: 'warm-air', name: 'Warm air', radiusKm: 450, durationHours: 72,
    description: 'Warms lower-level air by up to 3 °C and supports convection. Stacking is capped at +18 °C. Does not warm the ocean.' },
  { type: 'updraft', name: 'Updraft', radiusKm: 400, durationHours: 48,
    description: 'Adds up to 1 m/s of rising air to help a moist disturbance organise and grow. Stacking is capped at 9 m/s. Still needs warm ocean, moisture and a low.' },
  { type: 'cool', name: 'Cool water', radiusKm: 550, durationHours: 72,
    description: 'Cools the ocean by up to 3 °C per placement, capped at 30 °C, and forms a weak high. Cuts the storm’s ocean energy supply. Ocean only.' },
  { type: 'dry', name: 'Dry air', radiusKm: 550, durationHours: 72,
    description: 'Reduces humidity and disrupts convection. Overlap with other weakening conditions to dissipate storms faster.' },
  { type: 'high', name: 'High pressure', radiusKm: 800, durationHours: 72,
    description: 'Adds a high (clockwise north of the equator, anticlockwise south). Changes the flow that steers storms. Not within 300 km of a storm.' },
  { type: 'cold-air', name: 'Cold air', radiusKm: 450, durationHours: 72,
    description: 'Cools lower-level air by up to 3 °C, capped at 18 °C. Suppresses growth and weakens storms.' },
  { type: 'downdraft', name: 'Downdraft', radiusKm: 400, durationHours: 48,
    description: 'Adds up to 1 m/s of descending air, capped at 9 m/s. Suppresses convection and weakens storms.' },
  { type: 'high-shear', name: 'Strong shear', radiusKm: 400, durationHours: 48,
    description: 'Adds upper-level wind that tilts and tears a storm apart. Stacking is capped at +60 m/s.' },
  { type: 'unstable-air', name: 'Unstable air', radiusKm: 450, durationHours: 48,
    description: 'Increases atmospheric instability. Helps moist updrafts build thunderstorms and can intensify snowy bands.' },
  { type: 'stable-air', name: 'Stable air', radiusKm: 450, durationHours: 48,
    description: 'Stabilizes the air and suppresses convection, thunderstorms and intense snow bands.' },
];
const TOOL_BY_TYPE = new Map(TOOLS.map(t => [t.type, t]));
const EFFECT_STRENGTH: Record<ToolType, number> = { warm: 2.0, moisture: 0.22, low: -7, high: 7, 'warm-air': 3, updraft: 1, cool: 3, dry: 0.3, 'cold-air': -3, downdraft: -1, 'low-shear': -10, 'high-shear': 10, 'unstable-air': 1, 'stable-air': -1 };
export const EFFECT_STACK_LIMITS = { air: 18, vertical: 9, instability: 6, cooling: 30, drying: 3, shear: 60 } as const;
const SHEAR_STACK_CAP = EFFECT_STACK_LIMITS.shear;
/** Recipe effects stay additive; ordinary tools use the larger sandbox limits. */
function capEffect(total: number, unlimited: number, limit: number, minimum = -limit): number {
  return clamp(total - unlimited, minimum, limit) + unlimited;
}
const THERMAL_PRESSURE: Partial<Record<ToolType, number>> = { warm: -2, cool: 2 }; // hPa: warm water forms a weak thermal low, cool water a weak high

// ---------------------------------------------------------------------------------------------
// Geography and static grid
// ---------------------------------------------------------------------------------------------

let landIndex: LandIndex | null = null;
function getLandIndex(): LandIndex {
  landIndex ??= new LandIndex(LAND_POLYGONS);
  return landIndex;
}
export function isLand(lon: number, lat: number): boolean {
  return getLandIndex().contains(lon, lat);
}

export function inBounds(lon: number, lat: number): boolean {
  return Number.isFinite(lon) && Number.isFinite(lat)
    && lon >= BOUNDS.west && lon <= BOUNDS.east && lat >= BOUNDS.south && lat <= BOUNDS.north;
}

export function gridIndex(lon: number, lat: number): number {
  const i = clamp(Math.floor((wrapLon(lon) - BOUNDS.west) / GRID_STEP), 0, GRID_COLS - 1);
  const j = clamp(Math.floor((lat - BOUNDS.south) / GRID_STEP), 0, GRID_ROWS - 1);
  return j * GRID_COLS + i;
}

/**
 * Grid cells within reachKm of a point: rows clamped at the poles, columns wrapped at the dateline.
 * Calls fn(cellIndex) once per cell.
 */
function forCellsNear(lon: number, lat: number, reachKm: number, fn: (k: number) => void): void {
  const dLat = reachKm / 110.57 + GRID_STEP;
  const j0 = Math.max(0, Math.floor((lat - dLat - BOUNDS.south) / GRID_STEP));
  const j1 = Math.min(GRID_ROWS - 1, Math.floor((lat + dLat - BOUNDS.south) / GRID_STEP));
  const poleward = Math.min(89.5, Math.max(Math.abs(lat - dLat), Math.abs(lat + dLat)));
  const dLon = reachKm / (111.32 * cosLat(poleward)) + GRID_STEP;
  const ci = Math.floor((wrapLon(lon) - BOUNDS.west) / GRID_STEP);
  const span = Math.ceil(dLon / GRID_STEP);
  const all = 2 * span + 1 >= GRID_COLS;
  for (let j = j0; j <= j1; j++) {
    if (all) { for (let i = 0; i < GRID_COLS; i++) fn(j * GRID_COLS + i); continue; }
    for (let d = -span; d <= span; d++) fn(j * GRID_COLS + ((((ci + d) % GRID_COLS) + GRID_COLS) % GRID_COLS));
  }
}

interface CityShare { city: number; share: number }
interface StaticGrid { cells: { lon: number; lat: number; land: boolean; landFraction: number; population: number; cityId: string | null }[]; shares: CityShare[][] }
const CITY_SIGMA_KM = 80;
let staticGrid: StaticGrid | null = null;

function ruralDensity(lat: number): number {
  // Fictional people per fully-land 2° cell; sparse toward the poles, none on Antarctica.
  if (lat < -60) return 0;
  return 1_200_000 * (0.15 + 0.85 * smoothstep(62, 35, Math.abs(lat)));
}

/**
 * Land fraction from a scanline land mask (4×4 subsamples per cell); fictional population =
 * rural background × land fraction + each city spread over nearby land with a Gaussian kernel
 * normalised to keep the city total. Cells keep each city's share, so a cell shared by two
 * cities is apportioned, and each person is counted once.
 */
function buildStaticGrid(cities: City[]): StaticGrid {
  const sub = 4;
  const land = new Float64Array(GRID_COLS * GRID_ROWS);
  const index = getLandIndex();
  for (let j = 0; j < GRID_ROWS; j++) for (let b = 0; b < sub; b++) {
    const lat = BOUNDS.south + (j + (b + 0.5) / sub) * GRID_STEP;
    const xs = index.crossings(lat);
    let p = 0;
    for (let i = 0; i < GRID_COLS; i++) for (let a = 0; a < sub; a++) {
      const lon = BOUNDS.west + (i + (a + 0.5) / sub) * GRID_STEP;
      while (p < xs.length && xs[p] <= lon) p++;
      if (p % 2 === 1) land[j * GRID_COLS + i] += 1 / (sub * sub);
    }
  }
  const cells = Array.from({ length: GRID_COLS * GRID_ROWS }, (_, k) => {
    const lon = BOUNDS.west + ((k % GRID_COLS) + 0.5) * GRID_STEP;
    const lat = BOUNDS.south + (Math.floor(k / GRID_COLS) + 0.5) * GRID_STEP;
    return { lon, lat, land: land[k] >= 0.5, landFraction: land[k], population: ruralDensity(lat) * land[k], cityId: null as string | null };
  });
  const shares: CityShare[][] = cells.map(() => []);
  cities.forEach((city, ci) => {
    const near: { k: number; w: number }[] = [];
    let total = 0;
    forCellsNear(city.lon, city.lat, CITY_SIGMA_KM * 3, k => {
      const c = cells[k];
      if (c.landFraction <= 0) return;
      const d = distanceKm(city.lon, city.lat, c.lon, c.lat);
      const w = c.landFraction * Math.exp(-(d * d) / (2 * CITY_SIGMA_KM * CITY_SIGMA_KM));
      if (w > 1e-6) { near.push({ k, w }); total += w; }
    });
    if (total <= 0) { near.length = 0; near.push({ k: gridIndex(city.lon, city.lat), w: 1 }); total = 1; } // coast fallback
    for (const { k, w } of near) {
      const share = (city.population * w) / total;
      cells[k].population += share;
      shares[k].push({ city: ci, share });
    }
  });
  shares.forEach((list, k) => {
    let best: CityShare | null = null;
    for (const s of list) if (!best || s.share > best.share) best = s;
    if (best) cells[k].cityId = cities[best.city].id;
  });
  return { cells, shares };
}
export function getStaticGrid(): StaticGrid {
  staticGrid ??= buildStaticGrid(CITIES);
  return staticGrid;
}

// ---------------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------------

interface PressureSystem { lon: number; lat: number; amp: number; sigmaKm: number }
const SYSTEM_CUTOFF_SIGMA = 5;

const baseSystemCache = new Map<number, PressureSystem[]>();
function baseSystems(seed: number): PressureSystem[] {
  const hit = baseSystemCache.get(seed);
  if (hit) return hit;
  const j = (k: number, span: number) => (hash01(seed, 101, k) - 0.5) * 2 * span;
  const list: PressureSystem[] = [
    // Subtropical highs, north
    { lon: 150, lat: 29, amp: 9, sigmaKm: 1300 }, // western North Pacific lobe
    { lon: -150, lat: 33, amp: 10, sigmaKm: 1800 }, // North Pacific
    { lon: -40, lat: 32, amp: 10, sigmaKm: 1700 }, // Azores–Bermuda
    // Subtropical highs, south
    { lon: 80, lat: -30, amp: 9, sigmaKm: 1800 }, // Mascarene / south Indian
    { lon: -100, lat: -32, amp: 9, sigmaKm: 1900 }, // South Pacific
    { lon: -15, lat: -28, amp: 9, sigmaKm: 1500 }, // St Helena
    { lon: 170, lat: -32, amp: 7, sigmaKm: 1300 }, // Tasman / Kermadec
    // Monsoon troughs and mid-latitude troughs that let storms recurve
    { lon: 125, lat: 13, amp: -3, sigmaKm: 900 },
    { lon: 80, lat: 22, amp: -4, sigmaKm: 1200 },
    { lon: 125, lat: 47, amp: -6, sigmaKm: 1000 },
    { lon: -70, lat: 46, amp: -6, sigmaKm: 1000 },
  ].map((s, k) => ({ lon: wrapLon(s.lon + j(k * 3, 3)), lat: s.lat + j(k * 3 + 1, 2), amp: s.amp * (1 + j(k * 3 + 2, 0.12)), sigmaKm: s.sigmaKm }));
  if (baseSystemCache.size > 8) baseSystemCache.clear();
  baseSystemCache.set(seed, list);
  return list;
}

function effectWeight(e: Effect): number {
  return Math.min(1, e.ageHours / RAMP_HOURS) * Math.min(1, e.remainingHours / RAMP_HOURS);
}
function isPressureTool(type: ToolType): boolean {
  return type === 'low' || type === 'high' || type in THERMAL_PRESSURE;
}
function effectSystem(e: Effect): PressureSystem {
  return { lon: e.lon, lat: e.lat, amp: (THERMAL_PRESSURE[e.type] ?? EFFECT_STRENGTH[e.type]) * effectWeight(e), sigmaKm: e.radiusKm / 2 };
}
const SCALAR_REACH = 1.6; // scalar condition influence in units of radiusKm
function effectFalloff(e: Effect, lon: number, lat: number): number {
  const s = e.radiusKm / 2;
  const d = distanceKm(e.lon, e.lat, lon, lat);
  return d > e.radiusKm * SCALAR_REACH ? 0 : Math.exp(-(d * d) / (2 * s * s));
}

const OMEGA2 = 2 * 7.292e-5;
const SIN_FLOOR = Math.sin(10 * (Math.PI / 180));
/**
 * Pressure anomaly (hPa) and damped geostrophic wind (m/s). 1/f uses s/(s²+s0²) so the wind
 * changes sign across the equator smoothly instead of blowing up.
 */
function systemsAt(systems: PressureSystem[], lon: number, lat: number): { p: number; u: number; v: number } {
  const s = Math.sin(lat * (Math.PI / 180));
  const k = (0.45 / 1.2) * (s / (s * s + SIN_FLOOR * SIN_FLOOR)) / OMEGA2;
  let p = 0;
  let gx = 0;
  let gy = 0;
  for (const sys of systems) {
    if (sys.amp === 0) continue;
    const { dx, dy } = offsetKm(sys.lon, sys.lat, lon, lat);
    const r2 = (dx * dx + dy * dy) / (sys.sigmaKm * sys.sigmaKm);
    if (r2 > SYSTEM_CUTOFF_SIGMA * SYSTEM_CUTOFF_SIGMA) continue;
    const g = sys.amp * Math.exp(-r2 / 2);
    p += g;
    const c = (-g * 100) / (sys.sigmaKm * sys.sigmaKm * 1000); // hPa→Pa, km→m
    gx += c * dx;
    gy += c * dy;
  }
  return { p, u: -k * gy, v: k * gx };
}

function zonalBackground(lat: number): number {
  const a = Math.abs(lat);
  return -4 * (1 - smoothstep(16, 30, a)) + 10 * smoothstep(32, 45, a) * (1 - smoothstep(60, 75, a));
}

// ---------------------------------------------------------------------------------------------
// Calendar and seasons
// ---------------------------------------------------------------------------------------------

/** Day of the year (1 = Jan 1) a new world starts on: Aug 1, the peak-season state the base climate fields describe. */
export const DEFAULT_START_DOY = 213;
const YEAR_DAYS = 365.25;
const SUMMER_SOLSTICE_DOY = 172; // Jun 21
const SST_LAG = (2 * Math.PI * 35) / YEAR_DAYS; // the sea warms and cools about 35 days after the sun
const AIR_LAG = (2 * Math.PI * 20) / YEAR_DAYS;

export function isValidDayOfYear(day: unknown): day is number {
  return typeof day === 'number' && Number.isFinite(day) && day >= 0 && day < 366;
}

/** Today's day of the year (0..365.25) in the world's calendar: the start day plus model time. Never reads the real clock. */
export function dayOfYear(state: Pick<GameState, 'startDayOfYear' | 'hours'>): number {
  return (state.startDayOfYear + state.hours / 24) % YEAR_DAYS;
}

/** Day of the year (1 = Jan 1, fractional) of an ISO timestamp. */
function isoDayOfYear(iso: string): number {
  const ms = Date.parse(iso);
  return (ms - Date.UTC(new Date(ms).getUTCFullYear(), 0, 1)) / 86_400_000 + 1;
}

/**
 * The integer day the seasonal climate follows. While a historic typhoon is running it is the storm's own
 * calendar (its first best-track date plus the hours since it was loaded); otherwise the world's calendar.
 * One integer day is used by the grid and by point sampling alike, so the two always agree.
 */
function seasonDay(state: GameState): number {
  for (let k = state.historic.length - 1; k >= 0; k--) {
    const load = state.historic[k];
    if (load.finished) continue;
    const typhoon = typhoonById(load.typhoonId);
    if (typhoon) return Math.floor((isoDayOfYear(typhoon.points[0].t) + (state.hours - load.startHour) / 24) % YEAR_DAYS);
    break;
  }
  return Math.floor(dayOfYear(state));
}

/** Seasonal phase in [-1, 1]: 1 at the hemisphere's summer peak (after `lag`), opposite across the equator, blended over 5° either side. */
function seasonPhase(day: number, lat: number, lag: number): number {
  return clamp(lat / 5, -1, 1) * Math.cos((2 * Math.PI * (day - SUMMER_SOLSTICE_DOY)) / YEAR_DAYS - lag);
}

/**
 * Seasonal departures from the base climate, which is the peak-season (late-summer) state: 0 at the peak,
 * -2A at the trough. A game approximation of the annual cycle, not climatology. Sea temperature never changes
 * over land; `jet` is the extra mid-latitude westerly (m/s), a stronger jet in winter.
 */
function seasonalAt(day: number, lat: number, land: boolean): { sst: number; air: number; jet: number } {
  const a = Math.abs(lat);
  const sSst = seasonPhase(day, lat, SST_LAG);
  const sAir = seasonPhase(day, lat, AIR_LAG);
  const ampSst = 0.5 + 4 * smoothstep(10, 45, a);
  const ampAir = land ? 2 + 14 * smoothstep(10, 55, a) : 0.8 + 5.5 * smoothstep(10, 50, a);
  return {
    sst: land ? 0 : ampSst * (sSst - 1),
    air: ampAir * (sAir - 1),
    jet: 10 * smoothstep(32, 45, a) * (1 - smoothstep(60, 75, a)) * 0.3 * (1 - sAir) / 2,
  };
}
interface SeasonGrid { day: number; sst: Float64Array; air: Float64Array; jet: Float64Array }
let seasonGridCache: SeasonGrid | null = null;
/** Per-cell seasonal departures, recomputed only when the integer day changes. */
function seasonGrid(day: number): SeasonGrid {
  if (seasonGridCache?.day === day) return seasonGridCache;
  const cells = getStaticGrid().cells;
  const grid: SeasonGrid = { day, sst: new Float64Array(cells.length), air: new Float64Array(cells.length), jet: new Float64Array(cells.length) };
  cells.forEach((cell, k) => {
    const o = seasonalAt(day, cell.lat, centreLand(k)); // the point-sampling land test, so grid and sampleEnvironment agree
    grid.sst[k] = o.sst; grid.air[k] = o.air; grid.jet[k] = o.jet;
  });
  seasonGridCache = grid;
  return grid;
}

const bump = (lon: number, lat: number, lon0: number, lat0: number, sLon: number, sLat: number) =>
  Math.exp(-((wrapLon(lon - lon0) / sLon) ** 2) - ((lat - lat0) / sLat) ** 2);

function baseTemperature(seed: number, lon: number, lat: number): number {
  const a = Math.abs(lat);
  // Peak-season tropics in both hemispheres: ~29 °C to 18°, ~27.8 °C at 25°, ~18 °C at 40°.
  let t = 29.2 - 0.2 * Math.max(0, a - 18) - 0.012 * Math.max(0, a - 18) ** 2;
  t += 0.6 * bump(lon, lat, 150, 5, 30, 10); // Indo-Pacific warm pool
  t += 0.3 * bump(lon, lat, 80, 0, 25, 12);
  t -= 3.0 * bump(lon, lat, -95, -1, 25, 5); // eastern Pacific cold tongue
  t -= 2.5 * bump(lon, lat, -80, -18, 8, 10); // Humboldt
  t -= 2.5 * bump(lon, lat, 10, -22, 8, 10); // Benguela
  t -= 2.0 * bump(lon, lat, -122, 30, 8, 8); // California
  t -= 2.0 * bump(lon, lat, -18, 24, 7, 7); // Canary
  t += 1.5 * bump(lon, lat, 132 + (lat - 26) * 1.2, 30, 4, 5); // Kuroshio
  t += 1.2 * bump(lon, lat, -72 + (lat - 30) * 1.2, 34, 5, 6); // Gulf Stream
  t += (hash01(seed, 202) - 0.5) * 0.6;
  return Math.max(-1.8, t);
}
function baseHumidity(seed: number, lon: number, lat: number): number {
  const a = Math.abs(lat);
  let h = 0.62 - 0.18 * smoothstep(20, 40, a) + 0.05 * smoothstep(40, 60, a);
  h -= 0.12 * bump(lon, lat, 15, 23, 25, 8); // Sahara/Arabia outflow
  h -= 0.1 * bump(lon, lat, 135, -25, 15, 8); // Australian interior
  h += (hash01(seed, 303) - 0.5) * 0.04;
  return h;
}
function baseShear(seed: number, lon: number, lat: number): number {
  const a = Math.abs(lat);
  return 8 + 18 * smoothstep(22, 38, a) + 5 * bump(lon, lat, -95, 5, 20, 8) + (hash01(seed, 404) - 0.5) * 2;
}

// World climate (global offsets on top of the base climate and any recorded reanalysis).
const CLIMATE_RANGE: Record<ClimateKey, readonly [number, number]> = { warming: [-2, 4], enso: [-2, 2], polar: [-10, 10] };
export const CLIMATE_KEYS = Object.keys(CLIMATE_RANGE) as ClimateKey[];
export const CLIMATE_LIMITS = CLIMATE_RANGE;
/** The control value rounded to 0.1, or null when it is not a finite number inside the key's range. */
export function normalizeClimate(key: unknown, value: unknown): number | null {
  if (typeof key !== 'string' || !Object.hasOwn(CLIMATE_RANGE, key) || typeof value !== 'number' || !Number.isFinite(value)) return null;
  const [lo, hi] = CLIMATE_RANGE[key as ClimateKey];
  return value < lo || value > hi ? null : Math.round(value * 10) / 10 + 0; // + 0 turns -0 into 0
}
/**
 * 1 inside a lon/lat box, falling off as a Gaussian outside it. Longitude uses the wrapped difference to the
 * box centre, so a box (or its taper) may cross the dateline and cells stored as -180..180 or 0..360 agree.
 */
function boxTaper(lon: number, lat: number, lon0: number, lon1: number, lat0: number, lat1: number, sLon: number, sLat: number): number {
  const dLon = Math.max(0, Math.abs(wrapLon(lon - (lon0 + lon1) / 2)) - (lon1 - lon0) / 2);
  const dLat = Math.max(lat0 - lat, 0, lat - lat1);
  return Math.exp(-((dLon / sLon) ** 2) - ((dLat / sLat) ** 2));
}
/** ENSO box tapers (degrees): wide enough that the SST pattern changes by less than 0.2 °C per degree at ENSO ±2. */
const ENSO_TAPER_LON = 20;
const ENSO_TAPER_LAT = 6;
interface ClimateOffsets { sst: number; air: number; shear: number; humidity: number }
/** Offsets the climate controls add at a point. SST applies to ocean only; air, shear and humidity everywhere. */
export function climateAt(c: ClimateState, lon: number, lat: number): ClimateOffsets {
  const polar = c.polar * clamp((Math.abs(lat) - 35) / 15, 0, 1); // 0 at 35°, full from 50°
  let sst = c.warming + polar;
  let shear = 0;
  if (c.enso !== 0) {
    sst += c.enso * (1.5 * boxTaper(lon, lat, -170, -80, -6, 6, ENSO_TAPER_LON, ENSO_TAPER_LAT) - 0.8 * boxTaper(lon, lat, 120, 170, -6, 6, ENSO_TAPER_LON, ENSO_TAPER_LAT));
    shear = c.enso * (4 * boxTaper(lon, lat, 110, 170, 5, 25, ENSO_TAPER_LON, ENSO_TAPER_LAT) - 3 * boxTaper(lon, lat, -140, -95, 5, 20, ENSO_TAPER_LON, ENSO_TAPER_LAT));
  }
  return { sst, air: c.warming + polar, shear, humidity: 0.02 * c.warming };
}
interface ClimateGrid { key: string; sst: Float64Array; air: Float64Array; shear: Float64Array; humidity: number }
let climateGridCache: ClimateGrid | null = null;
/** Per-cell climate offsets, recomputed only when a control changes; null while every control is 0. */
function climateGrid(c: ClimateState): ClimateGrid | null {
  if (c.warming === 0 && c.enso === 0 && c.polar === 0) return null;
  const key = `${c.warming},${c.enso},${c.polar}`;
  if (climateGridCache?.key === key) return climateGridCache;
  const cells = getStaticGrid().cells;
  const grid: ClimateGrid = { key, sst: new Float64Array(cells.length), air: new Float64Array(cells.length), shear: new Float64Array(cells.length), humidity: 0.02 * c.warming };
  cells.forEach((cell, k) => {
    const o = climateAt(c, cell.lon, cell.lat);
    grid.sst[k] = o.sst; grid.air[k] = o.air; grid.shear[k] = o.shear;
  });
  climateGridCache = grid;
  return grid;
}

/** E-folding time (h) with which a player-driven wind departure relaxes back to the record. */
const WIND_DELTA_RELAX_HOURS = 72;
const historicEnvironments = new Map<string, HistoricEnvironment>();
/** Registers (or with null removes) the reanalysis dataset for a historic typhoon. Held outside GameState so the state stays small and serialisable. */
export function setHistoricEnvironment(typhoonId: string, data: HistoricEnvironment | null): void {
  if (data) historicEnvironments.set(typhoonId, data); else historicEnvironments.delete(typhoonId);
}
/** The environment in force: that of the most recently loaded historic typhoon that is still running and has data. */
function activeHistoric(state: GameState): { data: HistoricEnvironment; hours: number; startIso: string } | null {
  for (let k = state.historic.length - 1; k >= 0; k--) {
    const load = state.historic[k];
    if (load.finished || load.environment !== 'loaded') continue;
    const data = historicEnvironments.get(load.typhoonId);
    const typhoon = typhoonById(load.typhoonId);
    return data && typhoon ? { data, hours: state.hours - load.startHour, startIso: typhoon.points[0].t } : null;
  }
  return null;
}

export interface EnvironmentSample {
  temperature: number; airTemperature: number; airHeating: number; updraft: number; instability: number; drying: number; cooling: number; humidity: number; shear: number; pressure: number; u: number; v: number; land: boolean;
}

function allSystems(state: GameState): PressureSystem[] {
  const list: PressureSystem[] = state.initialWeather ? [] : baseSystems(state.seed).slice();
  for (const e of state.effects) if (isPressureTool(e.type)) list.push(effectSystem(e));
  for (const hazard of state.weatherHazards ?? []) list.push(hazardPressureSystem(hazard));
  return list;
}

function environmentAt(state: GameState, systems: PressureSystem[], lon: number, lat: number, land: boolean, withEffects = true): EnvironmentSample {
  const baseTemp = baseTemperature(state.seed, lon, lat);
  const season = seasonalAt(seasonDay(state), lat, land);
  let temperature = baseTemp + season.sst;
  let airHeating = 0;
  let updraft = 0;
  let instability = 0;
  let cooling = 0;
  let drying = 0;
  let shearDelta = 0;
  const unlimited = { air: 0, vertical: 0, instability: 0, cooling: 0, drying: 0, shear: 0 };
  let humidity = baseHumidity(state.seed, lon, lat) - (land ? 0.08 : 0);
  const s = systemsAt(systems, lon, lat);
  let airTemperature = baseTemp - 1.5 + season.air;
  let pressure = REFERENCE_PRESSURE + s.p;
  let u = s.u + zonalBackground(lat) + season.jet;
  let v = s.v;
  const background = currentWeather(state);
  if (background) {
    const weather = sampleLiveWeather(background, lon, lat);
    pressure = weather.p + s.p; u = weather.u + s.u; v = weather.v + s.v;
    if (!land && weather.t !== undefined) {
      temperature = weather.t + season.sst - seasonalAt(Math.floor(state.initialStartDayOfYear), lat, false).sst;
    }
    if (weather.air !== undefined) airTemperature = weather.air;
  }
  const active = activeHistoric(state);
  const h = active && sampleHistoric(active.data, active.hours, active.startIso, lon, lat);
  if (h) { // a historic typhoon is loaded: the recorded field is the base where it has data; player effects stack on top
    const added = systemsAt(state.initialWeather ? systems : systems.slice(baseSystems(state.seed).length), lon, lat);
    if (!Number.isNaN(h.t)) temperature = h.t;
    if (!Number.isNaN(h.air)) airTemperature = h.air;
    if (!Number.isNaN(h.h)) humidity = h.h;
    if (!Number.isNaN(h.p)) pressure = h.p + added.p;
    if (!Number.isNaN(h.u) && !Number.isNaN(h.v)) { u = h.u + added.u; v = h.v + added.v; }
  }
  const climate = climateAt(state.climate, lon, lat); // world climate adds on top of the base and of any recorded field
  if (!land) temperature += climate.sst;
  airTemperature += climate.air;
  humidity += climate.humidity;
  if (withEffects) for (const e of state.effects) {
    if (e.type === 'warm' && !land) temperature += EFFECT_STRENGTH.warm * effectWeight(e) * effectFalloff(e, lon, lat);
    else if (e.type === 'moisture') humidity += EFFECT_STRENGTH.moisture * effectWeight(e) * effectFalloff(e, lon, lat);
    else if (e.type === 'warm-air' || e.type === 'cold-air') {
      const delta = EFFECT_STRENGTH[e.type] * effectWeight(e) * effectFalloff(e, lon, lat);
      airHeating += delta; if (e.formation) unlimited.air += delta;
    }
    else if (e.type === 'updraft' || e.type === 'downdraft') {
      const delta = EFFECT_STRENGTH[e.type] * effectWeight(e) * effectFalloff(e, lon, lat);
      updraft += delta; if (e.formation) unlimited.vertical += delta;
    }
    else if (e.type === 'cool' && !land) {
      const delta = EFFECT_STRENGTH.cool * effectWeight(e) * effectFalloff(e, lon, lat);
      cooling += delta; if (e.formation) unlimited.cooling += delta;
    }
    else if (e.type === 'dry') {
      const delta = EFFECT_STRENGTH.dry * effectWeight(e) * effectFalloff(e, lon, lat);
      drying += delta; if (e.formation) unlimited.drying += delta;
    }
    else if (e.type === 'low-shear' || e.type === 'high-shear') {
      const delta = EFFECT_STRENGTH[e.type] * effectWeight(e) * effectFalloff(e, lon, lat);
      shearDelta += delta; if (e.formation) unlimited.shear += delta;
    }
    else if (e.type === 'unstable-air' || e.type === 'stable-air') {
      const delta = EFFECT_STRENGTH[e.type] * effectWeight(e) * effectFalloff(e, lon, lat);
      instability += delta; if (e.formation) unlimited.instability += delta;
    }
  }
  return {
    temperature: temperature - capEffect(cooling, unlimited.cooling, EFFECT_STACK_LIMITS.cooling, 0), airTemperature: airTemperature + capEffect(airHeating, unlimited.air, EFFECT_STACK_LIMITS.air), airHeating: capEffect(airHeating, unlimited.air, EFFECT_STACK_LIMITS.air), updraft: capEffect(updraft, unlimited.vertical, EFFECT_STACK_LIMITS.vertical), instability: capEffect(instability, unlimited.instability, EFFECT_STACK_LIMITS.instability), drying: capEffect(drying, unlimited.drying, EFFECT_STACK_LIMITS.drying, 0), cooling: capEffect(cooling, unlimited.cooling, EFFECT_STACK_LIMITS.cooling, 0), humidity: clamp(humidity - drying, 0, 1), shear: Math.max(0, baseShear(state.seed, lon, lat) + climate.shear + capEffect(shearDelta, unlimited.shear, SHEAR_STACK_CAP)), land,
    pressure, u, v,
  };
}

/** Storm-free environment at a point (background + player effects). */
export function sampleEnvironment(state: GameState, lon: number, lat: number): EnvironmentSample {
  return environmentAt(state, allSystems(state), wrapLon(lon), lat, isLand(lon, lat));
}

// ---------------------------------------------------------------------------------------------
// Storm physics
// ---------------------------------------------------------------------------------------------

/** Tuned convective support, neutral without the new tools; never replaces genesis gates. */
function convectionSupport(env: EnvironmentSample): number {
  return Math.max(0.1, 1 + 0.04 * clamp(env.airHeating, -EFFECT_STACK_LIMITS.air, EFFECT_STACK_LIMITS.air) + 0.12 * clamp(env.updraft, -EFFECT_STACK_LIMITS.vertical, EFFECT_STACK_LIMITS.vertical) + 0.18 * clamp(env.instability ?? 0, -EFFECT_STACK_LIMITS.instability, EFFECT_STACK_LIMITS.instability));
}

/** Genesis potential: warm sea, moist air, low shear and spin. No latitude factor: a storm may form on the equator. */
export function genesisPotential(env: EnvironmentSample, lat: number): number {
  if (env.land) return 0;
  const thermal = clamp((env.temperature - 26) / 2.5, 0, 1.4);
  const moist = clamp((env.humidity - 0.5) / 0.25, 0, 1.4);
  const shearF = clamp(1 - (env.shear - 6) / 14, 0, 1);
  const spin = clamp(1 + (REFERENCE_PRESSURE - env.pressure) / 10, 0.3, 1.4);
  return thermal * moist * shearF * spin * convectionSupport(env);
}

export interface FormationGuide {
  readings: { sst: number; airTemperature: number; humidity: number; shear: number; pressure: number; instability: number; land: boolean };
  /** Genesis potential now, with every placed effect at full weight. */
  potential: number;
  /** Genesis potential once the recommended stack is also in place. */
  projected: number;
  ok: boolean;
  /** The recommended placements in order, one entry per tool to place. */
  placements: ToolType[];
  land: boolean;
  maxEffects: boolean;
  threshold: number;
  scoreLabel: string;
  requiresSea: boolean;
  note?: string;
  cold?: boolean;
  impossibleShear?: boolean;
}
export interface FormationAdvice extends FormationGuide {
  recipe: { warm: number; moisture: number; low: number; lowShear: number; warmAir: number; updraft: number };
  cold: boolean;
  impossibleShear: boolean;
}
const ADVICE_SST = 27.5;
const ADVICE_HUMIDITY = 0.75;

/** The state with every effect (and any extra tool placed here) at full weight, for planning. */
function atFullWeight(state: GameState, extra: ToolType[], lon: number, lat: number, formation: FormationKind = 'typhoon'): GameState {
  const full = state.effects.map(e => ({ ...e, ageHours: RAMP_HOURS, remainingHours: Math.max(RAMP_HOURS, e.remainingHours) }));
  for (const type of extra) full.push({ id: 0, type, lon, lat, radiusKm: TOOL_BY_TYPE.get(type)!.radiusKm, remainingHours: RAMP_HOURS, ageHours: RAMP_HOURS, formation });
  return { ...state, effects: full };
}

/** Add only as many uncapped recipe tools as the actual local deficit needs. */
function fillRecipe(state: GameState, placements: ToolType[], kind: FormationKind, lon: number, lat: number,
  sites: readonly GeoPoint[], type: ToolType, target: number, read: (env: EnvironmentSample) => number): void {
  const tool = TOOL_BY_TYPE.get(type)!;
  const strength = Math.abs(EFFECT_STRENGTH[type]);
  for (;;) {
    const projected = atFullWeight(state, placements, lon, lat, kind);
    let needed = 0;
    for (const site of sites) {
      const deficit = target - read(sampleEnvironment(projected, site.lon, site.lat));
      if (deficit > 1e-8) {
        const falloff = effectFalloff({ ...tool, id: 0, lon, lat, ageHours: RAMP_HOURS, remainingHours: RAMP_HOURS }, site.lon, site.lat);
        needed = Math.max(needed, Math.ceil(deficit / (strength * falloff)));
      }
    }
    if (!needed) return;
    for (let i = 0; i < needed; i++) placements.push(type);
  }
}

/** Terrain is the only eligibility gate; deficits determine the unrestricted stack. */
export function formationRecipe(state: GameState, lon: number, lat: number): FormationAdvice {
  const x = wrapLon(lon), site = { lon: x, lat };
  const env = sampleEnvironment(atFullWeight(state, [], x, lat), x, lat);
  const placements: ToolType[] = [];
  const fill = (type: ToolType, target: number, read: (e: EnvironmentSample) => number) =>
    fillRecipe(state, placements, 'typhoon', x, lat, [site], type, target, read);
  if (!env.land) {
    fill('warm', ADVICE_SST, e => e.temperature);
    fill('moisture', ADVICE_HUMIDITY, e => e.humidity);
    fill('low-shear', -6, e => -e.shear);
    // Keep a durable disturbance at this point, or seed one if none is present.
    if (!state.effects.some(e => e.type === 'low' && e.remainingHours >= 24 && distanceKm(e.lon, e.lat, x, lat) < 30)) placements.push('low');
    const projected = sampleEnvironment(atFullWeight(state, placements, x, lat), x, lat);
    if (genesisPotential(projected, lat) < 1.3) {
      fill('warm', 29, e => e.temperature);
      fill('moisture', 0.85, e => e.humidity);
      fill('warm-air', 0, e => e.airHeating);
      fill('unstable-air', 0, e => e.instability);
      fill('updraft', 2, e => e.updraft);
    }
    // Even opposing highs and fully stacked weakening tools cannot veto a sea recipe.
    if (genesisPotential(sampleEnvironment(atFullWeight(state, placements, x, lat), x, lat), lat) < 1.3) {
      fill('warm', 30, e => e.temperature);
      fill('moisture', 0.9, e => e.humidity);
      fill('warm-air', 6, e => e.airHeating);
      fill('unstable-air', 1, e => e.instability);
      fill('updraft', 8, e => e.updraft);
    }
  }
  const count = (type: ToolType) => placements.filter(t => t === type).length;
  const recipe = { warm: count('warm'), moisture: count('moisture'), low: count('low'), lowShear: count('low-shear'),
    warmAir: count('warm-air'), updraft: count('updraft') };
  const projected = env.land ? 0 : genesisPotential(sampleEnvironment(atFullWeight(state, placements, x, lat), x, lat), lat);
  return { readings: guideReadings(env), potential: genesisPotential(env, lat), projected, ok: !env.land && projected >= GENESIS_THRESHOLD,
    recipe, placements, land: env.land, cold: !env.land && env.temperature < 20, impossibleShear: false, maxEffects: false,
    threshold: GENESIS_THRESHOLD, scoreLabel: 'Formation score', requiresSea: true };
}

function guideReadings(env: EnvironmentSample): FormationGuide['readings'] {
  return { sst: env.temperature, airTemperature: env.airTemperature, humidity: env.humidity,
    shear: env.shear, pressure: env.pressure, instability: env.instability, land: env.land };
}

/** A blizzard is diagnosed from the actual snow and wind field near the chosen point. */
function blizzardCellsNear(state: GameState, lon: number, lat: number): number {
  let count = 0;
  forCellsNear(lon, lat, 800, k => {
    const c = state.grid[k];
    if (c.blizzard && distanceKm(lon, lat, c.lon, c.lat) <= 800) count++;
  });
  return count;
}

function projectedBlizzardCells(state: GameState, placements: ToolType[], lon: number, lat: number): number {
  const projected = atFullWeight(state, placements, lon, lat, 'blizzard');
  const copy = { ...projected, grid: projected.grid.map(c => ({ ...c })) };
  refreshGrid(copy);
  return blizzardCellsNear(copy, lon, lat);
}

export function blizzardRecipe(state: GameState, lon: number, lat: number): FormationGuide {
  const x = wrapLon(lon);
  const env = sampleEnvironment(atFullWeight(state, [], x, lat), x, lat);
  const placements: ToolType[] = [];
  // Snow and gale wind must coincide in an actual cell, away from the calm low centre.
  let cell = state.grid[gridIndex(x, lat)], closest = Infinity;
  forCellsNear(x, lat, 400, k => {
    const candidate = state.grid[k], distance = distanceKm(x, lat, candidate.lon, candidate.lat);
    if (distance >= 150 && distance < closest) { cell = candidate; closest = distance; }
  });
  const sites = [{ lon: x, lat }, cell];
  fillRecipe(state, placements, 'blizzard', x, lat, sites, 'moisture', 0.9, e => e.humidity);
  fillRecipe(state, placements, 'blizzard', x, lat, sites, 'cold-air', 4, e => -e.airTemperature);
  // The low also supplies frontal precipitation. Its count adapts to latitude and land friction.
  let extra = 1;
  for (;;) {
    const projected = atFullWeight(state, placements, x, lat, 'blizzard');
    const wind = totalWind(projected, cell.lon, cell.lat);
    const pressure = sampleEnvironment(projected, cell.lon, cell.lat).pressure;
    const before = sampleEnvironment({ ...projected, effects: [] }, cell.lon, cell.lat).pressure;
    if (Math.hypot(wind.u, wind.v) >= 22 && before - pressure >= 12) break;
    for (let i = 0; i < extra; i++) placements.push('low');
    extra *= 2;
  }
  const potential = blizzardCellsNear(state, x, lat);
  const projected = projectedBlizzardCells(state, placements, x, lat);
  return { readings: guideReadings(env), potential, projected, ok: projected > 0, placements,
    land: env.land, maxEffects: false, threshold: 1, scoreLabel: 'Blizzard cells nearby', requiresSea: false };
}

/** Enough rotating, moist convection for an existing thunderstorm to develop a tornado. */
export function tornadoPotential(env: EnvironmentSample): number {
  const convection = convectivePotential(env.humidity, env.airHeating, env.updraft, env.airTemperature, env.instability);
  return Math.max(0, Math.min(convection / 1.2, env.humidity / 0.68, env.shear / 14, env.instability / 0.65));
}

export function tornadoRecipe(state: GameState, lon: number, lat: number): FormationGuide {
  const x = wrapLon(lon);
  const env = sampleEnvironment(atFullWeight(state, [], x, lat), x, lat);
  const placements: ToolType[] = [];
  // Include the sampled grid cell and room for the developing thunderstorm to drift.
  const sites = [{ lon: x, lat }, state.grid[gridIndex(x, lat)],
    ...[[150, 0], [-150, 0], [0, 150], [0, -150]].map(([east, north]) => moveKm(x, lat, east, north))];
  const fill = (type: ToolType, target: number, read: (e: EnvironmentSample) => number) =>
    fillRecipe(state, placements, 'tornado', x, lat, sites, type, target, read);
  fill('warm-air', 28, e => e.airTemperature);
  fill('moisture', 0.9, e => e.humidity);
  fill('high-shear', 22, e => e.shear);
  fill('unstable-air', 1.5, e => e.instability);
  fill('updraft', 3, e => e.updraft);
  // An updraft owns the guaranteed outbreak, even if other tools already provide enough lift.
  if (!placements.includes('updraft')) placements.push('updraft');
  const projected = tornadoPotential(sampleEnvironment(atFullWeight(state, placements, x, lat, 'tornado'), x, lat));
  return { readings: guideReadings(env), potential: tornadoPotential(env), projected, ok: projected >= 1, placements,
    land: env.land, maxEffects: false, threshold: 1, scoreLabel: 'Tornado potential', requiresSea: false };
}

/** Unrestricted condition recipes for the seven non-cyclone weather phenomena. */
export function weatherHazardRecipe(state: GameState, kind: WeatherHazardKind, lon: number, lat: number): FormationGuide {
  const x = wrapLon(lon), definition = WEATHER_HAZARDS[kind];
  const env = sampleEnvironment(atFullWeight(state, [], x, lat, kind), x, lat);
  const placements: ToolType[] = [];
  const allowed = !definition.landOnly || env.land;
  const sites = [{ lon: x, lat }, state.grid[gridIndex(x, lat)]];
  const fill = (type: ToolType, target: number, read: (e: EnvironmentSample) => number) =>
    fillRecipe(state, placements, kind, x, lat, sites, type, target, read);
  const readiness = (e: EnvironmentSample): number => clamp(kind === 'heatwave' ? (e.airTemperature - 25) / 15
    : kind === 'coldwave' ? (5 - e.airTemperature) / 20
    : kind === 'drought' || kind === 'dust' ? (0.6 - e.humidity) / 0.5
    : kind === 'gust' ? -e.updraft / 5
    : Math.min(e.humidity / 0.9, e.updraft / (kind === 'hail' ? 5 : 4)), 0, 1);
  if (allowed) {
    if (kind === 'heatwave') { fill('warm-air', 40, e => e.airTemperature); fill('dry', -0.25, e => -e.humidity); }
    else if (kind === 'coldwave') fill('cold-air', 18, e => -e.airTemperature);
    else if (kind === 'drought' || kind === 'dust') {
      fill('dry', -0.1, e => -e.humidity); fill('stable-air', 1, e => -e.instability);
    } else if (kind === 'gust') { fill('downdraft', 5, e => -e.updraft); fill('moisture', 0.8, e => e.humidity); }
    else {
      fill('moisture', 0.95, e => e.humidity);
      fill('warm-air', 20, e => e.airTemperature);
      fill('updraft', kind === 'hail' ? 5 : 4, e => e.updraft);
      fill('unstable-air', kind === 'hail' ? 2 : 1, e => e.instability);
    }
    // An anchor is kept even when the surrounding climate already meets all conditions.
    if (!placements.includes(definition.anchor)) placements.push(definition.anchor);
  }
  const projected = sampleEnvironment(atFullWeight(state, placements, x, lat, kind), x, lat);
  return { readings: guideReadings(env), potential: readiness(env), projected: allowed ? readiness(projected) : 0,
    ok: allowed, placements, land: env.land, maxEffects: false, threshold: 1, scoreLabel: 'Event readiness', requiresSea: false,
    note: allowed ? 'Place the recipe. The phenomenon begins after conditions build for six model hours.' : 'This phenomenon needs land. Pick a land spot.' };
}

/** Thermodynamic ceiling (m/s, 10-min mean) from SST. */
export function potentialIntensity(sst: number): number {
  return Math.max(0, 18 + 14 * (sst - 26));
}

/** e-folding hours of ocean weakening toward a lower ceiling (natural shear loss scales alike):
 * 96 h with no weakening conditions; one full-strength weakening condition restores the original
 * 20 h, which is also the floor, so stacked conditions weaken exactly as before. */
export const NATURAL_DECAY_HOURS = 96;
const INTERVENTION_DECAY_HOURS = 20;

/** Intensity tendency (m/s per hour) for a formed storm. landFraction in [0,1] under the core. */
export function intensityTendency(env: EnvironmentSample, wind: number, landFraction: number): number {
  const moist = clamp((env.humidity - 0.35) / 0.25, 0, 1);
  const shearF = clamp(1 - (env.shear - 8) / 18, 0, 1);
  const spin = clamp(1 + (REFERENCE_PRESSURE - env.pressure) / 30, 0.9, 1.15);
  const cold = Math.max(0, -env.airHeating);
  const sinking = Math.max(0, -env.updraft);
  const suppression = clamp(1 - 0.1 * cold - 0.15 * sinking, 0, 1);
  const damping = 0.2 * cold + 0.4 * sinking + 1.5 * env.drying;
  const target = suppression * potentialIntensity(env.temperature) * Math.min(1, (0.25 + 0.75 * moist) * shearF * spin);
  const intervention = env.cooling / 3 + cold / 3 + sinking + 3 * env.drying; // ~1 per full tool
  const decayHours = Math.max(INTERVENTION_DECAY_HOURS, NATURAL_DECAY_HOURS / (1 + (NATURAL_DECAY_HOURS / INTERVENTION_DECAY_HOURS - 1) * intervention));
  // Weak vortices organise slowly; mature ones approach the ceiling faster.
  const ocean = wind < target ? ((target - wind) / 30) * clamp(wind / 35, 0.35, 1) * convectionSupport(env) : -(wind - target) / decayHours;
  const shearHit = -0.05 * Math.max(0, env.shear - 16) * (INTERVENTION_DECAY_HOURS / decayHours);
  const land = -0.075 * Math.max(0, wind - 7); // Kaplan–DeMaria style inland decay, softened for play
  return (1 - landFraction) * (ocean + shearHit - damping) + landFraction * (land - damping);
}

export function blizzardDamageRatio(snowCm: number, wind: number): number {
  const v = Math.max(0, snowCm - 20) / 40; // snow load: 0 below 20 cm, 0.5 at 60 cm, 0.8 at 100 cm; wind scales it 0.5x..1.5x
  const load = (v * v) / (1 + v * v);
  return load * clamp((wind - 5) / 10, 0.5, 1.5);
}

export function damageRatio(wind: number): number {
  const vn = Math.max(0, wind - 20) / 35; // game curve: 0 below 20 m/s, 0.5 at 55 m/s
  const v3 = vn * vn * vn;
  return v3 / (1 + v3);
}

/** The part of a storm that shapes its vortex; a dissipated storm's remnant has just these. */
type Vortex = Pick<Storm, 'id' | 'lon' | 'lat' | 'wind' | 'radiusKm' | 'ageHours'>;
const NO_MOTION = { u: 0, v: 0 };

/** Outer wind profile exponent: young storms are compact, older ones broaden (visible growth). */
function profileExp(storm: Vortex): number {
  return 0.75 - 0.25 * clamp(storm.ageHours / 96, 0, 1);
}
/** Radius (km) where the circulation fades to zero; grows with age. */
export function outerRadiusKm(storm: Vortex): number {
  return 500 + 1000 * clamp(storm.ageHours / 96, 0, 1);
}
function rmwKm(wind: number, lat: number): number {
  return clamp(95 - 1.0 * wind + 0.8 * (Math.abs(lat) - 15), 18, 110);
}
function vortexSpeed(storm: Vortex, r: number): number {
  const rm = storm.radiusKm;
  const outer = outerRadiusKm(storm);
  const base = r < rm ? storm.wind * (r / rm) : storm.wind * (rm / r) ** profileExp(storm);
  return base * (1 - smoothstep(outer * 0.6, outer, r));
}
function galeRadius(storm: Storm): number {
  if (storm.wind <= GALE) return 0;
  return Math.min(outerRadiusKm(storm) * 0.6, storm.radiusKm * (storm.wind / GALE) ** (1 / profileExp(storm)));
}
/** Central pressure deficit (hPa) below the local environment, Atkinson–Holliday style. */
export function pressureDeficit(wind: number): number {
  return Math.min(850, Math.max(0, (wind * 1.944) / 6.7) ** (1 / 0.644)); // floor keeps pressure positive at extreme winds
}

// ---------------------------------------------------------------------------------------------
// Historic typhoons: a recorded (JMA, NHC or IBTrACS best-track) typhoon replaces the storm's motion and intensity.
// ---------------------------------------------------------------------------------------------

/** Recorded wind (m/s); an estimate from central pressure (inverse of pressureDeficit, floored at 13) where the record has none. */
function recordedWind(p: HistoricPoint): number {
  return p.windMs ?? Math.max(13, (6.7 * Math.max(0, REFERENCE_PRESSURE - p.pressure) ** 0.644) / 1.944);
}

const trackHoursCache = new Map<string, number[]>();
/** Hours of each recorded point after the first one. */
function trackHours(typhoon: HistoricTyphoon): number[] {
  let hours = trackHoursCache.get(typhoon.id);
  if (!hours) {
    const t0 = Date.parse(typhoon.points[0].t);
    hours = typhoon.points.map(p => (Date.parse(p.t) - t0) / 3_600_000);
    trackHoursCache.set(typhoon.id, hours);
  }
  return hours;
}

/** Recorded state `hours` after the first point, linear in time (rows are not evenly spaced); null past the last point. */
export function trackAt(typhoon: HistoricTyphoon, hours: number): { lon: number; lat: number; wind: number; pressure: number } | null {
  const th = trackHours(typhoon);
  if (hours > th[th.length - 1] + 1e-9) return null;
  let k = 1;
  while (k < th.length - 1 && th[k] < hours) k++;
  const a = typhoon.points[k - 1];
  const b = typhoon.points[k];
  const f = clamp((hours - th[k - 1]) / (th[k] - th[k - 1]), 0, 1);
  const wa = recordedWind(a);
  return {
    lon: wrapLon(a.lon + wrapLon(b.lon - a.lon) * f), lat: a.lat + (b.lat - a.lat) * f,
    wind: wa + (recordedWind(b) - wa) * f, pressure: a.pressure + (b.pressure - a.pressure) * f,
  };
}

/** Basin name for the strongest class, from the storm's position. */
function strongName(lon: number, lat: number): string {
  if (lat >= 0 && lon >= 100) return 'Typhoon';
  if (lat >= 0 && lon < -30) return 'Hurricane';
  return 'Cyclone';
}
const STAGE_WINDS = [0, 17.2, 24.5, 32.7, 44, 54];
/** Grades 0-5 follow STAGE_WINDS; above that a new grade starts every 10 m/s (64 -> 6, 74 -> 7, ...) with no upper bound. */
export function stageRank(wind: number): number {
  if (wind >= 64) return 6 + Math.floor((wind - 64) / 10);
  let r = 0;
  for (let k = 0; k < STAGE_WINDS.length; k++) if (wind >= STAGE_WINDS[k]) r = k;
  return r;
}
export function stageFor(wind: number, lon = 140, lat = 15): string {
  const strong = strongName(lon, lat);
  const rank = stageRank(wind);
  if (rank >= 6) return `Grade ${rank} ${strong}`;
  return ['Tropical Depression', 'Tropical Storm', 'Severe Tropical Storm', strong, `Very Strong ${strong}`, `Violent ${strong}`][rank];
}

/** Cyclonic rotation sign: +1 counter-clockwise (north), -1 clockwise (south). */
const spinSign = (lat: number) => (lat >= 0 ? 1 : -1);

export function stormVortexAt(storm: Vortex, motion: { u: number; v: number }, lon: number, lat: number): { u: number; v: number; dp: number } {
  const { dx, dy } = offsetKm(storm.lon, storm.lat, lon, lat);
  const r = Math.hypot(dx, dy);
  const outer = outerRadiusKm(storm);
  if (r > outer) return { u: 0, v: 0, dp: 0 };
  const dp = -pressureDeficit(storm.wind) * (1 - Math.exp(-((storm.radiusKm / Math.max(r, 1)) ** 1.5))) * (1 - smoothstep(outer * 0.6, outer, r));
  if (r < 0.5) return { u: 0, v: 0, dp };
  const speed = vortexSpeed(storm, r);
  const sgn = spinSign(storm.lat);
  const tx = (-dy / r) * sgn;
  const ty = (dx / r) * sgn;
  const inflow = 0.34; // ~20° inflow angle
  const asym = speed > 0 ? 0.5 * Math.min(1, storm.radiusKm / Math.max(r, storm.radiusKm)) : 0;
  return {
    u: speed * (Math.cos(inflow) * tx - Math.sin(inflow) * (dx / r)) + asym * motion.u,
    v: speed * (Math.cos(inflow) * ty - Math.sin(inflow) * (dy / r)) + asym * motion.v,
    dp,
  };
}

const STEER_RING_KM = 400;
function steeringAt(systems: PressureSystem[], p0: GeoPoint, wind: number, day: number, weather?: WeatherField): { u: number; v: number } {
  let u = 0;
  let v = 0;
  const n = 8;
  for (let k = 0; k <= n; k++) {
    const p = k === n ? p0 : moveKm(p0.lon, p0.lat, STEER_RING_KM * Math.cos((k * Math.PI * 2) / n), STEER_RING_KM * Math.sin((k * Math.PI * 2) / n));
    const s = systemsAt(systems, p.lon, p.lat);
    const initial = weather && sampleLiveWeather(weather, p.lon, p.lat);
    u += s.u + (initial ? initial.u : zonalBackground(p.lat) + seasonalAt(day, p.lat, false).jet);
    v += s.v + (initial ? initial.v : 0);
  }
  // Game beta drift: westward and poleward, stronger for stronger vortices.
  const beta = 0.6 + 0.6 * clamp(wind / 40, 0, 1);
  return { u: u / (n + 1) - 1.0 * beta, v: v / (n + 1) + 1.5 * beta * spinSign(p0.lat) };
}

/** Shared steering for live motion, surface-field asymmetry and coupled forecasts.
 * Other same-hemisphere storms induce rotation; closer pairs also converge. A softened
 * core avoids singular speeds, and young pairs ramp in without losing independent births.
 * Sum in stable ID order, then cap the combined perturbation for crowded worlds.
 */
function coupledSteering(systems: PressureSystem[], storm: Storm, neighbours: Storm[], day: number, weather?: WeatherField): { u: number; v: number } {
  const base = steeringAt(systems, storm, storm.wind, day, weather);
  let u = 0;
  let v = 0;
  for (const other of [...neighbours].sort((a, b) => a.id - b.id)) {
    if (other.id === storm.id || spinSign(other.lat) !== spinSign(storm.lat)) continue;
    const { dx, dy } = offsetKm(other.lon, other.lat, storm.lon, storm.lat);
    const r = Math.hypot(dx, dy);
    if (r < 1e-6 || r >= INTERACTION_RANGE_KM) continue;
    const maturity = smoothstep(0, MERGER_MIN_AGE_HOURS, Math.min(storm.ageHours, other.ageHours));
    const core = Math.max(60, other.radiusKm * 2);
    const speed = 0.4 * other.wind * other.radiusKm * r / (r * r + core * core)
      * (1 - smoothstep(500, INTERACTION_RANGE_KM, r)) * maturity;
    const inward = 0.5 * (1 - smoothstep(200, 500, r));
    const spin = spinSign(other.lat);
    u += speed * (-spin * dy - inward * dx) / r;
    v += speed * (spin * dx - inward * dy) / r;
  }
  const scale = Math.min(1, MAX_INTERACTION_MS / (Math.hypot(u, v) || 1));
  return { u: base.u + u * scale, v: base.v + v * scale };
}

/** Instantaneous steering velocity (m/s), excluding the storm's own circulation. */
export function steeringFlow(state: GameState, storm: Storm | undefined = state.storms[0]): { u: number; v: number } {
  if (!storm) return { u: 0, v: 0 };
  return coupledSteering(allSystems(state), storm, state.storms, seasonDay(state), currentWeather(state));
}

const motionCache = new WeakMap<GameState, { tick: number; key: string; motions: { u: number; v: number }[] }>();
function stormMotions(state: GameState, systems?: PressureSystem[]): { u: number; v: number }[] {
  const key = state.storms.map(s => `${s.id}:${s.lon}:${s.lat}:${s.wind}:${s.radiusKm}:${s.ageHours}`).join('|')
    + '#' + state.effects.map(e => `${e.id}:${e.ageHours}`).join(',');
  const c = motionCache.get(state);
  if (c && c.tick === state.tick && c.key === key) return c.motions;
  const sys = systems ?? allSystems(state);
  const day = seasonDay(state);
  const motions = state.storms.map(s => coupledSteering(sys, s, state.storms, day, currentWeather(state)));
  motionCache.set(state, { tick: state.tick, key, motions });
  return motions;
}

/** 10 m wind over land is roughly 30 % weaker than over sea for the same pressure gradient (surface roughness). */
export const LAND_WIND_FACTOR = 0.7;

/** Surface wind (m/s, east/north): environment + every storm's circulation, reduced over land. Used for rendering and damage.
 * A recorded (reanalysis) base wind already includes land friction, so only the model-made part is reduced. */
export function totalWind(state: GameState, lon: number, lat: number): { u: number; v: number } {
  const x = wrapLon(lon);
  const systems = allSystems(state);
  const active = activeHistoric(state);
  const h = active && sampleHistoric(active.data, active.hours, active.startIso, x, lat);
  const rec = h && !Number.isNaN(h.u) && !Number.isNaN(h.v) ? h : null; // recorded base replaces the base systems and background, as in refreshGrid
  const background = currentWeather(state);
  const initial = rec ?? (background && sampleLiveWeather(background, x, lat));
  const s = systemsAt(rec && !state.initialWeather ? systems.slice(baseSystems(state.seed).length) : systems, x, lat);
  const ur = initial ? initial.u : 0;
  const vr = initial ? initial.v : 0;
  let u = initial ? ur + s.u : s.u + zonalBackground(lat) + seasonalAt(seasonDay(state), lat, false).jet;
  let v = initial ? vr + s.v : s.v;
  const motions = stormMotions(state, systems);
  state.storms.forEach((storm, k) => {
    const w = stormVortexAt(storm, motions[k], x, lat);
    u += w.u;
    v += w.v;
  });
  for (const r of state.remnants) {
    const w = stormVortexAt(r, NO_MOTION, x, lat);
    u += w.u;
    v += w.v;
  }
  if (isLand(x, lat)) { u = ur + LAND_WIND_FACTOR * (u - ur); v = vr + LAND_WIND_FACTOR * (v - vr); }
  for (const hazard of state.weatherHazards ?? []) {
    const wind = hazardWind(hazard, { lon: x, lat }); u += wind.u; v += wind.v;
  }
  return { u, v };
}

/** Surface pressure (hPa) including every storm's pressure deficit. */
export function totalPressure(state: GameState, lon: number, lat: number): number {
  const x = wrapLon(lon);
  const background = currentWeather(state);
  const active = activeHistoric(state);
  const h = active && sampleHistoric(active.data, active.hours, active.startIso, x, lat);
  const recorded = h && !Number.isNaN(h.p) ? h.p : null;
  const systems = allSystems(state);
  let p = (recorded ?? (background ? sampleLiveWeather(background, x, lat).p : REFERENCE_PRESSURE))
    + systemsAt(recorded !== null && !state.initialWeather ? systems.slice(baseSystems(state.seed).length) : systems, x, lat).p;
  for (const storm of state.storms) p += stormVortexAt(storm, NO_MOTION, x, lat).dp;
  for (const r of state.remnants) p += stormVortexAt(r, NO_MOTION, x, lat).dp;
  return p;
}

// ---------------------------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------------------------

export function isValidSeed(seed: unknown): seed is number {
  return typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff;
}

export function createGame(seed: number = SCENARIO.seed, startDayOfYear: number = DEFAULT_START_DOY, initialWeather?: LiveWeatherSnapshot): GameState {
  if (!isValidSeed(seed)) throw new Error('Seed must be an integer between 0 and 4294967295.');
  if (!isValidDayOfYear(startDayOfYear)) throw new Error('Start day of the year must be between 0 and 366.');
  if (initialWeather !== undefined && !isLiveWeatherSnapshot(initialWeather)) throw new Error('Invalid starting weather.');
  const grid: EnvironmentCell[] = getStaticGrid().cells.map(c => ({
    lon: c.lon, lat: c.lat, land: c.land, temperature: 0, airTemperature: 0, airHeating: 0, updraft: 0, instability: 0, humidity: 0, rain: 0, snow: 0, blizzard: false, shear: 0, pressure: REFERENCE_PRESSURE,
    u: 0, v: 0, population: c.population, cityId: c.cityId, maxDamage: 0, calmHours: 0, exposed: false, snowCm: 0, convection: 0,
  }));
  const state: GameState = {
    ...(initialWeather ? { initialWeather: structuredClone(initialWeather), weather: {
      pressure: initialWeather.pressure.slice(), u: initialWeather.u.slice(), v: initialWeather.v.slice(),
      ...(initialWeather.seaTemperature ? { seaTemperature: initialWeather.seaTemperature.slice() } : {}),
      ...(initialWeather.airTemperature ? { airTemperature: initialWeather.airTemperature.slice() } : {}),
    } } : {}),
    traffic: createTraffic(seed),
    genesis: { enabled: false, waves: 0, nextSpawnTick: 0 }, climate: { warming: 0, enso: 0, polar: 0 }, historic: [], nextStormId: 1,
    scenarioId: SCENARIO.id, version: SIMULATION_VERSION, seed, tick: 0, hours: 0, startDayOfYear, initialStartDayOfYear: startDayOfYear, phase: 'seeding',
    score: 0, exposedPopulation: 0, storms: [], remnants: [], stormArchive: [], thunderstorms: [], nextThunderstormId: 1, candidates: [], effects: [], grid,
    cities: CITIES.map(c => ({ id: c.id, score: 0, damage: 0, exposedPopulation: 0, maxWind: 0, blizzardHours: 0 })),
    weatherHazards: [], disasters: [], news: [], actions: [], peakWind: 0, blizzardCells: 0,
  };
  addNews(state, { id: 'welcome', kind: 'info', title: 'Calm tropics',
    text: 'No storms yet. Overlap warm water, moisture and a low over tropical ocean to organise one.' });
  refreshGrid(state);
  return state;
}

function fmt(lon: number, lat: number): string {
  const x = wrapLon(lon);
  return `${Math.abs(x).toFixed(1)}°${x >= 0 ? 'E' : 'W'} ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`;
}

/** Rolling event feed. Event ids are unique by construction (storm/effect ids, crossing detection). */
function addNews(state: GameState, item: Omit<NewsItem, 'hour'>): void {
  state.news.push({ ...item, hour: state.hours });
  if (state.news.length > MAX_NEWS) state.news.splice(0, state.news.length - MAX_NEWS);
}

export function placeTool(state: GameState, type: ToolType, lon: number, lat: number, formation?: FormationKind): PlacementResult {
  const tool = TOOL_BY_TYPE.get(type);
  if (!tool) return { ok: false, reason: 'Unknown weather tool.' };
  if (typeof lon !== 'number' || typeof lat !== 'number' || !Number.isFinite(lon) || !Number.isFinite(lat)) {
    return { ok: false, reason: 'Placement needs a valid map position.' };
  }
  if (!inBounds(lon, lat)) return { ok: false, reason: 'Place tools between 180°W–180°E and 90°S–90°N.' };
  if (!formation && state.effects.filter(e => !e.formation).length >= MAX_ACTIVE_EFFECTS) {
    return { ok: false, reason: `${MAX_ACTIVE_EFFECTS} tools are already active. Wait for one to fade.` };
  }
  if (type === 'cool' && isLand(lon, lat)) return { ok: false, reason: 'Cool water must be placed over the ocean.' };
  if (type === 'warm' && isLand(lon, lat)) return { ok: false, reason: 'Warm water must be placed over the ocean.' };
  if (isWeatherHazardKind(formation) && WEATHER_HAZARDS[formation].landOnly && !isLand(lon, lat)) return { ok: false, reason: 'This phenomenon needs land. Pick a land spot.' };
  if (type === 'high') {
    for (const s of state.storms) {
      if (distanceKm(s.lon, s.lat, lon, lat) < MIN_HIGH_DISTANCE_KM) {
        return { ok: false, reason: `High pressure must be at least ${MIN_HIGH_DISTANCE_KM} km from a storm centre; shape its surroundings instead.` };
      }
    }
  }
  appendTool(state, type, lon, lat, formation);
  syncStormPressures(state);
  refreshGrid(state);
  refreshForecasts(state);
  return { ok: true };
}

/** Append a validated tool; recipes refresh the expensive world fields just once. */
function appendTool(state: GameState, type: ToolType, lon: number, lat: number, formation?: FormationKind): void {
  const tool = TOOL_BY_TYPE.get(type)!;
  const tag = formation ? { formation } : {};
  state.actions.push({ tick: state.tick, type, lon, lat, ...tag });
  state.effects.push({ id: state.actions.length, type, lon, lat, radiusKm: tool.radiusKm,
    remainingHours: tool.durationHours, ageHours: 0, ...tag });
}

/** Recompute and place the whole recipe atomically in the worker's current world. */
export function placeFormation(state: GameState, kind: FormationKind, lon: number, lat: number): PlacementResult {
  if (!['typhoon', 'blizzard', 'tornado'].includes(kind) && !isWeatherHazardKind(kind)) return { ok: false, reason: 'Unknown formation tool.' };
  if (!inBounds(lon, lat)) return { ok: false, reason: 'Placement needs a valid map position.' };
  if (kind === 'typhoon' && isLand(lon, lat)) return { ok: false, reason: 'Warm water must be placed over the ocean.' };
  if (isWeatherHazardKind(kind) && WEATHER_HAZARDS[kind].landOnly && !isLand(lon, lat)) return { ok: false, reason: 'This phenomenon needs land. Pick a land spot.' };
  const guide = isWeatherHazardKind(kind) ? weatherHazardRecipe(state, kind, lon, lat)
    : (kind === 'typhoon' ? formationRecipe : kind === 'blizzard' ? blizzardRecipe : tornadoRecipe)(state, lon, lat);
  if (!guide.ok) return { ok: false, reason: 'The formation recipe could not be prepared.' };
  for (const type of guide.placements) appendTool(state, type, lon, lat, kind);
  syncStormPressures(state);
  refreshGrid(state);
  refreshForecasts(state);
  return { ok: true };
}

/** Turns natural typhoon formation on or off. Turning it on brings a wave of formation conditions at once. */
export function setGenesis(state: GameState, on: boolean): PlacementResult {
  if (typeof on !== 'boolean') return { ok: false, reason: 'Natural formation needs on or off.' };
  const wasOn = state.genesis.enabled;
  state.actions.push({ tick: state.tick, type: 'genesis', on });
  state.genesis.enabled = on;
  if (on && !wasOn) {
    state.genesis.nextSpawnTick = state.tick;
    updateGenesisWaves(state);
    refreshGrid(state);
    refreshForecasts(state);
  }
  return { ok: true };
}

/** Sets one world-climate control (rounded to 0.1). Recorded like any other action, so replays reproduce it. */
export function setClimate(state: GameState, key: ClimateKey, value: number): PlacementResult {
  const rounded = normalizeClimate(key, value);
  if (rounded === null) {
    if (typeof key !== 'string' || !Object.hasOwn(CLIMATE_RANGE, key)) return { ok: false, reason: 'Unknown climate control.' };
    return { ok: false, reason: `Climate ${key} must be between ${CLIMATE_RANGE[key][0]} and ${CLIMATE_RANGE[key][1]}.` };
  }
  state.actions.push({ tick: state.tick, type: 'climate', key, value: rounded });
  state.climate[key] = rounded;
  refreshGrid(state);
  refreshForecasts(state);
  return { ok: true };
}

/** Moves the calendar to `day` (0..366) at the current model hour. Recorded like any other action, so replays reproduce it. */
export function setSeason(state: GameState, day: number): PlacementResult {
  if (!isValidDayOfYear(day)) return { ok: false, reason: 'The day of the year must be between 0 and 366.' };
  state.actions.push({ tick: state.tick, type: 'season', dayOfYear: day });
  state.startDayOfYear = (((day - state.hours / 24) % YEAR_DAYS) + YEAR_DAYS) % YEAR_DAYS;
  refreshGrid(state);
  refreshForecasts(state);
  return { ok: true };
}

/** Loads a recorded typhoon at its first best-track point; it follows the record from this hour on. Several may run at once. */
export function loadHistoric(state: GameState, typhoonId: string): PlacementResult {
  const typhoon = typhoonById(typhoonId);
  if (!typhoon) return { ok: false, reason: 'Unknown typhoon.' };
  const first = typhoon.points[0];
  const storm = newStorm(state.nextStormId++, wrapLon(first.lon), first.lat, REFERENCE_PRESSURE);
  storm.name = typhoon.name;
  storm.wind = storm.peakWind = recordedWind(first);
  storm.pressure = first.pressure;
  storm.radiusKm = rmwKm(storm.wind, storm.lat);
  storm.galeRadiusKm = galeRadius(storm);
  storm.stage = stageFor(storm.wind, storm.lon, storm.lat);
  storm.record = { typhoonId: typhoon.id, startHour: state.hours };
  const environment = historicEnvironments.has(typhoon.id) ? 'loaded' : 'missing';
  state.actions.push({ tick: state.tick, type: 'historic', typhoonId: typhoon.id });
  state.storms.push(storm);
  state.historic.push({ typhoonId: typhoon.id, stormId: storm.id, startHour: state.hours, finished: false, environment });
  state.peakWind = Math.max(state.peakWind, storm.wind);
  state.phase = 'active';
  addNews(state, { id: `historic-${storm.id}`, kind: 'info', title: `${typhoon.name} (${typhoon.year})`,
    text: `Replaying the recorded track of ${typhoon.name} from ${first.t.slice(0, 10)}, from ${AGENCY_NAMES[typhoon.agency]} best-track data.${typhoon.points.some(p => p.windMs === null) ? ' Where the record has no wind, it is estimated from central pressure.' : ''} ${
      environment === 'loaded' ? 'Sea temperature, air, humidity, pressure and wind follow NCEP/NCAR Reanalysis 1 and ERSST v5 for these dates.' : 'No environment record is available for these dates, so the base climate is used.'}` });
  refreshGrid(state);
  refreshForecasts(state);
  return { ok: true };
}

/** storm.pressure = totalPressure() at its centre (environment, effects and every storm). */
function syncStormPressures(state: GameState): void {
  const values = state.storms.map(s => totalPressure(state, s.lon, s.lat));
  state.storms.forEach((s, k) => { if (!s.record) s.pressure = values[k]; }); // loaded historic storms keep their recorded central pressure
}

/** Storm-free, effect-free fields per grid cell for one seed; static, so cached. */
interface BaseGrid { t: Float64Array; h: Float64Array; sh: Float64Array; p: Float64Array; u: Float64Array; v: Float64Array }
const baseGridCache = new Map<number, BaseGrid>();
function getBaseGrid(seed: number): BaseGrid {
  const hit = baseGridCache.get(seed);
  if (hit) return hit;
  const cells = getStaticGrid().cells;
  const n = cells.length;
  const b: BaseGrid = { t: new Float64Array(n), h: new Float64Array(n), sh: new Float64Array(n), p: new Float64Array(n), u: new Float64Array(n), v: new Float64Array(n) };
  const systems = baseSystems(seed);
  cells.forEach((c, k) => {
    const s = systemsAt(systems, c.lon, c.lat);
    b.t[k] = baseTemperature(seed, c.lon, c.lat);
    b.h[k] = baseHumidity(seed, c.lon, c.lat) - (c.land ? 0.08 : 0);
    b.sh[k] = Math.max(0, baseShear(seed, c.lon, c.lat));
    b.p[k] = REFERENCE_PRESSURE + s.p;
    b.u[k] = s.u + zonalBackground(c.lat);
    b.v[k] = s.v;
  });
  if (baseGridCache.size >= 4) baseGridCache.delete(baseGridCache.keys().next().value!);
  baseGridCache.set(seed, b);
  return b;
}

let centreLandCache: Uint8Array | null = null;
/** isLand() at a grid cell centre (point test, as in totalWind), cached because refreshGrid runs every step. */
function centreLand(k: number): boolean {
  if (!centreLandCache) {
    const cells = getStaticGrid().cells;
    centreLandCache = Uint8Array.from(cells, c => (isLand(c.lon, c.lat) ? 1 : 0));
  }
  return centreLandCache[k] === 1;
}

/**
 * Grid = cached base + effects near them + storms near them. Same field as totalWind() and
 * totalPressure() at cell centres (same cut-offs), and the field that damage reads.
 */
function refreshGrid(state: GameState): void {
  const b = getBaseGrid(state.seed);
  const season = seasonGrid(seasonDay(state));
  const g = state.grid;
  const hum = new Float64Array(b.h);
  const cooling = new Float64Array(g.length);
  const air = new Float64Array(g.length);
  const shearDelta = new Float64Array(g.length);
  const freeAir = new Float64Array(g.length), freeVertical = new Float64Array(g.length);
  const freeInstability = new Float64Array(g.length), freeCooling = new Float64Array(g.length), freeShear = new Float64Array(g.length);
  const recU = new Float64Array(g.length); // recorded base wind per cell, 0 where none: it already includes land friction, so the land factor skips it
  const recV = new Float64Array(g.length);
  const background = currentWeather(state);
  const seaSeasonOffsets = background?.seaTemperature ? Float64Array.from({ length: GRID_ROWS }, (_, row) => {
    const lat = BOUNDS.south + (row + 0.5) * GRID_STEP;
    return seasonalAt(seasonDay(state), lat, false).sst - seasonalAt(Math.floor(state.initialStartDayOfYear), lat, false).sst;
  }) : null;
  for (let k = 0; k < g.length; k++) {
    const c = g[k];
    c.airHeating = 0; c.updraft = 0; c.instability = 0; c.rain = 0; c.snow = 0; c.blizzard = false;
    c.temperature = b.t[k] + season.sst[k]; c.shear = b.sh[k]; c.pressure = b.p[k]; c.u = b.u[k] + season.jet[k]; c.v = b.v[k];
    if (background) {
      c.pressure = background.pressure[k];
      c.u = recU[k] = background.u[k]; c.v = recV[k] = background.v[k];
    }
    air[k] = b.t[k] - 1.5 + season.air[k];
    if (background?.airTemperature) air[k] = background.airTemperature[k];
    const sea = background?.seaTemperature?.[k];
    if (!c.land && sea != null) c.temperature = sea + seaSeasonOffsets![Math.floor(k / GRID_COLS)];
  }
  const active = activeHistoric(state);
  if (active) { // a historic typhoon is loaded: recorded fields replace the fictional ones inside the dataset window (NaN = missing, keep the base value)
    const f = fieldsAt(active.data, active.hours, active.startIso);
    windowCells(active.data).forEach((k, w) => {
      const c = g[k];
      if (!Number.isNaN(f.t[w])) c.temperature = f.t[w];
      if (!Number.isNaN(f.p[w])) c.pressure = f.p[w];
      if (!Number.isNaN(f.u[w]) && !Number.isNaN(f.v[w])) { c.u = recU[k] = f.u[w]; c.v = recV[k] = f.v[w]; }
      if (!Number.isNaN(f.h[w])) hum[k] = f.h[w];
      if (!Number.isNaN(f.air[w])) air[k] = f.air[w];
    });
  }
  const climate = climateGrid(state.climate); // world climate adds on top of the base and of any recorded field
  if (climate) {
    for (let k = 0; k < g.length; k++) {
      if (!g[k].land) g[k].temperature += climate.sst[k];
      air[k] += climate.air[k];
      g[k].shear += climate.shear[k];
      hum[k] += climate.humidity;
    }
  }
  // Use the same pressure-gradient circulation as point sampling and storm steering,
  // before rain/lift and land friction are evaluated. Event movement/fading updates this each step.
  for (const hazard of state.weatherHazards ?? []) {
    const sys = [hazardPressureSystem(hazard)];
    forCellsNear(hazard.lon, hazard.lat, sys[0].sigmaKm * SYSTEM_CUTOFF_SIGMA, k => {
      const c = g[k], s = systemsAt(sys, c.lon, c.lat);
      c.pressure += s.p; c.u += s.u; c.v += s.v;
    });
  }
  for (const e of state.effects) {
    const w = effectWeight(e);
    if (w === 0) continue;
    if (isPressureTool(e.type)) {
      const sys = [effectSystem(e)];
      forCellsNear(e.lon, e.lat, (e.radiusKm / 2) * SYSTEM_CUTOFF_SIGMA, k => {
        const c = g[k];
        const s = systemsAt(sys, c.lon, c.lat);
        c.pressure += s.p; c.u += s.u; c.v += s.v;
      });
    }
    if (e.type !== 'low' && e.type !== 'high') {
      forCellsNear(e.lon, e.lat, e.radiusKm * SCALAR_REACH, k => {
        const c = g[k];
        if (e.type === 'warm') { if (!c.land) c.temperature += EFFECT_STRENGTH.warm * w * effectFalloff(e, c.lon, c.lat); }
        else if (e.type === 'moisture') hum[k] += EFFECT_STRENGTH.moisture * w * effectFalloff(e, c.lon, c.lat);
        else if (e.type === 'warm-air' || e.type === 'cold-air') { const delta = EFFECT_STRENGTH[e.type] * w * effectFalloff(e, c.lon, c.lat); c.airHeating += delta; if (e.formation) freeAir[k] += delta; }
        else if (e.type === 'updraft' || e.type === 'downdraft') { const delta = EFFECT_STRENGTH[e.type] * w * effectFalloff(e, c.lon, c.lat); c.updraft += delta; if (e.formation) freeVertical[k] += delta; }
        else if (e.type === 'cool' && !c.land) { const delta = EFFECT_STRENGTH.cool * w * effectFalloff(e, c.lon, c.lat); cooling[k] += delta; if (e.formation) freeCooling[k] += delta; }
        else if (e.type === 'dry') hum[k] -= EFFECT_STRENGTH.dry * w * effectFalloff(e, c.lon, c.lat);
        else if (e.type === 'low-shear' || e.type === 'high-shear') { const delta = EFFECT_STRENGTH[e.type] * w * effectFalloff(e, c.lon, c.lat); shearDelta[k] += delta; if (e.formation) freeShear[k] += delta; }
        else if (e.type === 'unstable-air' || e.type === 'stable-air') { const delta = EFFECT_STRENGTH[e.type] * w * effectFalloff(e, c.lon, c.lat); c.instability += delta; if (e.formation) freeInstability[k] += delta; }
      });
    }
  }
  for (let k = 0; k < g.length; k++) {
    g[k].temperature -= capEffect(cooling[k], freeCooling[k], EFFECT_STACK_LIMITS.cooling, 0);
    g[k].shear = Math.max(0, g[k].shear + capEffect(shearDelta[k], freeShear[k], SHEAR_STACK_CAP));
    g[k].humidity = clamp(hum[k], 0, 1);
    g[k].airHeating = capEffect(g[k].airHeating, freeAir[k], EFFECT_STACK_LIMITS.air);
    g[k].airTemperature = air[k] + g[k].airHeating;
    g[k].updraft = capEffect(g[k].updraft, freeVertical[k], EFFECT_STACK_LIMITS.vertical);
    g[k].instability = capEffect(g[k].instability, freeInstability[k], EFFECT_STACK_LIMITS.instability);
    g[k].convection = convectivePotential(g[k].humidity, g[k].airHeating, g[k].updraft, g[k].airTemperature, g[k].instability);
    // Display-only rain (mm/h): background convective drizzle plus frontal lift inside a player-made low; thunderstorms and cyclones add below.
    const lift = clamp(((background?.pressure[k] ?? b.p[k]) - g[k].pressure - 2) / 6, 0, 1); // storm vortices are added later; compare tools to the current background
    g[k].rain = Math.min(60, 6 * clamp((g[k].humidity - 0.75) / 0.25, 0, 1) * clamp(g[k].updraft, 0, 3) / 3
      + 12 * lift * clamp((g[k].humidity - 0.45) / 0.3, 0, 1));
  }
  for (const t of state.thunderstorms) {
    if (t.intensity <= 0) continue;
    forCellsNear(t.lon, t.lat, 2 * t.radiusKm, k => {
      const c = g[k];
      const d = distanceKm(t.lon, t.lat, c.lon, c.lat);
      if (d <= 2 * t.radiusKm) c.rain = Math.min(60, c.rain + 25 * t.intensity * Math.exp(-((d / t.radiusKm) ** 2)));
    });
  }
  if (state.storms.length > 0 || state.remnants.length > 0) {
  const motions = state.storms.length > 0 ? stormMotions(state) : [];
  const vortices: [Vortex, { u: number; v: number }][] = [
    ...state.storms.map((storm, n): [Vortex, { u: number; v: number }] => [storm, motions[n]]),
    ...state.remnants.map((r): [Vortex, { u: number; v: number }] => [r, NO_MOTION]),
  ];
  vortices.forEach(([storm, motion]) => {
    forCellsNear(storm.lon, storm.lat, outerRadiusKm(storm), k => {
      const c = g[k];
      const w = stormVortexAt(storm, motion, c.lon, c.lat);
      c.u += w.u; c.v += w.v; c.pressure += w.dp;
      const r = distanceKm(storm.lon, storm.lat, c.lon, c.lat);
      const eye = 1 - smoothstep(25, 40, storm.wind) * Math.exp(-((r / (0.6 * storm.radiusKm)) ** 2)); // the dry eye only opens in a mature storm
      const vortexLift = clamp((-w.dp - 0.5) / 2, 0, 1); // a young depression's vortex is far narrower than the Low it consumed, so the ramp is steeper than the frontal term's
      // Structure: two spiral arms outside the core, more rain ahead and to the right of the motion (left in the south), and a ragged edge (vortexSpeed already fades the outer rim).
      const { dx, dy } = offsetKm(storm.lon, storm.lat, c.lon, c.lat);
      const sgn = spinSign(storm.lat);
      const psi = sgn * Math.atan2(dy, dx) * 2 - 2.2 * Math.log(Math.max(r, 20) / Math.max(storm.radiusKm, 20)) + storm.id * 1.7;
      const bandMix = smoothstep(storm.radiusKm, 3 * storm.radiusKm, r);
      const speed = Math.hypot(motion.u, motion.v);
      const asym = speed > 0.5 && r > 0
        ? clamp(1 + 0.25 * ((dx * motion.u + dy * motion.v) / (r * speed)) + 0.2 * (sgn * (dx * motion.v - dy * motion.u) / (r * speed)), 0.6, 1.5)
        : 1;
      const gale = (storm as Partial<Storm>).galeRadiusKm ?? 0; // a remnant has no gale radius: its shield uses the 250/500 km floor
      const envelope = 1 - smoothstep(Math.max(250, 2.5 * gale), Math.max(500, 4 * gale), r); // compact shield, not a disc out to the vortex rim
      const shape = (1 - bandMix + bandMix * Math.max(0, 0.35 + 0.65 * Math.cos(psi))) * envelope * asym * (hash01(state.seed, 909, k) * 0.5 + 0.75);
      c.rain = Math.min(60, c.rain + shape * (12 * vortexLift * clamp((c.humidity - 0.45) / 0.3, 0, 1)
        + 40 * c.humidity * clamp((vortexSpeed(storm, r) - 8) / 40, 0, 1) ** 1.3 * eye));
    });
  });
  }
  for (let k = 0; k < g.length; k++) {
    if (centreLand(k)) { g[k].u = recU[k] + LAND_WIND_FACTOR * (g[k].u - recU[k]); g[k].v = recV[k] + LAND_WIND_FACTOR * (g[k].v - recV[k]); }
  }
  for (const hazard of state.weatherHazards ?? []) {
    forCellsNear(hazard.lon, hazard.lat, hazard.radiusKm, k => applyHazardField(hazard, g[k]));
  }
  for (let k = 0; k < g.length; k++) { // display-only snow: precipitation below freezing; a blizzard is heavy snow in a gale
    const c = g[k];
    c.snow = c.airTemperature <= 0 ? c.rain * clamp(1 + 0.2 * c.instability, 0.6, 1.4) : 0;
    c.blizzard = c.snow >= 1 && Math.hypot(c.u, c.v) >= 15;
  }
}

function coreLandFraction(storm: Storm): number {
  let hits = isLand(storm.lon, storm.lat) ? 2 : 0;
  const r = Math.max(30, storm.radiusKm);
  for (let k = 0; k < 6; k++) {
    const p = moveKm(storm.lon, storm.lat, r * Math.cos((k * Math.PI) / 3), r * Math.sin((k * Math.PI) / 3));
    if (isLand(p.lon, p.lat)) hits++;
  }
  return hits / 8;
}

/** Repairs on a damaged cell start this long after the last hit. */
export const RECOVERY_DELAY_HOURS = 24;
/** Time constant of the exponential decay of a repairing cell's current damage. */
export const RECOVERY_TAU_HOURS = 168;

/**
 * Max-only cell damage: `coverage` is the share of the cell under the wind (1 for cyclones), so a
 * cell's people are counted at most once per damage level whatever passes over it.
 * Returns the people-weighted damage added (0 when the cell's damage did not grow).
 */
function damageCell(state: GameState, k: number, speed: number, coverage: number, ratio: number = damageRatio(speed) * coverage, weatherExposure = false): number {
  const c = state.grid[k];
  if (c.population <= 0) return 0;
  const cs = getStaticGrid().shares[k];
  for (const s of cs) if (speed > state.cities[s.city].maxWind) state.cities[s.city].maxWind = speed;
  if ((speed >= GALE || (weatherExposure && ratio > 0)) && !c.exposed) {
    c.exposed = true;
    state.exposedPopulation += c.population;
    for (const s of cs) state.cities[s.city].exposedPopulation += s.share;
  }
  // Sentinel: -STEP_HOURS marks "hit this step"; the recovery pass in applyDamage adds STEP_HOURS to every damaged cell, so hit cells end the step at 0.
  if (ratio > 0 && ratio >= 0.5 * c.maxDamage) c.calmHours = -STEP_HOURS;
  if (ratio <= c.maxDamage) return 0;
  const inc = ratio - c.maxDamage;
  c.maxDamage = ratio;
  state.score += inc * c.population;
  for (const s of cs) { state.cities[s.city].score += inc * s.share; state.cities[s.city].damage += inc * s.share; }
  return inc * c.population;
}

/** Only cities of at least this many people get `city` news. */
export const NEWS_MIN_CITY_POPULATION = 1_000_000;
/** Snow depth (cm) at which a populated cell starts taking snow-load damage. */
const SNOW_DAMAGE_MIN_CM = 20;

/** Reads the freshly refreshed grid, so the displayed wind is exactly the scored wind. */
function applyDamage(state: GameState): void {
  const { shares } = getStaticGrid();
  const disasters = new Map((state.disasters ?? []).map(record => [record.id, record]));
  const blizzard = (state.disasters ?? []).find(record => record.kind === 'blizzard' && record.endedHour === undefined);
  const beforeDamage = Float64Array.from(state.cities, c => c.damage);
  const beforeExposed = Float64Array.from(state.cities, c => c.exposedPopulation);
  const cyclone = new Set<number>();
  const convective = new Set<number>();
  const winter = new Set<number>();
  const weather = new Map<number, WeatherHazardKind>();
  const blizzardNow = new Set<number>();
  const beforeBlizzard = Float64Array.from(state.cities, c => c.blizzardHours);
  for (const storm of state.storms) {
    const reach = Math.min(outerRadiusKm(storm), Math.max(storm.galeRadiusKm * 2, storm.radiusKm * 3) + 150);
    forCellsNear(storm.lon, storm.lat, reach, k => {
      const c = state.grid[k];
      const added = damageCell(state, k, Math.hypot(c.u, c.v), 1);
      storm.damageScore += added;
      if (added > 0) for (const s of shares[k]) cyclone.add(s.city);
    });
  }
  for (const t of state.thunderstorms) {
    if (t.gustMs < GALE) continue;
    const k = gridIndex(t.lon, t.lat);
    const cellKm2 = GRID_STEP * 111.32 * cosLat(state.grid[k].lat) * GRID_STEP * 110.57;
    const footprint = t.tornado ? Math.max(0.02, Math.min(1, (Math.PI * 8 ** 2) / cellKm2)) : Math.min(1, (Math.PI * t.radiusKm ** 2) / cellKm2);
    const added = damageCell(state, k, t.gustMs, footprint);
    const record = disasters.get(`${t.tornado ? 'tornado' : 'thunderstorm'}-${t.id}`);
    if (record) record.damageScore += added;
    if (added > 0) for (const s of shares[k]) convective.add(s.city);
  }
  let blizzardCells = 0; let bLon = 0; let bLat = 0;
  for (let k = 0; k < state.grid.length; k++) {
    const c = state.grid[k];
    const speed = Math.hypot(c.u, c.v);
    if (c.blizzard) {
      blizzardCells++; bLon += c.lon; bLat += c.lat;
      for (const s of shares[k]) {
        blizzardNow.add(s.city);
        if (speed > state.cities[s.city].maxWind) state.cities[s.city].maxWind = speed;
      }
    }
    if (c.snowCm >= SNOW_DAMAGE_MIN_CM && c.population > 0) {
      const added = damageCell(state, k, speed, 1, blizzardDamageRatio(c.snowCm, speed));
      if (blizzard) blizzard.damageScore += added;
      else if (added > 0) {
        // A cold-wave/downpour combination can build damaging snow without a gale.
        // Keep that loss with its contributing event rather than leaving it out of rankings.
        let source: string | undefined, strength = 0;
        for (const hazard of state.weatherHazards ?? []) {
          if (hazard.kind !== 'coldwave' && hazard.kind !== 'downpour' && hazard.kind !== 'hail') continue;
          const influence = hazardInfluence(hazard, c);
          if (influence > strength) { source = `weather-${hazard.id}`; strength = influence; }
        }
        const record = source && disasters.get(source);
        if (record) record.damageScore += added;
      }
      if (added > 0) for (const s of shares[k]) winter.add(s.city);
    }
  }
  for (const hazard of state.weatherHazards ?? []) {
    const record = disasters.get(`weather-${hazard.id}`);
    forCellsNear(hazard.lon, hazard.lat, hazard.radiusKm, k => {
      const cell = state.grid[k], ratio = hazardDamageRatio(hazard, cell);
      const added = damageCell(state, k, Math.hypot(cell.u, cell.v), 1, ratio, true);
      if (record) record.damageScore += added;
      if (added > 0) {
        for (const share of shares[k]) weather.set(share.city, hazard.kind);
      }
    });
  }
  // Recovery: a damaged cell untouched for RECOVERY_DELAY_HOURS repairs exponentially; `score` and `state.score` stay cumulative.
  for (let k = 0; k < state.grid.length; k++) {
    const c = state.grid[k];
    if (c.maxDamage <= 0) continue;
    c.calmHours += STEP_HOURS;
    if (c.calmHours < RECOVERY_DELAY_HOURS) continue;
    let delta = c.maxDamage * (1 - Math.exp(-STEP_HOURS / RECOVERY_TAU_HOURS));
    if (c.maxDamage - delta < 1e-4) delta = c.maxDamage;
    c.maxDamage = c.maxDamage - delta < 1e-4 ? 0 : c.maxDamage - delta;
    for (const s of shares[k]) state.cities[s.city].damage = Math.max(0, state.cities[s.city].damage - delta * s.share);
  }
  for (const i of blizzardNow) state.cities[i].blizzardHours += STEP_HOURS;
  if (state.blizzardCells === 0 && blizzardCells > 0) {
    addNews(state, { id: `blizzard-start-${state.tick}`, kind: 'blizzard', title: 'Blizzard conditions develop',
      text: `Heavy snow and gale-force winds near ${fmt(bLon / blizzardCells, bLat / blizzardCells)}.` });
  }
  state.blizzardCells = blizzardCells;
  // News on threshold crossings this step only, so a rolling feed never repeats an event.
  state.cities.forEach((impact, i) => {
    const city = CITIES[i];
    // Smaller cities are still damaged and counted, but stay silent so the feed is not flooded.
    if (city.population < NEWS_MIN_CITY_POPULATION) return;
    if (beforeBlizzard[i] === 0 && impact.blizzardHours > 0) {
      addNews(state, { id: `blizzard-${city.id}`, kind: 'blizzard', cityId: city.id, title: `Blizzard hits ${city.name}`,
        text: `Blowing snow and winds of ${impact.maxWind.toFixed(0)} m/s cut visibility in ${city.name}. Roads and airports are closing.` });
    }
    if (beforeExposed[i] === 0 && impact.exposedPopulation > 0 && impact.maxWind >= GALE) {
      addNews(state, { id: `city-${city.id}-gale`, kind: 'city', cityId: city.id, title: `Gales reach ${city.name}`,
        text: `Winds above gale force cover parts of ${city.name}. Peak wind ${impact.maxWind.toFixed(0)} m/s.` });
    }
    // One bulletin per city per step, even when a strong gust crosses several tiers.
    // Threshold crossings use current damage, so a recovered city can report again in a later storm (ids carry the tick).
    const level = CITY_DAMAGE_LEVELS.reduce<number>((last, threshold, index) =>
      beforeDamage[i] / city.population < threshold && impact.damage / city.population >= threshold ? index : last, -1);
    if (level >= 0) {
      addNews(state, { id: `city-${city.id}-${level}-${state.tick}`, kind: 'city', cityId: city.id,
        ...(weather.has(i) ? { phenomenon: weather.get(i) } : {}),
        ...cityDamageBulletin(city, impact, level, weather.get(i) ?? (cyclone.has(i) ? 'cyclone' : winter.has(i) ? 'blizzard' : convective.has(i) ? 'thunderstorm' : 'cyclone')) });
    }
    if (beforeDamage[i] / city.population >= CITY_DAMAGE_LEVELS[0] && impact.damage / city.population < CITY_DAMAGE_LEVELS[0]) {
      const damage = estimateCityDamage(city, impact);
      addNews(state, { id: `recovery-${city.id}-${state.tick}`, kind: 'recovery', cityId: city.id, title: `${city.name} recovers`,
        text: `Repairs are complete after the storm damage in ${city.name}. Cumulative losses stand at USD ${damage.lossUsd.toLocaleString('en-US')}.`, damage });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Thunderstorms
// ---------------------------------------------------------------------------------------------

export const THUNDERSTORM_THRESHOLD = 1;
export const MAX_THUNDERSTORMS = 24;
const THUNDERSTORM_SPACING_KM = 250;
const THUNDERSTORM_NEWS_KM = 800;
const LONG_TRACK_TORNADO_KM = 100;

/** Game convective potential: lift from warm low-level air and updraft × moisture × warmth.
 * The untouched climate has no lift, so thunderstorms need player conditions; cold air,
 * downdraft and dry air suppress them. */
export function convectivePotential(humidity: number, airHeating: number, updraft: number, airTemperature: number, instability = 0): number {
  const lift = Math.max(0, 0.25 * airHeating + 0.6 * updraft);
  return lift * clamp((humidity - 0.5) / 0.2, 0, 1.5) * smoothstep(14, 24, airTemperature) * clamp(1 + 0.4 * instability, 0.2, 1.8);
}

/** Life-cycle envelope × local support; a seeded peak per id keeps cells distinct and replayable. */
function setThunderstormStrength(state: GameState, t: Thunderstorm, convection: number): void {
  const peak = 0.55 + 0.45 * hash01(state.seed, 8811, t.id);
  t.intensity = peak * Math.sin((Math.PI * t.ageHours) / t.durationHours) * smoothstep(0.3, THUNDERSTORM_THRESHOLD, convection);
  t.gustMs = (t.tornado ? 45 : 8) + 30 * t.intensity;
  t.radiusKm = 20 + 25 * t.intensity;
  t.cloudTopC = -20 - 55 * t.intensity;
}

function reportTornado(state: GameState, t: Thunderstorm): void {
  if (t.tornadoReported) return;
  t.tornadoReported = true;
  const city = nearestCity(t.lon, t.lat);
  const near = city && distanceKm(city.lon, city.lat, t.lon, t.lat) < 250 ? city : null;
  addNews(state, { id: `tornado-${t.id}`, kind: 'tornado', cityId: near?.id,
    title: near ? `Tornado touches down near ${near.name}` : 'Tornado touches down',
    text: `A rotating thunderstorm produced a tornado near ${fmt(t.lon, t.lat)}. Strong wind shear, moist rising air and atmospheric instability combined.` });
}

/** Interpolate the cell-centred wind so a tornado does not turn abruptly at grid boundaries. */
export function tornadoSteering(grid: EnvironmentCell[], lon: number, lat: number): { u: number; v: number } {
  const x = (((lon - BOUNDS.west) / GRID_STEP - 0.5) % GRID_COLS + GRID_COLS) % GRID_COLS;
  const y = clamp((lat - BOUNDS.south) / GRID_STEP - 0.5, 0, GRID_ROWS - 1);
  const i = Math.floor(x), j = Math.floor(y);
  const i2 = (i + 1) % GRID_COLS, j2 = Math.min(j + 1, GRID_ROWS - 1);
  const tx = x - i, ty = y - j;
  const a = grid[j * GRID_COLS + i], b = grid[j * GRID_COLS + i2];
  const c = grid[j2 * GRID_COLS + i], d = grid[j2 * GRID_COLS + i2];
  const interpolate = (v0: number, v1: number, v2: number, v3: number) =>
    (v0 + (v1 - v0) * tx) * (1 - ty) + (v2 + (v3 - v2) * tx) * ty;
  return { u: interpolate(a.u, b.u, c.u, d.u), v: interpolate(a.v, b.v, c.v, d.v) };
}

/** Drift, age and fade existing cells with the refreshed grid, then start new ones on the hour. */
function updateThunderstorms(state: GameState, dt: number): void {
  const g = state.grid;
  state.thunderstorms = state.thunderstorms.filter(t => {
    const here = g[gridIndex(t.lon, t.lat)];
    if (t.tornado) {
      moveTornado(t, state.seed, dt, point => ({ ...tornadoSteering(g, point.lon, point.lat), shear: g[gridIndex(point.lon, point.lat)].shear }));
    } else Object.assign(t, moveKm(t.lon, t.lat, here.u * dt * 3.6, here.v * dt * 3.6));
    t.ageHours += dt;
    if (t.ageHours >= t.durationHours) return false;
    const cell = g[gridIndex(t.lon, t.lat)];
    setThunderstormStrength(state, t, cell.convection);
    const supported = t.ageHours >= 1 && t.intensity >= 0.3
      && cell.convection >= 1.2 && cell.humidity >= 0.68 && cell.shear >= 14 && cell.instability >= 0.65;
    if (supported && !t.tornadoEnded && t.tornadoStartAgeHours === undefined) {
      t.tornadoStartAgeHours = t.ageHours;
      t.tornadoTrack = [{ lon: t.lon, lat: t.lat }];
      t.tornadoDistanceKm = 0;
    }
    t.tornado = supported && !t.tornadoEnded && t.tornadoStartAgeHours !== undefined;
    if (t.tornadoStartAgeHours !== undefined && !t.tornado) t.tornadoEnded = true;
    if (t.tornado) {
      t.gustMs = 45 + 30 * t.intensity;
      reportTornado(state, t);
    } else t.gustMs = 8 + 30 * t.intensity;
    if (t.tornado && !t.tornadoLongReported && (t.tornadoDistanceKm ?? 0) >= LONG_TRACK_TORNADO_KM) {
      t.tornadoLongReported = true;
      const city = nearestCity(t.lon, t.lat);
      const near = city && distanceKm(city.lon, city.lat, t.lon, t.lat) < 250 ? city : null;
      addNews(state, { id: `tornado-long-${t.id}`, kind: 'tornado', cityId: near?.id,
        title: near ? `Long-track tornado near ${near.name}` : 'Long-track tornado',
        text: `The tornado has traveled ${Math.round(t.tornadoDistanceKm!)} km while its rotating thunderstorm remains in warm, moist, unstable air with strong wind shear.` });
    }
    return t.intensity >= 0.02 || t.ageHours <= 1;
  });
  for (const effect of state.effects) {
    if (effect.formation !== 'tornado' || effect.type !== 'updraft' || effect.triggered || effect.ageHours < RAMP_HOURS) continue;
    const cell = g[gridIndex(effect.lon, effect.lat)];
    if (cell.convection < 1.6 || cell.humidity < 0.75 || cell.shear < 17 || cell.instability < 1) continue;
    const t: Thunderstorm = { id: state.nextThunderstormId++, lon: effect.lon, lat: effect.lat,
      intensity: 0, radiusKm: 0, gustMs: 0, cloudTopC: 0, ageHours: 1.5, durationHours: 8,
      tornado: true, tornadoStartAgeHours: 1.5, tornadoTrack: [{ lon: effect.lon, lat: effect.lat }], tornadoDistanceKm: 0 };
    setThunderstormStrength(state, t, cell.convection);
    state.thunderstorms.push(t);
    reportTornado(state, t);
    for (const same of state.effects) if (same.formation === 'tornado' && same.type === 'updraft'
      && same.lon === effect.lon && same.lat === effect.lat) same.triggered = true;
  }
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  const hour = state.tick / TICKS_PER_HOUR;
  for (let k = 0; k < g.length && state.thunderstorms.length < MAX_THUNDERSTORMS; k++) {
    const c = g[k];
    if (c.convection < THUNDERSTORM_THRESHOLD) continue;
    const chance = clamp(0.2 + 0.25 * (c.convection - THUNDERSTORM_THRESHOLD), 0, 0.6);
    if (hash01(state.seed, 100_000 + 4 * k, hour) >= chance) continue;
    const lon = wrapLon(c.lon + (hash01(state.seed, 100_001 + 4 * k, hour) - 0.5) * GRID_STEP * 0.8);
    const lat = c.lat + (hash01(state.seed, 100_002 + 4 * k, hour) - 0.5) * GRID_STEP * 0.8;
    const nearest = Math.min(Infinity, ...state.thunderstorms.map(t => distanceKm(t.lon, t.lat, lon, lat)));
    if (nearest < THUNDERSTORM_SPACING_KM) continue;
    const t: Thunderstorm = { id: state.nextThunderstormId++, lon, lat, intensity: 0, radiusKm: 0, gustMs: 0, cloudTopC: 0,
      ageHours: 0, durationHours: 3 + 3 * hash01(state.seed, 100_003 + 4 * k, hour) };
    setThunderstormStrength(state, t, c.convection);
    state.thunderstorms.push(t);
    if (nearest < THUNDERSTORM_NEWS_KM) continue; // one bulletin per outbreak
    const city = nearestCity(lon, lat);
    const near = city && distanceKm(city.lon, city.lat, lon, lat) < 300 ? city : null;
    addNews(state, { id: `thunderstorm-${t.id}`, kind: 'info', cityId: near?.id,
      title: near ? `Thunderstorms erupt near ${near.name}` : 'Thunderstorms erupt',
      text: `Warm, moist, rising air set off thunderstorms at ${fmt(lon, lat)}. Damaging gusts and downpours are possible for a few hours.` });
  }
}

function nearestCity(lon: number, lat: number): City | null {
  let best: City | null = null;
  let bestD = Infinity;
  for (const c of CITIES) {
    const d = distanceKm(c.lon, c.lat, lon, lat);
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

function newStorm(id: number, lon: number, lat: number, envP: number): Storm {
  const wind = 13;
  return {
    id, lon, lat, wind, movementSpeedKmh: 0, pressure: envP - pressureDeficit(wind), radiusKm: rmwKm(wind, lat), galeRadiusKm: 0,
    stage: stageFor(wind, lon, lat), ageHours: 0, peakWind: wind, track: [{ lon, lat }], forecast: [], history: [], damageScore: 0, windDelta: 0,
  };
}

/**
 * Natural formation draws a site from the base climate: a basin by weight, then seeded attempts inside
 * its box for open ocean (>= 300 km from land), SST >= 27 C and a genesis potential of at least 60%
 * of the ocean maximum (any latitude; the climate test alone keeps sites in warm water), clear of storms, lows and the previous site.
 */
export const GENESIS_MAX_STORMS = 3;
interface GenesisBasin { name: string; weight: number; west: number; east: number; south: number; north: number }
const GENESIS_BASINS: GenesisBasin[] = [
  { name: 'western Pacific', weight: 0.45, west: 110, east: 170, south: 0, north: 40 },
  { name: 'eastern Pacific', weight: 0.12, west: -140, east: -95, south: 0, north: 40 },
  { name: 'North Atlantic', weight: 0.13, west: -80, east: -20, south: 0, north: 40 },
  { name: 'north Indian Ocean', weight: 0.08, west: 55, east: 100, south: 0, north: 40 },
  { name: 'south Indian Ocean', weight: 0.12, west: 45, east: 115, south: -40, north: 0 },
  { name: 'South Pacific', weight: 0.10, west: 150, east: 190, south: -40, north: 0 },
];
const GENESIS_MIN_LAND_KM = 300;
const GENESIS_MIN_SPACING_KM = 1500;
const GENESIS_MIN_SST = 27;
const GENESIS_POTENTIAL_SHARE = 0.6;
const GENESIS_BASIN_ATTEMPTS = 40;
const GENESIS_CONDITIONS: ToolType[] = ['warm', 'moisture', 'low', 'warm-air', 'updraft'];

/** Genesis potential of the unmodified climate at a point (no effects, storms or land mask). */
function climateGenesisPotential(seed: number, systems: PressureSystem[], lon: number, lat: number): number {
  const temperature = baseTemperature(seed, lon, lat);
  return genesisPotential({
    temperature, airTemperature: temperature - 1.5, airHeating: 0, updraft: 0, instability: 0, drying: 0, cooling: 0,
    humidity: baseHumidity(seed, lon, lat), shear: Math.max(0, baseShear(seed, lon, lat)),
    pressure: REFERENCE_PRESSURE + systemsAt(systems, lon, lat).p, u: 0, v: 0, land: false,
  }, lat);
}
const genesisMaxCache = new Map<number, number>();
/** Highest climate genesis potential over all ocean cells, per seed. */
function genesisPotentialMax(seed: number): number {
  const hit = genesisMaxCache.get(seed);
  if (hit !== undefined) return hit;
  const systems = baseSystems(seed);
  let max = 0;
  for (const c of getStaticGrid().cells) {
    if (!c.land) max = Math.max(max, climateGenesisPotential(seed, systems, c.lon, c.lat));
  }
  if (genesisMaxCache.size >= 4) genesisMaxCache.delete(genesisMaxCache.keys().next().value!);
  genesisMaxCache.set(seed, max);
  return max;
}
const COMPASS_8: readonly (readonly [number, number])[] = [[1, 0], [-1, 0], [0, 1], [0, -1], [0.7071, 0.7071], [-0.7071, 0.7071], [0.7071, -0.7071], [-0.7071, -0.7071]];
function farFromLand(lon: number, lat: number): boolean {
  if (isLand(lon, lat)) return false;
  return COMPASS_8.every(([e, n]) => {
    const p = moveKm(lon, lat, e * GENESIS_MIN_LAND_KM, n * GENESIS_MIN_LAND_KM);
    return !isLand(p.lon, p.lat);
  });
}

function pickGenesisSite(state: GameState, wave: number): { lon: number; lat: number; basin: string } {
  const seed = state.seed;
  const systems = baseSystems(seed);
  const floor = GENESIS_POTENTIAL_SHARE * genesisPotentialMax(seed);
  const avoid: GeoPoint[] = [...state.storms, ...state.effects.filter(e => e.type === 'low')];
  if (state.genesis.lastSite) avoid.push(state.genesis.lastSite);
  const suitable = (lon: number, lat: number) =>
    avoid.every(p => distanceKm(p.lon, p.lat, lon, lat) >= GENESIS_MIN_SPACING_KM) &&
    baseTemperature(seed, lon, lat) >= GENESIS_MIN_SST &&
    climateGenesisPotential(seed, systems, lon, lat) >= floor && farFromLand(lon, lat);
  const drawBasin = (u: number) => {
    let r = u * GENESIS_BASINS.reduce((sum, b) => sum + b.weight, 0);
    for (const b of GENESIS_BASINS) { r -= b.weight; if (r < 0) return b; }
    return GENESIS_BASINS[0];
  };
  const inBox = (b: GenesisBasin, attempt: number) => {
    const lon = wrapLon(b.west + hash01(seed, 9200 + attempt, wave) * (b.east - b.west));
    const lat = b.south + hash01(seed, 9300 + attempt, wave) * (b.north - b.south);
    return { lon, lat };
  };
  const primary = drawBasin(hash01(seed, 9101, wave));
  for (let attempt = 0; attempt < GENESIS_BASIN_ATTEMPTS; attempt++) {
    const p = inBox(primary, attempt);
    if (suitable(p.lon, p.lat)) return { ...p, basin: primary.name };
  }
  // The drawn basin has no room: try any basin, then the known open-ocean fallback.
  for (let attempt = GENESIS_BASIN_ATTEMPTS; attempt < 2 * GENESIS_BASIN_ATTEMPTS; attempt++) {
    const b = drawBasin(hash01(seed, 9400 + attempt, wave));
    const p = inBox(b, attempt);
    if (suitable(p.lon, p.lat)) return { ...p, basin: b.name };
  }
  return { lon: 135, lat: 18, basin: GENESIS_BASINS[0].name };
}

function updateGenesisWaves(state: GameState): void {
  const genesis = state.genesis;
  if (!genesis.enabled || state.tick < genesis.nextSpawnTick) return;
  // Count pending lows even before their first favourable hour; reserve a whole recipe. Loaded historic storms do not count.
  const pending = state.effects.filter(e => e.type === 'low').length;
  if (state.storms.filter(s => !s.record).length + pending >= GENESIS_MAX_STORMS ||
      state.effects.length + GENESIS_CONDITIONS.length > MAX_ACTIVE_EFFECTS) {
    genesis.nextSpawnTick = state.tick + 4 * TICKS_PER_HOUR;
    return;
  }
  const wave = genesis.waves + 1;
  const { lon, lat, basin } = pickGenesisSite(state, wave);
  genesis.lastSite = { lon, lat };
  // Automatic placements are reconstructed from seed/time, never recorded as player actions.
  // Negative IDs cannot collide with the positive action-derived IDs of player conditions.
  GENESIS_CONDITIONS.forEach((type, index) => {
    const tool = TOOLS.find(t => t.type === type)!;
    state.effects.push({ id: -((wave - 1) * GENESIS_CONDITIONS.length + index + 1),
      type, lon, lat, radiusKm: tool.radiusKm, remainingHours: tool.durationHours, ageHours: 0 });
  });
  genesis.waves = wave;
  genesis.nextSpawnTick = state.tick + (48 + Math.floor(hash01(state.seed, 9501, wave) * 25)) * TICKS_PER_HOUR;
  addNews(state, { id: `genesis-wave-${wave}`, kind: 'info',
    title: `Natural formation wave ${wave}: conditions gathering…`,
    text: `Warm water, moisture, low pressure, warm air and updraft are gathering near ${fmt(lon, lat)} (${basin}). Weaken these conditions before a depression forms.` });
}

/** Genesis bookkeeping: each active low is a candidate disturbance; favourable hours accumulate. */
function updateCandidates(state: GameState, systems: PressureSystem[], dt: number): void {
  const next: GenesisCandidate[] = [];
  const formed = new Set<number>();
  for (const e of state.effects) {
    if (e.type !== 'low') continue;
    const was = state.candidates.find(c => c.id === e.id)?.progressHours ?? 0;
    const env = environmentAt(state, systems, e.lon, e.lat, isLand(e.lon, e.lat));
    const gp = genesisPotential(env, e.lat);
    const rate = gp >= GENESIS_THRESHOLD ? clamp((gp - GENESIS_THRESHOLD) / 0.5, 0.25, 1.5) : -0.5;
    const progressHours = Math.max(0, was + rate * dt);
    if (progressHours >= GENESIS_HOURS) { formed.add(e.id); continue; }
    if (was === 0 && progressHours > 0) {
      addNews(state, { id: `candidate-${e.id}-${state.tick}`, kind: 'info', title: 'Disturbance organising',
        text: `Warm, moist, spinning air is gathering near ${fmt(e.lon, e.lat)}. A depression may form if it holds.` });
    }
    if (progressHours > 0) next.push({ id: e.id, lon: e.lon, lat: e.lat, progressHours });
  }
  state.candidates = next;
  if (formed.size === 0) return;
  // Every displayed candidate owns its progress and becomes its own depression.
  // Nearby formations must not consume other lows or erase their accumulated progress.
  for (const e of state.effects) {
    if (!formed.has(e.id)) continue;
    const storm = newStorm(state.nextStormId++, e.lon, e.lat, REFERENCE_PRESSURE + systemsAt(systems, e.lon, e.lat).p);
    if (e.formation === 'typhoon') storm.formation = true;
    state.storms.push(storm);
    state.peakWind = Math.max(state.peakWind, storm.wind);
    addNews(state, { id: `formation-${storm.id}`, kind: 'formation', title: `Tropical Depression #${storm.id} forms`,
      text: `Sustained warm, moist, low-shear conditions organised a depression near ${fmt(e.lon, e.lat)}.` });
  }
  // Consume only lows that actually completed genesis, exactly once per placement.
  state.effects = state.effects.filter(e => !formed.has(e.id));
}

/** Record exact stage transitions (including weakening), hourly metrics and final position. */
function recordStormSample(state: GameState, storm: Storm, force = false): void {
  const last = storm.history.at(-1);
  if (!force && last && last.stage === storm.stage && state.tick % TICKS_PER_HOUR !== 0) return;
  const sample = { lon: storm.lon, lat: storm.lat, hour: state.hours, wind: storm.wind,
    pressure: storm.pressure, stage: storm.stage, grade: stageRank(storm.wind),
    movementSpeedKmh: storm.movementSpeedKmh, circulationRadiusKm: outerRadiusKm(storm), galeRadiusKm: storm.galeRadiusKm };
  if (last?.hour === state.hours) storm.history[storm.history.length - 1] = sample;
  else storm.history.push(sample);
  const point = storm.track.at(-1);
  if (!point || point.lon !== storm.lon || point.lat !== storm.lat) storm.track.push({ lon: storm.lon, lat: storm.lat });
}

function archiveStorm(state: GameState, storm: Storm, endReason: StormRecord['endReason'], mergedIntoId?: number): void {
  recordStormSample(state, storm, true);
  state.stormArchive.push({ ...storm, endedHour: state.hours, endReason, mergedIntoId,
    track: storm.track.map(p => ({ ...p })), history: storm.history.map(p => ({ ...p })), forecast: [] });
}

/** A dissipating storm leaves its vortex behind to fade (see stepRemnants). */
function leaveRemnant(state: GameState, storm: Storm): void {
  state.remnants.push({ id: storm.id, lon: storm.lon, lat: storm.lat, wind: storm.wind, radiusKm: storm.radiusKm, ageHours: storm.ageHours, hours: 0 });
}

/** Drifts every remnant with the steering flow (no vortex of its own in it) and lets its wind decay; drops it once it is calm or old. */
function stepRemnants(state: GameState, systems: PressureSystem[], dt: number): void {
  if (!state.remnants.length) return;
  const day = seasonDay(state);
  state.remnants = state.remnants.filter(r => {
    const flow = steeringAt(systems, r, r.wind, day, currentWeather(state));
    const next = moveKm(r.lon, r.lat, (flow.u * dt * 3600) / 1000, (flow.v * dt * 3600) / 1000);
    r.lon = next.lon;
    r.lat = next.lat;
    r.wind *= Math.exp(-dt / REMNANT_TAU_HOURS);
    r.ageHours += dt;
    r.hours += dt;
    return r.wind >= 2 && r.hours <= REMNANT_MAX_HOURS;
  });
}

/** Moves and evolves one storm. Returns false when it dissipates. */
function stepStorm(state: GameState, storm: Storm, systems: PressureSystem[], motion: { u: number; v: number }, dt: number): boolean {
  const label = storm.name ?? `#${storm.id}`;
  const scripted = storm.record ? typhoonById(storm.record.typhoonId) : undefined;
  const recorded = scripted && storm.record ? trackAt(scripted, state.hours - storm.record.startHour) : null;
  if (scripted && !recorded) {
    const last = scripted.points[scripted.points.length - 1];
    addNews(state, { id: `ended-${storm.id}`, kind: 'ended', title: `${label} ends`,
      text: `The recorded track ends at ${fmt(wrapLon(last.lon), last.lat)} after ${storm.ageHours.toFixed(0)} hours. Peak ${storm.peakWind.toFixed(0)} m/s.` });
    archiveStorm(state, storm, last.grade === 'L' ? 'extratropical' : 'dissipated');
    leaveRemnant(state, storm);
    for (const load of state.historic) if (load.stormId === storm.id) load.finished = true;
    return false;
  }
  const wasLand = isLand(storm.lon, storm.lat);
  const prevRank = stageRank(storm.peakWind);
  const next = recorded ?? moveKm(storm.lon, storm.lat, (motion.u * dt * 3600) / 1000, (motion.v * dt * 3600) / 1000);
  // Actual model displacement per model hour, independent of playback speed. The later
  // merger centre adjustment is not travel and deliberately does not inflate this reading.
  storm.movementSpeedKmh = distanceKm(storm.lon, storm.lat, next.lon, next.lat) / dt;
  storm.lon = next.lon;
  storm.lat = next.lat;
  storm.ageHours += dt;
  if (recorded) {
    // Recorded baseline plus a player-driven departure: the extra tendency conditions add over the unmodified record environment.
    const lf = coreLandFraction(storm);
    const land = isLand(storm.lon, storm.lat);
    const w = recorded.wind + storm.windDelta;
    const envWith = environmentAt(state, systems, storm.lon, storm.lat, land);
    const envBase = environmentAt(state, state.initialWeather ? [] : baseSystems(state.seed), storm.lon, storm.lat, land, false);
    storm.windDelta += (intensityTendency(envWith, w, lf) - intensityTendency(envBase, w, lf)) * dt;
    storm.windDelta *= Math.exp(-dt / WIND_DELTA_RELAX_HOURS);
    storm.wind = Math.max(0, recorded.wind + storm.windDelta);
    storm.pressure = recorded.pressure - (pressureDeficit(storm.wind) - pressureDeficit(recorded.wind));
  } else {
    const env = environmentAt(state, systems, storm.lon, storm.lat, isLand(storm.lon, storm.lat));
    const noise = (hash01(state.seed, 707 + storm.id, state.tick) - 0.5) * 0.3;
    storm.wind = Math.max(0, storm.wind + (intensityTendency(env, storm.wind, coreLandFraction(storm)) + noise) * dt);
    storm.pressure = env.pressure - pressureDeficit(storm.wind);
  }
  storm.radiusKm = rmwKm(storm.wind, storm.lat);
  storm.galeRadiusKm = galeRadius(storm);
  storm.stage = stageFor(storm.wind, storm.lon, storm.lat);
  storm.peakWind = Math.max(storm.peakWind, storm.wind);
  state.peakWind = Math.max(state.peakWind, storm.wind);
  const rank = stageRank(storm.peakWind);
  if (rank > prevRank) {
    addNews(state, { id: `stage-${storm.id}-${rank}`, kind: 'intensity', title: `${label} upgraded to ${storm.stage}`,
      text: `Maximum sustained wind ${storm.wind.toFixed(0)} m/s, central pressure ${storm.pressure.toFixed(0)} hPa.` });
  }
  if (!wasLand && isLand(storm.lon, storm.lat)) {
    const city = nearestCity(storm.lon, storm.lat);
    const near = city && distanceKm(city.lon, city.lat, storm.lon, storm.lat) < 400 ? city : null;
    addNews(state, { id: `landfall-${storm.id}-${state.tick}`, kind: 'landfall', cityId: near?.id,
      title: `${label} ${storm.stage} makes landfall${near ? ` near ${near.name}` : ''}`,
      text: `Centre crossed the coast at ${fmt(storm.lon, storm.lat)} with ${storm.wind.toFixed(0)} m/s winds. Land friction and lost ocean heat weaken it.` });
  }
  const gone = recorded ? '' : storm.wind < 10 ? 'weakened into a remnant low' : !storm.formation && Math.abs(storm.lat) > 65 ? 'became a cold-core storm at high latitude' : '';
  if (gone) {
    addNews(state, { id: `ended-${storm.id}`, kind: 'ended', title: `#${storm.id} dissipates`,
      text: `The storm ${gone} at ${fmt(storm.lon, storm.lat)} after ${storm.ageHours.toFixed(0)} hours. Peak ${storm.peakWind.toFixed(0)} m/s.` });
    archiveStorm(state, storm, storm.wind < 10 ? 'dissipated' : 'extratropical');
    leaveRemnant(state, storm);
    return false;
  }
  return true;
}

/** Merge mature, close, same-hemisphere storms; newly formed lows retain independent progress. */
function mergeStorms(state: GameState, archive = true): Set<number> {
  const eligible = state.storms.filter(s => !s.record && s.ageHours >= MERGER_MIN_AGE_HOURS && s.wind >= MERGER_MIN_WIND); // recorded storms never merge
  const pairs: { a: Storm; b: Storm; distance: number }[] = [];
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i];
    const b = eligible[j];
    if (spinSign(a.lat) !== spinSign(b.lat)) continue;
    const distance = distanceKm(a.lon, a.lat, b.lon, b.lat);
    if (distance <= MERGER_DISTANCE_KM) pairs.push({ a, b, distance });
  }
  // Closest pair first, with stable ID tie breaks independent of array order.
  pairs.sort((x, y) => x.distance - y.distance
    || Math.min(x.a.id, x.b.id) - Math.min(y.a.id, y.b.id)
    || Math.max(x.a.id, x.b.id) - Math.max(y.a.id, y.b.id));
  const used = new Set<number>();
  const absorbed = new Set<number>();
  const survivors = new Set<number>();
  for (const { a, b } of pairs) {
    if (used.has(a.id) || used.has(b.id)) continue;
    used.add(a.id); used.add(b.id);
    const keep = a.wind > b.wind || (a.wind === b.wind && a.id < b.id) ? a : b;
    const other = keep === a ? b : a;
    if (archive) {
      other.pressure = totalPressure(state, other.lon, other.lat);
      archiveStorm(state, other, 'merged', keep.id);
    }
    // A bounded game approximation: wind-weighted centre, strongest wind retained rather than summed.
    const fraction = other.wind ** 2 / (keep.wind ** 2 + other.wind ** 2);
    const { dx, dy } = offsetKm(keep.lon, keep.lat, other.lon, other.lat);
    const centre = moveKm(keep.lon, keep.lat, dx * fraction, dy * fraction);
    keep.lon = centre.lon; keep.lat = centre.lat;
    keep.ageHours = Math.max(keep.ageHours, other.ageHours);
    keep.peakWind = Math.max(keep.peakWind, other.peakWind);
    keep.radiusKm = rmwKm(keep.wind, keep.lat);
    keep.galeRadiusKm = galeRadius(keep);
    keep.stage = stageFor(keep.wind, keep.lon, keep.lat);
    absorbed.add(other.id); survivors.add(keep.id);
    addNews(state, { id: `merger-${keep.id}-${other.id}-${state.tick}`, kind: 'merger',
      absorbedId: other.id, mergedIntoId: keep.id,
      title: `Storm #${other.id} merges into #${keep.id}`,
      text: `Two developed storms joined near ${fmt(keep.lon, keep.lat)}. Storm #${keep.id} continues with maximum wind ${keep.wind.toFixed(0)} m/s. Nearby forming lows keep their own progress.` });
  }
  if (absorbed.size) state.storms = state.storms.filter(s => !absorbed.has(s.id));
  return survivors;
}

/** Advance exactly one fixed step of STEP_HOURS. The world never ends. */
export function stepGame(state: GameState): void {
  const dt = STEP_HOURS;
  for (const e of state.effects) {
    const was = effectWeight(e);
    e.ageHours += dt; e.remainingHours -= dt;
    // As a pressure tool fades, transfer the lost part to the evolving atmosphere.
    // Its marker can disappear without uncovering the downloaded pressure map again.
    const retained = Math.max(0, was - Math.max(0, effectWeight(e)));
    if (state.weather && retained > 0 && isPressureTool(e.type)) {
      const weather = state.weather;
      const sys = [{ ...effectSystem(e), amp: (THERMAL_PRESSURE[e.type] ?? EFFECT_STRENGTH[e.type]) * retained }];
      forCellsNear(e.lon, e.lat, e.radiusKm / 2 * SYSTEM_CUTOFF_SIGMA, k => {
        const cell = state.grid[k], change = systemsAt(sys, cell.lon, cell.lat);
        const friction = centreLand(k) ? LAND_WIND_FACTOR : 1;
        weather.pressure[k] = clamp(weather.pressure[k] + change.p, 800, 1100);
        weather.u[k] = clamp(weather.u[k] + change.u * friction, -200, 200);
        weather.v[k] = clamp(weather.v[k] + change.v * friction, -200, 200);
      });
    }
  }
  state.effects = state.effects.filter(e => e.remainingHours > 1e-9);
  if (state.weather) stepLiveWeather(state.weather, dt, { dayOfYear: dayOfYear(state), cells: state.grid });
  state.tick += 1;
  state.hours = state.tick * STEP_HOURS;

  stepWeatherHazards(state, dt, point => state.grid[gridIndex(point.lon, point.lat)], item => addNews(state, item));
  let systems = allSystems(state);
  if (state.storms.length > 0) {
    const day = seasonDay(state);
    const motions = state.storms.map(s => coupledSteering(systems, s, state.storms, day, currentWeather(state))); // same pre-move snapshot
    state.storms = state.storms.filter((s, k) => stepStorm(state, s, systems, motions[k], dt));
  }
  stepRemnants(state, systems, dt);
  updateGenesisWaves(state);
  systems = allSystems(state);
  const effectCount = state.effects.length;
  updateCandidates(state, systems, dt);
  if (state.effects.length !== effectCount) systems = allSystems(state);
  const merged = mergeStorms(state);
  state.phase = state.storms.length > 0 ? 'active' : 'seeding';
  syncStormPressures(state); // after moves, formations and consumed-low removal

  refreshGrid(state);
  for (const c of state.grid) { // snow depth: wind-packed, 0.5 cm per mm of water, settling 2 %/h, melting 1 cm/h per °C above zero (up to 4 cm/h); steady state ≈ 25 × rate in mm/h (7 mm/h → ~175 cm, 20 cm after ~6 h, 60 cm after ~20 h)
    if (c.land || c.population > 0) c.snowCm = Math.max(0, c.snowCm + c.snow * 0.5 * STEP_HOURS - c.snowCm * 0.02 * STEP_HOURS - (c.airTemperature > 0 ? STEP_HOURS * Math.min(4, c.airTemperature) : 0));
  }
  updateThunderstorms(state, dt);
  syncDisasters(state, point => state.grid[gridIndex(point.lon, point.lat)]);
  applyDamage(state);
  for (const s of state.storms) recordStormSample(state, s, merged.has(s.id));
  if (state.tick % TICKS_PER_HOUR === 0 || merged.size) refreshForecasts(state, systems);
  const trafficMotions = stormMotions(state, systems);
  stepTraffic(state, dt, point => {
    let disasterId: string | undefined, hazardStrength = 0;
    for (const hazard of state.weatherHazards ?? []) {
      const flow = hazardWind(hazard, point), strength = Math.hypot(flow.u, flow.v);
      if (strength > hazardStrength) { hazardStrength = strength; disasterId = `weather-${hazard.id}`; }
    }
    // Away from vortices use the freshly computed wind field. Resolve narrow storm wind walls
    // at the vehicle's actual position instead of repeatedly evaluating global weather in calm areas.
    const nearVortex = [...state.storms, ...state.remnants].some(storm => distanceKm(point.lon, point.lat, storm.lon, storm.lat) < outerRadiusKm(storm) + 50);
    if (!nearVortex) {
      const cell = state.grid[gridIndex(point.lon, point.lat)];
      return { speed: Math.hypot(cell.u, cell.v), disasterId };
    }
    const wind = totalWind(state, point.lon, point.lat);
    let source: Storm | undefined, strength = 0;
    state.storms.forEach((storm, i) => {
      const vortex = stormVortexAt(storm, trafficMotions[i], point.lon, point.lat);
      const speed = Math.hypot(vortex.u, vortex.v);
      if (speed > strength) { strength = speed; source = storm; }
    });
    return { speed: Math.hypot(wind.u, wind.v), ...(hazardStrength > strength ? { disasterId } : { stormId: source?.id }) };
  });
  recordDisasterHistory(state);
}

/** Coupled 72 h paths, sampled every 6 h. Freeze effects/intensity, advance all centres
 * together at the live timestep, and apply the same merger gate. Absorbed paths stop.
 * Only cloned storm records/news are mutated; no simulated forecast leaks into live state.
 */
function refreshForecasts(state: GameState, systems = allSystems(state)): void {
  const natural = state.storms.filter(s => !s.record); // recorded tracks are not forecast
  if (!natural.length) return;
  const paths = new Map(natural.map(s => [s.id, [] as GeoPoint[]]));
  const forecast: GameState = { ...state, news: [], storms: natural.map(s => ({ ...s })) };
  const day = seasonDay(state);
  for (let tick = 1; tick <= FORECAST_HOURS * TICKS_PER_HOUR; tick++) {
    const motions = forecast.storms.map(s => coupledSteering(systems, s, forecast.storms, day, currentWeather(state)));
    forecast.storms = forecast.storms.filter((s, i) => {
      const p = moveKm(s.lon, s.lat, motions[i].u * 3.6 * STEP_HOURS, motions[i].v * 3.6 * STEP_HOURS);
      s.lon = p.lon; s.lat = p.lat; s.ageHours += STEP_HOURS;
      return !!s.formation || Math.abs(s.lat) <= 65;
    });
    // Record an absorbed path's last position even when merger falls between samples.
    const before = forecast.storms.slice();
    mergeStorms(forecast, false);
    const survivors = new Set(forecast.storms.map(s => s.id));
    for (const s of before) {
      if (!survivors.has(s.id) || tick % (6 * TICKS_PER_HOUR) === 0) paths.get(s.id)!.push({ lon: s.lon, lat: s.lat });
    }
    if (!forecast.storms.length) break;
  }
  for (const s of natural) s.forecast = paths.get(s.id)!;
}

// ---------------------------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------------------------

export function isValidUntilTick(untilTick: unknown): untilTick is number {
  return typeof untilTick === 'number' && Number.isInteger(untilTick) && untilTick >= 0 && untilTick <= REPLAY_MAX_TICKS;
}

/** Validates an untrusted action log without iterating unbounded input. Each action is one of: a placed tool, a natural-formation switch, a world-climate control, a season change or a loaded historic typhoon. */
export function validateActions(actions: unknown, untilTick: number = REPLAY_MAX_TICKS): { ok: true; actions: ActionRecord[] } | { ok: false; reason: string } {
  if (!Array.isArray(actions)) return { ok: false, reason: 'Replay actions must be a list.' };
  if (actions.length > REPLAY_MAX_ACTIONS) return { ok: false, reason: `Replay has more than ${REPLAY_MAX_ACTIONS} actions.` };
  const clean: ActionRecord[] = [];
  let lastTick = 0;
  for (let k = 0; k < actions.length; k++) {
    const a: unknown = actions[k];
    if (typeof a !== 'object' || a === null) return { ok: false, reason: `Action ${k + 1} is not an object.` };
    const { tick, type, lon, lat, on, typhoonId, key, value, dayOfYear: day, formation } = a as Record<string, unknown>;
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) return { ok: false, reason: `Action ${k + 1} has an invalid tick.` };
    if (tick > untilTick) return { ok: false, reason: `Action ${k + 1} is after the replay end tick ${untilTick}.` };
    if (tick < lastTick) return { ok: false, reason: `Action ${k + 1} is out of time order.` };
    lastTick = tick;
    if (type === 'genesis') {
      if (typeof on !== 'boolean') return { ok: false, reason: `Action ${k + 1} needs natural formation set to on or off.` };
      clean.push({ tick, type, on });
    } else if (type === 'climate') {
      const rounded = normalizeClimate(key, value);
      if (rounded === null) return { ok: false, reason: `Action ${k + 1} has an unknown climate control or a value out of range.` };
      clean.push({ tick, type, key: key as ClimateKey, value: rounded });
    } else if (type === 'season') {
      if (!isValidDayOfYear(day)) return { ok: false, reason: `Action ${k + 1} needs a day of the year between 0 and 366.` };
      clean.push({ tick, type, dayOfYear: day });
    } else if (type === 'historic') {
      if (typeof typhoonId !== 'string' || !typhoonById(typhoonId)) return { ok: false, reason: `Action ${k + 1} names an unknown typhoon.` };
      clean.push({ tick, type, typhoonId });
    } else {
      if (typeof type !== 'string' || !TOOL_TYPES.includes(type as ToolType)) return { ok: false, reason: `Action ${k + 1} has an unknown tool.` };
      if (typeof lon !== 'number' || typeof lat !== 'number' || !inBounds(lon, lat)) return { ok: false, reason: `Action ${k + 1} has an invalid position.` };
      if (formation !== undefined && !['typhoon', 'blizzard', 'tornado'].includes(formation as string) && !isWeatherHazardKind(formation)) return { ok: false, reason: `Action ${k + 1} has an invalid formation tag.` };
      clean.push({ tick, type: type as ToolType, lon, lat, ...(formation ? { formation: formation as FormationKind } : {}) });
    }
  }
  return { ok: true, actions: clean };
}

/**
 * Re-runs the world from seed + action log, stepping to `untilTick` and applying actions due at
 * `untilTick` last, which reproduces a live snapshot taken at that tick. Work is bounded by
 * REPLAY_MAX_TICKS steps and REPLAY_MAX_ACTIONS actions. Historic reanalysis data must already be
 * registered (setHistoricEnvironment) for every typhoon the log loads.
 */
export function replayGame(seed: unknown, actions: unknown, untilTick: unknown, startDayOfYear: unknown = DEFAULT_START_DOY, trafficDispatches: unknown = [], initialWeather?: LiveWeatherSnapshot): { ok: true; state: GameState } | { ok: false; reason: string } {
  if (!isValidDayOfYear(startDayOfYear)) return { ok: false, reason: 'Replay start day must be a number from 0 to 366.' };
  if (!isValidSeed(seed)) return { ok: false, reason: 'Replay seed must be an integer between 0 and 4294967295.' };
  if (!isValidUntilTick(untilTick)) return { ok: false, reason: `Replay end tick must be an integer between 0 and ${REPLAY_MAX_TICKS} (${REPLAY_MAX_HOURS} hours).` };
  if (initialWeather !== undefined && !isLiveWeatherSnapshot(initialWeather)) return { ok: false, reason: 'Replay starting weather is invalid.' };
  const checked = validateActions(actions, untilTick);
  if (!checked.ok) return checked;
  const traffic = validateTrafficDispatches(trafficDispatches, untilTick);
  if (!traffic.ok) return traffic;
  const state = createGame(seed, startDayOfYear, initialWeather);
  const list = checked.actions;
  let k = 0;
  let dispatchIndex = 0;
  const applyDue = (): string | null => {
    while (k < list.length && list[k].tick === state.tick) {
      const a = list[k];
      const r = a.type === 'genesis' ? setGenesis(state, a.on)
        : a.type === 'climate' ? setClimate(state, a.key, a.value)
        : a.type === 'season' ? setSeason(state, a.dayOfYear)
        : a.type === 'historic' ? loadHistoric(state, a.typhoonId)
        : placeTool(state, a.type, a.lon, a.lat, a.formation);
      if (!r.ok) return `Action ${k + 1} was rejected at hour ${state.hours}: ${r.reason}`;
      k++;
    }
    while (dispatchIndex < traffic.dispatches.length && traffic.dispatches[dispatchIndex].tick === state.tick) {
      const result = applyTrafficDispatch(state, traffic.dispatches[dispatchIndex++]);
      if (!result.ok) return result.reason ?? 'Invalid traffic dispatch.';
    }
    return null;
  };
  while (state.tick < untilTick) {
    const err = applyDue();
    if (err) return { ok: false, reason: err };
    stepGame(state);
  }
  const err = applyDue();
  if (err) return { ok: false, reason: err };
  return { ok: true, state };
}
