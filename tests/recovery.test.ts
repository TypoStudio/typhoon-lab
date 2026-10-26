import { describe, expect, it } from 'vitest';
import { CITIES } from '../src/data/world';
import {
  RECOVERY_DELAY_HOURS, RECOVERY_TAU_HOURS, STEP_HOURS, createGame, getStaticGrid, loadHistoric, placeTool, replayGame, stepGame,
} from '../src/simulation/engine';
import type { GameState } from '../src/types';

const runHours = (s: GameState, hours: number) => {
  const until = s.tick + Math.round(hours / STEP_HOURS);
  while (s.tick < until) stepGame(s);
};

describe('damage recovery', () => {
  it('waits a day, then decays the current damage while the cumulative score stays', () => {
    expect(RECOVERY_DELAY_HOURS).toBe(24);
    expect(RECOVERY_TAU_HOURS).toBe(168);
    const s = createGame(1);
    const { shares } = getStaticGrid();
    const city = CITIES.findIndex(c => c.id === 'manila');
    let k = -1;
    s.grid.forEach((c, i) => { if (shares[i].some(x => x.city === city) && (k < 0 || c.population > s.grid[k].population)) k = i; });
    expect(k).toBeGreaterThanOrEqual(0);
    const cell = s.grid[k];
    cell.maxDamage = 0.1;
    s.score = 0.1 * cell.population;
    for (const x of shares[k]) s.cities[x.city].damage = s.cities[x.city].score = 0.1 * x.share;
    const touched = shares[k].map(x => ({ i: x.city, score: 0.1 * x.share }));
    const total = () => touched.reduce((sum, t) => sum + s.cities[t.i].damage, 0);
    const startTotal = total();

    runHours(s, RECOVERY_DELAY_HOURS - STEP_HOURS);
    expect(cell.maxDamage).toBe(0.1);
    expect(total()).toBe(startTotal);
    runHours(s, STEP_HOURS); // the first repair step lands exactly at the delay
    expect(cell.maxDamage).toBeLessThan(0.1);
    runHours(s, RECOVERY_TAU_HOURS);
        expect(cell.maxDamage / 0.1).toBeGreaterThan(Math.exp(-1) * 0.98);
    expect(cell.maxDamage / 0.1).toBeLessThan(Math.exp(-1) * 1.02);
    expect(total() / startTotal).toBeCloseTo(cell.maxDamage / 0.1, 9);
    for (const t of touched) expect(s.cities[t.i].score).toBeCloseTo(t.score, 12);
    expect(s.score).toBeCloseTo(0.1 * cell.population, 6);
  });

  it('a storm leaves cities recovering after it passes and reports their recovery', () => {
    const s = createGame(1);
    expect(loadHistoric(s, 'maemi-2003')).toEqual({ ok: true });
    while (!s.historic.every(h => h.finished) && s.tick < 400_000) stepGame(s);
    const scoreAtEnd = s.score;
    const damageAtEnd = s.cities.map(c => c.damage);
    runHours(s, 24 * 14);
    s.cities.forEach((c, i) => {
      expect(c.damage, c.id).toBeLessThanOrEqual(c.score + 1e-6);
      if (damageAtEnd[i] > 1e-6) expect(c.damage, c.id).toBeLessThan(damageAtEnd[i]);
    });
    expect(s.cities.some(c => c.score > 0)).toBe(true);
    expect(s.score).toBe(scoreAtEnd);
    const recovered = s.news.filter(n => n.kind === 'recovery');
    expect(recovered.length).toBeGreaterThan(0);
    for (const n of recovered) {
      expect(n.id).toMatch(/^recovery-.+-\d+$/);
      expect(n.title).toMatch(/ recovers$/);
      expect(n.text).toMatch(/Cumulative losses stand at USD [\d,]+\.$/);
      expect(n.damage).toBeDefined();
    }
  }, 60_000);

  it('replays a storm and its recovery to the identical damage, repair clocks and news', () => {
    const dhaka = CITIES.find(c => c.id === 'dhaka')!;
    const s = createGame();
    for (const tool of ['moisture', 'warm-air', 'updraft'] as const) expect(placeTool(s, tool, dhaka.lon, dhaka.lat).ok).toBe(true);
    runHours(s, 24 * 8);
    const i = CITIES.indexOf(dhaka);
    expect(s.cities[i].score).toBeGreaterThan(0);
    expect(s.cities[i].damage).toBeLessThan(s.cities[i].score);
    expect(s.grid.some(c => c.maxDamage > 0 && c.calmHours > RECOVERY_DELAY_HOURS)).toBe(true);
    const r = replayGame(s.seed, s.actions, s.tick);
    if (!r.ok) throw new Error(r.reason);
    expect(r.state.cities.map(c => c.damage)).toEqual(s.cities.map(c => c.damage));
    expect(r.state.grid.map(c => [c.maxDamage, c.calmHours])).toEqual(s.grid.map(c => [c.maxDamage, c.calmHours]));
    expect(r.state.news).toEqual(s.news);
  }, 60_000);
});
