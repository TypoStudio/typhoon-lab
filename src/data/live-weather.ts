import { byteRange, decodeFieldValues, findRecord, nearestGridpoint, parseFields, parseGrid, parseIdx, parseProduct, splitMessages } from '@azohra/meteo.grib';
import type { LiveWeatherSnapshot } from '../types';
import { isLiveWeatherSnapshot, LIVE_WEATHER_COLS, LIVE_WEATHER_ROWS } from '../simulation/live-weather';

// Google's JSON download endpoint allows browser CORS and byte ranges, including on static hosting.
// The plain S3/GCS object endpoints do not enable CORS for this NOAA bucket.
const ENDPOINT = 'https://storage.googleapis.com/download/storage/v1/b/global-forecast-system/o/';
const HOUR = 3_600_000;
const CACHE_KEY = '/__weather-cache/gfs-start-v2';
type WeatherResult = { snapshot: LiveWeatherSnapshot; source: 'live' | 'cached' } | { source: 'base'; snapshot?: undefined };

export function gfsRunCandidates(now: number): string[] {
  const cycle = Math.floor(now / (6 * HOUR)) * 6 * HOUR;
  return Array.from({ length: 4 }, (_, i) => new Date(cycle - i * 6 * HOUR).toISOString());
}

export function gfsDownloadUrl(run: string, index = false): string {
  const date = run.slice(0, 10).replaceAll('-', ''), hour = run.slice(11, 13);
  const key = `gfs.${date}/${hour}/atmos/gfs.t${hour}z.pgrb2.1p00.f000${index ? '.idx' : ''}`;
  return `${ENDPOINT}${encodeURIComponent(key)}?alt=media`;
}

/** Decode the requested record only, checking its identity, timestamp and global grid. */
type GfsVariable = 'pressure' | 'u' | 'v' | 'seaTemperature' | 'airTemperature' | 'land' | 'ice';
export function decodeGfsRecord(bytes: Uint8Array, run: string, variable: GfsVariable): number[] {
  const definitions: Record<GfsVariable, [number, number, number, number, number?]> = {
    pressure: [0, 3, 1, 101], u: [0, 2, 2, 103, 10], v: [0, 2, 3, 103, 10],
    seaTemperature: [0, 0, 0, 1], airTemperature: [0, 0, 0, 103, 2],
    land: [2, 0, 0, 1], ice: [10, 2, 0, 1],
  };
  const expected = definitions[variable];
  const field = splitMessages(bytes).flatMap(parseFields).find(field => {
    const p = parseProduct(field.section4);
    return field.discipline === expected[0] && p.parameterCategory === expected[1] && p.parameterNumber === expected[2]
      && p.typeOfFirstFixedSurface === expected[3] && p.forecastTime === 0
      && (expected[4] === undefined || p.scaledValueOfFirstFixedSurface === expected[4]);
  });
  if (!field) throw new Error(`Missing GFS ${variable} analysis record.`);
  const id = field.identification;
  if (Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second) !== Date.parse(run)) throw new Error('GFS cycle mismatch.');
  const grid = parseGrid(field.section3);
  if (grid.kind !== 'latlon' || grid.ni !== 360 || grid.nj !== 181 || grid.uvRelativeToGrid) throw new Error('Unexpected GFS global grid.');
  const decoded = decodeFieldValues(field);
  if (decoded.missingCount) throw new Error('Incomplete GFS field.');
  const values: number[] = [];
  for (let row = 0; row < LIVE_WEATHER_ROWS; row++) for (let col = 0; col < LIVE_WEATHER_COLS; col++) {
    const point = nearestGridpoint(grid, -89 + row * 2, -179 + col * 2);
    const n = decoded.values[point.index];
    const value = variable === 'pressure' ? n / 100
      : variable === 'airTemperature' || variable === 'seaTemperature' ? n - 273.15 : n;
    values.push((variable === 'pressure' ? Math.round(value * 10) / 10 : Math.round(value * 100) / 100) || 0);
  }
  return values;
}

export async function fetchGfsSnapshot(run: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<LiveWeatherSnapshot> {
  const response = await fetcher(gfsDownloadUrl(run, true), { signal });
  if (!response.ok) throw new Error(`GFS index HTTP ${response.status}`);
  const records = parseIdx(await response.text());
  const variables = [
    ['pressure', 'PRMSL', 'mean sea level'], ['u', 'UGRD', '10 m above ground'], ['v', 'VGRD', '10 m above ground'],
    ['seaTemperature', 'TMP', 'surface'], ['airTemperature', 'TMP', '2 m above ground'],
    ['land', 'LAND', 'surface'], ['ice', 'ICEC', 'surface'],
  ] as const;
  const fields = await Promise.all(variables.map(async ([key, variable, level]) => {
    const record = findRecord(records, variable, level, 'anl');
    if (!record.length || record.length > 1_000_000) throw new Error('Unexpected GFS record size.');
    const res = await fetcher(gfsDownloadUrl(run), { signal, headers: { Range: byteRange(record) } });
    if (res.status !== 206) { await res.body?.cancel(); throw new Error('GFS server did not honor byte range.'); }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== record.length) throw new Error('Truncated GFS record.');
    return [key, decodeGfsRecord(bytes, run, key)] as const;
  }));
  const decoded = Object.fromEntries(fields);
  const seaTemperature = decoded.seaTemperature.map((t, i) => decoded.land[i] >= 0.5 ? null
    : decoded.ice[i] >= 0.15 ? -1.8 : Math.max(-1.8, t));
  const snapshot = { source: 'NOAA GFS', modelRun: run, pressure: decoded.pressure, u: decoded.u, v: decoded.v,
    seaTemperature, airTemperature: decoded.airTemperature };
  if (!isLiveWeatherSnapshot(snapshot)) throw new Error('Invalid GFS snapshot.');
  return snapshot;
}

/** Bound startup waiting; persist one validated starting analysis for offline/repeated entries. */
export async function loadLiveWeather(now = Date.now()): Promise<WeatherResult> {
  let cache: Cache | undefined, cached: LiveWeatherSnapshot | undefined;
  try {
    cache = await caches.open('typhoon-weather-v2');
    const value: unknown = await (await cache.match(CACHE_KEY))?.json();
    if (isLiveWeatherSnapshot(value) && value.seaTemperature && value.airTemperature
      && Date.parse(value.modelRun) <= now && now - Date.parse(value.modelRun) < 48 * HOUR) cached = value;
  } catch { /* private browsing and offline storage restrictions do not prevent play */ }
  if (cached && now - Date.parse(cached.modelRun) < 6 * HOUR) return { snapshot: cached, source: 'cached' };
  const signal = AbortSignal.timeout(10_000);
  for (const run of gfsRunCandidates(now)) {
    try {
      const snapshot = await fetchGfsSnapshot(run, signal);
      try { await cache?.put(CACHE_KEY, new Response(JSON.stringify(snapshot), { headers: { 'Content-Type': 'application/json' } })); } catch { /* optional cache */ }
      return { snapshot, source: 'live' };
    } catch { if (signal.aborted) break; }
  }
  return cached ? { snapshot: cached, source: 'cached' } : { source: 'base' };
}
