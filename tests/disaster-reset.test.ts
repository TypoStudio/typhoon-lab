import { describe, expect, it, vi } from 'vitest';
import { climateIsNormal, createGame, disastersActive, placeFormation, placeTool, replayActivatesClimateLayer, replayGame, resetClimateNow, resetConditionsNow, resetDisastersNow, setClimate, setGenesis, stepGame, validateActions } from '../src/simulation/engine';
import { actionKey, buildReplay } from '../src/ui/storage';

vi.setConfig({ testTimeout: 300_000 });
const SEED = 20261022;
const DOY = 213;
type Game = ReturnType<typeof createGame>;

/** A summer world with a recipe storm, a fine-dust event, a placed condition and a few days of damage. */
function busyWorld(): Game {
  const s = createGame(SEED, DOY);
  setGenesis(s, true);
  expect(placeFormation(s, 'typhoon', 140, 16).ok).toBe(true);
  expect(placeFormation(s, 'finedust', 117, 39).ok).toBe(true);
  expect(placeTool(s, 'warm', 150, 5).ok).toBe(true);
  for (let i = 0; i < 96 * 4 && !(s.storms.length > 0 && s.fineDustRows); i++) stepGame(s);
  return s;
}

describe('resetting disasters', () => {
  it('is rejected, and not recorded, when nothing is active', () => {
    const s = createGame(SEED, DOY);
    expect(disastersActive(s)).toBe(false);
    expect(resetDisastersNow(s).ok).toBe(false);
    expect(s.actions).toEqual([]);
  });

  it('ends storms, hazards, fine dust and thunderstorms but keeps damage, records, conditions and the climate reset', () => {
    const s = busyWorld();
    expect(s.storms.length).toBeGreaterThan(0);
    expect(s.weatherHazards.some(h => h.kind === 'finedust')).toBe(true);
    expect(s.fineDustRows).toBeDefined();
    s.thunderstorms.push({ id: 900, lon: 120, lat: 30, intensity: 0.6, radiusKm: 30, gustMs: 20, cloudTopC: -50, ageHours: 1, durationHours: 3 });
    for (let i = 0; i < 40; i++) stepGame(s);
    s.thunderstorms.push({ id: 901, lon: 121, lat: 30, intensity: 0.6, radiusKm: 30, gustMs: 20, cloudTopC: -50, ageHours: 1, durationHours: 3, tornado: true });
    setClimate(s, 'enso', 1.5);
    const before = { score: s.score, news: s.news.length, archive: s.stormArchive.length, records: (s.disasters ?? []).length, cities: s.cities.map(c => c.score), damage: s.grid.map(c => c.maxDamage),
      genesis: s.genesis.enabled, tick: s.tick, conditions: s.effects.filter(e => !e.formation).length };
    expect(before.conditions).toBeGreaterThan(0);
    const storms = s.storms.length;
    expect(disastersActive(s)).toBe(true);

    expect(resetClimateNow(s).ok).toBe(true);
    expect(resetDisastersNow(s)).toEqual({ ok: true });
    expect(s.actions.slice(-2).map(a => a.type)).toEqual(['climate-reset', 'disaster-reset']);

    expect(s.storms).toEqual([]); expect(s.remnants).toEqual([]); expect(s.candidates).toEqual([]);
    expect(s.thunderstorms).toEqual([]); expect(s.weatherHazards).toEqual([]);
    expect(s.fineDustRows).toBeUndefined();
    expect(s.grid.every(c => c.pm25 === 0 && !c.blizzard)).toBe(true);
    expect(s.effects.some(e => e.formation)).toBe(false);
    expect(s.effects.filter(e => !e.formation).length).toBe(before.conditions);
    expect(s.historic.every(h => h.finished)).toBe(true);
    expect((s.disasters ?? []).every(r => r.endedHour !== undefined)).toBe(true);
    expect(disastersActive(s)).toBe(false);
    expect(climateIsNormal(s)).toBe(true);
    expect(resetDisastersNow(s).ok).toBe(false);

    expect(s.score).toBe(before.score);
    expect(s.cities.map(c => c.score)).toEqual(before.cities);
    expect(s.grid.map(c => c.maxDamage)).toEqual(before.damage);
    expect(s.stormArchive.length).toBe(before.archive + storms);
    expect((s.disasters ?? []).length).toBeGreaterThanOrEqual(before.records); // a record is never dropped
    expect(s.news.length).toBeGreaterThan(before.news);
    expect(s.genesis.enabled).toBe(before.genesis);
    expect(s.tick).toBe(before.tick);

    // The reset stays reset: a few hours later nothing from the old events is back.
    for (let i = 0; i < 8; i++) stepGame(s);
    expect(s.weatherHazards.filter(h => h.kind === 'finedust')).toEqual([]);
    expect(s.grid.every(c => c.pm25 === 0)).toBe(true);
  });

  it('replays to the same world', () => {
    const s = busyWorld();
    setClimate(s, 'warming', 1);
    resetClimateNow(s);
    resetDisastersNow(s);
    for (let i = 0; i < 12; i++) stepGame(s);
    const r = replayGame(SEED, s.actions, s.tick, DOY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.storms.map(x => x.id)).toEqual(s.storms.map(x => x.id));
    expect(r.state.stormArchive.length).toBe(s.stormArchive.length);
    expect(r.state.weatherHazards).toEqual(s.weatherHazards);
    expect(r.state.score).toBe(s.score);
    expect(r.state.fineDustRows).toEqual(s.fineDustRows);
    expect(r.state.grid.map(c => c.pm25)).toEqual(s.grid.map(c => c.pm25));
    expect(r.state.news.length).toBe(s.news.length);
  });

  it('is validated, keyed, cleaned and exported as its own action', () => {
    const s = busyWorld();
    resetDisastersNow(s);
    expect(validateActions([{ tick: 0, type: 'disaster-reset', extra: 1 }])).toEqual({ ok: true, actions: [{ tick: 0, type: 'disaster-reset' }] });
    expect(replayGame(SEED, [{ tick: 0, type: 'disaster-reset' }], 0, DOY).ok).toBe(false); // nothing active
    expect(actionKey(s.actions.at(-1)!)).toEqual([s.tick, 'disaster-reset']);
    expect(buildReplay(s).actions.at(-1)).toEqual({ tick: s.tick, type: 'disaster-reset' });
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'disaster-reset' }])).toBe(false);
  });

  it('conditions-reset removes every effect, keeps storms, and replays to the same world', () => {
    const s = createGame(SEED, DOY);
    expect(resetConditionsNow(s).ok).toBe(false);
    expect(s.actions).toEqual([]);
    placeTool(s, 'warm', 150, 5); placeTool(s, 'cool', -170, 0);
    placeFormation(s, 'typhoon', 140, 16);
    for (let i = 0; i < 24; i++) stepGame(s);
    s.storms.push({ id: 777, lon: 130, lat: 20, wind: 30, movementSpeedKmh: 10, pressure: 970, radiusKm: 200, galeRadiusKm: 100, stage: 'typhoon', ageHours: 5, peakWind: 30, track: [], forecast: [], history: [], damageScore: 0, windDelta: 0 });
    const storms = s.storms.length;
    expect(s.effects.length).toBeGreaterThan(0);
    expect(resetConditionsNow(s)).toEqual({ ok: true });
    expect(s.effects).toEqual([]);
    expect(s.storms.length).toBe(storms);
    expect(s.actions.at(-1)).toEqual({ tick: s.tick, type: 'conditions-reset' });
    expect(resetConditionsNow(s).ok).toBe(false);
    expect(validateActions([{ tick: 0, type: 'conditions-reset', x: 1 }])).toEqual({ ok: true, actions: [{ tick: 0, type: 'conditions-reset' }] });
    expect(actionKey(s.actions.at(-1)!)).toEqual([s.tick, 'conditions-reset']);
    expect(buildReplay(s).actions.at(-1)).toEqual({ tick: s.tick, type: 'conditions-reset' });
    s.storms.pop();
    for (let i = 0; i < 12; i++) stepGame(s);
    const r = replayGame(SEED, s.actions, s.tick, DOY);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.state.effects).toEqual(s.effects); expect(r.state.score).toBe(s.score); }
  });
});
