import { describe, expect, it, vi } from 'vitest';
import { addWesterlyBurst, climateIndices, createClimate, restoreClimate, serializeClimate, stepClimateDay, thermoclineAt, setClimateScript } from '../src/simulation/climate-core';
import { anomaliesFor, anomalyAt, newAnomalyPoint } from '../src/simulation/climate-coupling';
import { createScenarioCore, climateScenarioById } from '../src/simulation/climate-scenarios';
import {
  advanceClimateTime, climateAnomalyContext, createGame, dayOfYear, stepGame, loadClimateScenario, loadHistoric, placeFormation, placeTool, setHistoricEnvironment, setGenesis, setSeason, sampleEnvironment, refreshClimateView, replayActivatesClimateLayer, replayGame, setClimate, setClimateMode, validateActions,
} from '../src/simulation/engine';
import { worldYear, fmtDateWithYear } from '../src/ui/calendar';
import { ProbeBook } from '../src/ui/measure';
import { observedNino34From } from '../src/data/climate-observed';
import type { GameState, LiveWeatherSnapshot } from '../src/types';
import observed from './fixtures/enso-observed.json';
import { skipDays } from './climate-helpers';

vi.setConfig({ testTimeout: 300_000 });
const SEED = 20261110;
const lons = observed.profileLonsEast;
const cellOf = (lon: number): number => (lon - 120) / 2.5 - 0.5;
const mean = (x: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / x.length; };
function corr(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const mx = mean(x), my = mean(y);
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; }
  return a / Math.sqrt(b * c);
}
const n3Of = (p: ArrayLike<number>): number => mean(Array.from(p).filter((_, i) => lons[i] >= 210 && lons[i] <= 270));

interface Djf { profile: Float64Array; nino3: number; nino34: number; soi: number; h250: number; slpNP: number; sstEq150W: number }
const point = newAnomalyPoint();
/** Runs a scenario through the game (days 0..424 of the scenario) and averages DJF (days 334..424). `step(s, 1)` advances one day. */
function runDjf(s: GameState, step: (s: GameState) => void): Djf {
  const out: Djf = { profile: new Float64Array(lons.length), nino3: 0, nino34: 0, soi: 0, h250: 0, slpNP: 0, sstEq150W: 0 };
  let views = 0;
  for (let d = 0; d < 425; d++) {
    step(s);
    if (d < 334) continue;
    const core = s.climateLayer!.core, ix = climateIndices(core);
    out.nino3 += ix.nino3 / 91; out.nino34 += ix.nino34 / 91; out.soi += ix.soi / 91; out.h250 += (thermoclineAt(core, 250)?.anomaly ?? 0) / 91;
    for (let i = 0; i < lons.length; i++) {
      const f = Math.min(62.999, Math.max(0, cellOf(lons[i]))), j = Math.floor(f), w = f - j;
      out.profile[i] += (core.T[j] * (1 - w) + core.T[j + 1] * w) / 91;
    }
    if (d % 15 === 4) { // the map fields, a few times through the season
      refreshClimateView(s);
      const a = anomaliesFor(s.climateLayer!, climateAnomalyContext());
      out.slpNP += anomalyAt(a, -165, 45, point).slp; out.sstEq150W += anomalyAt(a, -150, 0, point).sst; views++;
    }
  }
  out.slpNP /= views; out.sstEq150W /= views;
  return out;
}
const fastWorld = (id: string): GameState => { const s = createGame(SEED); expect(loadClimateScenario(s, id).ok).toBe(true); expect(setClimateMode(s, true).ok).toBe(true); return s; };
const fastStep = (s: GameState): void => { advanceClimateTime(s, 1); };
// These tests are about the climate layer, so natural formation (which a load turns on) is switched off again: a quiet world that skipDays can jump through.
const weatherWorld = (id: string): GameState => { const s = createGame(SEED); expect(loadClimateScenario(s, id).ok).toBe(true); setGenesis(s, false); return s; };
const weatherStep = (s: GameState): void => skipDays(s, 1);

describe('1997-98 El Nino scenario', () => {
  const obs = observed.equatorProfiles['DJF 1997/98'];
  for (const [path, make, step] of [['fast path, one day at a time', fastWorld, fastStep], ['weather speed', weatherWorld, weatherStep]] as const) {
    it(`reaches the observed event through the ${path}`, () => {
      const r = runDjf(make('nino-1997'), step);
      const pattern = corr(r.profile, obs);
      console.log(`[1997 ${path}] Nino-3 ${n3Of(r.profile).toFixed(2)} (index ${r.nino3.toFixed(2)}, observed ${n3Of(obs).toFixed(2)}), pattern ${pattern.toFixed(2)}, 160E ${r.profile[lons.indexOf(160)].toFixed(2)}, Nino 3.4 ${r.nino34.toFixed(2)}, SOI ${r.soi.toFixed(1)}, h250E ${r.h250.toFixed(1)} m, 45N165W SLP ${r.slpNP.toFixed(2)} hPa, 150W SST ${r.sstEq150W.toFixed(2)}`);
      expect(n3Of(r.profile)).toBeGreaterThanOrEqual(1.5);
      expect(pattern).toBeGreaterThanOrEqual(0.7);
      expect(r.profile[lons.indexOf(160)]).toBeLessThanOrEqual(0);
      expect(r.soi).toBeLessThan(0);
      expect(r.h250).toBeGreaterThan(0); // deeper thermocline in the east
      expect(r.slpNP).toBeLessThan(0); // deeper Aleutian low
      expect(r.sstEq150W).toBeGreaterThan(1);
    });
  }
  it('depends on the recharged ocean: the same bursts on a discharged ocean give a much weaker event', () => {
    const run = (h: number): number => {
      const core = createScenarioCore(1, 'nino-1997');
      core.K.fill(h / 2); core.R.fill(h / 2);
      let n3 = 0;
      for (let d = 0; d < 425; d++) { stepClimateDay(core); if (d >= 334) n3 += climateIndices(core).nino3 / 91; }
      return n3;
    };
    const charged = run(10), discharged = run(-10);
    console.log(`[1997 causality] Nino 3 recharged ${charged.toFixed(2)}, discharged ${discharged.toFixed(2)}`);
    expect(discharged).toBeLessThanOrEqual(0.5 * charged);
  });
});

describe('2010-11 La Nina scenario', () => {
  const obs = observed.equatorProfiles['DJF 2010/11'];
  for (const [path, make, step] of [['fast path, one day at a time', fastWorld, fastStep], ['weather speed', weatherWorld, weatherStep]] as const) {
    it(`reaches a strong La Nina through the ${path}`, () => {
      const r = runDjf(make('nina-2010'), step);
      const pattern = corr(r.profile, obs);
      console.log(`[2010 ${path}] Nino 3.4 ${r.nino34.toFixed(2)} (observed about -1.4), pattern ${pattern.toFixed(2)}, SOI ${r.soi.toFixed(1)}, h250E ${r.h250.toFixed(1)} m, 45N165W SLP ${r.slpNP.toFixed(2)} hPa, 150W SST ${r.sstEq150W.toFixed(2)}`);
      expect(r.nino34).toBeLessThanOrEqual(-0.8);
      expect(pattern).toBeGreaterThanOrEqual(0.5);
      expect(r.soi).toBeGreaterThan(0);
      expect(r.h250).toBeLessThan(0); // shoaling in the east
      expect(r.slpNP).toBeGreaterThan(0);
      expect(r.sstEq150W).toBeLessThan(-0.5);
    });
  }
  it('is caused by the strengthened trade winds: without them the same ocean stays near neutral', () => {
    const run = (withTrades: boolean): number => {
      const core = createScenarioCore(1, 'nina-2010');
      if (!withTrades) setClimateScript(core, []);
      let n34 = 0;
      for (let d = 0; d < 425; d++) { stepClimateDay(core); if (d >= 334) n34 += climateIndices(core).nino34 / 91; }
      return n34;
    };
    const with_ = run(true), without = run(false);
    console.log(`[2010 causality] Nino 3.4 with trades ${with_.toFixed(2)}, without ${without.toFixed(2)}`);
    expect(without).toBeGreaterThan(-0.5);
    expect(with_).toBeLessThan(without - 0.6);
  });
});

describe('loading a scenario', () => {
  it('moves the date to 1 January of the first year, the clock shows the year, and the layer is noise-free', () => {
    const s = createGame(SEED);
    placeTool(s, 'warm', 150, 5);
    for (let i = 0; i < 300; i++) s.tick++, s.hours = s.tick * 0.25; // time has passed on an odd hour
    expect(loadClimateScenario(s, 'nino-1997').ok).toBe(true);
    expect(dayOfYear(s)).toBeCloseTo(1, 4);
    expect(worldYear(s, s.hours)).toBe(1997);
    expect(fmtDateWithYear(s, s.hours, 'en', true)).toBe('Jan 1, 1997');
    expect(s.effects).toHaveLength(1); // placed tools stay, and the tropical one is fed into the new layer
    expect(s.climateLayer!.core.nPatches).toBeGreaterThan(0);
    expect(s.climateLayer!.core.stochastic).toBe(false);
    expect(s.news.at(-1)!.title).toBe('1997–98 El Niño');
    setClimateMode(s, true);
    expect(s.climateLayer!.core.stochastic).toBe(false); // the fast path does not add random bursts to a scenario
    advanceClimateTime(s, 400);
    expect(fmtDateWithYear(s, s.hours, 'en', true)).toMatch(/Feb \d+, 1998/);
    expect(s.climateLayer!.core.startYear).toBe(1997);
  });
  it('2010 starts on 1 January 2010 with the decaying El Nino warmth', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nina-2010');
    expect(worldYear(s, s.hours)).toBe(2010);
    expect(climateIndices(s.climateLayer!.core).nino34).toBeCloseTo(climateScenarioById('nina-2010').startNino34, 6);
  });
  it('rejects an unknown scenario without recording it', () => {
    const s = createGame(SEED);
    expect(loadClimateScenario(s, 'nope').ok).toBe(false);
    expect(s.actions).toHaveLength(0);
    expect(validateActions([{ tick: 0, type: 'climate-scenario', scenarioId: 'nope' }]).ok).toBe(false);
    expect(validateActions([{ tick: 0, type: 'climate-scenario', scenarioId: 'nina-2010' }]).ok).toBe(true);
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'climate-scenario', scenarioId: 'nina-2010' }])).toBe(true);
  });
  it('the slider and conditions interact with a running scenario and the world stays finite', () => {
    const s = fastWorld('nino-1997');
    advanceClimateTime(s, 100);
    expect(setClimate(s, 'enso', -1.5).ok).toBe(true);
    expect(climateIndices(s.climateLayer!.core).nino34).toBeCloseTo(-1.5, 1);
    advanceClimateTime(s, 60);
    expect(setClimate(s, 'enso', 0).ok).toBe(true);
    advanceClimateTime(s, 200);
    refreshClimateView(s);
    const core = s.climateLayer!.core;
    expect(core.T.every(Number.isFinite) && core.K.every(Number.isFinite)).toBe(true);
    expect(core.script.length).toBeGreaterThan(0);
  });
  it('replays a load, time passing, tools and the slider to the identical state', () => {
    const s = createGame(SEED);
    placeTool(s, 'low', 150, 45);
    loadClimateScenario(s, 'nino-1997');
    setGenesis(s, false);
    skipDays(s, 20);
    placeTool(s, 'warm', 160, 3);
    setClimate(s, 'enso', 1);
    skipDays(s, 5);
    setClimate(s, 'enso', 0);
    setClimateMode(s, true);
    advanceClimateTime(s, 120);
    setClimateMode(s, false);
    loadClimateScenario(s, 'nina-2010');
    setGenesis(s, false);
    skipDays(s, 10);
    const r = replayGame(SEED, s.actions, s.tick, 213);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core);
    expect(r.state.climateScenario).toEqual(s.climateScenario);
    expect(r.state.startDayOfYear).toBe(s.startDayOfYear);
    expect(r.state.calendarOffsetDays).toBe(s.calendarOffsetDays);
    expect(r.state.climate).toEqual(s.climate);
    expect(r.state.news).toEqual(s.news);
    expect(r.state.grid).toEqual(s.grid);
  });
});

describe('scripted forcing in the core', () => {
  it('serialises and restores exactly, and restoreClimate validates the schedule', () => {
    const core = createScenarioCore(7, 'nina-2010');
    for (let d = 0; d < 200; d++) stepClimateDay(core);
    const data = JSON.parse(JSON.stringify(serializeClimate(core)));
    const back = restoreClimate(data);
    const same = (): boolean => JSON.stringify(serializeClimate(back!)) === JSON.stringify(serializeClimate(core)); // JSON turns -0 into 0, so compare the serialised form
    expect(same()).toBe(true);
    for (let d = 0; d < 100; d++) { stepClimateDay(core); stepClimateDay(back!); }
    expect(same()).toBe(true);
    const bad = (script: unknown): boolean => restoreClimate({ ...data, script }) === null;
    expect(bad([1, 2, 3])).toBe(true); // not a multiple of five
    expect(bad([-1, 1, 1, 0, 0])).toBe(true); // negative day
    expect(bad([0, 5, 1, 0, 0])).toBe(true); // unknown kind
    expect(bad([0, 1, 9, 0, 0])).toBe(true); // trade wind out of range
    expect(bad([0, 0, 500, 5, 10])).toBe(true); // burst longitude out of range
    expect(bad([0, 0, 150, 5, 0])).toBe(true); // burst without duration
    expect(bad(Array(5 * 65).fill(0))).toBe(true); // too many entries
    expect(bad('x')).toBe(true);
    const old: Record<string, unknown> = { ...data }; delete old.script;
    expect(restoreClimate(old)?.script).toEqual([]); // states serialised before scenarios
    expect(setClimateScript(createClimate(1), [0, 1, 9, 0, 0])).toBe(false);
  });
  it('a world with no script is unchanged by the scripting code (values recorded from the committed climate-core.ts, ea3feac)', () => {
    const a = createClimate(3, 1, 2000, false);
    a.K.fill(4); a.R.fill(-2);
    for (let d = 0; d < 80; d++) { if (d === 5) addWesterlyBurst(a, { lonEast: 150, speed: 6, days: 12 }); stepClimateDay(a); }
    const sum = (x: ArrayLike<number>): number => Array.from(x).reduce((p, c) => p + c, 0);
    const ix = climateIndices(a);
    expect([a.T[20], a.T[40], a.K[10], a.R[50], sum(a.T), sum(a.K), ix.nino34, ix.soi]).toEqual([0.20814234604066437, 0.23970154146010553, -2.647245683605591, 0.2666724536332439, 12.108323726626935, 105.8265578336181, 0.2817870007936566, -2.582732981765776]);
    const b = createClimate(5, 100, 2000, true);
    for (let d = 0; d < 300; d++) stepClimateDay(b);
    expect([b.T[30], b.K[20], sum(b.T), sum(b.R3), b.burstCount, climateIndices(b).nino34, b.redNoise]).toEqual([1.7709281634113896, 3.4286010192686125, 58.8734771794296, -102.98286511361717, 5, 1.6582455507009317, -0.28346441469743966]);
    expect(a.script).toEqual([]);
  });
});

describe('worker-sized chunks, the end of the script, and other worlds', () => {
  it('advancing in 14-day chunks, as the worker does, reaches the same state as one day at a time', () => {
    const a = fastWorld('nino-1997'), b = fastWorld('nino-1997');
    for (let i = 0; i < 30; i++) advanceClimateTime(a, 14);
    for (let i = 0; i < 420; i++) advanceClimateTime(b, 1);
    expect(JSON.stringify(serializeClimate(a.climateLayer!.core))).toBe(JSON.stringify(serializeClimate(b.climateLayer!.core)));
    expect(a.calendarOffsetDays).toBe(b.calendarOffsetDays);
  });
  it('natural variability starts the day after the script ends on the fast path, whatever the chunking, and replays identically', () => {
    const run = (chunk: number): GameState => {
      const s = fastWorld('nino-1997');
      for (let d = 0; d < 1500; d += chunk) advanceClimateTime(s, chunk);
      return s;
    };
    const s = fastWorld('nino-1997');
    advanceClimateTime(s, 590);
    expect(s.climateLayer!.core.stochastic).toBe(false); // the scripted period is noise-free
    advanceClimateTime(s, 20);
    expect(s.climateLayer!.core.stochastic).toBe(true);
    const a = run(30), b = run(25);
    expect(a.climateLayer!.core.burstCount).toBeGreaterThan(0);
    const nino = (w: GameState): number[] => { const c = createClimate(1); return [climateIndices(w.climateLayer!.core).nino34, c.day]; };
    expect(nino(a)[0]).not.toBe(0);
    const r = replayGame(SEED, a.actions, a.tick, 213);
    expect(r.ok).toBe(true);
    if (r.ok) expect(JSON.stringify(serializeClimate(r.state.climateLayer!.core))).toBe(JSON.stringify(serializeClimate(a.climateLayer!.core)));
    // 1500 days is the same state through 30- and 25-day chunks
    expect(JSON.stringify(serializeClimate(a.climateLayer!.core))).toBe(JSON.stringify(serializeClimate(b.climateLayer!.core)));
  });
  it('pressing a season ends the scenario: year back to normal, script and trade anomaly gone, ocean kept, replay identical', () => {
    const s = weatherWorld('nino-1997');
    skipDays(s, 30);
    const t34 = climateIndices(s.climateLayer!.core).nino34;
    expect(setSeason(s, 200).ok).toBe(true);
    expect(s.climateScenario).toBeUndefined();
    expect(s.climateLayer!.core.script).toEqual([]);
    expect(s.climateLayer!.core.tradeAnomaly).toBe(0);
    expect(climateIndices(s.climateLayer!.core).nino34).toBe(t34);
    expect(s.news.at(-1)!.title).toBe('Climate scenario ended');
    expect(worldYear(s, s.hours)).not.toBe(1996);
    expect(fmtDateWithYear(s, s.hours, 'en', true)).not.toMatch(/1996|1997/);
    skipDays(s, 10);
    const r = replayGame(SEED, s.actions, s.tick, 213);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core);
    expect(r.state.climateScenario).toBeUndefined();
    expect(r.state.news).toEqual(s.news);
    const book = new ProbeBook();
    book.add('measure-nino34', 0, 0);
    book.sample(s);
    expect(book.observed).toBeNull();
  });
  it('loading the same scenario twice at the same time restarts the Measure line and keeps news ids unique', () => {
    const s = createGame(SEED);
    const book = new ProbeBook();
    book.add('measure-nino34', 0, 0);
    loadClimateScenario(s, 'nino-1997');
    skipDays(s, 3);
    book.sample(s);
    book.sample(s);
    loadClimateScenario(s, 'nino-1997');
    expect(book.sample(s)).toBe(true);
    expect(book.seriesOf('measure-nino34', 0, 0)!.t).toHaveLength(1);
    expect(s.climateScenario!.loads).toBe(2);
    const ids = s.news.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    const twice = createGame(SEED);
    loadClimateScenario(twice, 'nino-1997'); loadClimateScenario(twice, 'nino-1997');
    const idsTwice = twice.news.map(n => n.id);
    expect(new Set(idsTwice).size).toBe(idsTwice.length);
  });
  it('a load during the fast path replaces the layer, keeps the date mechanism, and replays identically', () => {
    const s = createGame(SEED, 213);
    setClimateMode(s, true);
    advanceClimateTime(s, 400);
    expect(loadClimateScenario(s, 'nina-2010').ok).toBe(true);
    expect(dayOfYear(s)).toBeCloseTo(1, 4);
    expect(worldYear(s, s.hours)).toBe(2010);
    expect(s.climateLayer!.core.day).toBe(0);
    expect(s.climateTime!.active).toBe(true);
    advanceClimateTime(s, 120);
    expect(fmtDateWithYear(s, s.hours, 'en', true)).toMatch(/May \d+, 2010/);
    expect(climateIndices(s.climateLayer!.core).nino34).toBeLessThan(0.7);
    const r = replayGame(SEED, s.actions, s.tick, 213);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core); expect(r.state.climateScenario).toEqual(s.climateScenario); expect(r.state.calendarOffsetDays).toBe(s.calendarOffsetDays); }
  });
  it('a load on a live-weather start drops the stale analysis and replays identically', () => {
    const live = (): LiveWeatherSnapshot => ({
      source: 'NOAA GFS', modelRun: '2026-10-27T00:00:00.000Z', pressure: Array(16200).fill(1010), u: Array(16200).fill(2), v: Array(16200).fill(0),
      seaTemperature: Array.from({ length: 16200 }, (_, k) => (Math.abs(-89 + 2 * Math.floor(k / 180)) > 60 ? 2 : 31)), airTemperature: Array(16200).fill(30),
    });
    const s = createGame(SEED, 300, live());
    s.weatherSource = 'live';
    expect(s.climateLayer!.live).toBe(true);
    expect(loadClimateScenario(s, 'nino-1997').ok).toBe(true);
    setGenesis(s, false);
    expect(s.weather).toBeUndefined();
    expect(s.liveEnded).toBe(true);
    expect(s.climateLayer!.live).toBe(false);
    expect(s.climateLayer!.base).toBeNull();
    expect(worldYear(s, s.hours)).toBe(1997);
    skipDays(s, 40);
    expect(Number.isFinite(sampleEnvironment(s, 160, 2).temperature)).toBe(true);
    const r = replayGame(SEED, s.actions, s.tick, 300, [], live());
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core); expect(r.state.news).toEqual(s.news); expect(r.state.grid).toEqual(s.grid); }
  });
  it('a load and a switch between scenarios leave running storms, hazards and tools as they are, and replay identically', () => {
    setHistoricEnvironment('maemi-2003', null);
    const s = createGame(SEED, 213);
    expect(loadHistoric(s, 'maemi-2003').ok).toBe(true);
    expect(placeFormation(s, 'typhoon', 140, 15).ok).toBe(true);
    expect(placeFormation(s, 'heatwave', 120, 35).ok).toBe(true);
    expect(placeTool(s, 'warm', 150, 5).ok).toBe(true);
    for (let i = 0; i < 200; i++) stepGame(s);
    const snap = () => ({ storms: s.storms.map(x => x.id), hazards: s.weatherHazards.map(x => x.id), tools: s.effects.map(x => x.id), historic: s.historic.map(h => h.finished), score: s.score, archive: s.stormArchive.length, hours: s.hours });
    const before = snap();
    expect(before.storms.length).toBeGreaterThan(0);
    expect(before.hazards.length).toBeGreaterThan(0);
    expect(before.tools.length).toBeGreaterThan(0);
    expect(loadClimateScenario(s, 'nino-1997').ok).toBe(true);
    expect(snap()).toEqual(before);
    expect(s.climateLayer!.core.nPatches).toBeGreaterThan(0); // the warm-water tool was fed once into the new layer
    const patches = s.climateLayer!.core.nPatches;
    for (let i = 0; i < 100; i++) stepGame(s);
    expect(s.storms.length).toBeGreaterThan(0);
    expect(s.hours).toBeGreaterThan(before.hours);
    const mid = snap();
    expect(loadClimateScenario(s, 'nina-2010').ok).toBe(true);
    expect(snap()).toEqual(mid);
    expect(s.climateLayer!.core.nPatches).toBe(patches);
    for (let i = 0; i < 100; i++) stepGame(s);
    expect(s.score).toBeGreaterThanOrEqual(mid.score);
    const r = replayGame(SEED, s.actions, s.tick, 213);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const t = r.state;
      expect(t.climateLayer!.core).toEqual(s.climateLayer!.core);
      expect(t.storms).toEqual(s.storms);
      expect(t.weatherHazards).toEqual(s.weatherHazards);
      expect(t.effects).toEqual(s.effects);
      expect(t.historic).toEqual(s.historic);
      expect(t.stormArchive).toEqual(s.stormArchive);
      expect(t.disasters).toEqual(s.disasters);
      expect(t.score).toBe(s.score);
      expect(t.genesis).toEqual(s.genesis);
    }
  });
});

describe('the observed series and the Measure chart', () => {
  it('ships the observed monthly Nino 3.4 and agrees with the test fixture', () => {
    const v = observedNino34From(1997, 24);
    expect(v).toHaveLength(24);
    expect(v).toEqual(observed.nino34.slice((1997 - 1950) * 12, (1997 - 1950) * 12 + 24));
    expect(observedNino34From(2024, 24)).toHaveLength(12);
    expect(observedNino34From(1900, 12)).toEqual([]);
  });
  it('keeps charting across the calendar jump of a load, with the observed months laid out from it', () => {
    const s = createGame(SEED);
    const book = new ProbeBook();
    book.add('measure-nino34', 0, 0);
    book.sample(s);
    placeTool(s, 'warm', 150, 5);
    skipDays(s, 3);
    book.sample(s);
    expect(book.seriesOf('measure-nino34', 0, 0)!.t.length).toBeGreaterThan(0);
    expect(book.observed).toBeNull();
    const before = s.hours / 24;
    loadClimateScenario(s, 'nina-2010');
    expect(book.sample(s)).toBe(true);
    const line = book.seriesOf('measure-nino34', 0, 0)!;
    expect(line.t).toHaveLength(1); // a fresh line from the load
    expect(line.t[0]).toBeGreaterThanOrEqual(before);
    expect(book.charts.has('measure-nino34')).toBe(true);
    expect(book.observed!.v.slice(0, 12)).toEqual(observed.nino34.slice((2010 - 1950) * 12, (2010 - 1950) * 12 + 12));
    expect(book.observed!.t[0]).toBeCloseTo(line.t[0] + 365 / 24, 6);
    setClimateMode(s, true);
    for (let i = 0; i < 12; i++) { advanceClimateTime(s, 30); book.sample(s); }
    const grown = book.seriesOf('measure-nino34', 0, 0)!;
    expect(grown.t.length).toBeGreaterThan(5);
    expect(grown.t.every((t, i) => i === 0 || t > grown.t[i - 1])).toBe(true);
    expect(grown.v.every(Number.isFinite)).toBe(true);
    expect(book.observed!.t[11]).toBeLessThan(grown.t[grown.t.length - 1] + 30);
  });
});
