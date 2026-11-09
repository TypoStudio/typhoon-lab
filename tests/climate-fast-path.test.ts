import { describe, expect, it, vi } from 'vitest';
import { heatSourceActive } from '../src/simulation/climate-core';
import { anomalyAt, newAnomalyPoint } from '../src/simulation/climate-coupling';
import {
  advanceClimateTime, fastDaysLeft, historicEnvironmentReady, setHistoricEnvironment, totalPressure, createGame, dayOfYear, placeFormation, placeTool, readClimatePoint, readClimateIndices, readThermocline, refreshClimateView, replayActivatesClimateLayer, replayGame, sampleEnvironment,
  setClimateMode, stepGame, validateActions,
} from '../src/simulation/engine';
import { fmtDateWithYear, showsYear } from '../src/ui/calendar';
import { isFastClimateSpeed } from '../src/time';
import type { GameState, LiveWeatherSnapshot } from '../src/types';
import { TICKS_PER_DAY, fullDays } from './climate-helpers';

vi.setConfig({ testTimeout: 120_000 });
const SEED = 20261022;
const AUG_1 = 213, NOV = 305;

function busyWorld(): GameState {
  const s = createGame(SEED, AUG_1);
  expect(placeFormation(s, 'typhoon', 140, 15).ok).toBe(true);
  for (let i = 0; i < 800 && s.storms.length === 0; i++) stepGame(s);
  expect(s.storms.length).toBeGreaterThan(0);
  return s;
}

describe('the fast climate path', () => {
  it('is taken above 2 days per second only', () => {
    expect([172_800, 86_400, 200].some(isFastClimateSpeed)).toBe(false);
    expect(isFastClimateSpeed(2_592_000)).toBe(true);
  });

  it('entering and leaving at once changes nothing', () => {
    const s = busyWorld();
    const storms = structuredClone(s.storms), effects = structuredClone(s.effects), doy = dayOfYear(s);
    expect(setClimateMode(s, true).ok).toBe(true);
    expect(s.climateLayer!.core.stochastic).toBe(true);
    expect(setClimateMode(s, false).ok).toBe(true);
    expect(s.storms).toEqual(storms);
    expect(s.effects).toEqual(effects);
    expect(dayOfYear(s)).toBe(doy);
  });

  it('moves the calendar continuously, ends storms once without damage, and typhoons form again on the changed climate', () => {
    const s = busyWorld();
    const hours = s.hours, tick = s.tick, score = s.score, count = s.storms.length, archive = s.stormArchive.length;
    setClimateMode(s, true);
    advanceClimateTime(s, 1);
    expect(s.storms).toHaveLength(0);
    expect(s.stormArchive.length).toBe(archive + count);
    expect(s.news.filter(n => n.title === 'Time has passed')).toHaveLength(1);
    const dates: number[] = [];
    for (let i = 0; i < 12; i++) { advanceClimateTime(s, 30); refreshClimateView(s); dates.push(dayOfYear(s)); }
    expect(s.news.filter(n => n.title === 'Time has passed')).toHaveLength(1);
    expect(s.hours).toBe(hours);
    expect(s.tick).toBe(tick);
    expect(s.score).toBe(score);
    for (let i = 1; i < dates.length; i++) expect((dates[i] - dates[i - 1] + 365.25) % 365.25).toBeGreaterThan(29);
    expect(s.calendarOffsetDays).toBeCloseTo((361 * 365.25) / 365, 6);
    setClimateMode(s, false);
    const core = s.climateLayer!.core;
    expect(((core.startDayOfYear - 1 + core.day) % 365) + 1).toBeCloseTo(Math.floor(dayOfYear(s)), 6);
    s.genesis.enabled = true;
    fullDays(s, 3);
    expect(s.tick).toBe(tick + 3 * TICKS_PER_DAY);
    expect(Number.isFinite(s.score)).toBe(true);
  });

  it('a tool placed on the fast path stays, ages with the days and ends', () => {
    const s = createGame(SEED, AUG_1);
    setClimateMode(s, true);
    advanceClimateTime(s, 2);
    expect(placeTool(s, 'low', 160, 5).ok).toBe(true);
    advanceClimateTime(s, 1);
    expect(s.effects).toHaveLength(1);
    advanceClimateTime(s, 3);
    expect(s.effects).toHaveLength(0);
  });

  it('a world that never takes it stays noise-free', () => {
    const s = createGame(SEED, AUG_1);
    placeTool(s, 'warm', -150, 2);
    fullDays(s, 5);
    expect(s.climateLayer!.core.stochastic).toBe(false);
    expect(s.climateLayer!.core.burstCount).toBe(0);
    expect(s.climateTime).toBeNull();
  });

  it('shows the year after a year or on the fast path', () => {
    const s = createGame(SEED, AUG_1);
    expect(showsYear(s, 0)).toBe(false);
    setClimateMode(s, true);
    expect(showsYear(s, 0)).toBe(true);
    advanceClimateTime(s, 400);
    setClimateMode(s, false);
    expect(showsYear(s, 0)).toBe(true);
    expect(fmtDateWithYear(s, 0, 'ko', false)).toMatch(/^\d{4}년 \d{1,2}월$/);
  });

  it('the layer carries natural variability after use (monthly Nino 3.4 std over 30 years)', () => {
    const sds: number[] = [];
    for (const seed of [11, 12]) {
      const s = createGame(seed, AUG_1);
      setClimateMode(s, true);
      const series: number[] = [];
      for (let m = 0; m < 360; m++) { advanceClimateTime(s, 30); series.push(readClimateIndices(s)!.nino34); }
      const mean = series.reduce((a, b) => a + b, 0) / series.length;
      sds.push(Math.sqrt(series.reduce((a, b) => a + (b - mean) ** 2, 0) / series.length));
    }
    expect(Math.min(...sds)).toBeGreaterThan(0.4);
    expect(Math.max(...sds)).toBeLessThan(1.6);
  });
});

describe('replay across the threshold', () => {
  /** Tools, speed changes over the 2 days/s threshold with different display cadences, more tools, back to slow time. */
  function play(viewEvery: number): GameState {
    const s = createGame(SEED, AUG_1);
    placeTool(s, 'low', 160, 2);
    placeTool(s, 'warm', -150, 1);
    fullDays(s, 1);
    setClimateMode(s, true);
    for (let i = 0; i < 24; i++) {
      advanceClimateTime(s, 30);
      if (i % viewEvery === 0) refreshClimateView(s);
      if (i === 5) placeTool(s, 'updraft', 170, 0);
      if (i === 9) placeTool(s, 'high', -120, 3);
    }
    setClimateMode(s, false);
    placeTool(s, 'cool', -130, 0);
    fullDays(s, 2);
    return s;
  }
  it('replays identically whatever the view rebuild cadence of the live run was', () => {
    const live = play(1), sparse = play(7);
    for (const s of [live, sparse]) {
      const r = replayGame(SEED, s.actions, s.tick, AUG_1);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core);
      expect(r.state.calendarOffsetDays).toBe(s.calendarOffsetDays);
      expect(r.state.climateTime).toEqual(s.climateTime);
      expect(r.state.score).toBe(s.score);
      for (const [lon, lat] of [[160, 2], [-150, 1], [140, 15], [-120, 3]]) {
        expect(sampleEnvironment(r.state, lon, lat)).toEqual(sampleEnvironment(s, lon, lat));
        expect(readClimatePoint(r.state, lon, lat)).toEqual(readClimatePoint(s, lon, lat));
      }
    }
    expect(live.climateLayer!.core).toEqual(sparse.climateLayer!.core);
  });
  it('a tool outside the tropics placed on the fast path replays to the same grid and state whatever the live view cadence', () => {
    const run = (viewEvery: number): GameState => {
      const s = createGame(SEED, AUG_1);
      setClimateMode(s, true);
      advanceClimateTime(s, 30);
      refreshClimateView(s);
      expect(placeTool(s, 'low', 150, 45).ok).toBe(true);
      expect(placeTool(s, 'cool', 150, 40).ok).toBe(true);
      for (let i = 0; i < 3; i++) { advanceClimateTime(s, 1); if (i % viewEvery === 0) refreshClimateView(s); }
      advanceClimateTime(s, 60);
      setClimateMode(s, false);
      placeTool(s, 'warm-air', 150, 45);
      fullDays(s, 2);
      return s;
    };
    for (const cadence of [1, 5]) {
      const s = run(cadence);
      const r = replayGame(SEED, s.actions, s.tick, AUG_1);
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.state.grid).toEqual(s.grid);
      expect(r.state.effects).toEqual(s.effects);
      expect(r.state.news).toEqual(s.news);
      expect(r.state.score).toBe(s.score);
      expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core);
    }
  });
  it('validates actions: layer activation and the fast-path limits', () => {
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'climate-mode', on: true }])).toBe(true);
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'low', lon: 150, lat: 10 }])).toBe(true);
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'low', lon: 150, lat: 45 }])).toBe(false);
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'low', lon: 150, lat: 10, formation: 'typhoon' }])).toBe(false);
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'moisture', lon: 150, lat: 10 }])).toBe(false);
    expect(validateActions([{ tick: 0, type: 'climate-advance', days: 0 }]).ok).toBe(false);
    expect(validateActions([{ tick: 0, type: 'climate-cause', cause: {} }]).ok).toBe(false);
    const s = createGame(SEED, AUG_1);
    setClimateMode(s, true);
    expect(advanceClimateTime(s, 200 * 365).ok).toBe(true);
    expect(advanceClimateTime(s, 1).ok).toBe(false);
  });
  it('point readers work', () => {
    const s = createGame(SEED, AUG_1);
    placeTool(s, 'low', 160, 0);
    const r = readClimatePoint(s, 160, 0);
    expect(r.seaTemperature).not.toBeNull();
    expect(readThermocline(s, 200)!.depth).toBeGreaterThan(40);
    expect(readThermocline(s, 100)).toBeNull();
  });
});

describe('the fast path in a world that started live', () => {
  const live = (): LiveWeatherSnapshot => ({
    source: 'NOAA GFS', modelRun: '2026-10-27T00:00:00.000Z', pressure: Array(16200).fill(1010), u: Array(16200).fill(2), v: Array(16200).fill(0),
    seaTemperature: Array.from({ length: 16200 }, (_, k) => (Math.abs(-89 + 2 * Math.floor(k / 180)) > 60 ? 2 : 31)), airTemperature: Array(16200).fill(30),
  });
  const run = (): GameState => {
    const s = createGame(SEED, 300, live());
    s.weatherSource = 'live';
    fullDays(s, 1);
    setClimateMode(s, true);
    return s;
  };

  it('drops the stale analysis once time has passed: the map and Measure values then follow the seasons', () => {
    const s = run();
    const before = { sea: readClimatePoint(s, 150, 40), grid: s.grid[gridIndexOf(s, 150, 40)].temperature };
    expect(s.weather).toBeDefined();
    advanceClimateTime(s, 1);
    expect(s.weather).toBeUndefined();
    expect(s.liveEnded).toBe(true);
    expect(s.climateLayer!.live).toBe(false);
    expect(s.climateLayer!.base).toBeNull();
    expect(s.news.filter(n => n.title === 'Live weather ended')).toHaveLength(1);
    const seen: number[] = [], grid: number[] = [], pressure: number[] = [];
    for (let i = 0; i < 12; i++) {
      advanceClimateTime(s, 30); refreshClimateView(s);
      seen.push(readClimatePoint(s, 150, 40).seaTemperature!); grid.push(s.grid[gridIndexOf(s, 150, 40)].temperature); pressure.push(readClimatePoint(s, 150, 40).pressure);
    }
    expect(s.news.filter(n => n.title === 'Live weather ended')).toHaveLength(1);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(3); // a year of seasons at 40N
    expect(Math.max(...grid) - Math.min(...grid)).toBeGreaterThan(3);
    expect(Math.abs(seen[0] - before.sea.seaTemperature!)).toBeGreaterThan(1); // the analysis' own 31 C is gone
    expect(new Set(pressure.map(v => v.toFixed(2))).size).toBeGreaterThan(1);
    expect(setClimateMode(s, false).ok).toBe(true);
    fullDays(s, 2);
    expect(s.grid.every(c => Number.isFinite(c.temperature) && Number.isFinite(c.pressure))).toBe(true);
  });

  it('is deterministic in replay', () => {
    const s = run();
    for (let i = 0; i < 6; i++) { advanceClimateTime(s, 30); if (i % 2) refreshClimateView(s); }
    setClimateMode(s, false);
    fullDays(s, 1);
    const r = replayGame(SEED, s.actions, s.tick, 300, [], live());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.liveEnded).toBe(true);
    expect(r.state.climateLayer!.core).toEqual(s.climateLayer!.core);
    expect(r.state.grid).toEqual(s.grid);
    expect(readClimatePoint(r.state, 150, 40)).toEqual(readClimatePoint(s, 150, 40));
  });
});

const gridIndexOf = (s: GameState, lon: number, lat: number): number => {
  let best = 0, d = Infinity;
  s.grid.forEach((c, k) => { const e = Math.hypot(c.lon - lon, c.lat - lat); if (e < d) { d = e; best = k; } });
  return best;
};

describe('review fixes', () => {
  it('Measure pressure includes the storms', () => {
    const s = busyWorld();
    const storm = s.storms[0];
    const point = readClimatePoint(s, storm.lon, storm.lat);
    expect(point.pressure).toBe(totalPressure(s, storm.lon, storm.lat));
    expect(point.pressure).toBeLessThan(sampleEnvironment(s, storm.lon, storm.lat).pressure - 5);
  });

  it('knows when a historic reanalysis is not registered in this thread yet', () => {
    const s = createGame(SEED, AUG_1);
    expect(historicEnvironmentReady(s)).toBe(true);
    s.historic.push({ typhoonId: 'maemi-2003', startHour: 0, stormId: 1, finished: false, environment: 'loaded' } as never);
    expect(historicEnvironmentReady(s)).toBe(false);
    setHistoricEnvironment('maemi-2003', { cells: [], steps: [] } as never);
    expect(historicEnvironmentReady(s)).toBe(true);
    setHistoricEnvironment('maemi-2003', null);
  });

  it('counts the fast days left and refuses more than the run allows', () => {
    const s = createGame(SEED, AUG_1);
    setClimateMode(s, true);
    expect(fastDaysLeft(s)).toBe(200 * 365);
    advanceClimateTime(s, 200 * 365 - 5);
    expect(fastDaysLeft(s)).toBe(5);
    expect(advanceClimateTime(s, 6).ok).toBe(false);
    expect(advanceClimateTime(s, 5).ok).toBe(true);
    expect(fastDaysLeft(s)).toBe(0);
  });

  it('the patches of wiped tools end with them, and the footprint stops with the tool', () => {
    const s = createGame(SEED, NOV);
    placeTool(s, 'low', 160, 0); placeTool(s, 'warm', -150, 0); placeTool(s, 'updraft', 170, 0);
    fullDays(s, 1);
    const core = s.climateLayer!.core;
    expect(core.nHeat).toBe(2);
    expect([0, 1].every(i => heatSourceActive(core, i))).toBe(true);
    setClimateMode(s, true);
    advanceClimateTime(s, 1);
    const after = s.climateLayer!.core; // entering gave the layer a new (noisy) core
    expect(s.effects).toHaveLength(0);
    expect(after.nHeat).toBe(2);
    expect([0, 1].some(i => heatSourceActive(after, i))).toBe(false);
    expect(after.patches[5]).toBeLessThanOrEqual(after.day - after.patches[4]); // the warm tool's SST patch is released
    refreshClimateView(s);
    const layerSlp = (w: GameState): number => anomalyAt(w.climateLayer!.anomalies!, 160, 0, newAnomalyPoint()).slp;
    const standing = createGame(SEED, NOV);
    placeTool(standing, 'low', 160, 0);
    fullDays(standing, 2);
    expect(Math.abs(layerSlp(standing))).toBeLessThan(0.05); // the low's own pressure system stands in for the layer's inside its footprint
    expect(layerSlp(s)).toBeLessThan(-0.1); // the tool is gone: the Gill pressure of the fading heating is back
  });
});
