import { describe, expect, it } from 'vitest';
import { MAX_ACTIVE_EFFECTS, createGame, formationRecipe, placeTool, stepGame } from '../src/simulation/engine';

function form(lon: number, lat: number) {
  const s = createGame(1);
  const advice = formationRecipe(s, lon, lat);
  for (const type of advice.placements) expect(placeTool(s, type, lon, lat).ok).toBe(true);
  for (let i = 0; i < 600 && !s.storms.length; i++) stepGame(s);
  return s;
}

describe('formation recipe', () => {
  it('is small in the warm western Pacific and forms a storm when placed', () => {
    const a = formationRecipe(createGame(1), 140, 15);
    expect(a.recipe.warm).toBeLessThanOrEqual(1);
    expect(a.recipe.moisture).toBeLessThanOrEqual(1);
    expect(a.recipe.low).toBe(1);
    expect(a.ok).toBe(true);
    expect(form(140, 15).storms.length).toBeGreaterThan(0);
  });

  it('asks for a deep stack over the Tyrrhenian Sea and forms a storm when placed', () => {
    const a = formationRecipe(createGame(1), 14.27, 38.72);
    expect(a.recipe.warm).toBeGreaterThanOrEqual(4);
    expect(a.recipe.lowShear).toBe(2);
    expect(a.ok).toBe(true);
    expect(form(14.27, 38.72).storms.length).toBeGreaterThan(0);
  });

  it('refuses land and flags hopeless polar water', () => {
    const land = formationRecipe(createGame(1), 127, 37.5);
    expect(land.land).toBe(true);
    expect(land.ok).toBe(false);
    expect(land.placements).toEqual([]);
    const north = formationRecipe(createGame(1), -30, 62);
    expect(north.impossibleShear || north.cold).toBe(true);
    expect(formationRecipe(createGame(1), 14.27, 60).land).toBe(true);
  });

  it('counts placed effects at full weight and flags a full effect list', () => {
    const s = createGame(1);
    const before = formationRecipe(s, 14.27, 38.72);
    for (const type of before.placements) placeTool(s, type, 14.27, 38.72);
    const after = formationRecipe(s, 14.27, 38.72);
    expect(after.potential).toBeGreaterThanOrEqual(0.9);
    expect(after.recipe.warm).toBe(0);
    expect(after.placements).toEqual([]);
    expect(after.ok).toBe(true);
    const crowded = createGame(1);
    for (let i = 0; i < MAX_ACTIVE_EFFECTS; i++) placeTool(crowded, 'moisture', -150, -30);
    expect(formationRecipe(crowded, 140, 15).maxEffects).toBe(true);
    expect(formationRecipe(createGame(1), 140, 15).maxEffects).toBe(false);
  });
});
