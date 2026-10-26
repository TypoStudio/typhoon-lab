import { afterEach, describe, expect, it } from 'vitest';
import type { ClimateState, GameState, HistoricEnvironment } from '../src/types';
import {
  REPLAY_FILE_VERSION, STEP_HOURS, climateAt, createGame, gridIndex, isLand, loadHistoric, placeTool, replayGame, sampleEnvironment, setClimate, setHistoricEnvironment, stepGame, validateActions,
} from '../src/simulation/engine';
import { buildReplay, parseReplay } from '../src/ui/storage';
import fixtureJson from './fixtures/environment-fixture.json';

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

  it('El Niño +2 warms the eastern equatorial Pacific, cools the warm pool and raises western shear', () => {
    const base = createGame(20261022);
    const nino = world({ enso: 2 });
    near(sample(nino, -120, 0).temperature - sample(base, -120, 0).temperature, 3);
    near(sample(nino, 150, 0).temperature - sample(base, 150, 0).temperature, -1.6);
    near(sample(nino, 135, 15).shear - sample(base, 135, 15).shear, 8);
    near(sample(nino, -115, 12).shear - sample(base, -115, 12).shear, -6);
  });

  it('La Niña mirrors El Niño', () => {
    const base = createGame(20261022);
    const nina = world({ enso: -2 });
    near(sample(nina, -120, 0).temperature - sample(base, -120, 0).temperature, -3);
    near(sample(nina, 150, 0).temperature - sample(base, 150, 0).temperature, 1.6);
    expect(sample(nina, 135, 15).shear).toBeLessThan(sample(base, 135, 15).shear);
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
  const enso2: ClimateState = { warming: 0, enso: 2, polar: 0 };
  const maxStep = (points: [number, number][], pick: (o: ReturnType<typeof climateAt>) => number) => {
    const values = points.map(([lon, lat]) => pick(climateAt(enso2, lon, lat)));
    return Math.max(...values.slice(1).map((v, i) => Math.abs(v - values[i])));
  };

  it('SST offset changes by less than 0.2 °C per degree along the equator from 100°E to 80°W, across the dateline', () => {
    const points: [number, number][] = [];
    for (let lon = 100; lon <= 280; lon++) points.push([((lon + 180) % 360) - 180, 0]);
    expect(maxStep(points, o => o.sst)).toBeLessThan(0.2);
    expect(climateAt(enso2, 179.5, 0).sst).toBeCloseTo(climateAt(enso2, -180.5, 0).sst, 9); // same place in either longitude convention
    expect(climateAt(enso2, 179.99, 0).sst).toBeCloseTo(climateAt(enso2, -179.99, 0).sst, 1);
  });

  it('SST offset changes by less than 0.2 °C per degree along 180° from 20°S to 20°N', () => {
    const points: [number, number][] = [];
    for (let lat = -20; lat <= 20; lat++) points.push([180, lat]);
    expect(maxStep(points, o => o.sst)).toBeLessThan(0.2);
  });

  it('the shear offset has no jump across the dateline or the box edges either', () => {
    const along = (a: [number, number], b: [number, number]) => { // one-degree steps
      const pts: [number, number][] = [];
      const n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      for (let k = 0; k <= n; k++) pts.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
      return pts.map(([lon, lat]) => [((lon + 540) % 360) - 180, lat] as [number, number]);
    };
    expect(maxStep(along([100, 15], [280, 15]), o => o.shear)).toBeLessThan(1);
    expect(maxStep(along([180, -10], [180, 40]), o => o.shear)).toBeLessThan(1);
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

  it('exports as version 6 and parseReplay accepts a climate action', () => {
    const file = buildReplay(live());
    expect(file.formatVersion).toBe(REPLAY_FILE_VERSION);
    expect(REPLAY_FILE_VERSION).toBe(6);
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
