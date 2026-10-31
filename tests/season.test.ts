import { afterEach, describe, expect, it } from 'vitest';
import type { GameState, HistoricEnvironment } from '../src/types';
import { DEFAULT_START_DOY, TICKS_PER_HOUR, createGame, dayOfYear, gridIndex, loadHistoric, placeTool, replayGame, sampleEnvironment, setHistoricEnvironment, setSeason, stepGame } from '../src/simulation/engine';
import { buildReplay, parseReplay } from '../src/ui/storage';
import { SEASONS, fmtMonthDay, parseStartParam, realTimeOfYear, seasonIdOf } from '../src/ui/calendar';
import { fmtClockLive, fmtClockShort } from '../src/ui/dom';
import { adjacentTimeSpeed, isTimeSpeed, timeSpeedLabel, TIME_SPEEDS } from '../src/time';
import fixtureJson from './fixtures/environment-fixture.json';

const run = (s: GameState, hours: number) => { for (let tick = 0; tick < hours * TICKS_PER_HOUR; tick++) stepGame(s); };
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const JAN15 = 15, AUG15 = 227;
const sst = (doy: number, lon: number, lat: number) => sampleEnvironment(createGame(1, doy), lon, lat).temperature;

describe('calendar', () => {
  it('dayOfYear is the start day plus model days, wrapped into the year', () => {
    expect(dayOfYear({ startDayOfYear: 213, hours: 0 })).toBe(213);
    expect(dayOfYear({ startDayOfYear: 360, hours: 240 })).toBeCloseTo(4.75, 9);
    expect(dayOfYear({ startDayOfYear: 10.5, hours: 36 })).toBeCloseTo(12, 9);
    expect(createGame(1).startDayOfYear).toBe(DEFAULT_START_DOY);
    expect(() => createGame(1, 400)).toThrow();
  });

  it('setSeason keeps the clock running, records an action and replays to the same world', () => {
    const s = createGame(20261022);
    run(s, 30);
    expect(setSeason(s, JAN15).ok).toBe(true);
    expect(dayOfYear(s)).toBeCloseTo(JAN15, 9);
    run(s, 12);
    expect(dayOfYear(s)).toBeCloseTo(JAN15 + 0.5, 9);
    placeTool(s, 'warm', 140, 16);
    run(s, 6);
    expect(s.actions.find(a => a.type === 'season')).toEqual({ tick: 30 * TICKS_PER_HOUR, type: 'season', dayOfYear: JAN15 });
    expect(setSeason(s, 400).ok).toBe(false);
    expect(setSeason(s, -1).ok).toBe(false);
    const r = replayGame(s.seed, s.actions, s.tick, s.initialStartDayOfYear);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.startDayOfYear).toBeCloseTo(s.startDayOfYear, 9);
      expect(r.state.grid).toEqual(s.grid);
      expect(r.state.actions).toEqual(s.actions);
    }
  });

  it('records the creation date in the replay header and rejects a missing or invalid one', () => {
    const s = createGame(7, 100);
    run(s, 5); setSeason(s, 300); run(s, 5);
    const file = buildReplay(s);
    expect(file.startDayOfYear).toBe(100);
    const parsed = parseReplay(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.replay).toEqual(file);
    const { startDayOfYear: _omit, ...without } = file;
    for (const bad of [without, { ...file, startDayOfYear: 'x' }, { ...file, startDayOfYear: 400 }, { ...file, startDayOfYear: -1 }, { ...file, actions: [{ tick: 0, type: 'season', dayOfYear: 400 }] }, { ...file, actions: [{ tick: 0, type: 'season' }] }]) {
      expect(parseReplay(JSON.stringify(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('seasonal base climate', () => {
  it('sea temperature falls by about 2A between mid-August and mid-January at 40N and the other way at 40S', () => {
    const amp = 0.5 + 4 * smooth(10, 45, 40);
    const north = sst(AUG15, 150, 40) - sst(JAN15, 150, 40);
    const south = sst(JAN15, 150, -40) - sst(AUG15, 150, -40);
    expect(Math.abs(north - 2 * amp)).toBeLessThan(0.5);
    expect(Math.abs(south - 2 * amp)).toBeLessThan(0.5);
    expect(sst(JAN15, 150, 40)).toBeLessThan(sst(AUG15, 150, 40));
    expect(sst(JAN15, 150, -40)).toBeGreaterThan(sst(AUG15, 150, -40));
  });

  it('air temperature and the mid-latitude jet follow the season; the equator barely moves', () => {
    const at = (doy: number, lon: number, lat: number) => sampleEnvironment(createGame(1, doy), lon, lat);
    expect(at(JAN15, 150, 45).airTemperature).toBeLessThan(at(AUG15, 150, 45).airTemperature - 5);
    expect(at(JAN15, 150, 45).u).toBeGreaterThan(at(AUG15, 150, 45).u);
    expect(at(AUG15, 150, -45).u).toBeGreaterThan(at(JAN15, 150, -45).u);
    for (const lat of [0, 3]) {
      const eq = Array.from({ length: 24 }, (_, k) => sst(15 * k + 1, 150, lat));
      expect(Math.max(...eq) - Math.min(...eq)).toBeLessThan(1.5);
      const eqAir = Array.from({ length: 24 }, (_, k) => at(15 * k + 1, 150, lat).airTemperature);
      expect(Math.max(...eqAir) - Math.min(...eqAir)).toBeLessThan(1.5);
    }
  });

  it('the fast grid equals point sampling with a non-default season', () => {
    const s = createGame(20261022, JAN15);
    run(s, 50); // the calendar passes day 17
    let checked = 0;
    for (const c of s.grid.filter(c => c.lon % 20 === 0 || Math.abs(c.lat) > 55)) {
      const p = sampleEnvironment(s, c.lon, c.lat);
      expect(c.temperature).toBeCloseTo(p.temperature, 9);
      expect(c.airTemperature).toBeCloseTo(p.airTemperature, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('seasons and a historic typhoon', () => {
  const ID = 'maemi-2003';
  afterEach(() => setHistoricEnvironment(ID, null));

  it('leaves recorded cells untouched whatever the world calendar says', () => {
    setHistoricEnvironment(ID, fixtureJson as unknown as HistoricEnvironment);
    const cell = gridIndex(129, 33);
    const worlds = [DEFAULT_START_DOY, JAN15].map(doy => {
      const s = createGame(1, doy);
      run(s, 10);
      expect(loadHistoric(s, ID).ok).toBe(true);
      return s;
    });
    for (const key of ['temperature', 'airTemperature', 'pressure', 'u', 'v', 'humidity'] as const) expect(worlds[0].grid[cell][key]).toBe(worlds[1].grid[cell][key]);
    expect(worlds[1].grid[cell].temperature).toBeCloseTo(29, 6);
    expect(worlds[1].grid[cell].airTemperature).toBeCloseTo(27, 6);
  });
});

describe('UI calendar helpers', () => {
  it('starts from the local real clock and displays seconds at 1×', () => {
    const start = realTimeOfYear(new Date(2026, 9, 27, 12, 34, 56, 500));
    expect(start).toBeCloseTo(300 + (12 * 3600 + 34 * 60 + 56.5) / 86400, 9);
    expect(fmtClockLive((start % 1) * 24)).toBe('Day 1 · 12:34:56');
    expect(fmtClockShort((start % 1) * 24)).toBe('D1 12:34:56');
    expect(fmtMonthDay(365 + 1)).toBe('Jan 1');
  });

  it('cycles through the available speeds in both directions', () => {
    expect(TIME_SPEEDS.every(isTimeSpeed)).toBe(true);
    expect([0, 1, 4, 12, 28800, 32768, Number.NaN].some(isTimeSpeed)).toBe(false);
    expect(TIME_SPEEDS.map(timeSpeedLabel)).toEqual(['x1', 'x2', 'x4', 'x8', 'x16', 'x48']);
    expect(adjacentTimeSpeed(200, 1)).toBe(600);
    expect(adjacentTimeSpeed(600, 1)).toBe(1200);
    expect(adjacentTimeSpeed(14400, 1)).toBe(200);
    expect(adjacentTimeSpeed(200, -1)).toBe(14400);
  });

  it('maps days to the four seasons, the season buttons to their own season, and days to dates', () => {
    expect([59, 60, 151, 152, 243, 244, 334, 335, 365, 1].map(seasonIdOf)).toEqual(['winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn', 'winter', 'winter', 'winter']);
    expect(SEASONS.map(s => [s.id, s.doy, seasonIdOf(s.doy)])).toEqual([['spring', 105, 'spring'], ['summer', 196, 'summer'], ['autumn', 288, 'autumn'], ['winter', 15, 'winter']]);
    expect(fmtMonthDay(213)).toBe('Aug 1');
    expect(fmtMonthDay(300.7)).toBe('Oct 27');
  });

  it('reads ?start=YYYY-MM-DD and rejects anything else', () => {
    expect(parseStartParam('?start=2026-08-01')).toBe(213);
    expect(parseStartParam('?seed=1')).toBeNull();
    expect(parseStartParam('?start=2026-13-01')).toBeNull();
    expect(parseStartParam('?start=August')).toBeNull();
  });
});
