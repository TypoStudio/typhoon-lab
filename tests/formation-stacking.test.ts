import { describe, expect, it } from 'vitest';
import { EFFECT_STACK_LIMITS, MAX_ACTIVE_EFFECTS, TOOLS, blizzardRecipe, createGame, formationRecipe, placeFormation, placeTool, replayGame, sampleEnvironment, stepGame, tornadoRecipe, validateActions } from '../src/simulation/engine';
import { buildReplay, parseReplay } from '../src/ui/storage';
import type { FormationKind, GameState, ToolType } from '../src/types';

function fullEffects(state: GameState, type: ToolType, count: number, lon: number, lat: number, formation?: FormationKind) {
  const tool = TOOLS.find(t => t.type === type)!;
  for (let i = 0; i < count; i++) state.effects.push({ id: 1000 + state.effects.length, type, lon, lat,
    radiusKm: tool.radiusKm, ageHours: 6, remainingHours: 72, ...(formation ? { formation } : {}) });
}

describe('unrestricted formation stacks', () => {
  it('uses terrain alone at the date line, the equator and both poles in summer and winter', () => {
    for (const day of [1, 213]) {
      const state = createGame(42, day);
      for (const [lon, lat] of [[180, 0], [-180, 0], [0, 90], [0, -90]]) {
        const typhoon = formationRecipe(state, lon, lat);
        expect(typhoon.ok).toBe(!typhoon.land);
        expect(typhoon.impossibleShear).toBe(false);
        expect(blizzardRecipe(state, lon, lat).ok).toBe(true);
        expect(tornadoRecipe(state, lon, lat).ok).toBe(true);
      }
    }
  });

  it('raises ordinary limits and keeps recipe effects additive in samples and the grid', () => {
    const state = createGame(1), lon = 141, lat = 15;
    fullEffects(state, 'warm-air', 10, lon, lat);
    fullEffects(state, 'updraft', 12, lon, lat);
    fullEffects(state, 'unstable-air', 9, lon, lat);
    fullEffects(state, 'high-shear', 10, lon, lat);
    let env = sampleEnvironment(state, lon, lat);
    const base = sampleEnvironment(createGame(1), lon, lat);
    expect(env.airHeating).toBe(EFFECT_STACK_LIMITS.air);
    expect(env.updraft).toBe(EFFECT_STACK_LIMITS.vertical);
    expect(env.instability).toBe(EFFECT_STACK_LIMITS.instability);
    expect(env.shear - base.shear).toBeCloseTo(EFFECT_STACK_LIMITS.shear);
    fullEffects(state, 'warm-air', 10, lon, lat, 'tornado');
    fullEffects(state, 'updraft', 12, lon, lat, 'tornado');
    fullEffects(state, 'unstable-air', 9, lon, lat, 'tornado');
    fullEffects(state, 'high-shear', 10, lon, lat, 'tornado');
    stepGame(state);
    env = sampleEnvironment(state, lon, lat);
    expect(env.airHeating).toBe(48);
    expect(env.updraft).toBe(21);
    expect(env.instability).toBe(15);
    expect(env.shear - base.shear).toBeCloseTo(160);
    const cell = state.grid.find(c => c.lon === lon && c.lat === lat)!;
    expect(cell.airHeating).toBeCloseTo(env.airHeating);
    expect(cell.updraft).toBeCloseTo(env.updraft);
    expect(cell.instability).toBeCloseTo(env.instability);
    expect(cell.shear).toBeCloseTo(env.shear);
  });

  for (const scenario of [
    { kind: 'blizzard', lon: 127.79, lat: 36.23, day: 213 },
    { kind: 'blizzard', lon: 140, lat: 15, day: 213 },
    { kind: 'blizzard', lon: 160, lat: 0, day: 213 },
    { kind: 'tornado', lon: -5, lat: 80, day: 1 },
    { kind: 'typhoon', lon: -5, lat: 80, day: 1 },
  ] as const) {
    it(`actually forms ${scenario.kind} at ${scenario.lon}, ${scenario.lat} despite the old climate limits`, () => {
      const { kind, lon, lat, day } = scenario;
      const state = createGame(1, day);
      const recipe = (kind === 'blizzard' ? blizzardRecipe : kind === 'tornado' ? tornadoRecipe : formationRecipe)(state, lon, lat);
      expect(recipe.ok).toBe(true);
      expect(recipe.maxEffects).toBe(false);
      if (kind === 'blizzard') expect(recipe.placements.filter(t => t === 'cold-air').length).toBeGreaterThan(2);
      if (kind === 'tornado') expect(recipe.placements.filter(t => t === 'warm-air').length).toBeGreaterThan(6);
      expect(placeFormation(state, kind, lon, lat).ok).toBe(true);
      const happened = () => kind === 'typhoon' ? state.storms.length > 0
        : kind === 'blizzard' ? state.blizzardCells > 0 : state.news.some(n => n.kind === 'tornado');
      for (let i = 0; i < 128 && !happened(); i++) stepGame(state);
      expect(happened()).toBe(true);
      const file = buildReplay(state), parsed = parseReplay(JSON.stringify(file));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.replay.actions).toEqual(state.actions);
      const replay = replayGame(state.seed, parsed.replay.actions, state.tick, day);
      expect(replay.ok).toBe(true);
      if (replay.ok) expect(replay.state).toEqual(state);
    });
  }

  it('places the complete recipe past 64 active effects and overcomes opposing tools', () => {
    const state = createGame(1), lon = 127.79, lat = 36.23;
    for (let i = 0; i < MAX_ACTIVE_EFFECTS; i++) expect(placeTool(state, i < 20 ? 'warm-air' : i < 40 ? 'dry' : 'high', lon, lat).ok).toBe(true);
    expect(placeTool(state, 'moisture', lon, lat).ok).toBe(false);
    expect(placeFormation(state, 'blizzard', lon, lat).ok).toBe(true);
    expect(state.effects.length).toBeGreaterThan(MAX_ACTIVE_EFFECTS);
    for (let i = 0; i < 48 && !state.blizzardCells; i++) stepGame(state);
    expect(state.blizzardCells).toBeGreaterThan(0);
    const replay = replayGame(state.seed, state.actions, state.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state).toEqual(state);
  });

  it('forms a sea depression even under a full stack of opposing highs and weakening conditions', () => {
    const state = createGame(1), lon = 140, lat = 15;
    for (const type of ['cool', 'dry', 'cold-air', 'downdraft', 'stable-air', 'high-shear', 'high', 'high'] as const) {
      for (let i = 0; i < 8; i++) expect(placeTool(state, type, lon, lat).ok).toBe(true);
    }
    const advice = formationRecipe(state, lon, lat);
    expect(advice.ok).toBe(true);
    expect(advice.projected).toBeGreaterThanOrEqual(1.3);
    expect(placeFormation(state, 'typhoon', lon, lat).ok).toBe(true);
    for (let i = 0; i < 128 && !state.storms.length; i++) stepGame(state);
    expect(state.storms.length).toBeGreaterThan(0);
  });

  it('keeps terrain validation and rejects invalid recipe tags without changing the world', () => {
    const state = createGame(1);
    const original = structuredClone(state);
    expect(placeFormation(state, 'typhoon', 127, 37.5).ok).toBe(false);
    expect(placeFormation(state, 'blizzard', NaN, 0).ok).toBe(false);
    expect(placeFormation(state, 'tornado', 0, 91).ok).toBe(false);
    expect(state).toEqual(original);
    expect(validateActions([{ tick: 0, type: 'cold-air', lon: 127, lat: 37, formation: 'unknown' }]).ok).toBe(false);
  });
});
