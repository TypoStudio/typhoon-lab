import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { byteRange, findRecord, parseIdx } from '@azohra/meteo.grib';
import { fetchGfsSnapshot } from '../src/data/live-weather';
import { buildFieldData, sampleGrid } from '../src/render/fields';
import { createGame, setClimate } from '../src/simulation/engine';
import type { GameState, LiveWeatherSnapshot } from '../src/types';
import { fullDays } from './climate-helpers';

vi.setConfig({ testTimeout: 300_000 });

// The slider is an imposed experiment: what the renderer draws (the grid as the worker posts it, read through the renderer's own field copy and sampler) must answer at once, paused or running.
const fixture = (file: string) => readFileSync(new URL(`./fixtures/gfs/${file}`, import.meta.url));
const FIELDS = [['pressure', 'PRMSL', 'mean sea level'], ['u', 'UGRD', '10 m above ground'], ['v', 'VGRD', '10 m above ground'], ['seaTemperature', 'TMP', 'surface'], ['airTemperature', 'TMP', '2 m above ground'], ['land', 'LAND', 'surface'], ['ice', 'ICEC', 'surface']] as const;
const gfs = async (): Promise<LiveWeatherSnapshot> => {
  const index = fixture('20261027-00.idx').toString(), records = parseIdx(index);
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const range = new Headers(init?.headers).get('Range');
    if (!range) return new Response(index);
    const field = FIELDS.find(([, name, level]) => byteRange(findRecord(records, name, level, 'anl')) === range);
    return field ? new Response(new Uint8Array(fixture(`${field[0]}.grib2`)), { status: 206 }) : new Response('', { status: 404 });
  });
  return fetchGfsSnapshot('2026-10-27T00:00:00.000Z', AbortSignal.timeout(5000), fetcher);
};

/** What the overlays show at a point: the posted state's grid through the renderer's field data. */
const overlay = (s: GameState, lon: number, lat: number) => {
  const f = buildFieldData(structuredClone(s).grid)!;
  return { sst: sampleGrid(f, f.temperature, lon, lat), p: sampleGrid(f, f.pressure, lon, lat) };
};
const POINTS = { w150: [-150, 0], w120: [-120, 0], darwin: [131, -12.4], tahiti: [-149.6, -17.5] } as const;
const diff = (a: GameState, b: GameState) => Object.fromEntries(Object.entries(POINTS).map(([name, [lon, lat]]) => {
  const x = overlay(a, lon, lat), y = overlay(b, lon, lat);
  return [name, { sst: x.sst - y.sst, p: x.p - y.p }];
}));

describe('the ENSO slider reaches the temperature and pressure overlays', () => {
  for (const world of ['base', 'live'] as const) {
    it(`${world} world: La Niña -2 changes the drawn sea and pressure at once (paused) and stays after a model day (running)`, async () => {
      const make = async (): Promise<GameState> => world === 'base' ? createGame(20261022) : createGame(20261022, 300, await gfs());
      const nina = await make(), control = await make();
      for (const w of [nina, control]) fullDays(w, 0.5);
      setClimate(nina, 'enso', -2);
      const paused = diff(nina, control);
      for (const w of [nina, control]) fullDays(w, 1);
      const running = diff(nina, control);
      console.info(`[climate-overlay] ${world} La Nina -2 vs control, paused:`, JSON.stringify(paused, (_k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
      console.info(`[climate-overlay] ${world} La Nina -2 vs control, +1 day running:`, JSON.stringify(running, (_k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
      for (const d of [paused, running]) {
        // measured, base / live (GFS fixture, a strong El Nino start): 150W sea -1.8 / -4.0, 120W sea -1.8 / -5.8, Darwin pressure -0.6 / -4.0 hPa, Tahiti +0.3 / +3.4 hPa
        expect(d.w150.sst).toBeLessThan(-1); // the central Pacific is cold, drawn on the temperature overlay
        expect(d.w120.sst).toBeLessThan(-1);
        expect(d.darwin.p).toBeLessThan(-0.4); // La Niña: low pressure at Darwin, high at Tahiti (positive SOI)
        expect(d.tahiti.p).toBeGreaterThan(0.25);
      }
    });
  }
});
