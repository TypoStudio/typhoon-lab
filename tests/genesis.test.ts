import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../src/i18n';
import { createGame, EFFECT_STACK_LIMITS, GENESIS_MAX_STORMS, MAX_ACTIVE_EFFECTS, genesisPotential, intensityTendency, isLand, loadHistoric, placeTool, replayGame, sampleEnvironment, setGenesis, stepGame, TICKS_PER_HOUR } from '../src/simulation/engine';
import { distanceKm, moveKm } from '../src/simulation/geo';
import { buildReplay, parseReplay } from '../src/ui/storage';
import type { GameState, Storm, ToolType } from '../src/types';

const weakening: ToolType[] = ['cool', 'dry', 'cold-air', 'downdraft'];
const RECIPE: ToolType[] = ['warm', 'moisture', 'low', 'warm-air', 'updraft'];
const run = (s: GameState, hours: number) => { for (let tick = 0; tick < hours * TICKS_PER_HOUR; tick++) stepGame(s); };
function protect(s: GameState, lon: number, lat: number) {
  for (const tool of weakening) expect(placeTool(s, tool, lon, lat).ok).toBe(true);
}
/** A world with natural formation switched on at tick 0, so the first wave is already in place. */
function natural(seed: number): GameState {
  const s = createGame(seed);
  expect(setGenesis(s, true)).toEqual({ ok: true });
  return s;
}

describe('natural typhoon formation and weakening conditions', () => {
  it('is off by default and brings a seeded wave of conditions the moment it is switched on', () => {
    const off = createGame(5);
    expect(off.genesis).toEqual({ enabled: false, waves: 0, nextSpawnTick: 0 });
    expect(off.effects).toHaveLength(0);
    const s = natural(5);
    expect(s.genesis).toMatchObject({ enabled: true, waves: 1 });
    expect(s.phase).toBe('seeding');
    expect(s.storms).toHaveLength(0); expect(s.peakWind).toBe(0);
    expect(s.actions).toEqual([{ tick: 0, type: 'genesis', on: true }]);
    expect(s.effects.map(e => e.type)).toEqual(RECIPE);
    for (const e of s.effects) { expect(e.ageHours).toBe(0); expect(e.id).toBeLessThan(0); }
    expect(s.news.at(-1)!.title).toBe('Natural formation wave 1: conditions gathering…');
    expect(s.effects).toEqual(natural(5).effects);
    expect(s.effects).not.toEqual(natural(6).effects);
    expect(setGenesis(createGame(5), 'yes' as unknown as boolean).ok).toBe(false);
  });

  it('switching on mid-game spawns at once, switching off stops new waves, switching on again resumes', () => {
    const s = createGame(5);
    run(s, 10);
    setGenesis(s, true);
    expect(s.genesis.waves).toBe(1);
    expect(s.genesis.nextSpawnTick).toBeGreaterThan(s.tick);
    const due = s.genesis.nextSpawnTick;
    setGenesis(s, false);
    expect(s.genesis.enabled).toBe(false);
    while (s.tick <= due + 8) stepGame(s);
    expect(s.genesis.waves).toBe(1);
    expect(s.actions.map(a => a.type)).toEqual(['genesis', 'genesis']);
    setGenesis(s, true);
    expect(s.genesis.waves).toBe(2);
    expect(s.actions).toHaveLength(3);
  });

  it('accumulates progress, births a young depression, then grows into a typhoon', () => {
    const s = natural(5);
    run(s, 6);
    expect(s.storms).toHaveLength(0);
    expect(s.candidates[0].progressHours).toBeGreaterThan(0);
    while (!s.storms.length && s.hours < 48) stepGame(s);
    expect(s.storms).toHaveLength(1);
    const storm = s.storms[0];
    expect(storm.wind).toBe(13); expect(storm.ageHours).toBe(0);
    expect(storm.stage).toBe('Tropical Depression');
    expect(storm.record).toBeUndefined();
    expect(storm.id).toBeGreaterThan(0);
    expect(s.hours).toBeGreaterThan(8);
    expect(storm.history[0].hour).toBe(s.hours);
    run(s, 36);
    expect(s.peakWind).toBeGreaterThanOrEqual(33);
    expect(s.actions).toHaveLength(1);
  });

  it('spawns successive waves at seeded intervals with bounded automatic arrivals', () => {
    const s = natural(5);
    const firstDue = s.genesis.nextSpawnTick;
    expect(firstDue / 4).toBeGreaterThanOrEqual(48);
    expect(firstDue / 4).toBeLessThanOrEqual(72);
    while (s.tick < firstDue) stepGame(s);
    expect(s.genesis.waves).toBe(2);
    const ids = [...s.storms, ...s.stormArchive].map(st => st.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Keep three healthy storms at a tropical location during the due tick.
    s.storms = Array.from({ length: GENESIS_MAX_STORMS }, (_, k) => ({ ...structuredClone(s.storms[0]), id: 20 + k, lon: 140 + 6 * k, lat: 16, wind: 40 }));
    s.genesis.nextSpawnTick = s.tick + 1;
    stepGame(s);
    expect(s.genesis.waves).toBe(2);
    expect(s.genesis.nextSpawnTick).toBeGreaterThan(s.tick);
  });

  it('counts only natural storms toward the cap, never loaded historic ones', () => {
    const s = createGame(5);
    for (let k = 0; k < GENESIS_MAX_STORMS + 1; k++) expect(loadHistoric(s, 'maemi-2003').ok).toBe(true);
    setGenesis(s, true);
    expect(s.genesis.waves).toBe(1);
    expect(s.effects.map(e => e.type)).toEqual(RECIPE);
    // The same number of natural storms does block the next wave.
    const natural3: Storm[] = Array.from({ length: GENESIS_MAX_STORMS }, (_, k) => ({ ...structuredClone(s.storms[0]), id: 20 + k, record: undefined, name: undefined }));
    s.storms.push(...natural3);
    s.effects = [];
    s.genesis.nextSpawnTick = s.tick;
    stepGame(s);
    expect(s.genesis.waves).toBe(1);
    s.storms = s.storms.filter(st => !st.record).slice(0, GENESIS_MAX_STORMS - 1);
    s.genesis.nextSpawnTick = s.tick;
    stepGame(s);
    expect(s.genesis.waves).toBe(2);
  });

  it('all four conditions weaken a storm, cooling is ocean-only, and opposite air conditions cancel', () => {
    const baseline = createGame(); const env = sampleEnvironment(baseline, 140, 16);
    for (const tool of weakening) {
      const s = createGame(); expect(placeTool(s, tool, 140, 16).ok).toBe(true); run(s, 6);
      const altered = sampleEnvironment(s, 140, 16);
      expect(intensityTendency(altered, 40, 0), tool).toBeLessThan(intensityTendency(env, 40, 0));
      expect(genesisPotential(altered, 16), tool).toBeLessThan(genesisPotential(env, 16));
    }
    expect(placeTool(baseline, 'cool', 104, 30).ok).toBe(false);
    for (const type of ['warm-air', 'cold-air', 'updraft', 'downdraft'] as ToolType[]) placeTool(baseline, type, 140, 16);
    run(baseline, 6);
    expect(sampleEnvironment(baseline, 140, 16).airHeating).toBeCloseTo(0);
    expect(sampleEnvironment(baseline, 140, 16).updraft).toBeCloseTo(0);
  });

  it('caps negative fields and keeps the fast grid consistent with sampling', () => {
    const s = createGame(); const before = sampleEnvironment(s, 140, 16);
    for (let i = 0; i < 12; i++) protect(s, 140, 16); // 36 °C of cooling, -36 °C of air heating and -12 m/s of updraft requested: all past the stack limits
    run(s, 6);
    const after = sampleEnvironment(s, 140, 16);
    expect(after.temperature).toBeCloseTo(before.temperature - EFFECT_STACK_LIMITS.cooling);
    expect(after.airHeating).toBe(-EFFECT_STACK_LIMITS.air); expect(after.updraft).toBe(-EFFECT_STACK_LIMITS.vertical); expect(after.humidity).toBe(0);
    for (const c of s.grid.filter(c => c.lon >= 137 && c.lon <= 143 && c.lat >= 13 && c.lat <= 19)) {
      const sampled = sampleEnvironment(s, c.lon, c.lat);
      for (const key of ['temperature', 'airTemperature', 'updraft', 'humidity'] as const) expect(c[key]).toBeCloseTo(sampled[key], 9);
    }
    run(s, 74);
    expect(s.effects).toHaveLength(0);
    const untouched = createGame(); run(untouched, 80); // the calendar has moved on 80 h, so compare with an effect-free world at the same hour
    expect(sampleEnvironment(s, 140, 16)).toEqual(sampleEnvironment(untouched, 140, 16));
  });

  it('early intervention prevents the first wave from forming instead of merely hiding a storm', () => {
    const base = natural(5); const protectedWorld = natural(5);
    const site = protectedWorld.effects.find(e => e.type === 'low')!;
    protect(protectedWorld, site.lon, site.lat);
    run(base, 48); run(protectedWorld, 48);
    expect(base.peakWind).toBeGreaterThanOrEqual(33);
    expect(protectedWorld.storms).toHaveLength(0);
    expect(protectedWorld.stormArchive).toHaveLength(0);
    expect(protectedWorld.peakWind).toBe(0);
    expect(protectedWorld.score).toBe(0);
    expect(new Set(protectedWorld.effects.map(e => e.id)).size).toBe(protectedWorld.effects.length);
  });

  it('defers waves for pending lows or a full effect pool without partially placing a recipe', () => {
    for (const block of ['pending', 'capacity']) {
      const s = natural(5);
      const count = block === 'pending' ? GENESIS_MAX_STORMS - 1 : MAX_ACTIVE_EFFECTS - s.effects.length;
      for (let i = 0; i < count; i++) expect(placeTool(s, block === 'pending' ? 'low' : 'dry', 140, 16).ok).toBe(true);
      const effects = s.effects.length;
      s.genesis.nextSpawnTick = 1;
      stepGame(s);
      expect(s.genesis.waves).toBe(1);
      expect(s.genesis.nextSpawnTick).toBe(17);
      expect(s.effects).toHaveLength(effects);
    }
  });

  it('replays automatic waves, toggles and interventions exactly', () => {
    const s = natural(4); protect(s, s.effects[0].lon, s.effects[0].lat); run(s, 60);
    setGenesis(s, false); run(s, 20); setGenesis(s, true); run(s, 40);
    const file = buildReplay(s); const parsed = parseReplay(JSON.stringify(file));
    expect(parsed.ok).toBe(true); expect(file.formatVersion).toBe(6);
    expect(s.actions.map(a => a.type)).toEqual(['genesis', 'cool', 'dry', 'cold-air', 'downdraft', 'genesis', 'genesis']);
    const result = replayGame(s.seed, s.actions, s.tick);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.state.genesis).toEqual(s.genesis);
    expect(result.state.actions).toEqual(s.actions);
    expect(result.state.storms).toEqual(s.storms);
    expect(result.state.stormArchive).toEqual(s.stormArchive);
    expect(result.state.cities).toEqual(s.cities);
    expect(result.state.news).toEqual(s.news);
    expect(result.state.effects).toEqual(s.effects);
    expect(result.state.candidates).toEqual(s.candidates);
    expect(result.state.grid).toEqual(s.grid);
  }, 30_000);
});

/** Where the newest wave put its low, and the basin named in its news text. */
function site(s: GameState) {
  const low = s.effects.filter(e => e.type === 'low').at(-1)!;
  return { lon: low.lon, lat: low.lat, basin: /\((.+)\)\. Weaken/.exec(s.news.at(-1)!.text)![1] };
}
/** Steps through `count` waves on a seed, clearing storms and effects between them so only the previous-site rule spaces them. */
function sites(seed: number, count: number) {
  const s = natural(seed);
  const list = [site(s)];
  while (list.length < count) {
    s.effects = []; s.storms = [];
    s.genesis.nextSpawnTick = s.tick;
    stepGame(s);
    expect(s.genesis.waves).toBe(list.length + 1);
    list.push(site(s));
  }
  return list;
}

describe('climatology-based formation sites', () => {
  afterEach(() => setLanguage('en'));

  it('spreads twelve waves over several basins, apart from one another, on open warm ocean in the tropics', () => {
    const list = sites(1, 12);
    expect(new Set(list.map(p => p.basin)).size).toBeGreaterThanOrEqual(3);
    const climate = createGame(1);
    list.forEach((p, k) => {
      if (k > 0) expect(distanceKm(list[k - 1].lon, list[k - 1].lat, p.lon, p.lat), `wave ${k + 1}`).toBeGreaterThanOrEqual(1500);
      expect(isLand(p.lon, p.lat)).toBe(false);
      for (const [e, n] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const q = moveKm(p.lon, p.lat, e * 300, n * 300); expect(isLand(q.lon, q.lat), `wave ${k + 1} land near`).toBe(false); }
      expect(sampleEnvironment(climate, p.lon, p.lat).temperature).toBeGreaterThanOrEqual(27);
    });
  });

  it('keeps a new site 1,500 km from an active storm and from a pending low', () => {
    const s = natural(1);
    const first = site(s);
    for (let k = 0; k < 8; k++) {
      s.genesis.nextSpawnTick = s.tick;
      s.effects = s.effects.filter(e => e.type === 'low').slice(0, 1);
      s.storms = [];
      stepGame(s);
      if (s.genesis.waves === 1) continue;
      const lows = s.effects.filter(e => e.type === 'low');
      expect(lows).toHaveLength(2);
      expect(distanceKm(lows[0].lon, lows[0].lat, lows[1].lon, lows[1].lat)).toBeGreaterThanOrEqual(1500);
      expect(distanceKm(first.lon, first.lat, lows[1].lon, lows[1].lat)).toBeGreaterThanOrEqual(1500);
      return;
    }
    throw new Error('no second wave placed');
  });

  it('differs between seeds, repeats for one seed, and names the basin in both languages', () => {
    const a = natural(1); const b = natural(2);
    expect(site(a)).not.toEqual(site(b));
    expect(site(a)).toEqual(site(natural(1)));
    expect(new Set([1, 2, 3, 4, 5, 6].map(seed => site(natural(seed)).basin)).size).toBeGreaterThanOrEqual(3);
    const { text } = a.news.at(-1)!;
    expect(text).toMatch(/near \d+\.\d°[EW] \d+\.\d°[NS] \(.+\)\. Weaken/);
    setLanguage('ko');
    expect(t(text)).not.toMatch(/[A-Za-z]/);
    expect(t(text)).toContain(t(site(a).basin));
  });

  it('forms a storm from a southern-hemisphere wave and replays a long natural run exactly', () => {
    const s = natural(1);
    expect(site(s).lat).toBeLessThan(0);
    run(s, 72);
    expect(s.peakWind).toBeGreaterThanOrEqual(33);
    expect(s.genesis.waves).toBeGreaterThanOrEqual(2);
    const result = replayGame(s.seed, s.actions, s.tick);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.state.effects).toEqual(s.effects);
    expect(result.state.genesis).toEqual(s.genesis);
  }, 30_000);
});
