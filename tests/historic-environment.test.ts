import { afterEach, describe, expect, it } from 'vitest';
import type { GameState, HistoricEnvironment } from '../src/types';
import { TICKS_PER_HOUR, createGame, gridIndex, isLand, loadHistoric, placeTool, replayGame, sampleEnvironment, setHistoricEnvironment, stepGame, totalWind } from '../src/simulation/engine';
import { sampleHistoric } from '../src/simulation/historic';
import fixtureJson from './fixtures/environment-fixture.json';

// 3×3 cells at 127/129/131°E, 31/33/35°N; days 4-6 Sep 2003 (Maemi starts 2003-09-04T00Z); sea-level pressure 990/1000/1010 by day; the SW cell has no SST.
const fixture = fixtureJson as unknown as HistoricEnvironment;
// The same window 20 hPa higher, registered for a second typhoon so the two environments can be told apart.
const shifted: HistoricEnvironment = { ...fixture, typhoonId: 'sarah-1959', fields: { ...fixture.fields, slp: fixture.fields.slp.map(d => d.map(x => (x === null ? null : x + 200))) } };
const ID = 'maemi-2003';
const START = 10; // hour at which the typhoon is loaded into the running world
const stepTo = (state: GameState, hours: number) => { while (state.hours < hours - 1e-9) stepGame(state); };
const pressureCell = gridIndex(129, 33);
/** A running sandbox at hour 10 with Maemi loaded. */
function world(seed = 1): GameState {
  const s = createGame(seed);
  stepTo(s, START);
  expect(loadHistoric(s, ID).ok).toBe(true);
  return s;
}

afterEach(() => { for (const id of [ID, 'sarah-1959', 'tip-1979']) setHistoricEnvironment(id, null); });

describe('historic typhoons: environment', () => {
  it('reports missing and keeps the fictional climate without a dataset', () => {
    const plain = createGame(1);
    stepTo(plain, START);
    const s = world();
    expect(s.historic[0].environment).toBe('missing');
    expect(s.news.at(-1)!.text).toContain('base climate');
    expect(s.grid[pressureCell].pressure).toBe(plain.grid[pressureCell].pressure);
  });

  it('writes the recorded sea, air, humidity, pressure and wind into the window cells from the load on', () => {
    setHistoricEnvironment(ID, fixture);
    const s = createGame(1);
    stepTo(s, START);
    expect(s.grid[pressureCell].pressure).not.toBeCloseTo(990, 1); // nothing recorded before the load
    expect(loadHistoric(s, ID).ok).toBe(true);
    expect(s.historic[0].environment).toBe('loaded');
    expect(s.news.at(-1)!.text).toContain('NCEP/NCAR Reanalysis 1 and ERSST v5');
    expect(JSON.parse(JSON.stringify(s)).historic[0].environment).toBe('loaded'); // the dataset itself is not on the state
    expect(JSON.stringify(s)).not.toContain('"fields"');
    const c = s.grid[pressureCell];
    expect(c.temperature).toBeCloseTo(29, 6);
    expect(c.airTemperature).toBeCloseTo(27, 6);
    expect(c.humidity).toBeCloseTo(0.8, 6);
    expect(c.pressure).toBeCloseTo(990, 6);
    expect(c.u).toBeCloseTo(5, 6);
    expect(c.v).toBeCloseTo(-2, 6);
  });

  it('interpolates linearly between 12Z daily values, counted from the load, and agrees with sampleEnvironment', () => {
    setHistoricEnvironment(ID, fixture);
    const s = world();
    const k = pressureCell;
    const at0 = sampleEnvironment(s, 129, 33);
    expect(at0).toMatchObject({ temperature: expect.closeTo(29, 6), airTemperature: expect.closeTo(27, 6), humidity: expect.closeTo(0.8, 6), pressure: expect.closeTo(990, 6), u: expect.closeTo(5, 6), v: expect.closeTo(-2, 6) });
    stepTo(s, START + 12); // daily means are valid at 12:00 UTC: before the first 12Z the first day is held
    expect(s.grid[k].pressure).toBeCloseTo(990, 6);
    expect(sampleEnvironment(s, 129, 33).pressure).toBeCloseTo(990, 6);
    stepTo(s, START + 24); // halfway between the 12Z values of days 1 and 2
    expect(s.tick).toBe((START + 24) * TICKS_PER_HOUR);
    expect(s.grid[k].pressure).toBeCloseTo(995, 6);
    const at24 = sampleEnvironment(s, 129, 33);
    expect(at24.pressure).toBeCloseTo(995, 6);
    expect(at24.temperature).toBeCloseTo(s.grid[k].temperature, 6);
    expect(at24.humidity).toBeCloseTo(s.grid[k].humidity, 6);
    expect(at24.u).toBeCloseTo(s.grid[k].u, 6);
    expect(at24.airTemperature).toBeCloseTo(s.grid[k].airTemperature, 6);
    stepTo(s, START + 36);
    expect(s.grid[k].pressure).toBeCloseTo(1000, 6);
    stepTo(s, START + 60); // from the last 12Z on: held at the final day
    expect(s.grid[k].pressure).toBeCloseTo(1010, 6);
  });

  it('does not reduce a recorded land wind by the land factor, only the model-made part', () => {
    const land = [127, 129, 131].flatMap(lon => [31, 33, 35].map(lat => ({ lon, lat }))).find(c => isLand(c.lon, c.lat))!;
    expect(land).toBeDefined();
    const k = gridIndex(land.lon, land.lat);
    const fictional = world();
    setHistoricEnvironment(ID, fixture);
    const s = world();
    expect(s.grid[k].u).toBeCloseTo(5, 6); // recorded wind, factor not applied
    expect(s.grid[k].v).toBeCloseTo(-2, 6);
    expect(totalWind(s, s.grid[k].lon, s.grid[k].lat).u).toBeCloseTo(5, 6);
    const [fu, fv] = [fictional.grid[k].u, fictional.grid[k].v];
    const low = [land.lon + 3, land.lat];
    for (const w of [fictional, s]) { expect(placeTool(w, 'low', low[0], low[1]).ok).toBe(true); stepTo(w, w.hours + 12); } // the Low ramps up
    const du = s.grid[k].u - 5;
    const dv = s.grid[k].v + 2;
    expect(Math.hypot(du, dv)).toBeGreaterThan(0.5);
    // the Low's own wind is reduced exactly as without a recording
    expect(du).toBeCloseTo(fictional.grid[k].u - fu, 6);
    expect(dv).toBeCloseTo(fictional.grid[k].v - fv, 6);
    const w = totalWind(s, s.grid[k].lon, s.grid[k].lat);
    expect(w.u).toBeCloseTo(s.grid[k].u, 9);
    expect(w.v).toBeCloseTo(s.grid[k].v, 9);
  });

  it('samples bilinearly and wraps longitude', () => {
    const day0 = '2003-09-04T00:00:00Z';
    expect(sampleHistoric(fixture, 0, day0, 130, 34)!.p).toBeCloseTo(990, 6);
    const ramp = { ...fixture, fields: { ...fixture.fields, u: fixture.fields.u.map(d => d.map((_, i) => (i % 3) * 100)) } }; // u = 0, 1, 2 m/s by column
    expect(sampleHistoric(ramp, 0, day0, 130, 33)!.u).toBeCloseTo(1.5, 6);
    expect(sampleHistoric(fixture, 0, day0, 129 - 360, 33)!.p).toBeCloseTo(990, 6);
    expect(sampleHistoric(fixture, 0, day0, 140, 33)).toBeNull();
    expect(sampleHistoric(fixture, 0, day0, 129, 50)).toBeNull();
  });

  it('keeps the fictional climate outside the window and where SST is missing', () => {
    const fictional = world();
    setHistoricEnvironment(ID, fixture);
    const s = world();
    const inside = new Set([127, 129, 131].flatMap(lon => [31, 33, 35].map(lat => gridIndex(lon, lat))));
    for (let k = 0; k < s.grid.length; k++) {
      if (inside.has(k)) continue;
      const a = s.grid[k];
      const b = fictional.grid[k];
      expect([a.temperature, a.airTemperature, a.humidity, a.pressure, a.u, a.v]).toEqual([b.temperature, b.airTemperature, b.humidity, b.pressure, b.u, b.v]);
    }
    const nullSst = gridIndex(127, 31);
    expect(s.grid[nullSst].temperature).toBe(fictional.grid[nullSst].temperature);
    expect(s.grid[nullSst].pressure).toBeCloseTo(990, 6);
    expect(sampleEnvironment(s, 128, 32).temperature).toBeGreaterThan(0);
    expect(sampleEnvironment(s, 80, 0)).toEqual(sampleEnvironment(fictional, 80, 0));
  });

  it('follows the most recently loaded typhoon that is still running and has data', () => {
    setHistoricEnvironment(ID, fixture);
    setHistoricEnvironment('sarah-1959', shifted);
    const plain = createGame(1);
    const s = world();
    expect(s.grid[pressureCell].pressure).toBeCloseTo(990, 6);
    expect(loadHistoric(s, 'sarah-1959').ok).toBe(true);
    expect(s.grid[pressureCell].pressure).toBeCloseTo(1010, 6);
    expect(sampleEnvironment(s, 129, 33).pressure).toBeCloseTo(1010, 6);
    expect(loadHistoric(s, 'tip-1979').ok).toBe(true); // no dataset: does not take over
    expect(s.historic.map(h => h.environment)).toEqual(['loaded', 'loaded', 'missing']);
    stepGame(s);
    expect(s.grid[pressureCell].pressure).toBeCloseTo(1010, 6);
    s.historic[1].finished = true; // the latest dataset's record ended: the earlier load's environment is back
    stepGame(s);
    expect(s.grid[pressureCell].pressure).toBeCloseTo(990, 6);
    s.historic[0].finished = true; // nothing active any more: the fictional climate returns
    stepGame(s);
    expect(s.grid[pressureCell].pressure).toBeCloseTo(plain.grid[pressureCell].pressure, 6);
  });

  it('replays to the same storm archive and grid with the dataset loaded', () => {
    setHistoricEnvironment(ID, fixture);
    const live = world(7);
    const until = (START + 40) * TICKS_PER_HOUR;
    while (live.tick < until) stepGame(live);
    const result = replayGame(7, live.actions, until);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.historic[0].environment).toBe('loaded');
    expect(result.state.stormArchive).toEqual(live.stormArchive);
    expect(result.state.grid).toEqual(live.grid);
  });
});
