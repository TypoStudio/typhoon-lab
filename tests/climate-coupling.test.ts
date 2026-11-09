import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { byteRange, findRecord, parseIdx } from '@azohra/meteo.grib';
import { fetchGfsSnapshot } from '../src/data/live-weather';
import { equatorNormalSst } from '../src/data/climate-normals';
import {
  MAX_PATCHES, OCEAN_N, createClimate, restoreClimate, serializeClimate, stackSstPatch, stepClimateDay, addSstPatch, climateFields, climateIndices,
} from '../src/simulation/climate-core';
import { CLIMATE_SOURCE, createLiveClimateLayer } from '../src/simulation/climate-coupling';
import {
  STEP_HOURS, createGame, gridIndex, loadHistoric, placeFormation, placeTool, replayGame, sampleEnvironment, setClimate, setHistoricEnvironment, setSeason, stepGame, totalPressure, totalWind,
} from '../src/simulation/engine';
import { windowCells } from '../src/simulation/historic';
import type { GameState, HistoricEnvironment, LiveWeatherSnapshot } from '../src/types';
import { atlanticShear, fullDays, genesisCentroid, skipDays } from './climate-helpers';
import fixtureJson from './fixtures/environment-fixture.json';
import golden from './fixtures/base-world-golden.json';

vi.setConfig({ testTimeout: 120_000 }); // twin worlds run thousands of weather steps, slower when files run in parallel

const SEED = 20261022;
const AUG_1 = 213, NOV_1 = 305;
const DARWIN: [number, number] = [131, -12.4], TAHITI: [number, number] = [-149.6, -17.5], NP: [number, number] = [-165, 45];
const note = (...a: unknown[]) => console.info('[climate-coupling]', ...a);
/** A change in a sampled quantity between the perturbed and the control world. */
const delta = (a: GameState, b: GameState, [lon, lat]: [number, number], pick: (s: GameState, lon: number, lat: number) => number) => pick(a, lon, lat) - pick(b, lon, lat);
const press = (s: GameState, lon: number, lat: number) => totalPressure(s, lon, lat);
const sst = (s: GameState, lon: number, lat: number) => sampleEnvironment(s, lon, lat).temperature;
const hum = (s: GameState, lon: number, lat: number) => sampleEnvironment(s, lon, lat).humidity;
const uWind = (s: GameState, lon: number, lat: number) => totalWind(s, lon, lat).u;
const twin = (startDay: number, perturb: (s: GameState) => void): [GameState, GameState] => {
  const a = createGame(SEED, startDay), b = createGame(SEED, startDay);
  perturb(a);
  return [a, b];
};
/** A live analysis whose equatorial SST is exactly the ERSST normal (no ENSO anomaly), with calm uniform pressure and wind. */
const RUN_ID = '2026-10-27T00:00:00.000Z';
const neutralSnapshot = (): LiveWeatherSnapshot => {
  const month = ((300 - 0.5) / 365) * 12 - 0.5;
  const sea = Array.from({ length: 16200 }, (_, k) => {
    const col = k % 180, row = Math.floor(k / 180), lon = -179 + 2 * col, lat = -89 + 2 * row;
    if (Math.abs(lat) > 12) return 20;
    try { return equatorNormalSst(month, lon < 0 ? lon + 360 : lon); } catch { return null; }
  });
  return { source: 'NOAA GFS', modelRun: RUN_ID, pressure: Array(16200).fill(1010), u: Array(16200).fill(0), v: Array(16200).fill(0), seaTemperature: sea, airTemperature: Array(16200).fill(25) };
};
const stack = (s: GameState, type: 'warm' | 'cool', n: number, lon = -150, lat = 0) => { for (let i = 0; i < n; i++) expect(placeTool(s, type, lon, lat).ok).toBe(true); };

afterEach(() => { setHistoricEnvironment('maemi-2003', null); vi.unstubAllGlobals(); });

describe('A. an untouched base world is unchanged', () => {
  const fingerprint = (s: GameState) => {
    let t = 0, p = 0, u = 0, v = 0, sh = 0, h = 0, a = 0;
    for (const c of s.grid) { t += c.temperature; p += c.pressure; u += c.u; v += c.v; sh += c.shear; h += c.humidity; a += c.airTemperature; }
    return { t, p, u, v, sh, h, a };
  };
  it('matches the pre-change engine exactly (golden values recorded from the commit before this stage) and has no climate layer', () => {
    const s = createGame(SEED);
    for (let i = 0; i < golden.steps; i++) stepGame(s); // 200 steps cross two climate-day boundaries (ticks 96 and 192)
    expect(s.climateLayer).toBeNull();
    expect({ base: fingerprint(s), env: [[140, 15], [-120, 0], [10, 50], [-50, 15]].map(([x, y]) => sampleEnvironment(s, x, y)), tp: totalPressure(s, 140, 15), tw: totalWind(s, 140, 15) }).toEqual(golden.neutral);
    const w = createGame(SEED);
    setClimate(w, 'warming', 1.5); setClimate(w, 'polar', -3); placeTool(w, 'low', 140, 16); placeTool(w, 'moisture', 140, 16);
    for (let i = 0; i < golden.steps; i++) stepGame(w);
    expect(w.climateLayer).toBeNull(); // warming, polar and non-water tools do not activate the layer
    expect({ base: fingerprint(w), env: [[140, 15], [-120, 0]].map(([x, y]) => sampleEnvironment(w, x, y)) }).toEqual(golden.controls);
  });

  it('activates only on the ENSO slider, a warm/cool tool within 30 degrees (not recipes), or a live start; a zero slider changes nothing', () => {
    const s = createGame(SEED);
    expect(setClimate(s, 'enso', 0).ok).toBe(true);
    expect(s.climateLayer).toBeNull();
    expect(placeTool(s, 'warm', -150, 45).ok).toBe(true); // too far poleward
    expect(placeTool(s, 'cool', 10, 0).ok).toBe(false); // land
    expect(s.climateLayer).toBeNull();
    setClimate(s, 'enso', 1);
    expect(s.climateLayer).not.toBeNull();
    expect(s.climateLayer!.core.hold).toBe(1);
    setClimate(s, 'enso', 0);
    expect(s.climateLayer!.core.hold).toBeNull();
    const t = createGame(SEED);
    placeTool(t, 'warm', -150, 20);
    expect(t.climateLayer!.core.nPatches).toBe(1);
    const recipe = createGame(SEED);
    expect(placeFormation(recipe, 'typhoon', -150, 27).ok).toBe(true); // a recipe stacks local warm tools; they stay out of the layer
    expect(recipe.effects.some(e => e.type === 'warm')).toBe(true);
    expect(recipe.climateLayer).toBeNull();
  });
});

describe('a layer that nothing drives', () => {
  it('has exactly zero anomalies everywhere, including regions whose normal SST is below the 18 C floor', () => {
    const f = climateFields(createClimate(1, 213, 2000, false));
    for (const key of ['sst', 'slp', 'u', 'v', 'precip'] as const) expect(f[key].every(x => x === 0), key).toBe(true);
    const w = createGame(SEED), c = createGame(SEED);
    setClimate(w, 'enso', 1); setClimate(w, 'enso', 0);
    const an = w.climateLayer!.anomalies!;
    for (const key of ['sst', 'air', 'hum', 'slp', 'u', 'v', 'ug', 'vg', 'shear'] as const) expect(an[key].every(x => x === 0), key).toBe(true);
    expect(sampleEnvironment(w, 13, -23)).toEqual(sampleEnvironment(c, 13, -23)); // Benguela: normal SST below 18 C
    fullDays(w, 2); fullDays(c, 2);
    expect(w.grid).toEqual(c.grid);
  });

  it('stays quiet for months: a base-world layer is deterministic, so a tool or a released slider starts no random ENSO event', () => {
    const w = createGame(SEED, AUG_1);
    expect(w.climateLayer).toBeNull();
    setClimate(w, 'enso', 1); setClimate(w, 'enso', 0);
    expect(w.climateLayer!.core.stochastic).toBe(false);
    fullDays(w, 3); skipDays(w, 177);
    expect(Math.max(...Array.from(w.climateLayer!.core.T, Math.abs))).toBeLessThan(1e-9);
    expect(Math.abs(climateIndices(w.climateLayer!.core).nino34)).toBeLessThan(1e-9);
    expect(w.climateLayer!.core.burstCount).toBe(0);
    expect(createGame(SEED, AUG_1, neutralSnapshot()).climateLayer!.core.stochastic).toBe(true); // a live world keeps the natural noise
  });
});

describe('stackSstPatch merges overlapping patches', () => {
  const patch = { lonEast: 210, lat: 0, radiusDeg: 3.18, deltaC: 2, days: 4 };
  it('adds the anomalies, the areas and the hold time of overlapping same-sign patches into one', () => {
    const s = createClimate(1, 213, 2000, false);
    expect(stackSstPatch(s, patch)).toBe(true);
    expect(stackSstPatch(s, { ...patch, lonEast: 212, lat: 1 })).toBe(true);
    expect(s.nPatches).toBe(1);
    const p = Array.from(s.patches.slice(0, 6));
    expect(p[3]).toBeCloseTo(4, 9);
    expect(p[2]).toBeCloseTo(3.18 * Math.SQRT2, 9);
    expect(p[0]).toBeCloseTo(211, 9);
    expect(p[1]).toBeCloseTo(0.5, 9);
    expect(p[5]).toBe(4); // simultaneous tools do not extend each other: the longer of 4 remaining and 4 new days
  });

  it('caps the anomaly and the radius inside the limits that restoreClimate checks, and keeps escalating the area', () => {
    const s = createClimate(1, 213, 2000, false);
    for (let i = 0; i < 12; i++) expect(stackSstPatch(s, patch)).toBe(true);
    expect(s.nPatches).toBe(1);
    expect(s.patches[3]).toBe(6);
    expect(s.patches[2]).toBeCloseTo(3.18 * Math.sqrt(12), 9);
    expect(s.patches[5]).toBe(4);
    for (let d = 0; d < 2; d++) stepClimateDay(s);
    expect(stackSstPatch(s, { ...patch, days: 10 })).toBe(true);
    expect(s.patches[5]).toBe(10); // a longer new patch sets the hold (2 days remained)
    for (let i = 0; i < 300; i++) stackSstPatch(s, patch);
    expect(s.patches[2]).toBe(40);
    expect(s.patches[5]).toBeLessThanOrEqual(730);
    for (let d = 0; d < 60; d++) stepClimateDay(s);
    const r = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(s))));
    expect(r).not.toBeNull();
    expect(Array.from(r!.patches)).toEqual(Array.from(s.patches));
  });

  it('opens a new slot for distant, opposite-sign or released patches, merges when slots are full, and rejects invalid input untouched', () => {
    const s = createClimate(1, 213, 2000, false);
    expect(stackSstPatch(s, patch)).toBe(true);
    expect(stackSstPatch(s, { ...patch, lonEast: 260 })).toBe(true); // distant
    expect(stackSstPatch(s, { ...patch, deltaC: -2 })).toBe(true); // opposite sign overlaps but does not cancel
    expect(s.nPatches).toBe(3);
    for (let i = 0; i < 5; i++) expect(stackSstPatch(s, { ...patch, lonEast: 20 + 40 * i, lat: 10 })).toBe(true);
    expect(s.nPatches).toBe(MAX_PATCHES);
    expect(stackSstPatch(s, { ...patch, lonEast: 320, lat: -20 })).toBe(false); // full and not overlapping
    expect(stackSstPatch(s, { ...patch, lonEast: 211 })).toBe(true); // full but overlapping: merges
    expect(s.nPatches).toBe(MAX_PATCHES);
    const before = Array.from(s.patches);
    for (const bad of [{ ...patch, lat: 45 }, { ...patch, deltaC: 0 }, { ...patch, radiusDeg: 1 }, { ...patch, days: 0 }, { ...patch, lonEast: Number.NaN }]) expect(stackSstPatch(s, bad)).toBe(false);
    expect(Array.from(s.patches)).toEqual(before);
    const t = createClimate(1, 213, 2000, false);
    stackSstPatch(t, patch);
    for (let d = 0; d < 5; d++) stepClimateDay(t); // the first patch is released after 4 days
    expect(stackSstPatch(t, patch)).toBe(true);
    expect(t.nPatches).toBe(2);
    expect(addSstPatch(createClimate(2), patch)).toBe(true); // plain addSstPatch is unchanged
  });
});

describe('B. cause and effect through the weather layer (twin worlds, same seed)', () => {
  it('one warm tool: a local response and the same centre SST as before; nothing at a far point', () => {
    const [a, b] = twin(AUG_1, s => placeTool(s, 'warm', -150, 0));
    fullDays(a, 0.5); fullDays(b, 0.5);
    const layer = a.climateLayer!;
    a.climateLayer = null; const before = sst(a, -150, 0) - sst(b, -150, 0); a.climateLayer = layer; // the tool alone, as before this stage
    const centre = sst(a, -150, 0) - sst(b, -150, 0);
    note('one warm tool, centre SST change with / without the layer:', centre.toFixed(3), before.toFixed(3));
    expect(Math.abs(centre - before)).toBeLessThan(0.1);
    expect(centre).toBeGreaterThan(1.9);
    fullDays(a, 4.5); fullDays(b, 4.5);
    const rows: Record<string, number[]> = {};
    for (const day of [5, 10, 60]) {
      if (day > 5) { skipDays(a, day === 10 ? 5 : 50); skipDays(b, day === 10 ? 5 : 50); }
      rows[`day ${day}`] = [delta(a, b, [-150, 0], press), delta(a, b, [-150, 0], hum), delta(a, b, [-120, 0], press), delta(a, b, DARWIN, press), delta(a, b, NP, press), delta(a, b, NP, sst)];
      note(`day ${day}: dP site / dHum site / dP 30deg east / dP Darwin / dP 45N165W / dSST 45N165W =`, rows[`day ${day}`].map(x => x.toFixed(3)).join(' / '));
    }
    const day10 = rows['day 10'], day60 = rows['day 60'];
    expect(Math.abs(day10[0])).toBeGreaterThan(0.05); // local pressure response
    expect(Math.abs(day10[1])).toBeGreaterThan(0.002); // local humidity response
    expect(Math.abs(day10[2])).toBeLessThan(Math.abs(day10[0]) * 2); // within the same region
    for (const row of [day10, day60]) { expect(Math.abs(row[4])).toBeLessThan(0.05); expect(row[5]).toBe(0); }
    // The base-world layer is deterministic, so the twin differs only through the tool: the site's pressure and humidity answer within days,
    // Darwin shows the opposite-signed Walker partner at a similar size, everything fades by day 60 and the extratropics see nothing.
    expect(Math.abs(day10[3])).toBeLessThan(0.4);
    expect(Math.sign(day10[3])).toBe(-Math.sign(day10[0]));
    expect(Math.abs(day60[3])).toBeLessThan(0.3);
    const n34 = climateIndices(a.climateLayer!.core).nino34;
    note('one warm tool: Nino 3.4 at day 60 =', n34.toFixed(3));
    expect(n34).toBeGreaterThan(0); expect(n34).toBeLessThan(0.3); // a small warm push, no spontaneous event
  });

  it('twelve stacked warm tools: basin-wide, the east warms beyond the footprint, Darwin up, Tahiti down, trades weaken, the North Pacific low deepens in winter', () => {
    const [a, b] = twin(NOV_1, s => stack(s, 'warm', 12));
    fullDays(a, 5); fullDays(b, 5);
    const patch = a.climateLayer!.core;
    note('stacked patch (after merging):', Array.from(patch.patches.slice(0, 6)).map(x => x.toFixed(2)).join(', '));
    expect(patch.nPatches).toBe(1);
    expect(patch.patches[3]).toBe(6);
    expect(patch.patches[2]).toBeGreaterThan(10);
    expect(patch.patches[5]).toBe(4); // twelve simultaneous tools hold for one tool's duration, not twelve
    skipDays(a, 55); skipDays(b, 55);
    const day60 = { east: delta(a, b, [-130, 0], sst), darwin: delta(a, b, DARWIN, press), tahiti: delta(a, b, TAHITI, press), trades: delta(a, b, [175, 0], uWind), warmPool: delta(a, b, [150, 0], sst), np: delta(a, b, NP, press), n34: climateIndices(a.climateLayer!.core).nino34 };
    note('12 warm tools, day 60:', JSON.stringify(Object.fromEntries(Object.entries(day60).map(([k, v]) => [k, +v.toFixed(2)]))));
    skipDays(a, 30); skipDays(b, 30);
    const day90 = { east: delta(a, b, [-130, 0], sst), np: delta(a, b, NP, press), npAir: delta(a, b, NP, (s, lon, lat) => sampleEnvironment(s, lon, lat).airTemperature), usSouth: delta(a, b, [-95, 30], press) };
    note('12 warm tools, day 90 (late January):', JSON.stringify(Object.fromEntries(Object.entries(day90).map(([k, v]) => [k, +v.toFixed(2)]))));
    expect(day60.east).toBeGreaterThan(0.3);
    expect(day60.darwin).toBeGreaterThan(0.5);
    expect(day60.tahiti).toBeLessThan(-0.3);
    expect(day60.trades).toBeGreaterThan(0.3);
    expect(day90.np).toBeLessThan(-0.3);
  });

  it('a long ENSO hold does the same; a hold of -2 and twelve cool tools give the opposite signs', () => {
    const [warm, neutral] = twin(NOV_1, s => setClimate(s, 'enso', 2));
    const cold = createGame(SEED, NOV_1); setClimate(cold, 'enso', -2);
    const [cool] = twin(NOV_1, s => stack(s, 'cool', 12));
    for (const s of [warm, neutral, cold, cool]) { fullDays(s, 5); skipDays(s, 85); }
    const read = (s: GameState) => ({ east: delta(s, neutral, [-130, 0], sst), darwin: delta(s, neutral, DARWIN, press), tahiti: delta(s, neutral, TAHITI, press), trades: delta(s, neutral, [150, 0], uWind), np: delta(s, neutral, NP, press) });
    const w = read(warm), c = read(cold), k = read(cool);
    note('hold +2 vs neutral, day 90:', JSON.stringify(w));
    note('hold -2 vs neutral, day 90:', JSON.stringify(c));
    note('12 cool tools vs neutral, day 90:', JSON.stringify(k));
    expect(w.east).toBeGreaterThan(0.5); expect(w.darwin).toBeGreaterThan(0.5); expect(w.tahiti).toBeLessThan(-0.3); expect(w.trades).toBeGreaterThan(0); expect(w.np).toBeLessThan(-0.3);
    expect(c.east).toBeLessThan(-0.3); expect(c.darwin).toBeLessThan(-0.3); expect(c.tahiti).toBeGreaterThan(0.3); expect(c.trades).toBeLessThan(0); expect(c.np).toBeGreaterThan(0.1);
    expect(k.east).toBeLessThan(-0.1); expect(k.darwin).toBeLessThan(-0.2); expect(k.tahiti).toBeGreaterThan(0.15); expect(k.trades).toBeLessThan(0); expect(k.np).toBeGreaterThan(0.5);
  });

  it('ENSO hold +2 vs -2 from August: the western North Pacific genesis centroid is east under +2 and west under -2; Atlantic shear rises under +2 and falls under -2', () => {
    const worlds = new Map<number, GameState>();
    for (const v of [0, 2, -2]) { const s = createGame(SEED, AUG_1); if (v) setClimate(s, 'enso', v); fullDays(s, 4); skipDays(s, 116); worlds.set(v, s); }
    const out = new Map([...worlds].map(([v, s]) => [v, { ...genesisCentroid(s), shear: atlanticShear(s) }]));
    for (const [v, r] of out) note(`hold ${v}, day 120: genesis centroid ${r.lon.toFixed(2)}E ${r.lat.toFixed(2)}N, total ${r.total.toFixed(2)}, Atlantic shear ${r.shear.toFixed(3)}`);
    const [base, warm, cold] = [out.get(0)!, out.get(2)!, out.get(-2)!];
    note(`centroid shift under +2: ${(warm.lon - base.lon).toFixed(2)} deg lon, ${(warm.lat - base.lat).toFixed(2)} deg lat; under -2: ${(cold.lon - base.lon).toFixed(2)}, ${(cold.lat - base.lat).toFixed(2)}`);
    expect(warm.lon).toBeGreaterThan(cold.lon);
    expect(warm.lon - base.lon).toBeGreaterThan(3);
    expect(cold.lon - base.lon).toBeLessThan(-1.5);
    // The latitude change is printed above, not asserted: it is about zero, not the observed south-eastward shift.
    expect(warm.shear).toBeGreaterThan(base.shear + 0.03);
    expect(cold.shear).toBeLessThan(base.shear - 0.03);
  });
});

describe('field mapping', () => {
  it('names where each region comes from', () => {
    expect(CLIMATE_SOURCE.tropics).toContain('Gill');
    expect(CLIMATE_SOURCE.remote).toContain('observed statistics');
  });

  it('the grid, the point sampler and the wind/pressure accessors agree at cell centres with the layer active, beside a warm tool and over the dateline', () => {
    const s = createGame(SEED, NOV_1);
    setClimate(s, 'enso', 2); stack(s, 'warm', 3, 179, 5);
    fullDays(s, 5); skipDays(s, 25);
    fullDays(s, 0.25); // a real step refreshes the grid with the current layer
    const quiet = createGame(SEED, NOV_1); setClimate(quiet, 'enso', 2); // no tool: also compare a layer-only world
    fullDays(quiet, 5); skipDays(quiet, 25); fullDays(quiet, 0.25);
    for (const world of [s, quiet]) {
      for (const [lon, lat] of [[179, 5], [-179, 5], [-150, 0], [150, 0], [131, -13], [-165, 45], [-50, 15], [-95, 30], [-30, 50], [-120, 12]]) {
        const cell = world.grid[gridIndex(lon, lat)];
        const point = sampleEnvironment(world, cell.lon, cell.lat);
        for (const key of ['temperature', 'airTemperature', 'shear', 'humidity', 'pressure'] as const) expect(cell[key], `${lon},${lat} ${key}`).toBeCloseTo(point[key], 6);
        if (!cell.land) { // the grid wind is the accessor's, before land friction
          expect(cell.u, `${lon},${lat} u`).toBeCloseTo(totalWind(world, cell.lon, cell.lat).u, 6);
          expect(cell.pressure, `${lon},${lat} p`).toBeCloseTo(totalPressure(world, cell.lon, cell.lat), 6);
        }
      }
    }
  });

  it('reuses its buffers: the anomaly set is one object that is refilled each day', () => {
    const s = createGame(SEED);
    setClimate(s, 'enso', 1);
    const first = s.climateLayer!.anomalies!;
    expect(first).not.toBeNull();
    const rev = first.rev;
    fullDays(s, 2);
    expect(s.climateLayer!.anomalies).toBe(first);
    expect(first.rev).toBeGreaterThan(rev);
  });

  it('a cloned state (as the main thread receives it) rebuilds the same fields', () => {
    const [a] = twin(AUG_1, s => { setClimate(s, 'enso', 1.5); stack(s, 'warm', 2); });
    fullDays(a, 5); skipDays(a, 10);
    const clone = structuredClone(a);
    expect(clone.climateLayer!.anomalies).toEqual(a.climateLayer!.anomalies); // carried by the clone: no rebuild on the main thread
    for (const [lon, lat] of [[-150, 0], [131, -12.4], [-165, 45], [-50, 15]]) expect(sampleEnvironment(clone, lon, lat)).toEqual(sampleEnvironment(a, lon, lat));
  });
});

describe('D. a recorded reanalysis field already holds the real ENSO state', () => {
  it('window cells are unchanged by the layer, cells outside it respond', () => {
    setHistoricEnvironment('maemi-2003', fixtureJson as unknown as HistoricEnvironment);
    const [a, b] = twin(AUG_1, s => { setClimate(s, 'enso', 2); stack(s, 'warm', 2); });
    for (const s of [a, b]) expect(loadHistoric(s, 'maemi-2003').ok).toBe(true);
    fullDays(a, 2.1); fullDays(b, 2.1);
    const cells = Array.from(windowCells(fixtureJson as unknown as HistoricEnvironment));
    let worst = 0;
    for (const k of cells) {
      for (const key of ['temperature', 'airTemperature', 'shear', 'humidity', 'pressure', 'u', 'v'] as const) {
        const d = Math.abs(a.grid[k][key] - b.grid[k][key]);
        // the window's cells that are warm tool sites differ by the tool itself; none are here
        worst = Math.max(worst, d);
      }
    }
    note('historic window: largest field difference with / without the layer', worst.toExponential(2), `over ${cells.length} cells`);
    expect(worst).toBeLessThan(1e-9);
    const open = gridIndex(-150, 0);
    expect(Math.abs(a.grid[open].pressure - b.grid[open].pressure) + Math.abs(a.grid[open].humidity - b.grid[open].humidity)).toBeGreaterThan(1e-3);
    const p = sampleEnvironment(a, 129, 33), q = sampleEnvironment(b, 129, 33);
    for (const key of ['temperature', 'airTemperature', 'shear', 'humidity', 'pressure', 'u', 'v'] as const) expect(p[key]).toBeCloseTo(q[key], 9);
    // the accessors and the sampler agree with the control inside the window, over every window cell centre
    for (const k of cells) {
      const c = a.grid[k];
      expect(totalPressure(a, c.lon, c.lat)).toBeCloseTo(totalPressure(b, c.lon, c.lat), 9);
      expect(totalWind(a, c.lon, c.lat).u).toBeCloseTo(totalWind(b, c.lon, c.lat).u, 9);
      expect(totalWind(a, c.lon, c.lat).v).toBeCloseTo(totalWind(b, c.lon, c.lat).v, 9);
    }
  });

  it('a warm tool inside the window behaves as before, the layer does not add to it; storm steering uses the record there', () => {
    setHistoricEnvironment('maemi-2003', fixtureJson as unknown as HistoricEnvironment);
    const a = createGame(AUG_1), b = createGame(AUG_1);
    setClimate(a, 'enso', 2);
    for (const s of [a, b]) { expect(loadHistoric(s, 'maemi-2003').ok).toBe(true); expect(placeTool(s, 'warm', 129, 33).ok).toBe(true); placeTool(s, 'cool', 129, 31); }
    fullDays(a, 2.1); fullDays(b, 2.1);
    for (const k of Array.from(windowCells(fixtureJson as unknown as HistoricEnvironment))) {
      for (const key of ['temperature', 'airTemperature', 'shear', 'humidity', 'pressure', 'u', 'v'] as const) expect(a.grid[k][key], `${k} ${key}`).toBeCloseTo(b.grid[k][key], 9);
    }
    expect(sampleEnvironment(a, 129, 33).temperature).toBeCloseTo(sampleEnvironment(b, 129, 33).temperature, 9);
    expect(a.storms.length).toBe(b.storms.length);
    for (let i = 0; i < a.storms.length; i++) expect(a.storms[i].lon).toBeCloseTo(b.storms[i].lon, 6); // the recorded storm and the steering inside the window are untouched
  });
});

describe('E. replays reproduce the climate layer from seed and actions', () => {
  it('a run with a slider, stacked tools and a season change replays to identical climate state, grid and samples', () => {
    const s = createGame(SEED);
    fullDays(s, 1);
    setClimate(s, 'enso', 1.2);
    stack(s, 'warm', 3, -150, 2); placeTool(s, 'cool', 150, 5); placeTool(s, 'low', 140, 16);
    fullDays(s, 2.3);
    setSeason(s, 250); setClimate(s, 'warming', 0.5);
    fullDays(s, 2.4);
    expect(s.climateLayer).not.toBeNull();
    expect(s.climateLayer!.core.day).toBeGreaterThanOrEqual(4);
    const r = replayGame(s.seed, s.actions, s.tick, s.initialStartDayOfYear);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.climateLayer).toEqual(s.climateLayer);
    expect(serializeClimate(r.state.climateLayer!.core)).toEqual(serializeClimate(s.climateLayer!.core));
    expect(r.state.grid).toEqual(s.grid);
    for (const [lon, lat] of [[-150, 2], [131, -12.4], [-165, 45], [140, 16], [-50, 15]]) {
      expect(sampleEnvironment(r.state, lon, lat)).toEqual(sampleEnvironment(s, lon, lat));
      expect(totalPressure(r.state, lon, lat)).toBe(totalPressure(s, lon, lat));
    }
    const restored = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(s.climateLayer!.core))));
    expect(restored).not.toBeNull();
    expect(serializeClimate(restored!)).toEqual(serializeClimate(s.climateLayer!.core));
  });
});

describe('E2. replays of live worlds', () => {
  it('a live initialWeather layer, a slider, and a season change on a live layer replay identically', () => {
    const snap = neutralSnapshot();
    const s = createGame(5, 300, snap);
    expect(s.climateLayer!.live).toBe(true);
    fullDays(s, 1.5);
    setClimate(s, 'enso', 1.5);
    stack(s, 'warm', 2, -150, 3);
    fullDays(s, 1.5);
    setSeason(s, 330);
    fullDays(s, 1.5);
    expect(s.climateLayer!.core.day).toBeGreaterThanOrEqual(3);
    const r = replayGame(s.seed, s.actions, s.tick, s.initialStartDayOfYear, [], s.initialWeather);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.climateLayer).toEqual(s.climateLayer);
    expect(serializeClimate(r.state.climateLayer!.core)).toEqual(serializeClimate(s.climateLayer!.core));
    expect(r.state.weather).toEqual(s.weather);
    expect(r.state.grid).toEqual(s.grid);
    // the calendar moved with the season change: layer day of year equals the world's
    const doy = Math.floor(((s.startDayOfYear + s.hours / 24) % 365.25));
    const core = s.climateLayer!.core;
    expect((core.startDayOfYear - 1 + core.day) % 365 + 1).toBeCloseTo(doy, 0);
  }, 180000);
});

describe('live start from a NOAA GFS analysis', () => {
  const RUN = '2026-10-27T00:00:00.000Z';
  const fixture = (file: string) => readFileSync(new URL(`./fixtures/gfs/${file}`, import.meta.url));
  const fields = [['pressure', 'PRMSL', 'mean sea level'], ['u', 'UGRD', '10 m above ground'], ['v', 'VGRD', '10 m above ground'], ['seaTemperature', 'TMP', 'surface'], ['airTemperature', 'TMP', '2 m above ground'], ['land', 'LAND', 'surface'], ['ice', 'ICEC', 'surface']] as const;
  const fetcher = () => {
    const index = fixture('20261027-00.idx').toString();
    const records = parseIdx(index);
    return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const range = new Headers(init?.headers).get('Range');
      if (!range) return new Response(index);
      const field = fields.find(([, name, level]) => byteRange(findRecord(records, name, level, 'anl')) === range);
      return field ? new Response(new Uint8Array(fixture(`${field[0]}.grib2`)), { status: 206 }) : new Response('', { status: 404 });
    });
  };
  let snapshot: LiveWeatherSnapshot | null = null;
  const gfs = async (): Promise<LiveWeatherSnapshot> => (snapshot ??= await fetchGfsSnapshot(RUN, AbortSignal.timeout(5000), fetcher()));
  const OCT_27 = 300;

  it('starts the core from the analysis: a real strip anomaly is read, bounded, and the thermocline is zero in the west', async () => {
    const snap = await gfs();
    const layer = createLiveClimateLayer(7, OCT_27, 2026, { pressure: snap.pressure, u: snap.u, v: snap.v, seaTemperature: snap.seaTemperature });
    const n34 = climateIndices(layer.core).nino34;
    note('GFS 2026-10-27: Nino 3.4 anomaly of the analysis vs ERSST normals', n34.toFixed(2), 'degC; Nino 3', climateIndices(layer.core).nino3.toFixed(2), 'WWV', climateIndices(layer.core).wwv.toFixed(2));
    expect(Math.abs(n34)).toBeLessThan(4); // the fixture is a strong El Nino: +4 C at 240E, +3 C in Nino 3.4
    expect(layer.live).toBe(true);
    expect(layer.nino).toBe(layer.nino0);
    expect(layer.core.K[0] + layer.core.R[0]).toBeCloseTo(0, 12);
    for (let j = 0; j < OCEAN_N; j++) expect(Number.isFinite(layer.core.T[j] + layer.core.K[j] + layer.core.R[j])).toBe(true);
    expect(restoreClimate(JSON.parse(JSON.stringify(serializeClimate(layer.core))))).not.toBeNull();
  });

  it('a synthetic +1.5 C strip anomaly becomes +1.5 C in Nino 3.4 with a deepened thermocline in the east only', () => {
    const month = ((OCT_27 - 0.5) / 365) * 12 - 0.5;
    const sea = Array.from({ length: 16200 }, (_, k) => {
      const col = k % 180, row = Math.floor(k / 180), lon = -179 + 2 * col, lat = -89 + 2 * row;
      const lonEast = lon < 0 ? lon + 360 : lon;
      if (Math.abs(lat) > 12) return 20;
      try { return equatorNormalSst(month, lonEast) + 1.5; } catch { return null; }
    });
    const weather = { pressure: Array(16200).fill(1010), u: Array(16200).fill(0), v: Array(16200).fill(0), seaTemperature: sea };
    const layer = createLiveClimateLayer(7, OCT_27, 2026, weather);
    const idx = climateIndices(layer.core);
    note('synthetic +1.5: Nino 3.4', idx.nino34.toFixed(2), 'Nino 3', idx.nino3.toFixed(2), 'WWV', idx.wwv.toFixed(1));
    expect(idx.nino34).toBeGreaterThan(1.3); expect(idx.nino34).toBeLessThan(1.7);
    expect(layer.core.K[60] + layer.core.R[60]).toBeGreaterThan(5); // 270E
    expect(layer.core.K[5] + layer.core.R[5]).toBeCloseTo(0, 12); // 133E
  });

  it('C1. with no player action the first week stays close to the pre-change model', async () => {
    const snap = await gfs();
    const a = createGame(1, OCT_27, snap), b = createGame(1, OCT_27, snap);
    expect(a.climateLayer).not.toBeNull();
    b.climateLayer = null; // the pre-change model: same weather engine, no layer
    fullDays(a, 7); fullDays(b, 7);
    let maxP = 0, maxU = 0, sumP = 0, sumU = 0, n = 0;
    for (let k = 0; k < a.grid.length; k++) {
      const dp = Math.abs(a.grid[k].pressure - b.grid[k].pressure), du = Math.hypot(a.grid[k].u - b.grid[k].u, a.grid[k].v - b.grid[k].v);
      maxP = Math.max(maxP, dp); maxU = Math.max(maxU, du); sumP += dp * dp; sumU += du * du; n++;
    }
    note(`live week 1 vs pre-change: pressure max ${maxP.toFixed(3)} hPa, rms ${Math.sqrt(sumP / n).toFixed(4)}; wind max ${maxU.toFixed(3)} m/s, rms ${Math.sqrt(sumU / n).toFixed(4)}`);
    expect(maxP).toBeLessThan(1);
    expect(maxU).toBeLessThan(1.5);
    expect(Math.sqrt(sumP / n)).toBeLessThan(0.15);
  }, 60000);

  it('C2. an imposed +2 hold on a neutral live start moves pressure and wind in the right sense and follows the layer', () => {
    const neutral = neutralSnapshot();
    const a = createGame(1, OCT_27, neutral), b = createGame(1, OCT_27, neutral);
    expect(Math.abs(climateIndices(a.climateLayer!.core).nino34)).toBeLessThan(0.05);
    setClimate(a, 'enso', 2);
    fullDays(a, 15); fullDays(b, 15);
    const layerA = a.climateLayer!.anomalies!, layerB = b.climateLayer!.anomalies!;
    const cell = (lon: number, lat: number) => gridIndex(lon, lat);
    const dP = (lon: number, lat: number) => a.grid[cell(lon, lat)].pressure - b.grid[cell(lon, lat)].pressure;
    const dU = (lon: number, lat: number) => a.grid[cell(lon, lat)].u - b.grid[cell(lon, lat)].u;
    const expected = (lon: number, lat: number) => layerA.slp[cell(lon, lat)] - layerB.slp[cell(lon, lat)];
    const rows = [[DARWIN[0], DARWIN[1]], [TAHITI[0], TAHITI[1]], [-150, 0], [150, 0]].map(([lon, lat]) => ({ lon, lat, live: dP(lon, lat), layer: expected(lon, lat) }));
    note('live +2 hold from a neutral start, day 15, dP (game) vs layer anomaly (hPa):', rows.map(r => `${r.lon},${r.lat}: ${r.live.toFixed(2)} vs ${r.layer.toFixed(2)}`).join(' | '), '; dU 150E 1N', dU(150, 1).toFixed(2), '; Nino 3.4', climateIndices(a.climateLayer!.core).nino34.toFixed(2));
    expect(dP(DARWIN[0], DARWIN[1])).toBeGreaterThan(0.2);
    expect(dP(TAHITI[0], TAHITI[1])).toBeLessThan(-0.1);
    expect(dU(150, 1)).toBeGreaterThan(0);
    for (const r of rows) {
      expect(Math.sign(r.live)).toBe(Math.sign(r.layer));
      expect(Math.abs(r.live)).toBeLessThan(1.5 * Math.abs(r.layer) + 0.1); // never more than the layer asks for (no second source of pressure)
      expect(Math.abs(r.live)).toBeGreaterThan(0.3 * Math.abs(r.layer)); // and it does get there
    }
  }, 120000);
});

describe('live thermal low does not count the climate layer\'s SST anomaly twice', () => {
  const cellsWith = (offset: number) => Array.from({ length: 16200 }, (_, k) => ({ land: false, temperature: 28 + (k % 180 < 90 ? offset : 0), airTemperature: 27, airHeating: 0 }));
  const weather = () => ({ pressure: Array<number>(16200).fill(1010), u: Array<number>(16200).fill(0), v: Array<number>(16200).fill(0), seaTemperature: Array<number | null>(16200).fill(28), airTemperature: Array<number>(16200).fill(27) });
  it('a layer SST anomaly in the cells changes nothing, while the same warmth without the layer deepens the thermal low', async () => {
    const { stepLiveWeather } = await import('../src/simulation/live-weather');
    const zero = new Float32Array(16200), sstAnomaly = Float32Array.from({ length: 16200 }, (_, k) => (k % 180 < 90 ? 2 : 0));
    const withLayer = weather(), without = weather(), warmNoLayer = weather();
    stepLiveWeather(withLayer, 400, { dayOfYear: 213, cells: cellsWith(2) as never, climate: { slp: zero, u: zero, v: zero, sst: sstAnomaly, air: zero } });
    stepLiveWeather(without, 400, { dayOfYear: 213, cells: cellsWith(0) as never });
    stepLiveWeather(warmNoLayer, 400, { dayOfYear: 213, cells: cellsWith(2) as never });
    expect(withLayer.pressure).toEqual(without.pressure);
    const lows = warmNoLayer.pressure.map((p, k) => p - without.pressure[k]);
    expect(Math.min(...lows)).toBeLessThan(-0.01); // without the exclusion the 2 C of extra sea warmth does add a thermal low
  });
});

describe('F. cost', () => {
  it('measures the real day-boundary step (core update, field rebuild, effective-base refill) against ordinary steps, with the real engine context', () => {
    const b = createGame(11);
    setClimate(b, 'enso', 1);
    for (let i = 0; i < 300; i++) stepGame(b);
    const boundary: number[] = [], normal: number[] = [];
    for (let i = 0; i < 480; i++) {
      const t0 = performance.now();
      stepGame(b);
      (b.tick % 96 === 0 ? boundary : normal).push(performance.now() - t0);
    }
    const mean = (x: number[]) => x.reduce((p, q) => p + q, 0) / x.length;
    const extra = mean(boundary) - mean(normal); // includes the daily season-grid rebuild every world pays, so it overstates the layer's share
    note(`ms/step ordinary ${mean(normal).toFixed(3)}, day-boundary ${mean(boundary).toFixed(2)}; extra per day ${extra.toFixed(2)} ms = ${(100 * extra / 96 / mean(normal)).toFixed(2)} % of a step averaged over the day`);
    // Wall-clock ratios are too noisy for a test; the cost figures above are printed, and the structural facts below are checked instead.
    expect(b.climateLayer!.anomalies).not.toBeNull();
    expect(createGame(11).climateLayer).toBeNull(); // no layer, no work
  }, 120000);
});

void STEP_HOURS;
