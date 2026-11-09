import { describe, expect, it, vi } from 'vitest';
import { createClimate, restoreClimate, serializeClimate, stackHeatPatch, stepClimateDay, MAX_HEAT_PATCHES, addHeatPatch, heatSourceActive } from '../src/simulation/climate-core';
import { anomalyAt, newAnomalyPoint } from '../src/simulation/climate-coupling';
import { createGame, placeTool, readClimateIndices, readThermocline, sampleEnvironment, type ClimatePointReading } from '../src/simulation/engine';
import type { GameState, ToolType } from '../src/types';
import { fullDays, skipDays } from './climate-helpers';

vi.setConfig({ testTimeout: 120_000 });
const SEED = 20261022;
const NOV_1 = 305;
const note = (...a: unknown[]) => console.info('[climate-conditions]', ...a);
type Drop = [ToolType, number, number];
const many = (type: ToolType, n: number, lon: number, lat: number): Drop[] => Array.from({ length: n }, () => [type, lon, lat]);

/** A world after the drops, `days` days later (the drops last 2-3 days). A world without drops has no layer: the control. */
function world(drops: Drop[], days: number): GameState {
  const s = createGame(SEED, NOV_1);
  for (const [type, lon, lat] of drops) expect(placeTool(s, type, lon, lat).ok).toBe(true);
  fullDays(s, 4);
  s.storms = []; s.remnants = []; s.candidates = []; // storms the stack happened to start are not what is measured here; the cheap day skip needs a quiet world
  skipDays(s, days - 4);
  return s;
}
const n34 = (s: GameState): number => readClimateIndices(s)!.nino34;
const nino3 = (s: GameState): number => readClimateIndices(s)!.nino3;
const u = (s: GameState, lon: number, lat = 0): number => sampleEnvironment(s, lon, lat).u;
const p = (s: GameState, lon: number, lat = 0): number => sampleEnvironment(s, lon, lat).pressure;
void (null as unknown as ClimatePointReading);

describe('heat patches in the core', () => {
  it('serialise, restore, validate, stack and expire', () => {
    const s = createClimate(1, 305, 2000, false);
    expect(stackHeatPatch(s, { lonEast: 160, lat: 0, radiusDeg: 4, strength: 2, days: 3 })).toBe(true);
    expect(stackHeatPatch(s, { lonEast: 163, lat: 1, radiusDeg: 4, strength: 2, days: 3 })).toBe(true);
    expect(s.nHeat).toBe(1); // merged
    expect(s.heat[3]).toBe(4);
    expect(s.heat[2]).toBeCloseTo(Math.hypot(4, 4), 9);
    expect(stackHeatPatch(s, { lonEast: 160, lat: 0, radiusDeg: 4, strength: -2, days: 3 })).toBe(true);
    expect(s.nHeat).toBe(2); // opposite signs never merge
    const back = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(s))));
    expect(back).not.toBeNull();
    expect(back!.heat).toEqual(s.heat);
    expect(back!.nHeat).toBe(2);
    for (const bad of [{ strength: 0 }, { strength: 5 }, { lat: 45 }, { radiusDeg: 1 }, { radiusDeg: 41 }, { days: 0 }, { lonEast: NaN }]) {
      expect(addHeatPatch(s, { lonEast: 160, lat: 0, radiusDeg: 4, strength: 1, days: 3, ...bad })).toBe(false);
    }
    const d = serializeClimate(s); (d.heat as number[])[3] = 9;
    expect(restoreClimate(d)).toBeNull();
    for (let i = 0; i < 20; i++) stepClimateDay(s);
    expect(s.nHeat).toBe(0);
    const full = createClimate(1, 305, 2000, false);
    for (let i = 0; i < MAX_HEAT_PATCHES; i++) expect(addHeatPatch(full, { lonEast: 10 * i, lat: 0, radiusDeg: 3, strength: 1, days: 3 })).toBe(true);
    expect(addHeatPatch(full, { lonEast: 5, lat: 0, radiusDeg: 3, strength: 1, days: 3 })).toBe(false);
  });
});

describe('heat patch slots and kinds', () => {
  const patch = (lonEast: number, strength = 1, own = false) => ({ lonEast, lat: 0, radiusDeg: 3, strength, days: 3, own });
  it('with all slots in use a new patch merges into the nearest same-sign patch instead of being dropped', () => {
    const s = createClimate(1, 305, 2000, false);
    for (let i = 0; i < MAX_HEAT_PATCHES; i++) expect(addHeatPatch(s, patch(20 * i))).toBe(true);
    const before = s.heat[3 * 6 + 3];
    expect(stackHeatPatch(s, patch(64))).toBe(true); // nearest is the patch at 60E
    expect(s.nHeat).toBe(MAX_HEAT_PATCHES);
    expect(s.heat[3 * 6 + 3]).toBeCloseTo(before + 1, 9);
    expect(s.heat[3 * 6 + 2]).toBeGreaterThan(3);
    expect(stackHeatPatch(s, patch(64, -1))).toBe(false); // nothing of that sign or kind to merge with, and nothing fading to replace
  });
  it('takes the slot of the weakest fading patch first', () => {
    const s = createClimate(1, 305, 2000, false);
    for (let i = 0; i < MAX_HEAT_PATCHES; i++) addHeatPatch(s, patch(20 * i));
    for (let i = 0; i < 4; i++) stepClimateDay(s); // the sources are over, the heating fades
    expect(heatSourceActive(s, 0)).toBe(false);
    expect(stackHeatPatch(s, patch(10, -1))).toBe(true);
    expect(s.nHeat).toBe(MAX_HEAT_PATCHES);
    expect(s.heat.slice(0, MAX_HEAT_PATCHES * 6).filter((_, i) => i % 6 === 3 && _ < 0)).toHaveLength(1);
  });
  it('pressure-tool patches and others never merge; the kind is serialised', () => {
    const s = createClimate(1, 305, 2000, false);
    stackHeatPatch(s, patch(160, 2, true)); stackHeatPatch(s, patch(161, 1, false));
    expect(s.nHeat).toBe(2);
    expect(Array.from(s.heatOwn.slice(0, 2))).toEqual([1, 0]);
    const back = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(s))))!;
    expect(Array.from(back.heatOwn.slice(0, 2))).toEqual([1, 0]);
    const bad = serializeClimate(s); (bad.heatOwn as number[])[0] = 2;
    expect(restoreClimate(bad)).toBeNull();
  });
});

describe('placed conditions drive the climate (twin worlds)', () => {
  it('only low and high stand in for the layer inside their footprint: an updraft keeps its Gill pressure', () => {
    const layerSlp = (s: GameState): number => anomalyAt(s.climateLayer!.anomalies!, 160, 0, newAnomalyPoint()).slp;
    const up = createGame(SEED, NOV_1), low = createGame(SEED, NOV_1), high = createGame(SEED, NOV_1);
    for (let i = 0; i < 6; i++) { placeTool(up, 'updraft', 160, 0); placeTool(low, 'low', 160, 0); placeTool(high, 'high', 160, 0); }
    fullDays(up, 1); fullDays(low, 1); fullDays(high, 1);
    note('layer pressure at the centre of six updrafts / lows / highs:', layerSlp(up).toFixed(3), layerSlp(low).toFixed(3), layerSlp(high).toFixed(3));
    expect(layerSlp(up)).toBeLessThan(-0.2);
    expect(Math.abs(layerSlp(low))).toBeLessThan(0.05);
    expect(Math.abs(layerSlp(high))).toBeLessThan(0.05);
  });

  it('moisture and dry air feed nothing; far-away conditions do not build a layer', () => {
    const s = createGame(SEED, NOV_1);
    placeTool(s, 'moisture', 160, 0); placeTool(s, 'dry', 170, 0); placeTool(s, 'low', 160, 45);
    expect(s.climateLayer).toBeNull();
  });

  it('one low keeps exactly its own centre pressure (no double counting)', () => {
    const one = createGame(SEED, NOV_1);
    placeTool(one, 'low', 160, 0);
    fullDays(one, 1);
    const ref = createGame(SEED, NOV_1);
    placeTool(ref, 'moisture', 0, 60);
    fullDays(ref, 1);
    const dp = p(one, 160) - p(ref, 160);
    note('one low, centre pressure change (hPa):', dp.toFixed(3), 'layer-only part:', one.climateLayer!.anomalies!.slp.reduce((m, v) => Math.min(m, v), 0).toFixed(3));
    expect(dp).toBeCloseTo(-7, 1);
    // the layer's own wind still acts: westerlies west of the heating
    expect(u(one, 150) - u(ref, 150)).toBeGreaterThan(0);
  });

  it('a stack of lows (or updrafts) near 160E: westerlies on the west side, a downwelling Kelvin wave, a warmer east Pacific', () => {
    const control = world([['moisture', 0, 60]], 4);
    const lows = world(many('low', 12, 160, 0), 90), updrafts = world(many('updraft', 12, 160, 0), 90);
    const early = createGame(SEED, NOV_1);
    for (const d of many('low', 12, 160, 0)) placeTool(early, d[0], d[1], d[2]);
    fullDays(early, 1);
    const w = u(early, 150) - u(control, 150);
    note('12 lows: u change at 150E on day 1', w.toFixed(2), 'm/s; day 90 Nino3', nino3(lows).toFixed(3), 'thermocline anomaly at 200E', readThermocline(lows, 200)!.anomaly.toFixed(2), 'm; 12 updrafts day 90 Nino3', nino3(updrafts).toFixed(3));
    expect(w).toBeGreaterThan(0.5);
    expect(nino3(lows)).toBeGreaterThan(0.05);
    expect(nino3(updrafts)).toBeGreaterThan(0.02);
    expect(readClimateIndices(lows)!.wwv).toBeGreaterThan(0);
  });

  it('a high in the east plus a low in the west strengthens the trades and cools the east first', () => {
    const control = world([['moisture', 0, 60]], 4);
    const drops: Drop[] = [...many('low', 12, 150, 0), ...many('high', 12, -120, 0)];
    const early = createGame(SEED, NOV_1);
    for (const d of drops) placeTool(early, d[0], d[1], d[2]);
    fullDays(early, 1);
    const trades = u(early, -160) - u(control, -160);
    const day30 = world(drops, 30);
    note('trades u change at 160W:', trades.toFixed(2), 'm/s; Nino3 on day 30', nino3(day30).toFixed(3));
    expect(trades).toBeLessThan(-1);
    expect(nino3(day30)).toBeLessThan(-0.1);
  });

  it('one condition stays local; stacking spreads and grows monotonically; opposite conditions have opposite signs; off the equator is weaker', () => {
    const control = world([['moisture', 0, 60]], 4);
    const one = world(many('low', 1, 160, 0), 60);
    expect(Math.abs(n34(one))).toBeLessThan(0.02);
    const early = (drops: Drop[]) => { const s = createGame(SEED, NOV_1); for (const d of drops) placeTool(s, d[0], d[1], d[2]); fullDays(s, 1); return s; };
    const single = early(many('low', 1, 160, 0));
    expect(Math.abs(p(single, -165, 45) - p(control, -165, 45))).toBeLessThan(0.05);
    expect(Math.abs(u(single, 200) - u(control, 200))).toBeLessThan(0.2);
    const reach = (n: number) => Math.abs(u(early(many('low', n, 160, 0)), 200) - u(control, 200));
    const sizes = [1, 2, 6, 12].map(n => nino3(world(many('low', n, 160, 0), 90)));
    note('Nino3 on day 90 for 1, 2, 6, 12 lows:', sizes.map(v => v.toFixed(3)).join(' '), '; wind change at 200E for 1, 12:', reach(1).toFixed(2), reach(12).toFixed(2));
    for (let i = 1; i < sizes.length; i++) expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    expect(reach(12)).toBeGreaterThan(reach(1) * 3);
    const highs = world(many('high', 12, 160, 0), 90);
    const off = world(many('low', 12, 160, 15), 90);
    note('12 highs Nino3.4', n34(highs).toFixed(3), 'WWV', readClimateIndices(highs)!.wwv.toFixed(2), '; 12 lows at 15N Nino3', nino3(off).toFixed(3), 'vs equator', sizes[3].toFixed(3));
    expect(n34(highs)).toBeLessThan(-0.02);
    expect(readClimateIndices(highs)!.wwv).toBeLessThan(0);
    const earlyHighs = early(many('high', 12, 160, 0)), earlyLows = early(many('low', 12, 160, 0));
    expect(u(earlyHighs, 150) - u(control, 150)).toBeLessThan(0);
    expect(u(earlyLows, 150) - u(control, 150)).toBeGreaterThan(0);
    expect(nino3(off)).toBeLessThan(sizes[3]);
    expect(nino3(off)).toBeGreaterThan(0);
    const warmAir = world(many('warm-air', 12, 160, 0), 90), cold = world(many('cold-air', 12, 160, 0), 90);
    expect(n34(warmAir)).toBeGreaterThan(0);
    expect(n34(cold)).toBeLessThan(0);
    const unstable = world(many('unstable-air', 12, 160, 0), 90), stable = world(many('stable-air', 12, 160, 0), 90), down = world(many('downdraft', 12, 160, 0), 90);
    expect(n34(unstable)).toBeGreaterThan(0);
    expect(n34(stable)).toBeLessThan(0);
    expect(n34(down)).toBeLessThan(0);
  });
});
