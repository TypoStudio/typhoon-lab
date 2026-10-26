import { describe, expect, it } from 'vitest';
import {
  GRID_STEP, MAX_THUNDERSTORMS, THUNDERSTORM_THRESHOLD, TICKS_PER_HOUR, convectivePotential, createGame, damageRatio,
  placeTool, replayGame, setGenesis, stepGame,
} from '../src/simulation/engine';
import { CITIES } from '../src/data/world';
import type { GameState, ToolType } from '../src/types';

const DHAKA = CITIES.find(c => c.id === 'dhaka')!;
const CONVECTIVE: ToolType[] = ['moisture', 'warm-air', 'updraft'];
const run = (s: GameState, hours: number, each?: () => void) => {
  for (let i = 0; i < hours * TICKS_PER_HOUR; i++) { stepGame(s); each?.(); }
};
function place(s: GameState, tools: ToolType[], lon = DHAKA.lon, lat = DHAKA.lat) {
  for (const t of tools) expect(placeTool(s, t, lon, lat).ok).toBe(true);
}
/** Largest cell damage ratio one thunderstorm can leave: peak gust 38 m/s over a 45 km radius. */
function cellCap(lat: number): number {
  const cellKm2 = GRID_STEP * 111.32 * Math.cos(lat * Math.PI / 180) * GRID_STEP * 110.57;
  return damageRatio(38) * Math.PI * 45 ** 2 / cellKm2;
}

describe('thunderstorms', () => {
  it('need lift: none in an untouched world, from the genesis recipe, or in a protected natural-formation wave', () => {
    expect(convectivePotential(0.9, 0, 0, 30)).toBe(0);
    expect(convectivePotential(0.76, 3, 1, 28)).toBeGreaterThan(THUNDERSTORM_THRESHOLD);
    expect(convectivePotential(0.76, 3, 1, 8)).toBe(0); // too cold for deep convection
    const worlds = [createGame(), createGame(7), createGame()];
    place(worlds[2], ['warm', 'moisture', 'low'], 140, 16);
    for (const s of worlds) {
      run(s, 48, () => expect(s.thunderstorms).toEqual([]));
      expect(s.grid.every(c => c.convection === 0)).toBe(true);
      expect(s.nextThunderstormId).toBe(1);
    }
    const natural = createGame(5);
    setGenesis(natural, true);
    const low = natural.effects.find(e => e.type === 'low')!;
    place(natural, ['cool', 'dry', 'cold-air', 'downdraft'], low.lon, low.lat);
    run(natural, 24, () => expect(natural.thunderstorms).toEqual([]));
    expect(natural.score).toBe(0);
  }, 30_000);

  it('damage a city without any tropical cyclone, with render-ready fields and a thunderstorm bulletin', () => {
    const s = createGame();
    place(s, CONVECTIVE);
    let seen = 0;
    run(s, 48, () => {
      expect(s.thunderstorms.length).toBeLessThanOrEqual(MAX_THUNDERSTORMS);
      for (const t of s.thunderstorms) {
        seen = Math.max(seen, t.id);
        expect(t.intensity).toBeGreaterThanOrEqual(0); expect(t.intensity).toBeLessThanOrEqual(1);
        expect(t.gustMs).toBeCloseTo(8 + 30 * t.intensity, 9);
        expect(t.cloudTopC).toBeLessThanOrEqual(-20); expect(t.cloudTopC).toBeGreaterThanOrEqual(-75);
        expect(t.ageHours).toBeLessThan(t.durationHours);
        expect(t.durationHours).toBeGreaterThanOrEqual(3); expect(t.durationHours).toBeLessThan(6);
      }
    });
    expect(seen).toBeGreaterThan(1);
    expect(s.storms).toEqual([]); expect(s.stormArchive).toEqual([]); expect(s.peakWind).toBe(0);
    const impact = s.cities[CITIES.indexOf(DHAKA)];
    expect(impact.score).toBeGreaterThan(0);
    expect(impact.exposedPopulation).toBeGreaterThan(0);
    expect(impact.maxWind).toBeGreaterThan(17.2);
    expect(s.news.some(n => n.id === 'thunderstorm-1' && n.kind === 'info')).toBe(true);
    const bulletin = s.news.find(n => n.id.startsWith('city-dhaka-0-'))!;
    expect(bulletin.text).toMatch(/^Severe thunderstorms in Dhaka/);
    expect(bulletin.damage!.displaced).toBeGreaterThan(0);
  }, 30_000);

  it('keep population damage capped however long the outbreak is sustained', () => {
    const s = createGame();
    for (let day = 0; day < 5; day++) { place(s, CONVECTIVE); run(s, 24); }
    for (const c of s.grid) expect(c.maxDamage).toBeLessThanOrEqual(cellCap(c.lat) + 1e-12);
    for (const [i, city] of CITIES.entries()) expect(s.cities[i].score / city.population, city.id).toBeLessThan(0.03);
    expect(s.score).toBeLessThan(s.exposedPopulation * 0.03);
  }, 30_000);

  it('are suppressed by cold air and downdraft placed on the same spot', () => {
    const s = createGame();
    place(s, [...CONVECTIVE, 'cold-air', 'downdraft']);
    run(s, 48, () => expect(s.thunderstorms).toEqual([]));
    expect(s.score).toBe(0);
  }, 30_000);

  it('replay exactly, including mid-life cells, ids, damage and news', () => {
    const s = createGame();
    place(s, CONVECTIVE);
    run(s, 20);
    place(s, CONVECTIVE, DHAKA.lon + 6, DHAKA.lat - 2);
    run(s, 10.25);
    expect(s.thunderstorms.length).toBeGreaterThan(0);
    const result = replayGame(s.seed, s.actions, s.tick);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    expect(result.state.thunderstorms).toEqual(s.thunderstorms);
    expect(result.state.nextThunderstormId).toBe(s.nextThunderstormId);
    expect(result.state).toEqual(s);
  }, 30_000);
});
