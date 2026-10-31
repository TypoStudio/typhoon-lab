import { describe, expect, it } from 'vitest';
import type { Effect, GameState, Storm, ToolType } from '../src/types';
import { CITIES, SCENARIO } from '../src/data/world';
import {
  GENESIS_HOURS, GRID_COLS, LAND_WIND_FACTOR, GRID_ROWS, MAX_ACTIVE_EFFECTS, REPLAY_MAX_ACTIONS, REPLAY_MAX_TICKS,
  SIMULATION_VERSION, STEP_HOURS, TOOLS, blizzardDamageRatio, createGame, damageRatio, genesisPotential, gridIndex, intensityTendency,
  potentialIntensity, pressureDeficit, stageFor, stageRank,
  isLand, outerRadiusKm, placeTool, replayGame, sampleEnvironment, setClimate, steeringFlow, stepGame, totalPressure, totalWind,
  validateActions,
} from '../src/simulation/engine';
import { distanceKm, moveKm } from '../src/simulation/geo';

const GENESIS: ToolType[] = ['warm', 'moisture', 'low'];
const WPAC: [number, number] = [140, 16];
const ATLANTIC: [number, number] = [-55, 16];
const SOUTH_INDIAN: [number, number] = [90, -12];

function seedSite(s: GameState, [lon, lat]: [number, number], tools: ToolType[] = GENESIS): void {
  for (const t of tools) expect(placeTool(s, t, lon, lat)).toEqual({ ok: true });
}
function runHours(s: GameState, hours: number, each?: () => void): void {
  const until = s.tick + Math.round(hours / STEP_HOURS);
  while (s.tick < until) { stepGame(s); each?.(); }
}
function runUntil(s: GameState, done: () => boolean, maxHours: number): boolean {
  const until = s.tick + Math.round(maxHours / STEP_HOURS);
  while (s.tick < until) { if (done()) return true; stepGame(s); }
  return done();
}
/** Hours until the first storm forms, or Infinity within maxHours. */
function genesisHours(sites: [number, number][], tools: ToolType[] = GENESIS, maxHours = 72, extra?: (s: GameState) => void): number {
  const s = createGame();
  for (const site of sites) seedSite(s, site, tools);
  extra?.(s);
  return runUntil(s, () => s.storms.length > 0, maxHours) ? s.hours : Infinity;
}
/** A fully ramped-in synthetic effect, independent of placement rules. */
function effect(type: ToolType, lon: number, lat: number, radiusKm = 800): Effect {
  return { id: 999, type, lon, lat, radiusKm, remainingHours: 24, ageHours: 24 };
}
/** Storm-relative surface wind (storm vortex only) at an offset from the storm centre. */
function vortexAt(s: GameState, st: Storm, eastKm: number, northKm: number) {
  const p = moveKm(st.lon, st.lat, eastKm, northKm);
  const w = totalWind(s, p.lon, p.lat);
  const env = sampleEnvironment(s, p.lon, p.lat);
  return { u: w.u - env.u, v: w.v - env.v };
}
function expectPressuresSynced(s: GameState): void {
  for (const st of s.storms) expect(totalPressure(s, st.lon, st.lat)).toBeCloseTo(st.pressure, 9);
}

describe('empty, endless world', () => {
  it('starts with no storms, candidates, effects or budget fields', () => {
    const s = createGame();
    expect(s).toMatchObject({ tick: 0, hours: 0, phase: 'seeding', storms: [], candidates: [], effects: [], actions: [], score: 0, version: SIMULATION_VERSION });
    expect(s.grid).toHaveLength(GRID_COLS * GRID_ROWS);
    expect(GRID_COLS * GRID_ROWS).toBe(180 * 90);
    for (const key of ['resources', 'endReason', 'storm', 'track', 'forecast']) expect(key in s).toBe(false);
  });

  it('never forms a storm unassisted, and time keeps running past the old 168 h deadline', () => {
    for (const seed of [SCENARIO.seed, 1, 0xffffffff]) {
      const s = createGame(seed);
      runHours(s, 200, () => { expect(s.storms).toEqual([]); expect(s.candidates).toEqual([]); });
      expect(s.hours).toBe(200);
      expect(s.phase).toBe('seeding');
    }
  }, 90_000);
});

describe('genesis', () => {
  it('overlapping warm + moisture + low over tropical ocean forms a depression after a delay', () => {
    const s = createGame();
    seedSite(s, WPAC);
    let firstProgress = Infinity;
    runUntil(s, () => {
      if (s.candidates.length && firstProgress === Infinity) firstProgress = s.hours;
      return s.storms.length > 0;
    }, 72);
    expect(s.storms).toHaveLength(1);
    expect(firstProgress).toBeLessThan(s.hours);
    expect(s.hours).toBeGreaterThanOrEqual(GENESIS_HOURS / 1.5); // progress accrues at most 1.5 h per hour
    expect(s.hours).toBeLessThan(36);
    expect(s.phase).toBe('active');
    const st = s.storms[0];
    expect(st.stage).toBe('Tropical Depression');
    expect(s.peakWind).toBeGreaterThanOrEqual(st.wind); // global peak includes the new depression at once
    expect(distanceKm(st.lon, st.lat, ...WPAC)).toBeLessThan(150);
    expect(s.effects.some(e => e.type === 'low')).toBe(false); // the low became the storm
    expect(s.news.some(n => n.kind === 'formation')).toBe(true);
  });

  it('wrong or partial conditions do not form a storm', () => {
    expect(genesisHours([WPAC], ['low'])).toBe(Infinity); // spin without moisture
    expect(genesisHours([WPAC], ['warm', 'moisture'])).toBe(Infinity); // no disturbance
    expect(genesisHours([[-150, 45]])).toBe(Infinity); // cold water
    expect(genesisHours([[20, 10]], ['moisture', 'low'])).toBe(Infinity); // over Africa
  });

  it('forms a storm on the equator, which stays finite', () => {
    const s = createGame(1);
    seedSite(s, [150, 1.0], ['warm', 'moisture', 'low']);
    for (let tick = 0; tick < 400 && !s.storms.length; tick++) stepGame(s);
    expect(s.storms.length).toBeGreaterThan(0);
    for (let tick = 0; tick < 200; tick++) {
      stepGame(s);
      for (const st of s.storms) for (const v of [st.lon, st.lat, st.wind, st.pressure, st.radiusKm]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('each ingredient speeds genesis; ingredients must overlap', () => {
    const all = genesisHours([WPAC]);
    const ml = genesisHours([WPAC], ['moisture', 'low']);
    expect(all).toBeLessThan(ml);
    expect(ml).toBeLessThan(Infinity);
    // Warm water 2000 km away does not help.
    const apart = genesisHours([WPAC], ['moisture', 'low'], 72, s => placeTool(s, 'warm', 160, 16));
    expect(apart).toBe(ml);
  });

  it('works away from the Pacific: Atlantic and south Indian Ocean sites', () => {
    expect(genesisHours([ATLANTIC])).toBeLessThan(36);
    expect(genesisHours([SOUTH_INDIAN])).toBeLessThan(36);
  });

  it('each low in an overlapping patch forms its own storm, including simultaneous completions', () => {
    const s = createGame();
    seedSite(s, WPAC, ['warm', 'moisture', 'low', 'low', 'low']);
    placeTool(s, 'low', WPAC[0] + 1, WPAC[1] + 1);
    const lowIds = s.effects.filter(e => e.type === 'low').map(e => e.id);
    runHours(s, 4);
    expect(s.candidates.map(c => c.id)).toEqual(lowIds);
    expect(s.candidates.every(c => c.progressHours > 0)).toBe(true);
    expect(runUntil(s, () => s.storms.length === 4, 36)).toBe(true);
    expect(s.storms.map(st => st.id)).toEqual([1, 2, 3, 4]);
    expect(s.candidates).toEqual([]);
    expect(s.effects.filter(e => e.type === 'low')).toHaveLength(0);
    expect(s.news.filter(n => n.kind === 'formation')).toHaveLength(4);
    expectPressuresSynced(s);
    runHours(s, 8);
    expect(s.news.filter(n => n.kind === 'formation')).toHaveLength(4);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state).toEqual(s);
  });

  it('nearby staggered lows retain progress when the first storm forms', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runHours(s, 4);
    expect(placeTool(s, 'low', 141, 16)).toEqual({ ok: true });
    const secondId = s.effects[s.effects.length - 1].id;
    let previousProgress = 0;
    while (!s.storms.length && s.hours < 36) {
      previousProgress = s.candidates.find(c => c.id === secondId)?.progressHours ?? 0;
      stepGame(s);
    }
    expect(s.storms).toHaveLength(1);
    expect(distanceKm(s.storms[0].lon, s.storms[0].lat, 141, 16)).toBeLessThan(600);
    expect(s.candidates.find(c => c.id === secondId)!.progressHours).toBeGreaterThan(previousProgress);
    expect(s.effects.some(e => e.id === secondId)).toBe(true);
    expect(runUntil(s, () => s.storms.length === 2, 24)).toBe(true);
    expect(s.storms.map(st => st.id)).toEqual([1, 2]);
    expect(s.effects.some(e => e.id === secondId)).toBe(false);
  });

  it('a newly placed low can form near an existing storm', () => {
    const s = createGame();
    seedSite(s, WPAC);
    expect(runUntil(s, () => s.storms.length > 0, 36)).toBe(true);
    expect(placeTool(s, 'low', 141, 16)).toEqual({ ok: true });
    const secondId = s.effects[s.effects.length - 1].id;
    expect(distanceKm(s.storms[0].lon, s.storms[0].lat, 141, 16)).toBeLessThan(600);
    runHours(s, 2);
    expect(s.candidates.some(c => c.id === secondId && c.progressHours > 0)).toBe(true);
    expect(runUntil(s, () => s.storms.length === 2, 36)).toBe(true);
    expect(s.storms.map(st => st.id)).toEqual([1, 2]);
  });

  it('separated sites still make independent storms across basins', () => {
    const m = createGame();
    seedSite(m, WPAC);
    seedSite(m, ATLANTIC);
    seedSite(m, SOUTH_INDIAN);
    runHours(m, 36);
    expect(m.storms).toHaveLength(3);
    expect(new Set(m.storms.map(x => x.id)).size).toBe(3);
    for (const a of m.storms) for (const b of m.storms) if (a !== b) expect(distanceKm(a.lon, a.lat, b.lon, b.lat)).toBeGreaterThan(600);
  });
});

describe('storm lifecycle', () => {
  it('a depression grows in wind and visible size into a typhoon, with per-storm track and forecast', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0, 72);
    const st = s.storms[0];
    const samples: { wind: number; gale: number; outer: number }[] = [];
    for (let k = 0; k < 4; k++) { samples.push({ wind: st.wind, gale: st.galeRadiusKm, outer: outerRadiusKm(st) }); runHours(s, 8); }
    for (let k = 1; k < samples.length; k++) {
      expect(samples[k].wind).toBeGreaterThan(samples[k - 1].wind);
      expect(samples[k].gale).toBeGreaterThanOrEqual(samples[k - 1].gale);
      expect(samples[k].outer).toBeGreaterThan(samples[k - 1].outer);
    }
    expect(samples[3].gale).toBeGreaterThan(50);
    runUntil(s, () => s.peakWind >= 33, 160);
    expect(s.peakWind).toBeGreaterThanOrEqual(33);
    expect(st.stage).toMatch(/Typhoon/);
    expect(st.track.length).toBeGreaterThan(10);
    expect(st.forecast.length).toBeGreaterThan(3);
  });

  it('two simultaneous storms evolve independently; the world continues after both dissipate', () => {
    const s = createGame();
    seedSite(s, WPAC);
    seedSite(s, ATLANTIC);
    runUntil(s, () => s.storms.length === 2, 48);
    const formedAt = s.hours;
    runHours(s, 20, () => expect(s.storms).toHaveLength(2));
    expect(s.hours).toBe(formedAt + 20);
    for (const st of s.storms) expect(st.wind).toBeGreaterThan(17.2);
    runUntil(s, () => s.storms.length === 0, 400);
    expect(s.storms).toHaveLength(0);
    expect(s.phase).toBe('seeding');
    expect(s.news.filter(n => n.kind === 'ended').length).toBeGreaterThanOrEqual(1);
    const hours = s.hours;
    runHours(s, 10);
    expect(s.hours).toBe(hours + 10);
    seedSite(s, [150, 14]); // and new storms can still form
    expect(runUntil(s, () => s.storms.length > 0, 48)).toBe(true);
  }, 30_000);
});

describe('rotation and motion in both hemispheres', () => {
  function anomaly(type: ToolType, lat: number) {
    const s = createGame();
    const withFx = createGame();
    withFx.effects.push(effect(type, 145, lat));
    const d = (e: number, n: number) => {
      const p = moveKm(145, lat, e, n);
      const a = sampleEnvironment(withFx, p.lon, p.lat);
      const b = sampleEnvironment(s, p.lon, p.lat);
      return { u: a.u - b.u, v: a.v - b.v };
    };
    return { east: d(400, 0), west: d(-400, 0), north: d(0, 400), south: d(0, -400) };
  }

  it('highs turn clockwise in the north and anticlockwise in the south; lows the reverse', () => {
    const hn = anomaly('high', 25);
    expect(hn.east.v).toBeLessThan(-1); expect(hn.west.v).toBeGreaterThan(1); expect(hn.north.u).toBeGreaterThan(1); expect(hn.south.u).toBeLessThan(-1);
    const hs = anomaly('high', -25);
    expect(hs.east.v).toBeGreaterThan(1); expect(hs.west.v).toBeLessThan(-1); expect(hs.north.u).toBeLessThan(-1); expect(hs.south.u).toBeGreaterThan(1);
    const ln = anomaly('low', 25);
    expect(ln.east.v).toBeGreaterThan(1); expect(ln.north.u).toBeLessThan(-1);
    const ls = anomaly('low', -25);
    expect(ls.east.v).toBeLessThan(-1); expect(ls.north.u).toBeGreaterThan(1);
  });

  it('storm circulation is cyclonic in each hemisphere and storms drift poleward', () => {
    const s = createGame();
    seedSite(s, WPAC);
    seedSite(s, SOUTH_INDIAN);
    runUntil(s, () => s.storms.length === 2 && s.storms.every(x => x.wind > 30), 96);
    const north = s.storms.find(x => x.lat > 0)!;
    const south = s.storms.find(x => x.lat < 0)!;
    for (const [st, sign] of [[north, 1], [south, -1]] as const) {
      const r = st.radiusKm * 1.5;
      expect(sign * vortexAt(s, st, r, 0).v).toBeGreaterThan(10);
      expect(sign * vortexAt(s, st, -r, 0).v).toBeLessThan(-10);
      expect(sign * vortexAt(s, st, 0, r).u).toBeLessThan(-10);
      expect(vortexAt(s, st, r, 0).u).toBeLessThan(0); // inflow on the east side points west
    }
    const lat0 = { n: north.lat, s: south.lat };
    runHours(s, 24);
    expect(north.lat).toBeGreaterThan(lat0.n + 0.5);
    expect(south.lat).toBeLessThan(lat0.s - 0.5);
  });

  it('steering excludes every storm’s own circulation and responds to pressure systems', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0, 48);
    const st = s.storms[0];
    const base = steeringFlow(s, st);
    expect(steeringFlow(s)).toEqual(base);
    const altered = structuredClone(s);
    Object.assign(altered.storms[0], { radiusKm: st.radiusKm * 3, ageHours: 200 });
    expect(steeringFlow(altered, altered.storms[0])).toEqual(base);
    const withFx = (type: ToolType, e: number, n: number) => {
      const t = structuredClone(s);
      const p = moveKm(st.lon, st.lat, e, n);
      t.effects = [effect(type, p.lon, p.lat)];
      return steeringFlow(t, t.storms[0]);
    };
    expect(withFx('high', 700, 0).v).toBeGreaterThan(base.v + 1);
    expect(withFx('high', 0, 700).u).toBeLessThan(base.u - 1);
    expect(withFx('low', 0, 700).u).toBeGreaterThan(base.u + 1);
    expect(steeringFlow(createGame())).toEqual({ u: 0, v: 0 });
  });

  it('warm water forms a weak thermal low and cool water a weak high', () => {
    const [lon, lat] = WPAC;
    for (const [type, sign] of [['warm', -1], ['cool', 1]] as const) {
      const s = createGame();
      const before = totalPressure(s, lon, lat);
      expect(placeTool(s, type, lon, lat)).toEqual({ ok: true });
      runHours(s, 24);
      const delta = totalPressure(s, lon, lat) - before;
      expect(delta * sign).toBeGreaterThan(0.5);
      expect(s.grid[gridIndex(lon, lat)].pressure).toBeCloseTo(totalPressure(s, s.grid[gridIndex(lon, lat)].lon, s.grid[gridIndex(lon, lat)].lat), 9);
    }
  });

  it('wraps distance, movement and fields across the dateline', () => {
    expect(distanceKm(179.9, 0, -179.9, 0)).toBeLessThan(25);
    expect(moveKm(179.9, 10, 100, 0).lon).toBeLessThan(-179);
    const s = createGame();
    seedSite(s, [-178, 14]);
    runUntil(s, () => s.storms.length > 0 && s.storms[0].lon > 0, 120);
    const st = s.storms[0];
    expect(st.lon).toBeGreaterThan(170); // crossed from west to east longitude
    for (let k = 1; k < st.track.length; k++) {
      const a = st.track[k - 1];
      const b = st.track[k];
      expect(distanceKm(a.lon, a.lat, b.lon, b.lat)).toBeLessThan(80);
    }
    // The circulation shows on both sides of the dateline in the grid.
    for (const lon of [179, -179]) {
      const c = s.grid[gridIndex(lon, st.lat)];
      const w = totalWind(s, c.lon, c.lat);
      const env = sampleEnvironment(s, c.lon, c.lat);
      expect(c.u).toBeCloseTo(w.u, 9);
      expect(c.v).toBeCloseTo(w.v, 9);
      expect(Math.hypot(w.u - env.u, w.v - env.v)).toBeGreaterThan(1);
    }
  });
});

describe('intensity physics', () => {
  const env = { temperature: 29, airTemperature: 27.5, airHeating: 0, updraft: 0, instability: 0, drying: 0, cooling: 0, humidity: 0.7, shear: 8, pressure: 1008, u: 0, v: 0, land: false };

  it('genesis potential favours warm, moist, low-shear, low-pressure ocean at any latitude', () => {
    const g = (o: Partial<typeof env>, lat = 15) => genesisPotential({ ...env, ...o }, lat);
    expect(g({ temperature: 30 })).toBeGreaterThan(g({}));
    expect(g({ temperature: 26 })).toBe(0);
    expect(g({ humidity: 0.8 })).toBeGreaterThan(g({}));
    expect(g({ shear: 20 })).toBeLessThan(g({}));
    expect(g({ pressure: 1002 })).toBeGreaterThan(g({}));
    expect(g({ land: true })).toBe(0);
    expect(g({}, 0)).toBe(g({}, 15));
    expect(g({}, -15)).toBe(g({}, 15));
  });

  it('intensity responds to SST, humidity and shear, and land weakens storms', () => {
    const t = (o: Partial<typeof env>, wind = 30, landFraction = 0) => intensityTendency({ ...env, ...o }, wind, landFraction);
    expect(t({ temperature: 30.5 })).toBeGreaterThan(t({}));
    expect(t({ humidity: 0.3 })).toBeLessThan(t({}));
    expect(t({ shear: 25 })).toBeLessThan(t({}));
    expect(t({ temperature: 24 })).toBeLessThan(0);
    expect(t({}, 40, 1)).toBeLessThan(-2);
    expect(t({}, 40, 1)).toBeLessThan(t({}, 40, 0.5));
    expect(t({}, 40, 0.5)).toBeLessThan(t({}, 40, 0));
  });

  it('a storm over land weakens every step', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0, 48);
    s.effects = [];
    Object.assign(s.storms[0], { lon: 104, lat: 30, wind: 40 }); // inland China
    expect(isLand(104, 30)).toBe(true);
    let prev = 40;
    runHours(s, 6, () => { expect(s.storms[0].wind).toBeLessThan(prev); prev = s.storms[0].wind; });
    expect(prev).toBeLessThan(30);
  });
});

describe('grid, damage and consistency', () => {
  it('has a global land mask and fictional population grid', () => {
    const s = createGame();
    expect(s.grid[gridIndex(78, 22)].land).toBe(true); // central India
    expect(s.grid[gridIndex(-150, 0)].land).toBe(false); // central Pacific
    expect(s.grid[gridIndex(15, 23)].land).toBe(true); // Sahara
    expect(s.grid[gridIndex(-60, 15)].land).toBe(false); // Caribbean Sea
    expect(s.grid[gridIndex(0, -85)].land).toBe(true); // Antarctica
    expect(s.grid[gridIndex(0, -85)].population).toBe(0);
    const total = s.grid.reduce((a, c) => a + c.population, 0);
    expect(total).toBeGreaterThan(CITIES.reduce((a, c) => a + c.population, 0));
    // Each city's people sit on the cells around it (cities sharing a cell are apportioned there).
    for (const city of CITIES) {
      const near = s.grid.filter(c => distanceKm(city.lon, city.lat, c.lon, c.lat) < 450).reduce((a, c) => a + c.population, 0);
      expect(near, city.id).toBeGreaterThanOrEqual(city.population);
    }
    expect(new Set(s.grid.map(c => c.cityId).filter(Boolean)).size).toBeGreaterThan(CITIES.length / 2);
    for (const c of s.grid) if (c.population === 0) expect(c.cityId).toBeNull();
  });

  it('grid wind/pressure equal totalWind/totalPressure, and storm.pressure equals the centre value', () => {
    const s = createGame();
    seedSite(s, WPAC);
    seedSite(s, [WPAC[0] + 9, WPAC[1] + 1]); // ~1000 km apart: two storms whose fields overlap
    let checkedFormation = false;
    runUntil(s, () => {
      if (s.storms.length > 0 && !checkedFormation) { expectPressuresSynced(s); checkedFormation = true; }
      return s.storms.length === 2 && s.storms.every(x => x.wind > 30);
    }, 120);
    expect(checkedFormation).toBe(true);
    expect(s.storms).toHaveLength(2);
    expectPressuresSynced(s);
    const st = s.storms[0];
    for (let k = 0; k < s.grid.length; k += 37) {
      const c = s.grid[k];
      const w = totalWind(s, c.lon, c.lat);
      expect(c.u).toBeCloseTo(w.u, 9);
      expect(c.v).toBeCloseTo(w.v, 9);
      expect(c.pressure).toBeCloseTo(totalPressure(s, c.lon, c.lat), 9);
    }
    for (let d = -600; d <= 600; d += 200) {
      const p = moveKm(st.lon, st.lat, d, d / 2);
      const c = s.grid[gridIndex(p.lon, p.lat)];
      expect(c.u).toBeCloseTo(totalWind(s, c.lon, c.lat).u, 9);
      expect(c.pressure).toBeCloseTo(totalPressure(s, c.lon, c.lat), 9);
    }
    // Paused placement keeps every centre pressure in sync with the changed environment.
    expect(placeTool(s, 'high', st.lon - 8, st.lat + 6).ok).toBe(true);
    expect(placeTool(s, 'low', st.lon + 3, st.lat - 4).ok).toBe(true);
    expectPressuresSynced(s);
    stepGame(s);
    expectPressuresSynced(s);
  }, 30_000);

  it('surface wind over land is LAND_WIND_FACTOR times the environment wind; over sea it is unchanged', () => {
    const s = createGame();
    seedSite(s, [132, 36], ['low', 'low']); // Low straddling the Korea/Japan coasts
    stepGame(s);
    let land = 0, sea = 0;
    for (const c of s.grid) {
      if (distanceKm(132, 36, c.lon, c.lat) > 1500) continue;
      const env = sampleEnvironment(s, c.lon, c.lat);
      const w = totalWind(s, c.lon, c.lat);
      const f = isLand(c.lon, c.lat) ? LAND_WIND_FACTOR : 1;
      expect(w.u).toBeCloseTo(env.u * f, 9);
      expect(w.v).toBeCloseTo(env.v * f, 9);
      expect(c.u).toBeCloseTo(w.u, 9);
      expect(c.v).toBeCloseTo(w.v, 9);
      if (f < 1) land++; else sea++;
    }
    expect(land).toBeGreaterThan(0);
    expect(sea).toBeGreaterThan(0);
  });

  it('damage is incremental and scored from the displayed wind', () => {
    const s = createGame();
    seedSite(s, [128, 14]); // tracks toward the Philippines/Taiwan
    let last = 0;
    runHours(s, 160, () => {
      expect(s.score).toBeGreaterThanOrEqual(last);
      last = s.score;
      if (s.tick % 16 !== 0) return;
      let sum = 0;
      let exposed = 0;
      for (const c of s.grid) {
        expect(c.maxDamage).toBeLessThanOrEqual(1);
        if (c.population > 0 && s.storms.length) expect(c.maxDamage + 1e-12).toBeGreaterThanOrEqual(damageRatio(Math.hypot(c.u, c.v)));
        sum += c.population * c.maxDamage;
        if (c.exposed) exposed += c.population;
      }
      expect(s.score).toBeGreaterThanOrEqual(sum - 1e-6); // cumulative; the cells' current damage can only be lower once repairs start
      expect(s.exposedPopulation).toBeCloseTo(exposed, 2);
      expect(s.cities.reduce((a, c) => a + c.score, 0)).toBeLessThanOrEqual(s.score + 1e-6);
    });
    expect(s.score).toBeGreaterThan(0);
  }, 30_000);

  it('a storm sitting still does not add the same damage again', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0, 48);
    s.effects = [];
    Object.assign(s.storms[0], { lon: 121.2, lat: 15.2, wind: 45, ageHours: 48 });
    stepGame(s);
    expect(s.score).toBeGreaterThan(0);
    const st = s.storms[0];
    const pos = { lon: st.lon, lat: st.lat };
    const first = s.score;
    for (let k = 0; k < 6; k++) {
      Object.assign(st, { ...pos, wind: 40 }); // same place, weaker: nothing new
      stepGame(s);
    }
    expect(s.score - first).toBeLessThan(first * 0.05);
  });
});

describe('placement', () => {
  it('tools are free, have no cooldown, and record actions', () => {
    const s = createGame();
    for (const t of TOOLS) expect('cost' in t).toBe(false);
    for (let k = 0; k < 3; k++) seedSite(s, [140 + k * 20, 15]);
    expect(s.effects).toHaveLength(9);
    expect(s.actions).toHaveLength(9);
    expect(s.actions[0]).toEqual({ tick: 0, type: 'warm', lon: 140, lat: 15 });
    expect(new Set(s.effects.map(e => e.id)).size).toBe(9);
  });

  it('rejects invalid placements with readable reasons, and caps simultaneous effects generously', () => {
    const s = createGame();
    expect(placeTool(s, 'warm', 139.7, 35.7).reason).toMatch(/ocean/i);
    expect(placeTool(s, 'moisture', Number.NaN, 20).ok).toBe(false);
    expect(placeTool(s, 'moisture', 190, 20).ok).toBe(false);
    expect(placeTool(s, 'moisture', 20, -91).ok).toBe(false);
    expect(placeTool(s, 'tornado' as ToolType, 130, 20).ok).toBe(false);
    for (let k = 0; k < MAX_ACTIVE_EFFECTS; k++) expect(placeTool(s, 'moisture', -170 + k * 5, 10).ok).toBe(true);
    const full = placeTool(s, 'moisture', 0, 0);
    expect(full.ok).toBe(false);
    expect(full.reason).toMatch(/active/);
    expect(MAX_ACTIVE_EFFECTS).toBeGreaterThanOrEqual(30);
    const t = createGame();
    seedSite(t, WPAC);
    runUntil(t, () => t.storms.length > 0, 48);
    expect(placeTool(t, 'high', t.storms[0].lon + 1, t.storms[0].lat).reason).toMatch(/km/);
  });

  it('effects ramp in and expire', () => {
    const s = createGame();
    placeTool(s, 'moisture', 150, 20);
    const h0 = sampleEnvironment(s, 150, 20).humidity;
    runHours(s, 6);
    expect(sampleEnvironment(s, 150, 20).humidity).toBeGreaterThan(h0 + 0.15);
    runHours(s, TOOLS.find(t => t.type === 'moisture')!.durationHours);
    expect(s.effects).toHaveLength(0);
  });
});

describe('determinism and replay', () => {
  it('same seed and actions give identical states; a different seed differs', () => {
    const play = (seed: number) => { const s = createGame(seed); seedSite(s, WPAC); runHours(s, 60); return s; };
    expect(play(SCENARIO.seed)).toEqual(play(SCENARIO.seed));
    expect(play(SCENARIO.seed + 1).storms[0].track).not.toEqual(play(SCENARIO.seed).storms[0].track);
  });

  it('replay to untilTick reproduces a live snapshot exactly, including actions at the snapshot tick', () => {
    const live = createGame();
    seedSite(live, WPAC);
    runHours(live, 30);
    seedSite(live, ATLANTIC);
    runHours(live, 25);
    expect(placeTool(live, 'high', 150, 32).ok).toBe(true);
    runHours(live, 10);
    seedSite(live, SOUTH_INDIAN); // placed while paused at the snapshot tick
    const r = replayGame(live.seed, structuredClone(live.actions), live.tick);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state).toEqual(live);
    const early = replayGame(live.seed, live.actions.filter(a => a.tick <= 40), 40);
    expect(early.ok && early.state.tick).toBe(40);
  });

  it('rejects malformed replay input quickly with a reason', () => {
    const good = { tick: 0, type: 'low', lon: 136, lat: 16 };
    const bad: [unknown, unknown, unknown][] = [
      ['1', [], 10], [-1, [], 10], [1.5, [], 10], [2 ** 32, [], 10], [Number.NaN, [], 10],
      [1, [], -1], [1, [], 1.5], [1, [], REPLAY_MAX_TICKS + 1], [1, [], '10'], [1, [], undefined],
      [1, 'nope', 10], [1, null, 10], [1, [null], 10], [1, [{ ...good, tick: -1 }], 10], [1, [{ ...good, tick: 0.5 }], 10],
      [1, [{ ...good, tick: 11 }], 10], [1, [{ ...good, type: 'tornado' }], 10],
      [1, [{ ...good, lon: Number.NaN }], 10], [1, [{ ...good, lat: 95 }], 10], [1, [{ ...good, lon: '136' }], 10],
      [1, [{ ...good, tick: 5 }, { ...good, tick: 3 }], 10],
      [1, Array.from({ length: REPLAY_MAX_ACTIONS + 1 }, () => good), 10],
      [1, Array.from({ length: 1_000_000 }, () => good), 10],
      [1, [{ tick: 0, type: 'warm', lon: 139.7, lat: 35.7 }], 10], // legal shape, illegal play (warm on land)
    ];
    const t0 = performance.now();
    for (const [seed, actions, until] of bad) {
      const r = replayGame(seed, actions, until);
      expect(r.ok, JSON.stringify([seed, until])).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(5);
    }
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(validateActions([{ ...good, extra: 'x' }], 10)).toEqual({ ok: true, actions: [good] });
  });
});

describe('open-ended grades', () => {
  it('continues one grade per 10 m/s above grade 5 with no upper bound', () => {
    expect(stageRank(63.9)).toBe(5);
    expect(stageRank(64)).toBe(6);
    expect(stageRank(104)).toBe(10);
    expect(stageFor(74, 140, 20)).toBe('Grade 7 Typhoon');
    expect(stageFor(74, -60, 20)).toBe('Grade 7 Hurricane');
    expect(stageFor(54)).toBe('Violent Typhoon');
  });
  it('no longer caps potential intensity at 85 m/s or pressure below zero', () => {
    expect(potentialIntensity(32)).toBeGreaterThan(85);
    expect(potentialIntensity(10)).toBe(0);
    expect(Number.isFinite(pressureDeficit(150))).toBe(true);
    expect(1010 - pressureDeficit(300)).toBeGreaterThan(0);
  });
});

describe('rainfall (display-only grid field)', () => {
  it('rains hard around a mature storm and nowhere in a calm, untouched ocean', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0 && s.storms[0].wind >= 38, 200);
    const st = s.storms[0];
    expect(st.wind).toBeGreaterThanOrEqual(38);
    let wettest = 0;
    s.grid.forEach(c => { if (distanceKm(st.lon, st.lat, c.lon, c.lat) <= Math.max(1.5 * st.radiusKm, 300)) wettest = Math.max(wettest, c.rain); });
    expect(wettest).toBeGreaterThan(5);
    expect(Math.max(...s.grid.map(c => c.rain))).toBeLessThanOrEqual(60);
    const calm = s.grid[gridIndex(ATLANTIC[0], ATLANTIC[1])];
    expect(calm.land).toBe(false);
    expect(calm.rain).toBe(0);
    expect(createGame().grid.every(c => c.rain === 0)).toBe(true);
  }, 30_000);

  it('a mature storm\'s rain is not a uniform disc: spiral bands and motion asymmetry vary it around a ring', () => {
    const s = createGame();
    seedSite(s, WPAC);
    runUntil(s, () => s.storms.length > 0 && s.storms[0].wind >= 38, 200);
    const st = s.storms[0];
    expect(st.wind).toBeGreaterThanOrEqual(38);
    const ring: number[] = [];
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * 2 * Math.PI;
      const p = moveKm(st.lon, st.lat, 4 * st.radiusKm * Math.cos(a), 4 * st.radiusKm * Math.sin(a));
      ring.push(s.grid[gridIndex(p.lon, p.lat)].rain);
    }
    const max = Math.max(...ring), min = Math.min(...ring), mean = ring.reduce((a, b) => a + b, 0) / ring.length;
    expect(mean).toBeGreaterThan(1);
    expect(max / Math.max(min, 1e-9)).toBeGreaterThanOrEqual(1.6);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state.grid.map(c => c.rain)).toEqual(s.grid.map(c => c.rain));
  }, 60_000);

  it('the rain a Low makes carries over when it becomes a depression, and a young depression has no dry eye', () => {
    const s = createGame();
    seedSite(s, WPAC);
    const wettest = () => {
      let m = 0;
      s.grid.forEach(c => { if (distanceKm(WPAC[0], WPAC[1], c.lon, c.lat) <= 400) m = Math.max(m, c.rain); });
      return m;
    };
    let before = 0;
    const until = s.tick + Math.round(72 / STEP_HOURS);
    while (s.tick < until && s.storms.length === 0) { before = wettest(); stepGame(s); }
    expect(s.storms.length).toBeGreaterThan(0);
    const after = wettest();
    expect(after).toBeGreaterThanOrEqual(2);
    expect(after).toBeGreaterThanOrEqual(0.6 * before);
    const st = s.storms[0];
    expect(st.wind).toBeLessThan(25);
    expect(s.grid[gridIndex(st.lon, st.lat)].rain).toBeGreaterThan(0);
  }, 30_000);

  it('a player-made low over moist open ocean rains at its centre; the untouched world stays dry there', () => {
    const [lon, lat] = [140, 55];
    const s = createGame();
    expect(s.grid[gridIndex(lon, lat)].land).toBe(false);
    seedSite(s, [lon, lat], ['low', 'moisture']);
    runHours(s, 24);
    const wet = s.grid[gridIndex(lon, lat)];
    expect(wet.rain).toBeGreaterThan(1);
    expect(wet.rain).toBeLessThanOrEqual(60);
    const dry = createGame();
    runHours(dry, 24);
    expect(dry.grid[gridIndex(lon, lat)].rain).toBe(0);
  }, 30_000);

  it('freezing precipitation falls as snow, and two Lows plus Moisture in the cold north Atlantic make a blizzard', () => {
    const [lon, lat] = [-30, 62];
    const s = createGame();
    seedSite(s, [lon, lat], ['low', 'low', 'moisture']);
    runHours(s, 24);
    expect(s.grid.every(c => c.snow === 0 || (c.airTemperature <= 0 && c.snow === c.rain))).toBe(true);
    expect(s.grid.every(c => !c.blizzard || (c.snow >= 1 && Math.hypot(c.u, c.v) >= 15))).toBe(true);
    const near = s.grid.filter(c => distanceKm(lon, lat, c.lon, c.lat) <= 8 * 111);
    expect(near.some(c => c.blizzard)).toBe(true);
    expect(createGame().grid.every(c => c.snow === 0 && !c.blizzard)).toBe(true);
  }, 30_000);

  it('snow-load damage is zero below 20 cm, half at 60 cm in a 15 m/s gale, and grows with depth', () => {
    expect(blizzardDamageRatio(10, 15)).toBe(0);
    expect(blizzardDamageRatio(20, 30)).toBe(0);
    expect(blizzardDamageRatio(60, 15)).toBeCloseTo(0.5, 5);
    expect(blizzardDamageRatio(100, 15)).toBeCloseTo(0.8, 5);
    let last = 0;
    for (let cm = 0; cm <= 400; cm += 10) { const r = blizzardDamageRatio(cm, 15); expect(r).toBeGreaterThanOrEqual(last); last = r; }
    expect(blizzardDamageRatio(60, 25)).toBeGreaterThan(blizzardDamageRatio(60, 15));
    expect(blizzardDamageRatio(60, 0)).toBeCloseTo(0.25, 5);
  });

  it('three Lows, Moisture and Cold air over Helsinki in a cold world bury it, raise blizzard news and a snow-damage bulletin; replay agrees', () => {
    const helsinki = CITIES.find(c => c.id === 'helsinki')!;
    const index = CITIES.indexOf(helsinki);
    const s = createGame();
    expect(setClimate(s, 'polar', -6)).toEqual({ ok: true });
    seedSite(s, [helsinki.lon, helsinki.lat], ['low', 'low', 'low', 'moisture', 'cold-air']); // land friction (x0.7) needs a third Low to keep a gale
    runHours(s, 72);
    const cells = s.grid.filter(c => c.cityId === helsinki.id);
    expect(Math.max(...cells.map(c => c.snowCm))).toBeGreaterThan(20);
    expect(s.cities[index].blizzardHours).toBeGreaterThan(0);
    expect(s.cities[index].score).toBeGreaterThan(0);
    expect(s.news.some(n => n.kind === 'blizzard' && n.id === `blizzard-${helsinki.id}` && n.cityId === helsinki.id)).toBe(true);
    expect(s.news.some(n => n.kind === 'blizzard' && n.id.startsWith('blizzard-start-'))).toBe(true);
    expect(s.news.some(n => n.kind === 'city' && n.cityId === helsinki.id && n.text.includes('Heavy snow'))).toBe(true);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.state.score).toBe(s.score);
      expect(replay.state.cities[index]).toEqual(s.cities[index]);
      expect(replay.state.grid.map(c => c.snowCm)).toEqual(s.grid.map(c => c.snowCm));
      expect(replay.state.news).toEqual(s.news);
    }
  }, 120_000);

  it('an untouched world never lays snow, raises blizzard news or takes snow damage', () => {
    const s = createGame();
    runHours(s, 72);
    expect(s.grid.every(c => c.snowCm === 0 && c.snow === 0 && !c.blizzard)).toBe(true);
    expect(s.cities.every(c => c.blizzardHours === 0 && c.score === 0)).toBe(true);
    expect(s.blizzardCells).toBe(0);
    expect(s.score).toBe(0);
    expect(s.news.every(n => n.kind === 'info')).toBe(true);
  }, 60_000);
});

describe('remnant low', () => {
  /** Forms a storm in the western Pacific and runs until it dissipates; returns the state on its last storm step and the step after. */
  function dissipate(): { s: GameState; last: Storm; probe: { lon: number; lat: number } } {
    const s = createGame();
    seedSite(s, WPAC);
    expect(runUntil(s, () => s.storms.length > 0, 72)).toBe(true);
    let last = structuredClone(s.storms[0]);
    expect(runUntil(s, () => { if (s.storms.length) last = structuredClone(s.storms[0]); return s.storms.length === 0 && s.tick > 0 && s.stormArchive.length > 0; }, 600)).toBe(true);
    const probe = moveKm(last.lon, last.lat, last.radiusKm, 0); // one RMW east of the last storm centre
    return { s, last, probe };
  }

  it('fades the vortex over hours instead of removing it in one step', () => {
    const { s, last, probe } = dissipate();
    expect(s.remnants).toHaveLength(1);
    expect(s.remnants[0].id).toBe(last.id);
    const speed = (g: GameState) => { const w = totalWind(g, probe.lon, probe.lat); return Math.hypot(w.u, w.v); };
    // The same probe point with the last live storm still in place (and no remnant).
    const before = structuredClone(s);
    before.storms = [last]; before.remnants = [];
    const wLast = speed(before);
    const w0 = speed(s);
    expect(w0).toBeGreaterThan(0.5 * wLast);
    let prev = w0;
    for (let h = 1; h <= 12; h++) {
      runHours(s, 1);
      expect(s.remnants).toHaveLength(1);
      const w = speed(s);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
    runHours(s, 36);
    expect(s.remnants).toHaveLength(0);
  }, 60_000);

  it('is restored by replay', () => {
    const { s } = dissipate();
    runHours(s, 3);
    expect(s.remnants).toHaveLength(1);
    const restored = replayGame(s.seed, s.actions, s.tick);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.state.remnants).toEqual(s.remnants);
  }, 60_000);
});
