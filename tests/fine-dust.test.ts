import { describe, expect, it } from 'vitest';
import { GRID_COLS, GRID_ROWS, createGame, gridIndex, placeFormation, replayGame, stepGame, weatherHazardRecipe } from '../src/simulation/engine';
import { PM25_CAP, fineDustEmission, pm25Band, stepFineDust } from '../src/simulation/fine-dust';
import type { GameState } from '../src/types';
import { MEASURE_BY_ID, ProbeBook, pm25At } from '../src/ui/measure';

interface Air { u?: number; v?: number; rain?: number; humidity?: number; instability?: number; pressure?: number }
const BEIJING = { lon: 117, lat: 39 }, SEOUL = { lon: 127, lat: 37 };

/** A world with uniform, hand-set air and one fine-dust event; the tracer is stepped on its own so only the named cause varies. */
function world(air: Air, at = { lon: 118, lat: 36 }): GameState {
  const state = createGame(17, 213);
  for (const c of state.grid) {
    c.u = air.u ?? 0; c.v = air.v ?? 0; c.rain = air.rain ?? 0; c.humidity = air.humidity ?? 0.4; c.instability = air.instability ?? 0; c.pressure = air.pressure ?? 1013;
  }
  state.weatherHazards.push({ id: 1, kind: 'finedust', lon: at.lon, lat: at.lat, radiusKm: 600, ageHours: 24, durationHours: 96, intensity: 1, directionRad: 0 });
  return state;
}
const run = (state: GameState, hours: number, dt = 0.25) => { for (let i = 0; i < hours / dt; i++) stepFineDust(state, dt, GRID_COLS, GRID_ROWS); return state; };
const mass = (state: GameState) => state.grid.reduce((sum, c) => sum + c.pm25, 0);
const peak = (state: GameState) => Math.max(...state.grid.map(c => c.pm25));
/** Concentration-weighted mean longitude, relative to the source so the dateline never matters here. */
const centroidLon = (state: GameState) => { let m = 0, x = 0; for (const c of state.grid) { m += c.pm25; x += c.pm25 * c.lon; } return x / m; };
const at = (state: GameState, p: { lon: number; lat: number }) => state.grid[gridIndex(p.lon, p.lat)].pm25;

describe('fine dust tracer', () => {
  it('does nothing and keeps no state when no event exists', () => {
    const state = createGame(17, 213);
    stepFineDust(state, 0.25, GRID_COLS, GRID_ROWS);
    expect(state.fineDustRows).toBeUndefined();
    expect(mass(state)).toBe(0);
  });

  it('drifts downwind: the centroid follows the wind, East China to Korea to Japan under westerlies', () => {
    const state = world({ u: 10 }, { lon: 118, lat: 36 });
    run(state, 24);
    const day1 = centroidLon(state);
    expect(day1).toBeGreaterThan(118 + 2);
    expect(at(state, { lon: 127, lat: 36 })).toBeGreaterThan(5); // Korea
    run(state, 24);
    const day2 = centroidLon(state);
    expect(day2).toBeGreaterThan(day1 + 0.5);
    run(state, 24);
    expect(at(state, { lon: 139, lat: 36 })).toBeGreaterThan(5); // Japan
    const east = world({ u: -10 }, { lon: 118, lat: 36 });
    expect(centroidLon(run(east, 24))).toBeLessThan(118 - 2); // an easterly carries it the other way
    const north = world({ v: 10 }, { lon: 118, lat: 36 });
    let lat = 0, m = 0; run(north, 24); for (const c of north.grid) { lat += c.pm25 * c.lat; m += c.pm25; }
    expect(lat / m).toBeGreaterThan(36 + 1);
  });

  it('builds up in stagnation and is cleared by rain, strong wind and unstable air (opposite causes, opposite effects)', () => {
    const calm = mass(run(world({ u: 1 }), 48));
    const stagnant = mass(run(world({ u: 1, pressure: 1030, instability: -1.5, humidity: 0.2 }), 48));
    const stormy = mass(run(world({ u: 1, pressure: 1000, instability: 2 }), 48));
    expect(stagnant).toBeGreaterThan(calm * 1.4);
    expect(stormy).toBeLessThan(calm * 0.6);
    const rainy = mass(run(world({ u: 1, rain: 15 }), 48));
    expect(rainy).toBeLessThan(calm * 0.3);
    const windy = peak(run(world({ u: 25 }), 48));
    expect(windy).toBeLessThan(peak(run(world({ u: 1 }), 48)) * 0.4);
    const dry = mass(run(world({ u: 1, humidity: 0.1 }), 48)), wet = mass(run(world({ u: 1, humidity: 0.95 }), 48));
    expect(dry).toBeGreaterThan(wet);
    // High pressure alone (a shallow mixing layer) and a stable layer alone each raise it.
    expect(mass(run(world({ u: 1, pressure: 1030 }), 48))).toBeGreaterThan(calm);
    expect(mass(run(world({ u: 1, instability: -1.5 }), 48))).toBeGreaterThan(calm);
  });

  it('washes out an existing plume when rain arrives', () => {
    const state = run(world({ u: 1 }), 24);
    const before = mass(state);
    state.weatherHazards = [];
    for (const c of state.grid) c.rain = 20;
    run(state, 12);
    expect(mass(state)).toBeLessThan(before * 0.2);
  });

  it('scales the emission with the people living there', () => {
    expect(fineDustEmission(0)).toBe(0);
    expect(fineDustEmission(2e7)).toBeGreaterThan(10 * fineDustEmission(2e5));
    const city = run(world({ u: 1 }, BEIJING), 24), rural = run(world({ u: 1 }, { lon: 100, lat: 61 }), 24);
    expect(mass(city)).toBeGreaterThan(8 * mass(rural));
    const sea = run(world({ u: 1 }, { lon: 151, lat: 31 }), 24);
    expect(mass(sea)).toBeLessThan(mass(city) * 0.2);
  });

  it('stays bounded, non-negative and finite at any wind, step and for a long run', () => {
    for (const [dt, speed] of [[0.25, 80], [1, 80], [6, 120], [0.25, 3]] as const) {
      const state = world({ u: speed, v: -speed / 3, humidity: 0.1, pressure: 1040, instability: -2 }, SEOUL);
      state.grid.forEach((c, k) => { c.u = speed * Math.sin(k); c.v = speed * Math.cos(k * 3); });
      run(state, 400 * dt, dt);
      for (const c of state.grid) { expect(Number.isFinite(c.pm25)).toBe(true); expect(c.pm25).toBeGreaterThanOrEqual(0); expect(c.pm25).toBeLessThanOrEqual(PM25_CAP); }
    }
    const steady = world({ u: 2 }, BEIJING);
    run(steady, 600);
    const m1 = mass(steady); run(steady, 100);
    expect(mass(steady) / m1).toBeLessThan(1.1); // a balance of source and loss, not unbounded growth
  });

  it('clears itself once the event ends, and a clean world drops its state', () => {
    const state = run(world({ u: 3, rain: 3, humidity: 0.8 }), 12);
    state.weatherHazards = [];
    expect(state.fineDustRows).toBeDefined();
    run(state, 24 * 30);
    expect(mass(state)).toBe(0);
    expect(state.fineDustRows).toBeUndefined();
  });

  it('wraps across the dateline', () => {
    const state = world({ u: 10 }, { lon: 175, lat: 35 });
    state.grid[gridIndex(175, 35)].population = 1e7; // open water emits nothing
    run(state, 30);
    expect(at(state, { lon: -179, lat: 35 })).toBeGreaterThan(0.5);
  });

  it('names PM2.5 by EPA band', () => {
    expect([5, 20, 80, 200, 300].map(pm25Band)).toEqual(['good air', 'moderate air', 'unhealthy air', 'very unhealthy air', 'hazardous air']);
  });

  it('costs well under half a millisecond per step', () => {
    const state = world({ u: 8, v: 2 }, BEIJING);
    state.grid.forEach(c => { c.pressure = 1020; });
    run(state, 60);
    const steps = 400, began = performance.now();
    for (let i = 0; i < steps; i++) stepFineDust(state, 0.25, GRID_COLS, GRID_ROWS);
    const ms = (performance.now() - began) / steps;
    console.log(`fine dust tracer: ${ms.toFixed(3)} ms per step (rows ${state.fineDustRows})`);
    expect(ms).toBeLessThan(0.5);
  });
});

describe('fine dust as a game event', () => {
  it('needs a populated area, a high and stable air, and starts after six hours', () => {
    const state = createGame(17, 213);
    const guide = weatherHazardRecipe(state, 'finedust', SEOUL.lon, SEOUL.lat);
    expect(guide.ok).toBe(true);
    expect(guide.placements).toContain('high');
    expect(guide.placements).toContain('stable-air');
    expect(guide.projected).toBeGreaterThan(guide.potential);
    expect(weatherHazardRecipe(state, 'finedust', 151, 31).ok).toBe(false);
    expect(placeFormation(state, 'finedust', 151, 31).ok).toBe(false);
    expect(placeFormation(state, 'finedust', SEOUL.lon, SEOUL.lat)).toEqual({ ok: true });
    for (let i = 0; i < 23; i++) stepGame(state);
    expect(state.weatherHazards).toHaveLength(0);
  });

  it('is a health event: bands, news with city names, no deaths, no homes lost, deterministic replay', () => {
    const state = createGame(17, 213);
    expect(placeFormation(state, 'finedust', BEIJING.lon, BEIJING.lat)).toEqual({ ok: true });
    for (let i = 0; i < 24 * 4 * 2; i++) stepGame(state);
    expect(state.weatherHazards.some(h => h.kind === 'finedust')).toBe(true);
    expect(peak(state)).toBeGreaterThan(35.5);
    const record = state.disasters!.find(r => r.kind === 'finedust')!;
    expect(record.damageScore).toBeGreaterThan(0);
    const news = state.news.filter(n => n.phenomenon === 'finedust' && n.kind === 'city');
    console.log('fine dust news:', news.map(n => n.title).join(' | '), `peak ${peak(state).toFixed(0)} µg/m³`);
    expect(news.length).toBeGreaterThan(0);
    for (const n of news) { expect(n.title).toMatch(/^Fine dust: (unhealthy|very unhealthy|hazardous) air in /); expect(n.damage!.deaths).toBe(0); expect(n.damage!.floodedHomes).toBe(0); }
    const replay = replayGame(state.seed, state.actions, state.tick, state.initialStartDayOfYear);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.state.grid.map(c => c.pm25)).toEqual(state.grid.map(c => c.pm25));
    expect(replay.state.fineDustRows).toEqual(state.fineDustRows);
    expect(replay.state.score).toBe(state.score);
  });
});

describe('fine dust in the Measure tab', () => {
  it('reads the concentration at a pin, 0 where there is none, with the four band lines', () => {
    const item = MEASURE_BY_ID.get('measure-fine-dust')!;
    expect(item.key).toBe('');
    expect(item.plots).toHaveLength(1);
    expect(item.plots[0].unit).toBe('µg/m³');
    expect(item.plots[0].guides!.map(g => g.value)).toEqual([12, 35.5, 150.5, 250.5]);
    const state = world({ u: 4 }, BEIJING);
    expect(pm25At(state, 117, 39)).toBe(0); // no field yet
    run(state, 24);
    const book = new ProbeBook();
    expect(book.add('measure-fine-dust', 117, 39).ok).toBe(true);
    expect(book.add('measure-fine-dust', -60, -40).ok).toBe(true);
    book.sample(state);
    expect(book.latest('measure-fine-dust', 0, 1)).toBeGreaterThan(20);
    expect(book.latest('measure-fine-dust', 0, 2)).toBe(0);
    expect(pm25At(state, 117, 39)).toBeCloseTo(state.grid[gridIndex(117, 39)].pm25, 0);
  });
});
