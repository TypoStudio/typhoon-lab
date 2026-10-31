import type { EnvironmentCell, GameState, LiveWeatherSnapshot, WeatherField } from '../types';
import { clamp, cosLat, KM_PER_DEG_LAT, KM_PER_DEG_LON_EQ, smoothstep } from './geo';

export const LIVE_WEATHER_COLS = 180;
export const LIVE_WEATHER_ROWS = 90;
const CELLS = LIVE_WEATHER_COLS * LIVE_WEATHER_ROWS;
/** Game-model timescales; never relax back toward the downloaded snapshot. */
const PRESSURE_RELAX_HOURS = 72;
const WIND_ADJUST_HOURS = 12;
const REFERENCE_PRESSURE = 1010;

/** Checks both network/cache data and untrusted replay files before they reach the model. */
export function isLiveWeatherSnapshot(value: unknown): value is LiveWeatherSnapshot {
  if (!value || typeof value !== 'object') return false;
  const v = value as LiveWeatherSnapshot;
  if (v.source !== 'NOAA GFS' || typeof v.modelRun !== 'string'
    || !/^\d{4}-\d\d-\d\dT(?:00|06|12|18):00:00\.000Z$/.test(v.modelRun) || !Number.isFinite(Date.parse(v.modelRun))
    || new Date(v.modelRun).toISOString() !== v.modelRun) return false;
  const valid = (a: unknown, min: number, max: number) => Array.isArray(a) && a.length === CELLS
    && a.every(n => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max);
  const seaValid = v.seaTemperature === undefined || (Array.isArray(v.seaTemperature) && v.seaTemperature.length === CELLS
    && v.seaTemperature.every(t => t === null || typeof t === 'number' && Number.isFinite(t) && t >= -3 && t <= 50));
  return valid(v.pressure, 800, 1100) && valid(v.u, -200, 200) && valid(v.v, -200, 200) && seaValid
    && (v.airTemperature === undefined || valid(v.airTemperature, -100, 65));
}

/** Current field for simulation; starting analysis is only a compatibility fallback. */
export function currentWeather(state: Pick<GameState, 'weather' | 'initialWeather'>): WeatherField | undefined {
  return state.weather ?? state.initialWeather;
}

/** Bilinear point sample of a weather field; wraps longitude and clamps poles. */
export function sampleLiveWeather(weather: WeatherField, lon: number, lat: number): { p: number; u: number; v: number; t?: number; air?: number } {
  const x = (((lon + 179) / 2) % LIVE_WEATHER_COLS + LIVE_WEATHER_COLS) % LIVE_WEATHER_COLS;
  const y = Math.max(0, Math.min(LIVE_WEATHER_ROWS - 1, (lat + 89) / 2));
  const x0 = Math.floor(x), x1 = (x0 + 1) % LIVE_WEATHER_COLS;
  const y0 = Math.min(LIVE_WEATHER_ROWS - 2, Math.floor(y));
  const tx = x - x0, ty = y - y0;
  const at = (a: number[]) => {
    const lo = a[y0 * LIVE_WEATHER_COLS + x0] * (1 - tx) + a[y0 * LIVE_WEATHER_COLS + x1] * tx;
    const hi = a[(y0 + 1) * LIVE_WEATHER_COLS + x0] * (1 - tx) + a[(y0 + 1) * LIVE_WEATHER_COLS + x1] * tx;
    return lo * (1 - ty) + hi * ty;
  };
  const seaAt = (a: (number | null)[]) => {
    const a00 = a[y0 * LIVE_WEATHER_COLS + x0], a10 = a[y0 * LIVE_WEATHER_COLS + x1];
    const a01 = a[(y0 + 1) * LIVE_WEATHER_COLS + x0], a11 = a[(y0 + 1) * LIVE_WEATHER_COLS + x1];
    const w00 = a00 === null ? 0 : (1 - tx) * (1 - ty), w10 = a10 === null ? 0 : tx * (1 - ty);
    const w01 = a01 === null ? 0 : (1 - tx) * ty, w11 = a11 === null ? 0 : tx * ty;
    const weight = w00 + w10 + w01 + w11;
    return weight > 0 ? ((a00 ?? 0) * w00 + (a10 ?? 0) * w10 + (a01 ?? 0) * w01 + (a11 ?? 0) * w11) / weight : undefined;
  };
  return { p: at(weather.pressure), u: at(weather.u), v: at(weather.v),
    ...(weather.airTemperature ? { air: at(weather.airTemperature) } : {}),
    ...(weather.seaTemperature ? { t: seaAt(weather.seaTemperature) } : {}),
  };
}

interface WeatherForcing { dayOfYear?: number; cells?: readonly EnvironmentCell[] }
const gaussian = (x: number, centre: number, width: number) => Math.exp(-(((x - centre) / width) ** 2));
/** Solar-heating approximation used when no imported air temperature exists (older replays). */
function radiativeTemperature(lat: number, day: number): number {
  const a = Math.abs(lat), summer = Math.sign(lat) * Math.cos(2 * Math.PI * (day - 172) / 365.25);
  return clamp(28 - 0.65 * a + (2 + 10 * Math.sin(a * Math.PI / 180)) * summer, -65, 40);
}

/** Reduced thermal circulation model: advect weather, sustain circulation from differential
 * heating and rotation, and rebalance wind to pressure gradients. Never restore the initial map.
 */
export function stepLiveWeather(weather: WeatherField, dt: number, forcing: WeatherForcing = {}): void {
  if (dt <= 0) return;
  const pressure = new Array<number>(CELLS), u = new Array<number>(CELLS), v = new Array<number>(CELLS);
  const air = weather.airTemperature ? new Array<number>(CELLS) : undefined;
  const decay = Math.exp(-dt / PRESSURE_RELAX_HOURS);
  const adjust = 1 - Math.exp(-dt / WIND_ADJUST_HOURS);
  const day = forcing.dayOfYear ?? 213;
  const solarLat = 5 * Math.sin(2 * Math.PI * (day - 80) / 365.25);
  const heat = new Float64Array(CELLS), zonalHeat = new Float64Array(LIVE_WEATHER_ROWS);
  let tropicHeat = 0, polarHeat = 0, tropicWeight = 0, polarWeight = 0;
  for (let row = 0; row < LIVE_WEATHER_ROWS; row++) {
    const lat = -89 + row * 2, weight = cosLat(lat);
    for (let col = 0; col < LIVE_WEATHER_COLS; col++) {
      const k = row * LIVE_WEATHER_COLS + col;
      const t = forcing.cells?.[k]?.airTemperature ?? weather.airTemperature?.[k] ?? radiativeTemperature(lat, day);
      const sea = forcing.cells ? (forcing.cells[k].land ? null : forcing.cells[k].temperature) : weather.seaTemperature?.[k];
      heat[k] = sea == null ? t : 0.7 * t + 0.3 * sea;
      zonalHeat[row] += heat[k] / LIVE_WEATHER_COLS;
      if (Math.abs(lat) < 20) { tropicHeat += heat[k] * weight; tropicWeight += weight; }
      if (Math.abs(lat) > 60) { polarHeat += heat[k] * weight; polarWeight += weight; }
    }
  }
  const contrast = tropicHeat / tropicWeight - polarHeat / polarWeight;
  const circulation = clamp(contrast / 35, 0, 1.5);
  for (let row = 0; row < LIVE_WEATHER_ROWS; row++) {
    const lat = -89 + row * 2;
    const a = Math.abs(lat - solarLat);
    // Parameterised Hadley/Ferrel/polar pressure belts, sustained by the current heat contrast.
    const belt = 7 * gaussian(a, 30, 11) - 6 * gaussian(a, 60, 11)
      - 3 * gaussian(a, 0, 12) + 4 * gaussian(a, 90, 12);
    for (let col = 0; col < LIVE_WEATHER_COLS; col++) {
      const k = row * LIVE_WEATHER_COLS + col, lon = -179 + col * 2;
      const fromLat = clamp(lat - weather.v[k] * 3.6 * dt / KM_PER_DEG_LAT, -89, 89);
      const fromLon = lon - weather.u[k] * 3.6 * dt / (KM_PER_DEG_LON_EQ * cosLat((lat + fromLat) / 2));
      const from = sampleLiveWeather(weather, fromLon, fromLat);
      const thermalLow = clamp(-0.18 * (heat[k] - zonalHeat[row]), -5, 5);
      const equilibrium = REFERENCE_PRESSURE + belt * circulation + thermalLow;
      pressure[k] = clamp(equilibrium + (from.p - equilibrium) * decay, 800, 1100);
      u[k] = from.u; v[k] = from.v;
      if (air) {
        const sea = forcing.cells ? (forcing.cells[k].land ? null : forcing.cells[k].temperature) : weather.seaTemperature?.[k];
        const target = (sea == null ? radiativeTemperature(lat, day) : sea - 1.5) + (forcing.cells?.[k]?.airHeating ?? 0);
        air[k] = clamp(from.air! + (target - from.air!) * (1 - Math.exp(-dt / (sea == null ? 72 : 48))), -100, 65);
      }
    }
  }
  // Same damped pressure-gradient response as the game's other pressure systems.
  const sinFloor = Math.sin(10 * Math.PI / 180);
  for (let row = 0; row < LIVE_WEATHER_ROWS; row++) {
    const lat = -89 + row * 2, s = Math.sin(lat * Math.PI / 180);
    const response = (0.45 / 1.2) * (s / (s * s + sinFloor * sinFloor)) / (2 * 7.292e-5);
    const south = Math.max(0, row - 1), north = Math.min(LIVE_WEATHER_ROWS - 1, row + 1);
    const a = Math.abs(lat - solarLat), direction = Math.sign(lat - solarLat);
    const zonal = circulation * (-4 * (1 - smoothstep(20, 32, a))
      + 6 * smoothstep(25, 40, a) * (1 - smoothstep(55, 68, a)) - 3 * smoothstep(62, 78, a));
    const meridional = circulation * direction * (a < 30 ? -1.4 * Math.sin(Math.PI * a / 30)
      : a < 60 ? 0.8 * Math.sin(Math.PI * (a - 30) / 30) : -0.6 * Math.sin(Math.PI * (a - 60) / 30));
    for (let col = 0; col < LIVE_WEATHER_COLS; col++) {
      const k = row * LIVE_WEATHER_COLS + col;
      const west = row * LIVE_WEATHER_COLS + (col + LIVE_WEATHER_COLS - 1) % LIVE_WEATHER_COLS;
      const east = row * LIVE_WEATHER_COLS + (col + 1) % LIVE_WEATHER_COLS;
      const gx = (pressure[east] - pressure[west]) * 100 / (4 * KM_PER_DEG_LON_EQ * cosLat(lat) * 1000);
      const gy = (pressure[north * LIVE_WEATHER_COLS + col] - pressure[south * LIVE_WEATHER_COLS + col]) * 100
        / ((north - south) * 2 * KM_PER_DEG_LAT * 1000);
      u[k] = clamp(u[k] * (1 - adjust) + (zonal - response * gy) * adjust, -200, 200);
      v[k] = clamp(v[k] * (1 - adjust) + (meridional + response * gx) * adjust, -200, 200);
    }
  }
  weather.pressure = pressure; weather.u = u; weather.v = v;
  if (air) weather.airTemperature = air;
}
