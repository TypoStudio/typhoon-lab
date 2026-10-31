import { describe, expect, it } from 'vitest';
import { WEATHER_HAZARDS, WEATHER_HAZARD_KINDS } from '../src/data/weather-hazards';
import { createGame, gridIndex, loadHistoric, placeFormation, replayGame, sampleEnvironment, setHistoricEnvironment, stepGame, totalPressure, totalWind, validateActions, weatherHazardRecipe } from '../src/simulation/engine';
import { hazardDamageRatio, stepWeatherHazards } from '../src/simulation/weather-hazards';
import type { HistoricEnvironment, LiveWeatherSnapshot, NewsItem } from '../src/types';
import fixtureJson from './fixtures/environment-fixture.json';

const PRESSURE_SIGN = { heatwave: 1, drought: 1, downpour: -1, coldwave: 1, hail: -1, dust: -1, gust: 1 };

const advance = (state: ReturnType<typeof createGame>, ticks: number) => { for (let i = 0; i < ticks; i++) stepGame(state); };

describe('player-created weather phenomena', () => {
  it.each(WEATHER_HAZARD_KINDS)('forms %s, changes the physical field, causes damage and ends once', kind => {
    const state = createGame(17, 213);
    const guide = weatherHazardRecipe(state, kind, 127, 37);
    expect(guide.ok).toBe(true);
    expect(guide.placements).toContain(WEATHER_HAZARDS[kind].anchor);
    expect(placeFormation(state, kind, 127, 37)).toEqual({ ok: true });
    advance(state, 23);
    expect(state.weatherHazards).toHaveLength(0);
    advance(state, 6);
    const hazard = state.weatherHazards.find(item => item.kind === kind)!;
    expect(hazard).toBeDefined();
    const report = state.disasters!.find(item => item.id === `weather-${hazard.id}`)!;
    expect(report).toMatchObject({ kind, lon: hazard.lon, lat: hazard.lat });
    expect(report.endedHour).toBeUndefined();
    expect(report.damageScore).toBeGreaterThan(0);
    expect(report.history.length).toBeGreaterThan(0);
    expect(state.news.filter(item => item.kind === 'weather' && item.phenomenon === kind)).toHaveLength(1);
    expect(state.score).toBeGreaterThan(0);
    const cell = state.grid.find(cell => cell.lon === 127 && cell.lat === 37)!;
    if (kind === 'heatwave') expect(cell.airTemperature).toBeGreaterThan(35);
    if (kind === 'coldwave') expect(cell.airTemperature).toBeLessThan(-10);
    if (kind === 'drought' || kind === 'dust') expect(cell.humidity).toBeLessThan(0.25);
    if (kind === 'downpour') expect(cell.rain).toBeGreaterThan(35);
    if (kind === 'hail') expect(cell.rain).toBeGreaterThan(15);
    if (kind === 'gust') expect(Math.hypot(cell.u, cell.v)).toBeGreaterThan(25);
    const wind = totalWind(state, cell.lon, cell.lat);
    expect(cell.u).toBeCloseTo(wind.u, 5);
    expect(cell.v).toBeCloseTo(wind.v, 5);
    const hazards = state.weatherHazards;
    state.weatherHazards = [];
    const backgroundPressure = totalPressure(state, cell.lon, cell.lat);
    state.weatherHazards = hazards;
    expect((cell.pressure - backgroundPressure) * PRESSURE_SIGN[kind]).toBeGreaterThan(0.5);
    // The map, point readout and pressure query must agree, including the circulation outside
    // the rain/temperature footprint (the pressure system has a wider, smooth envelope).
    for (const lon of [123, 125, 127, 129, 131]) {
      const flank = state.grid[gridIndex(lon, 37)], flow = totalWind(state, lon, 37);
      expect(flank.pressure).toBeCloseTo(totalPressure(state, lon, 37), 6);
      expect(flank.pressure).toBeCloseTo(sampleEnvironment(state, lon, 37).pressure, 6);
      expect(flank.u).toBeCloseTo(flow.u, 6);
      expect(flank.v).toBeCloseTo(flow.v, 6);
    }
    expect(hazardDamageRatio(hazard, { lon: -50, lat: -30 })).toBe(0);
    const news: Omit<NewsItem, 'hour'>[] = [];
    stepWeatherHazards(state, hazard.durationHours, () => cell, item => news.push(item));
    expect(state.weatherHazards).toHaveLength(0);
    expect(totalPressure(state, cell.lon, cell.lat)).toBeCloseTo(backgroundPressure, 6);
    expect(news).toHaveLength(1);
    expect(news[0].title).toContain('subsides');
    stepWeatherHazards(state, 1, () => cell, item => news.push(item));
    expect(news).toHaveLength(1);
  });

  it.each(WEATHER_HAZARD_KINDS)('moves and fades the %s pressure field with its event', kind => {
    const state = createGame(17, 213);
    const definition = WEATHER_HAZARDS[kind];
    state.weatherHazards.push({ id: 999, kind, lon: 127, lat: 37, radiusKm: definition.radiusKm,
      ageHours: definition.durationHours / 2, durationHours: definition.durationHours, intensity: 1, directionRad: 0 });
    const hazard = state.weatherHazards[0];
    const anomaly = (lon: number, lat: number) => {
      const pressure = totalPressure(state, lon, lat);
      state.weatherHazards = [];
      const background = totalPressure(state, lon, lat);
      state.weatherHazards = [hazard];
      return Math.abs(pressure - background);
    };
    const mature = anomaly(127, 37);
    expect(mature).toBeGreaterThan(3);
    if (definition.moves) {
      const startLon = hazard.lon;
      stepWeatherHazards(state, 0.1, () => ({ ...state.grid[gridIndex(127, 37)], u: 20, v: 0 }), () => {});
      expect(hazard.lon).toBeGreaterThan(startLon);
      expect(anomaly(hazard.lon, hazard.lat)).toBeGreaterThan(anomaly(127, 37));
    }
    hazard.ageHours = 0.9 * hazard.durationHours;
    stepWeatherHazards(state, 0, () => state.grid[0], () => {});
    const faded = anomaly(hazard.lon, hazard.lat);
    expect(faded).toBeGreaterThan(0);
    expect(faded).toBeLessThan(mature * 0.6);
    hazard.ageHours = hazard.durationHours;
    stepGame(state);
    expect(state.weatherHazards).toHaveLength(0);
    expect(state.grid[gridIndex(127, 37)].pressure).toBeCloseTo(totalPressure(state, 127, 37), 6);
  });

  it('adds event pressure consistently above live and historic background fields', () => {
    const weather: LiveWeatherSnapshot = { source: 'NOAA GFS', modelRun: '2026-10-27T00:00:00.000Z',
      pressure: Array(16200).fill(1005), u: Array(16200).fill(5), v: Array(16200).fill(-2) };
    setHistoricEnvironment('maemi-2003', fixtureJson as unknown as HistoricEnvironment);
    try {
      for (const initial of [undefined, weather]) for (const historic of [false, true]) {
        const state = createGame(17, 213, initial);
        if (historic) expect(loadHistoric(state, 'maemi-2003').ok).toBe(true);
        placeFormation(state, 'heatwave', 129, 33);
        advance(state, 29);
        expect(state.weatherHazards).toHaveLength(1);
        for (const lon of [127, 129, 131]) {
          const cell = state.grid[gridIndex(lon, 33)], wind = totalWind(state, lon, 33);
          expect(cell.pressure).toBeCloseTo(totalPressure(state, lon, 33), 6);
          // The environment readout excludes typhoon vortices, but must include the same event anomaly.
          const environmentPressure = sampleEnvironment(state, lon, 33).pressure;
          const hazards = state.weatherHazards;
          state.weatherHazards = [];
          const change = cell.pressure - totalPressure(state, lon, 33);
          expect(change).toBeGreaterThan(0);
          expect(environmentPressure - sampleEnvironment(state, lon, 33).pressure).toBeCloseTo(change, 6);
          state.weatherHazards = hazards;
          expect(cell.u).toBeCloseTo(wind.u, 6); expect(cell.v).toBeCloseTo(wind.v, 6);
        }
      }
    } finally { setHistoricEnvironment('maemi-2003', null); }
  });

  it('rejects land-only phenomena over water without recording partial placements', () => {
    const state = createGame(17);
    for (const kind of ['drought', 'dust'] as const) {
      expect(weatherHazardRecipe(state, kind, 140, 16).ok).toBe(false);
      expect(placeFormation(state, kind, 140, 16).ok).toBe(false);
    }
    expect(state.actions).toHaveLength(0);
    expect(state.effects).toHaveLength(0);
  });

  it('replays simultaneous phenomena, fields, damage and bulletins deterministically', () => {
    const state = createGame(17, 213);
    for (const kind of WEATHER_HAZARD_KINDS) expect(placeFormation(state, kind, 127, 37).ok).toBe(true);
    advance(state, 29);
    expect(state.weatherHazards).toHaveLength(7);
    expect(validateActions(state.actions, state.tick).ok).toBe(true);
    const replay = replayGame(state.seed, state.actions, state.tick, state.initialStartDayOfYear);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.state.weatherHazards).toEqual(state.weatherHazards);
    expect(replay.state.disasters).toEqual(state.disasters);
    expect(replay.state.grid).toEqual(state.grid);
    expect(replay.state.cities).toEqual(state.cities);
    expect(replay.state.news).toEqual(state.news);
  });

  it('uses heat damage headlines without claiming a flood or gale', () => {
    const state = createGame(17, 213);
    placeFormation(state, 'heatwave', 127, 37);
    advance(state, 36);
    const bulletins = state.news.filter(item => item.phenomenon === 'heatwave' && item.damage);
    expect(bulletins.length).toBeGreaterThan(0);
    expect(bulletins.every(item => item.title.includes('Heatwave damage') && item.damage!.lossUsd > 0 && !item.text.includes('Flooding'))).toBe(true);
    expect(state.news.some(item => item.title.startsWith('Gales reach'))).toBe(false);
  });
});
