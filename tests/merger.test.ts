import { describe, expect, it } from 'vitest';
import { createGame, placeTool, stepGame, replayGame, totalPressure, MERGER_MIN_AGE_HOURS, MERGER_DISTANCE_KM, STEP_HOURS } from '../src/simulation/engine';
import type { GameState } from '../src/types';

function stepUntil(s: GameState, done: () => boolean, hours = 80) {
  const until = s.tick + hours / STEP_HOURS;
  while (!done() && s.tick < until) stepGame(s);
  expect(done()).toBe(true);
}
function twoYoung() {
  const s = createGame();
  for (const type of ['warm', 'moisture', 'low', 'low'] as const) expect(placeTool(s, type, 140, 16).ok).toBe(true);
  stepUntil(s, () => s.storms.length === 2);
  return s;
}
function maturePair() {
  const s = twoYoung();
  for (const storm of s.storms) { storm.ageHours = MERGER_MIN_AGE_HOURS; storm.wind = 40; storm.peakWind = 40; }
  return s;
}

describe('developed storm mergers', () => {
  it('allows independent births, later merges naturally, and replays the result exactly', () => {
    const s = twoYoung();
    expect(s.news.filter(n => n.kind === 'formation')).toHaveLength(2);
    const birthIds = s.storms.map(st => st.id);
    stepUntil(s, () => Math.min(...s.storms.map(st => st.ageHours)) >= 20);
    expect(s.storms).toHaveLength(2);
    expect(s.news.some(n => n.kind === 'merger')).toBe(false);
    stepUntil(s, () => s.news.some(n => n.kind === 'merger'));
    expect(s.storms).toHaveLength(1);
    const merged = s.storms[0];
    expect(merged.ageHours).toBeGreaterThanOrEqual(MERGER_MIN_AGE_HOURS);
    const event = s.news.find(n => n.kind === 'merger')!;
    expect([event.absorbedId, event.mergedIntoId].sort()).toEqual(birthIds.sort());
    expect(event.mergedIntoId).toBe(merged.id);
    expect(totalPressure(s, merged.lon, merged.lat)).toBeCloseTo(merged.pressure, 8);
    expect(merged.track.at(-1)).toEqual({ lon: merged.lon, lat: merged.lat });
    expect(merged.forecast.length).toBeGreaterThan(0);
    for (let i = 0; i < 8; i++) stepGame(s);
    expect(s.news.filter(n => n.kind === 'merger')).toHaveLength(1);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state).toEqual(s);
  });

  it('retains the stronger ID without adding wind speeds, and keeps organising lows', () => {
    const s = maturePair();
    s.storms[0].wind = 45; s.storms[0].peakWind = 45;
    const strongId = s.storms[0].id;
    const weakId = s.storms[1].id;
    expect(placeTool(s, 'low', 140, 16).ok).toBe(true);
    const low = s.effects.at(-1)!;
    low.ageHours = 6;
    s.candidates.push({ id: low.id, lon: low.lon, lat: low.lat, progressHours: 3 });
    stepGame(s);
    expect(s.storms).toHaveLength(1);
    expect(s.storms[0].id).toBe(strongId);
    expect(s.storms[0].wind).toBeGreaterThan(44);
    expect(s.storms[0].wind).toBeLessThan(46);
    expect(s.news.find(n => n.kind === 'merger')).toMatchObject({ absorbedId: weakId, mergedIntoId: strongId });
    expect(s.candidates.find(c => c.id === low.id)!.progressHours).toBeGreaterThan(3);
    expect(s.effects.some(e => e.id === low.id)).toBe(true);
    for (const cell of s.grid) expect(Number.isFinite(cell.pressure + cell.u + cell.v)).toBe(true);
  });

  it('does not merge young, weak, distant or opposite-hemisphere storms', () => {
    for (const situation of ['young', 'weak', 'distant', 'opposite']) {
      const s = maturePair();
      if (situation === 'young') s.storms[1].ageHours = 0;
      if (situation === 'weak') s.storms[1].wind = 13;
      if (situation === 'distant') s.storms[1].lon += MERGER_DISTANCE_KM / 100 + 1;
      if (situation === 'opposite') { s.storms[0].lat = 0.1; s.storms[1].lat = -0.1; }
      stepGame(s);
      expect(s.storms, situation).toHaveLength(2);
      expect(s.news.some(n => n.kind === 'merger'), situation).toBe(false);
    }
  });

  it('merges across the dateline without moving the centre to the other side of the world', () => {
    const s = maturePair();
    s.storms[0].lon = 179.8; s.storms[1].lon = -179.8;
    stepGame(s);
    expect(s.storms).toHaveLength(1);
    const survivor = s.storms[0];
    expect(Math.abs(survivor.lon)).toBeGreaterThan(179.5);
    expect(totalPressure(s, survivor.lon, survivor.lat)).toBeCloseTo(survivor.pressure, 8);
  });

  it('selects disjoint closest pairs deterministically regardless of storm-array order', () => {
    const s = maturePair();
    s.storms.push({ ...structuredClone(s.storms[0]), id: 99, lon: 140.05 });
    const reversed = structuredClone(s);
    reversed.storms.reverse();
    stepGame(s); stepGame(reversed);
    expect(s.storms).toHaveLength(2); // one storm cannot be consumed twice in a step
    expect(s.news.filter(n => n.kind === 'merger')).toHaveLength(1);
    expect(s.storms.map(st => st.id).sort()).toEqual(reversed.storms.map(st => st.id).sort());
    expect(s.news.filter(n => n.kind === 'merger')).toEqual(reversed.news.filter(n => n.kind === 'merger'));
  });
});
