import { describe, expect, it } from 'vitest';
import { NATURAL_DECAY_HOURS, TICKS_PER_HOUR, createGame, intensityTendency, placeTool, sampleEnvironment, stepGame } from '../src/simulation/engine';
import type { GameState, ToolType } from '../src/types';

const step = (s: GameState, hours: number) => { for (let i = 0; i < hours * TICKS_PER_HOUR; i++) stepGame(s); };
function formedStorm(): GameState {
  const s = createGame();
  for (const t of ['warm', 'moisture', 'low'] as ToolType[]) expect(placeTool(s, t, 140, 16).ok).toBe(true);
  while (!s.storms.length) stepGame(s);
  return s;
}

describe('tropical cyclone lifetime', () => {
  // Cool sea: the ceiling is far below the wind, so the ocean term is pure decay.
  const env = { ...sampleEnvironment(createGame(), 140, 16), temperature: 25, humidity: 0.7, shear: 8 };

  it('weakens slowly by nature, and one weakening condition restores the original 20 h rate', () => {
    const natural = intensityTendency(env, 40, 0);
    expect(natural).toBeLessThan(0);
    expect(intensityTendency({ ...env, cooling: 3 }, 40, 0) / natural).toBeCloseTo(NATURAL_DECAY_HOURS / 20, 9);
    // Stacked conditions never weaken faster than before (20 h floor; other damping is unchanged).
    expect(intensityTendency({ ...env, cooling: 9 }, 40, 0)).toBe(intensityTendency({ ...env, cooling: 3 }, 40, 0));
    expect(intensityTendency({ ...env, cooling: 1.5 }, 40, 0)).toBeLessThan(natural);
    expect(intensityTendency({ ...env, cooling: 1.5 }, 40, 0)).toBeGreaterThan(intensityTendency({ ...env, cooling: 3 }, 40, 0));
  });

  it('lets an undisturbed western Pacific storm live about a week, then still dissipate', () => {
    const s = formedStorm();
    const born = s.hours;
    while (s.storms.length && s.hours < born + 400) stepGame(s);
    expect(s.stormArchive).toHaveLength(1);
    const life = s.stormArchive[0].endedHour - born;
    expect(life).toBeGreaterThan(160); // 120 h before the longer-survival tuning
    expect(life).toBeLessThan(400);
    expect(s.stormArchive[0].peakWind).toBeGreaterThanOrEqual(32.7);
  }, 30_000);

  it('still lets the four weakening conditions cut a mature storm down quickly', () => {
    const base = formedStorm();
    step(base, 48);
    const shielded = structuredClone(base);
    const st = shielded.storms[0];
    for (const t of ['cool', 'dry', 'cold-air', 'downdraft'] as ToolType[]) expect(placeTool(shielded, t, st.lon, st.lat).ok).toBe(true);
    step(base, 24); step(shielded, 24);
    expect(base.storms[0].wind).toBeGreaterThan(30);
    expect(shielded.storms.length === 0 || shielded.storms[0].wind < base.storms[0].wind - 12).toBe(true);
  }, 30_000);
});
