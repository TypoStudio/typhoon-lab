import { describe, expect, it } from 'vitest';
import { createGame, genesisPotential, intensityTendency, placeTool, replayGame, sampleEnvironment, stepGame, validateActions } from '../src/simulation/engine';
import type { GameState, ToolType } from '../src/types';

const site = { lon: 140, lat: 16 };
function place(s: GameState, types: ToolType[]) {
  for (const type of types) expect(placeTool(s, type, site.lon, site.lat).ok).toBe(true);
}
function run(s: GameState, ticks: number) { for (let i = 0; i < ticks; i++) stepGame(s); }
function sample(s: GameState) { return sampleEnvironment(s, site.lon, site.lat); }

describe('warm air and updraft conditions', () => {
  it('keeps sea temperature and humidity separate, and bounds repeated air/lift placements', () => {
    const s = createGame();
    const base = sample(s);
    place(s, ['warm-air', 'warm-air', 'warm-air', 'updraft', 'updraft', 'updraft', 'updraft']);
    run(s, 24);
    const env = sample(s);
    expect(env.airTemperature - base.airTemperature).toBeCloseTo(6);
    expect(env.airHeating).toBe(6);
    expect(env.updraft).toBe(3);
    expect(env.temperature).toBe(base.temperature);
    expect(env.humidity).toBe(base.humidity);
    expect(env.pressure).toBe(base.pressure);
    expect(env.u).toBe(base.u);
    expect(env.v).toBe(base.v);
    expect(s.storms).toHaveLength(0);
    expect(s.candidates).toHaveLength(0);
  });

  it('supports genesis and strengthening without bypassing cold ocean, dry air or land', () => {
    const env = { ...sample(createGame()), humidity: 0.8, pressure: 1003 };
    for (const added of [{ airHeating: 3 }, { updraft: 1 }]) {
      const boosted = { ...env, ...added };
      expect(genesisPotential(boosted, 16)).toBeGreaterThan(genesisPotential(env, 16));
      expect(intensityTendency(boosted, 20, 0)).toBeGreaterThan(intensityTendency(env, 20, 0));
      expect(genesisPotential({ ...boosted, land: true }, 16)).toBe(0);
      expect(genesisPotential({ ...boosted, temperature: 24 }, 16)).toBe(0);
      expect(genesisPotential({ ...boosted, humidity: 0.4 }, 16)).toBe(0);
      expect(intensityTendency({ ...boosted, temperature: 24 }, 30, 0)).toBeLessThan(0);
      expect(intensityTendency(boosted, 30, 1)).toBe(intensityTendency(env, 30, 1));
    }
  });

  it('actually advances formation when added to the original three-condition recipe', () => {
    const base = createGame(); const boosted = createGame();
    place(base, ['warm', 'moisture', 'low']);
    place(boosted, ['warm', 'moisture', 'low', 'warm-air', 'updraft']);
    for (const s of [base, boosted]) for (let tick = 0; tick < 200 && !s.storms.length; tick++) stepGame(s);
    expect(base.storms).toHaveLength(1); expect(boosted.storms).toHaveLength(1);
    expect(boosted.hours).toBeLessThan(base.hours);
  });

  it('keeps the rendered grid equal to sampling and removes fields when tools expire', () => {
    const s = createGame();
    place(s, ['warm-air', 'updraft']);
    run(s, 24);
    for (const c of s.grid.filter(c => c.lon >= 135 && c.lon <= 145 && c.lat >= 11 && c.lat <= 21)) {
      const env = sampleEnvironment(s, c.lon, c.lat);
      expect(c.airTemperature).toBeCloseTo(env.airTemperature, 9);
      expect(c.updraft).toBeCloseTo(env.updraft, 9);
      expect(c.humidity).toBeCloseTo(env.humidity, 9);
    }
    run(s, 300);
    expect(s.effects).toHaveLength(0);
    expect(sample(s).airHeating).toBe(0); expect(sample(s).updraft).toBe(0);
    expect(s.grid.every(c => c.airHeating === 0 && c.updraft === 0)).toBe(true);
  });

  it('accepts the new action types and replays their storm and environment effects exactly', () => {
    const s = createGame(); place(s, ['warm', 'moisture', 'low', 'warm-air', 'updraft']); run(s, 100);
    expect(validateActions(s.actions, s.tick).ok).toBe(true);
    const result = replayGame(s.seed, s.actions, s.tick);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    const replay = result.state;
    expect(replay.storms).toEqual(s.storms);
    expect(replay.effects).toEqual(s.effects);
    expect(sample(replay)).toEqual(sample(s));
    expect(replay.news).toEqual(s.news);
  });
});
