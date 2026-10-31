import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { byteRange, findRecord, parseIdx } from '@azohra/meteo.grib';
import { fetchGfsSnapshot, gfsRunCandidates, loadLiveWeather } from '../src/data/live-weather';
import { isLiveWeatherSnapshot, sampleLiveWeather, stepLiveWeather } from '../src/simulation/live-weather';
import { distanceKm } from '../src/simulation/geo';
import { createGame, gridIndex, placeTool, replayGame, sampleEnvironment, steeringFlow, stepGame, totalPressure, totalWind } from '../src/simulation/engine';
import { buildReplay, parseReplay, replayExportProblem } from '../src/ui/storage';
import type { LiveWeatherSnapshot, Storm } from '../src/types';

const RUN = '2026-10-27T00:00:00.000Z';
const NOW = Date.parse('2026-10-27T05:00:00Z');
const fixture = (file: string) => readFileSync(new URL(`./fixtures/gfs/${file}`, import.meta.url));
const fields = [
  ['pressure', 'PRMSL', 'mean sea level'], ['u', 'UGRD', '10 m above ground'], ['v', 'VGRD', '10 m above ground'],
  ['seaTemperature', 'TMP', 'surface'], ['airTemperature', 'TMP', '2 m above ground'],
  ['land', 'LAND', 'surface'], ['ice', 'ICEC', 'surface'],
] as const;
function fixtureFetch() {
  const index = fixture('20261027-00.idx').toString();
  const records = parseIdx(index);
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range');
    if (!range) return new Response(index);
    const field = fields.find(([, name, level]) => byteRange(findRecord(records, name, level, 'anl')) === range);
    if (!field) return new Response('', { status: 404 });
    return new Response(new Uint8Array(fixture(`${field[0]}.grib2`)), { status: 206 });
  });
}
const uniform = (): LiveWeatherSnapshot => ({ source: 'NOAA GFS', modelRun: RUN,
  pressure: Array(16200).fill(1005), u: Array(16200).fill(12), v: Array(16200).fill(-3) });

afterEach(() => vi.unstubAllGlobals());

it('decodes real NOAA analysis records onto the correctly oriented global game grid', async () => {
  const fetcher = fixtureFetch();
  const weather = await fetchGfsSnapshot(RUN, AbortSignal.timeout(2000), fetcher);
  expect(isLiveWeatherSnapshot(weather)).toBe(true);
  expect(Math.min(...weather.pressure)).toBe(946.9);
  expect(Math.max(...weather.pressure)).toBe(1048.2);
  expect(fetcher).toHaveBeenCalledTimes(8);
  expect(weather.seaTemperature![gridIndex(141, 19)]).toBeGreaterThan(20);
  expect(weather.seaTemperature![gridIndex(127, 37)]).toBeNull();
  expect(weather.airTemperature![gridIndex(127, 37)]).toBeGreaterThan(-30);
  expect(weather.airTemperature![gridIndex(127, 37)]).toBeLessThan(40);
  // The fixture contains different northern/southern fields: catch a north/south flip.
  expect(weather.pressure[gridIndex(0, -75)]).not.toBe(weather.pressure[gridIndex(0, 75)]);
  for (const [lon, lat] of [[-179, -89], [179, 89], [127, 37]]) {
    const k = gridIndex(lon, lat);
    expect(sampleLiveWeather(weather, lon, lat)).toEqual({ p: weather.pressure[k], u: weather.u[k], v: weather.v[k],
      t: weather.seaTemperature![k] ?? undefined, air: weather.airTemperature![k] });
  }
  const state = createGame(1, 299, weather), ocean = state.grid[gridIndex(141, 19)], land = state.grid[gridIndex(127, 37)];
  expect(ocean.temperature).toBe(weather.seaTemperature![gridIndex(141, 19)]);
  expect(land.airTemperature).toBe(weather.airTemperature![gridIndex(127, 37)]);
  expect(sampleEnvironment(state, 141, 19).temperature).toBe(ocean.temperature);
  expect(sampleEnvironment(state, 127, 37).airTemperature).toBe(land.airTemperature);
  expect(replayExportProblem(state)).toBeNull();
  expect(parseReplay(JSON.stringify(buildReplay(state), null, 2)).ok).toBe(true);
});

it('tries previous published cycles and falls back cleanly on network failure', async () => {
  expect(gfsRunCandidates(Date.parse('2026-10-27T07:00Z')).slice(0, 2)).toEqual(['2026-10-27T06:00:00.000Z', RUN]);
  vi.stubGlobal('caches', undefined);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  expect(await loadLiveWeather(NOW)).toEqual({ source: 'base' });
});

it('uses a recent cache without network, and a bounded older cache when offline', async () => {
  const snapshot = { ...uniform(), seaTemperature: Array(16200).fill(28), airTemperature: Array(16200).fill(26) };
  vi.stubGlobal('caches', { open: async () => ({ match: async () => new Response(JSON.stringify(snapshot)) }) });
  const network = vi.fn().mockRejectedValue(new Error('offline'));
  vi.stubGlobal('fetch', network);
  expect(await loadLiveWeather(NOW)).toEqual({ snapshot, source: 'cached' });
  expect(network).not.toHaveBeenCalled();
  expect(await loadLiveWeather(NOW + 10 * 3600000)).toEqual({ snapshot, source: 'cached' });
  expect(await loadLiveWeather(NOW + 50 * 3600000)).toEqual({ source: 'base' });
});

it('rejects truncated, wrong-cycle and whole-file responses instead of applying corrupt weather', async () => {
  const actual = fixtureFetch();
  await expect(fetchGfsSnapshot('2026-10-27T06:00:00.000Z', AbortSignal.timeout(2000), actual)).rejects.toThrow('cycle mismatch');
  const wholeFile: typeof fetch = async (url, init) => new Headers(init?.headers).has('Range')
    ? new Response('whole file', { status: 200 }) : actual(url, init);
  await expect(fetchGfsSnapshot(RUN, AbortSignal.timeout(2000), wholeFile)).rejects.toThrow('byte range');
  const bad = uniform(); bad.u[12] = NaN;
  expect(isLiveWeatherSnapshot(bad)).toBe(false);
  expect(() => createGame(1, 299, bad)).toThrow('starting weather');
});

it('keeps imported pressure/wind after stepping and adds player effects without double land friction', () => {
  const weather = uniform(), state = createGame(1, 299, weather);
  for (const [lon, lat] of [[127, 37], [141, 19]]) {
    const c = state.grid[gridIndex(lon, lat)];
    expect([c.pressure, c.u, c.v]).toEqual([1005, 12, -3]);
    expect(totalWind(state, lon, lat)).toEqual({ u: 12, v: -3 });
    expect(sampleEnvironment(state, lon, lat).pressure).toBe(1005);
  }
  placeTool(state, 'low', 141, 19);
  for (let i = 0; i < 8; i++) stepGame(state);
  expect(state.grid[gridIndex(141, 19)].pressure).toBeLessThan(1005);
  for (const [lon, lat] of [[127, 37], [141, 19]]) {
    const c = state.grid[gridIndex(lon, lat)], w = totalWind(state, lon, lat);
    expect(c.pressure).toBeCloseTo(totalPressure(state, lon, lat), 6);
    expect(c.u).toBeCloseTo(w.u, 6); expect(c.v).toBeCloseTo(w.v, 6);
  }
  expect(weather.pressure.every(p => p === 1005)).toBe(true);
});

it('uses imported wind to steer typhoons, with the existing beta drift', () => {
  const state = createGame(1, 299, uniform());
  const storm = { id: 1, lon: 140, lat: 20, wind: 40, radiusKm: 50, ageHours: 20 } as Storm;
  state.storms = [storm];
  expect(steeringFlow(state, storm)).toEqual({ u: 10.8, v: -1.2000000000000002 });
});

it('exports the initial analysis and replays it without another network request', () => {
  const state = createGame(1, 299, uniform());
  placeTool(state, 'low', 141, 19);
  for (let i = 0; i < 4; i++) stepGame(state);
  expect(replayExportProblem(state)).toBeNull();
  const parsed = parseReplay(JSON.stringify(buildReplay(state)));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  const r = parsed.replay;
  const replay = replayGame(r.seed, r.actions, r.untilTick, r.startDayOfYear, r.trafficDispatches, r.initialWeather);
  expect(replay.ok).toBe(true);
  if (replay.ok) {
    expect(replay.state.grid).toEqual(state.grid);
    expect(replay.state.weather).toEqual(state.weather);
  }
  r.initialWeather!.pressure.pop();
  expect(parseReplay(JSON.stringify(r)).ok).toBe(false);
});

it('moves and weakens a downloaded low instead of continually restoring its initial pressure', () => {
  const weather = uniform();
  weather.pressure = weather.pressure.map((_, k) => {
    const lon = -179 + (k % 180) * 2, lat = -89 + Math.floor(k / 180) * 2;
    return 1010 - 15 * Math.exp(-(distanceKm(141, 19, lon, lat) ** 2) / (2 * 500 ** 2));
  });
  weather.u.fill(20); weather.v.fill(0);
  const initial = weather.pressure.slice();
  for (let i = 0; i < 24; i++) stepLiveWeather(weather, 0.25);
  const row = weather.pressure.slice(54 * 180, 55 * 180);
  const minimumLon = -179 + row.indexOf(Math.min(...row)) * 2;
  expect(minimumLon).toBeGreaterThan(141);
  expect(Math.min(...weather.pressure)).toBeGreaterThan(Math.min(...initial));
  expect(weather.pressure[gridIndex(141, 19)]).toBeGreaterThan(initial[gridIndex(141, 19)]);
  expect(weather.u.every(Number.isFinite)).toBe(true);
  expect(weather.v.every(Number.isFinite)).toBe(true);
});

it('does not uncover the original low when overriding high-pressure tools expire', () => {
  const initial = uniform();
  initial.u.fill(0); initial.v.fill(0);
  initial.pressure = initial.pressure.map((_, k) => {
    const lon = -179 + (k % 180) * 2, lat = -89 + Math.floor(k / 180) * 2;
    return 1010 - 14 * Math.exp(-(distanceKm(141, 19, lon, lat) ** 2) / (2 * 650 ** 2));
  });
  const control = createGame(1, 299, initial), changed = createGame(1, 299, initial);
  for (let i = 0; i < 3; i++) expect(placeTool(changed, 'high', 141, 19).ok).toBe(true);
  let beforeExpiry = 0;
  for (let i = 0; i < 288; i++) {
    if (i === 287) beforeExpiry = totalPressure(changed, 141, 19);
    stepGame(control); stepGame(changed);
  }
  const afterExpiry = totalPressure(changed, 141, 19);
  expect(changed.effects.filter(e => e.type === 'high')).toHaveLength(0);
  expect(afterExpiry).toBeGreaterThan(totalPressure(control, 141, 19) + 8);
  expect(afterExpiry).toBeGreaterThan(1010);
  expect(Math.abs(afterExpiry - beforeExpiry)).toBeLessThan(1);
  expect(changed.initialWeather).toEqual(initial);
  const parsed = parseReplay(JSON.stringify(buildReplay(changed)));
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    const r = parsed.replay;
    const replay = replayGame(r.seed, r.actions, r.untilTick, r.startDayOfYear, r.trafficDispatches, r.initialWeather);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state.weather).toEqual(changed.weather);
  }
}, 60_000);

it('keeps a paused field unchanged and does not create wind from rotation without a heat contrast', () => {
  const weather = uniform(); weather.u.fill(0); weather.v.fill(0);
  weather.airTemperature = Array(16200).fill(20); weather.seaTemperature = Array(16200).fill(21.5);
  const before = structuredClone(weather);
  stepLiveWeather(weather, 0);
  expect(weather).toEqual(before);
  for (let i = 0; i < 288; i++) stepLiveWeather(weather, 0.25);
  expect(weather.pressure[0]).toBeCloseTo(1010 - 5 / Math.E, 6);
  expect(weather.u[0]).toBeCloseTo(0, 10); expect(weather.v[0]).toBeCloseTo(0, 10);
});

it('sustains pressure belts, trade winds and westerlies from heat contrast after a week', () => {
  const weather = uniform(); weather.pressure.fill(1010); weather.u.fill(0); weather.v.fill(0);
  weather.seaTemperature = Array.from({ length: 16200 }, (_, k) => Math.max(-1.8, 30 - Math.abs(-89 + Math.floor(k / 180) * 2) * 0.65));
  weather.airTemperature = weather.seaTemperature.map(t => t! - 2);
  for (let i = 0; i < 7 * 24 * 4; i++) stepLiveWeather(weather, 0.25);
  expect(Math.max(...weather.pressure) - Math.min(...weather.pressure)).toBeGreaterThan(8);
  for (const lat of [15, -15]) expect(weather.u[gridIndex(141, lat)]).toBeLessThan(-1);
  for (const lat of [45, -45]) expect(weather.u[gridIndex(141, lat)]).toBeGreaterThan(1);
  expect(weather.pressure.every(Number.isFinite)).toBe(true);
  expect(weather.u.every(Number.isFinite)).toBe(true);
  expect(weather.v.every(Number.isFinite)).toBe(true);
}, 60_000);
