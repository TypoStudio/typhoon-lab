import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ClimateState, GameState, HistoricEnvironment } from '../src/types';
import {
  REPLAY_FILE_VERSION, STEP_HOURS, createGame, gridIndex, isLand, loadHistoric, placeTool, replayGame, sampleEnvironment, setClimate, setHistoricEnvironment, stepGame, validateActions,
} from '../src/simulation/engine';
import { buildReplay, parseReplay } from '../src/ui/storage';
import fixtureJson from './fixtures/environment-fixture.json';
import { nino34Of, stepClimateDay } from '../src/simulation/climate-core';
import { atlanticShear, fullDays, skipDays } from './climate-helpers';

const run = (s: GameState, hours: number) => { const until = s.tick + Math.round(hours / STEP_HOURS); while (s.tick < until) stepGame(s); };
const sample = (s: GameState, lon: number, lat: number) => sampleEnvironment(s, lon, lat);
/** Within 0.1: a box's Gaussian tail reaches the far side of the Pacific at the 10^-2 level. */
const near = (actual: number, expected: number) => expect(Math.abs(actual - expected)).toBeLessThan(0.1);
const world = (climate: Partial<ClimateState>): GameState => {
  const s = createGame(20261022);
  for (const [key, value] of Object.entries(climate)) expect(setClimate(s, key as keyof ClimateState, value)).toEqual({ ok: true });
  return s;
};

afterEach(() => setHistoricEnvironment('maemi-2003', null));

describe('setClimate', () => {
  it('starts neutral, rounds to 0.1 and records one action per accepted change', () => {
    const s = createGame(1);
    expect(s.climate).toEqual({ warming: 0, enso: 0, polar: 0 });
    run(s, 1);
    expect(setClimate(s, 'warming', 1.26)).toEqual({ ok: true });
    expect(setClimate(s, 'polar', -0.04)).toEqual({ ok: true });
    expect(s.climate).toEqual({ warming: 1.3, enso: 0, polar: 0 });
    expect(Object.is(s.climate.polar, 0)).toBe(true); // not -0
    expect(s.actions).toEqual([{ tick: 4, type: 'climate', key: 'warming', value: 1.3 }, { tick: 4, type: 'climate', key: 'polar', value: 0 }]);
  });

  it('accepts the range ends and rejects anything outside, leaving state and actions untouched', () => {
    const s = createGame(1);
    for (const [key, lo, hi] of [['warming', -2, 4], ['enso', -2, 2], ['polar', -10, 10]] as const) {
      expect(setClimate(s, key, lo).ok).toBe(true);
      expect(setClimate(s, key, hi).ok).toBe(true);
      for (const bad of [lo - 0.1, hi + 0.1, Number.NaN, Infinity, '1' as unknown as number]) expect(setClimate(s, key, bad).ok, `${key} ${String(bad)}`).toBe(false);
    }
    expect(s.climate).toEqual({ warming: 4, enso: 2, polar: 10 });
    expect(s.actions).toHaveLength(6);
    expect(setClimate(s, 'monsoon' as 'enso', 1)).toEqual({ ok: false, reason: 'Unknown climate control.' });
  });
});

describe('climate effects on the environment', () => {
  it('warming +2 raises sea temperature by 2 and air temperature by 2 (humidity +0.04)', () => {
    const base = sample(createGame(20261022), 140, 15);
    const warm = sample(world({ warming: 2 }), 140, 15);
    expect(warm.temperature - base.temperature).toBeCloseTo(2, 9);
    expect(warm.airTemperature - base.airTemperature).toBeCloseTo(2, 9);
    expect(warm.humidity - base.humidity).toBeCloseTo(0.04, 9);
    expect(sample(world({ warming: 4 }), 10, 20).humidity).toBeLessThanOrEqual(1);
    expect(sample(world({ warming: -2 }), 140, 15).temperature - base.temperature).toBeCloseTo(-2, 9);
  });

  it('warming leaves land surface temperature alone but warms its air', () => {
    expect(isLand(10, 20)).toBe(true);
    const base = sample(createGame(20261022), 10, 20);
    const warm = sample(world({ warming: 2 }), 10, 20);
    expect(warm.temperature).toBe(base.temperature);
    expect(warm.airTemperature - base.airTemperature).toBeCloseTo(2, 9);
  });

  // ENSO is a hold on Nino 3.4 that the dynamic climate layer (climate-coupling.ts) answers over days to weeks, so these
  // run 60 model days (three real days, then a cheap skip) and compare with a neutral twin.
  const enso = (value: number): [GameState, GameState] => {
    const s = world({ enso: value }), base = createGame(20261022);
    for (const w of [s, base]) { fullDays(w, 3); skipDays(w, 57); }
    return [s, base];
  };

  it('El Niño +2 shows at once, with no time passed: warm central and east Pacific, Darwin pressure up, Tahiti pressure down', () => {
    const quick = world({ enso: 2 }), calm = createGame(20261022);
    const d = (lon: number, lat: number, pick: (e: ReturnType<typeof sample>) => number) => pick(sample(quick, lon, lat)) - pick(sample(calm, lon, lat));
    const seen = { sst150W: d(-150, 0, e => e.temperature), sst120W: d(-120, 0, e => e.temperature), darwinP: d(131, -12.4, e => e.pressure), tahitiP: d(-149.6, -17.5, e => e.pressure) };
    console.info('[climate] El Nino +2 straight after the slider (paused), change vs neutral:', JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, +v.toFixed(2)]))));
    expect(seen.sst150W).toBeGreaterThan(1.5); // measured +1.85: the held pattern is 2 C at 190-240E and tapers west and east
    expect(seen.sst120W).toBeGreaterThan(1.5); // measured +1.82
    expect(seen.darwinP).toBeGreaterThan(0.5); // measured +1.88
    expect(seen.tahitiP).toBeLessThan(-0.5);
    expect(quick.climateLayer!.core.hold).toBe(2);
  });

  it('releasing the slider to 0 lets the ocean evolve from there and leaves no permanent offset', () => {
    const s = world({ enso: 2 });
    const held = sample(s, -150, 0).temperature;
    setClimate(s, 'enso', 0);
    expect(s.climateLayer!.core.hold).toBeNull();
    expect(sample(s, -150, 0).temperature).toBe(held); // releasing does not jump the sea
    const core = s.climateLayer!.core;
    let worst = 0;
    for (let day = 0; day < 40 * 365; day++) { stepClimateDay(core); if (day >= 39 * 365) worst = Math.max(worst, Math.abs(nino34Of(core))); }
    console.info('[climate] El Nino +2 released, largest |Nino 3.4| in year 40 (noise-free core):', worst.toExponential(2));
    expect(worst).toBeLessThan(0.01);
  });

  it('El Niño +2 after two months still warms the eastern equatorial Pacific, raises Atlantic and western shear, and lowers central and east Pacific shear', () => {
    const [nino, base] = enso(2);
    const d = (lon: number, lat: number, pick: (e: ReturnType<typeof sample>) => number) => pick(sample(nino, lon, lat)) - pick(sample(base, lon, lat));
    const shear = (e: ReturnType<typeof sample>) => e.shear, sst = (e: ReturnType<typeof sample>) => e.temperature;
    const seen = { sst135W: d(-135, 0, sst), warmPool150E: d(150, 0, sst), wnp135_15: d(135, 15, shear), cp175W_10: d(-175, 10, shear), ep115W_12: d(-115, 12, shear), ep100W_15: d(-100, 15, shear), atl: atlanticShear(nino) - atlanticShear(base) };
    console.info('[climate] El Nino +2 day 60 (Oct 1), change vs neutral:', JSON.stringify(Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, +v.toFixed(2)]))));
    expect(seen.sst135W).toBeGreaterThan(0.5);
    expect(seen.sst135W).toBeLessThan(4);
    expect(seen.warmPool150E).toBeLessThan(0);
    expect(seen.wnp135_15).toBeGreaterThan(0); // observed: shear rises over the western North Pacific and the Philippines
    expect(seen.cp175W_10).toBeLessThan(-0.5); // and falls over the central Pacific, where genesis moves east
    expect(seen.ep115W_12).toBeLessThan(0); // east Pacific SON shear falls under El Nino
    expect(seen.atl).toBeGreaterThan(0);
    expect(nino.climateLayer!.core.hold).toBe(2);
  });

  it('La Niña mirrors El Niño', () => {
    const [nina, base] = enso(-2);
    const d = (lon: number, lat: number, pick: (e: ReturnType<typeof sample>) => number) => pick(sample(nina, lon, lat)) - pick(sample(base, lon, lat));
    expect(d(-135, 0, e => e.temperature)).toBeLessThan(-0.5);
    expect(d(-175, 10, e => e.shear)).toBeGreaterThan(0.5);
    expect(d(-115, 12, e => e.shear)).toBeGreaterThan(0);
    expect(d(135, 15, e => e.shear)).toBeLessThan(0);
    expect(atlanticShear(nina)).toBeLessThan(atlanticShear(base));
  });

  it('polar -5 cools air poleward of 50 degrees by 5 and leaves the tropics alone, ramping linearly from 35 degrees', () => {
    const base = createGame(20261022);
    const cold = world({ polar: -5 });
    expect(sample(cold, 10, 70).airTemperature - sample(base, 10, 70).airTemperature).toBeCloseTo(-5, 9);
    expect(sample(cold, -150, -55).temperature - sample(base, -150, -55).temperature).toBeCloseTo(-5, 9);
    expect(sample(cold, 10, 20).airTemperature).toBe(sample(base, 10, 20).airTemperature);
    expect(sample(cold, -150, 35).temperature).toBe(sample(base, -150, 35).temperature);
    expect(sample(cold, -150, 42.5).temperature - sample(base, -150, 42.5).temperature).toBeCloseTo(-2.5, 9);
  });

  it('never makes shear negative, and a reset world is neutral', () => {
    const s = world({ enso: -2 });
    placeTool(s, 'low-shear', -115, 12); placeTool(s, 'low-shear', -115, 12);
    run(s, 12);
    expect(sample(s, -115, 12).shear).toBeGreaterThanOrEqual(0);
    expect(Math.min(...s.grid.map(c => c.shear))).toBeGreaterThanOrEqual(0);
    expect(createGame(20261022).climate).toEqual({ warming: 0, enso: 0, polar: 0 });
  });

  it('the grid and the point sampler agree at cell centres, including cells beside the dateline', () => {
    const s = world({ warming: 1.5, enso: 2, polar: -6 });
    run(s, 1);
    for (const [lon, lat] of [[140, 15], [-121, 1], [151, -1], [179, 1], [-179, 1], [-179, 9], [135, 15], [-115, 13], [10, 70], [-150, -55], [-150, 42]]) {
      const cell = s.grid[gridIndex(lon, lat)];
      const point = sampleEnvironment(s, cell.lon, cell.lat);
      expect(cell.temperature, `${lon},${lat} sst`).toBeCloseTo(point.temperature, 6);
      expect(cell.airTemperature, `${lon},${lat} air`).toBeCloseTo(point.airTemperature, 6);
      expect(cell.shear, `${lon},${lat} shear`).toBeCloseTo(point.shear, 6);
      expect(cell.humidity, `${lon},${lat} humidity`).toBeCloseTo(point.humidity, 6);
    }
  });

  it('adds on top of a recorded reanalysis field', () => {
    setHistoricEnvironment('maemi-2003', fixtureJson as unknown as HistoricEnvironment);
    const plain = createGame(1);
    const warm = createGame(1);
    setClimate(warm, 'warming', 2);
    for (const s of [plain, warm]) expect(loadHistoric(s, 'maemi-2003').ok).toBe(true);
    const k = gridIndex(129, 33);
    expect(warm.grid[k].airTemperature - plain.grid[k].airTemperature).toBeCloseTo(2, 6);
    expect(warm.grid[k].airTemperature).toBeCloseTo(29, 6); // recorded 27 + 2
    expect(sampleEnvironment(warm, 129, 33).airTemperature).toBeCloseTo(29, 6);
    expect(warm.grid[k].humidity - plain.grid[k].humidity).toBeCloseTo(0.04, 6);
  });
});

describe('ENSO pattern is smooth', () => {
  // Holds of +2 and -2 against a neutral twin, sampled at days 20, 60, 100, 140 and 180 from Aug 1. The equator runs from 100E to 83W:
  // beyond that the coast of South America (land, no SST change) ends the ocean, which is a coastline and not a front in the anomaly.
  const sampled: Record<string, { up: GameState; down: GameState; base: GameState }> = {};
  const DAYS = [20, 60, 100, 140, 180];
  const worst = { equator: 0, meridian180: 0, meridian130W: 0, shearEquatorAlong15N: 0 };
  beforeAll(() => {
    const up = world({ enso: 2 }), down = world({ enso: -2 }), base = createGame(20261022);
    for (const w of [up, down, base]) fullDays(w, 2);
    let day = 2;
    for (const d of DAYS) {
      for (const w of [up, down, base]) skipDays(w, d - day);
      day = d;
      const step = (w: GameState, pts: [number, number][], pick: (e: ReturnType<typeof sampleEnvironment>) => number) => {
        const v = pts.map(([lon, lat]) => pick(sampleEnvironment(w, lon, lat)) - pick(sampleEnvironment(base, lon, lat)));
        return Math.max(...v.slice(1).map((x, i) => Math.abs(x - v[i])));
      };
      const line = (a: [number, number], b: [number, number]) => { const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); return Array.from({ length: n + 1 }, (_, k) => { const lon = a[0] + ((b[0] - a[0]) * k) / n; return [((lon + 540) % 360) - 180, a[1] + ((b[1] - a[1]) * k) / n] as [number, number]; }); };
      for (const w of [up, down]) {
        worst.equator = Math.max(worst.equator, step(w, line([100, 0], [277, 0]), e => e.temperature));
        worst.meridian180 = Math.max(worst.meridian180, step(w, line([180, -20], [180, 20]), e => e.temperature));
        worst.meridian130W = Math.max(worst.meridian130W, step(w, line([230, -20], [230, 20]), e => e.temperature));
        worst.shearEquatorAlong15N = Math.max(worst.shearEquatorAlong15N, step(w, line([100, 15], [260, 15]), e => e.shear));
      }
      if (d === 60) sampled[d] = { up: structuredClone(up), down: structuredClone(down), base: structuredClone(base) };
    }
    console.info('[climate] largest SST / shear change per degree over holds +-2, days 20-180:', JSON.stringify(worst));
  }, 240000);

  it('SST changes by less than 0.2 °C per degree along the equator, along 180° and along 130°W, across the dateline, for holds of ±2 on days 20 to 180', () => {
    expect(worst.equator).toBeLessThan(0.2);
    expect(worst.meridian180).toBeLessThan(0.2);
    expect(worst.meridian130W).toBeLessThan(0.2);
  });

  it('the same location is the same place in either longitude convention', () => {
    const { up, base } = sampled[60];
    const d = (lon: number) => sampleEnvironment(up, lon, 0).temperature - sampleEnvironment(base, lon, 0).temperature;
    expect(d(179.99)).toBeCloseTo(d(-179.99), 1);
  });

  it('shear changes by less than 1 m/s per degree along 15°N', () => {
    expect(worst.shearEquatorAlong15N).toBeLessThan(1);
  });
});

describe('climate in replays', () => {
  const live = (): GameState => {
    const s = createGame(20261022);
    run(s, 6);
    setClimate(s, 'warming', 1.5); setClimate(s, 'enso', 1.2);
    placeTool(s, 'warm', 140, 16); placeTool(s, 'low', 140, 16);
    run(s, 30);
    setClimate(s, 'polar', -4); setClimate(s, 'warming', 0);
    run(s, 6);
    return s;
  };

  it('reproduces identical state from seed and actions', () => {
    const s = live();
    expect(s.actions.filter(a => a.type === 'climate')).toHaveLength(4);
    const r = replayGame(s.seed, s.actions, s.tick);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.climate).toEqual({ warming: 0, enso: 1.2, polar: -4 });
      expect(r.state.grid).toEqual(s.grid);
      expect(r.state.storms).toEqual(s.storms);
      expect(r.state.actions).toEqual(s.actions);
    }
  });

  it('exports as version 8 and parseReplay accepts a climate action', () => {
    const file = buildReplay(live());
    expect(file.formatVersion).toBe(REPLAY_FILE_VERSION);
    expect(REPLAY_FILE_VERSION).toBe(8);
    const parsed = parseReplay(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.replay).toEqual(file);
  });

  it('parseReplay and validateActions reject unknown keys and out-of-range or non-numeric values, and normalise rounding', () => {
    const file = buildReplay(live());
    const withAction = (a: Record<string, unknown>) => JSON.stringify({ ...file, actions: [a] });
    for (const bad of [
      { tick: 0, type: 'climate', key: 'warming', value: 4.1 }, { tick: 0, type: 'climate', key: 'warming', value: -2.1 },
      { tick: 0, type: 'climate', key: 'enso', value: 2.5 }, { tick: 0, type: 'climate', key: 'polar', value: -10.5 },
      { tick: 0, type: 'climate', key: 'monsoon', value: 1 }, { tick: 0, type: 'climate', key: 'warming', value: '1' },
      { tick: 0, type: 'climate', key: 'warming' }, { tick: 0, type: 'climate', value: 1 }, { tick: 0, type: 'climate', key: 'warming', value: null },
    ]) expect(parseReplay(withAction(bad)).ok, JSON.stringify(bad)).toBe(false);
    const ok = validateActions([{ tick: 0, type: 'climate', key: 'enso', value: 1.24, lon: 5 }]);
    expect(ok).toEqual({ ok: true, actions: [{ tick: 0, type: 'climate', key: 'enso', value: 1.2 }] });
  });
});
