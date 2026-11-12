import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { byteRange, findRecord, parseIdx } from '@azohra/meteo.grib';
import { fetchGfsSnapshot } from '../src/data/live-weather';
import { createGame, gridIndex, sampleEnvironment, setClimate, stepGame, TICKS_PER_HOUR } from '../src/simulation/engine';
import type { ClimateKey } from '../src/types';

const RUN = '2026-10-27T00:00:00.000Z';
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

const OCEAN: [number, number] = [141, 19], LAND: [number, number] = [127, 37], POLAR_OCEAN: [number, number] = [-10, 70], POLAR_LAND: [number, number] = [100, 70];
type Point = [number, number];
/** Air and sea temperature at points after three model days with one climate control set. */
function after3Days(weather: Awaited<ReturnType<typeof fetchGfsSnapshot>> | undefined, key: ClimateKey, value: number, points: Point[]) {
  const state = createGame(1, 299, weather);
  if (value !== 0) setClimate(state, key, value);
  for (let i = 0; i < 72 * TICKS_PER_HOUR; i++) stepGame(state);
  return points.map(([lon, lat]) => { const e = sampleEnvironment(state, lon, lat); return { air: e.airTemperature, sst: e.temperature }; });
}

it.each(['base', 'live'])('applies warming and polar once in a %s world', async world => {
  const weather = world === 'live' ? await fetchGfsSnapshot(RUN, AbortSignal.timeout(2000), fixtureFetch()) : undefined;
  const points = [OCEAN, LAND, POLAR_OCEAN, POLAR_LAND];
  const zero = after3Days(weather, 'warming', 0, points);
  const warm = after3Days(weather, 'warming', 2, points);
  expect(Math.abs(warm[0].air - zero[0].air - 2)).toBeLessThan(0.3);
  expect(Math.abs(warm[1].air - zero[1].air - 2)).toBeLessThan(0.3); // land air
  expect(warm[0].sst - zero[0].sst).toBeCloseTo(2, 5);
  const polar = after3Days(weather, 'polar', 5, points); // full from 50 degrees: +5 at 70 degrees
  for (const i of [2, 3]) expect(Math.abs(polar[i].air - zero[i].air - 5)).toBeLessThan(0.3);
  expect(polar[2].sst - zero[2].sst).toBeCloseTo(5, 5);
}, 600_000);
