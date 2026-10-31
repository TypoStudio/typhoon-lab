import { describe, expect, it } from 'vitest';
import { blizzardRecipe, createGame, placeFormation, replayGame, stepGame, tornadoRecipe } from '../src/simulation/engine';

describe('new formation probes', () => {
  it('places a cold-weather recipe that produces blizzard cells', () => {
    const state = createGame(1);
    const advice = blizzardRecipe(state, -30, 62);
    expect(advice.ok).toBe(true);
    expect(placeFormation(state, 'blizzard', -30, 62).ok).toBe(true);
    for (let i = 0; i < 96 && state.blizzardCells === 0; i++) stepGame(state);
    expect(state.blizzardCells).toBeGreaterThan(0);
    expect(state.disasters!.some(record => record.kind === 'blizzard' && record.endedHour === undefined)).toBe(true);
  });

  it('places a warm-weather recipe that produces a visible, replayable tornado', () => {
    const state = createGame(1, 210);
    const lon = 127, lat = 37.5;
    const advice = tornadoRecipe(state, lon, lat);
    expect(advice.ok).toBe(true);
    expect(placeFormation(state, 'tornado', lon, lat).ok).toBe(true);
    let farthestKm = 0;
    let longestTrack = 0;
    for (let i = 0; i < 96; i++) {
      stepGame(state);
      for (const storm of state.thunderstorms) {
        farthestKm = Math.max(farthestKm, storm.tornadoDistanceKm ?? 0);
        longestTrack = Math.max(longestTrack, storm.tornadoTrack?.length ?? 0);
      }
    }
    expect(state.news.some(n => n.kind === 'tornado')).toBe(true);
    expect(state.disasters!.some(record => record.kind === 'tornado')).toBe(true);
    expect(farthestKm).toBeGreaterThanOrEqual(100);
    expect(longestTrack).toBeGreaterThan(2);
    expect(state.news.some(n => n.title.startsWith('Long-track tornado'))).toBe(true);
    const replay = replayGame(state.seed, state.actions, state.tick, state.initialStartDayOfYear);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.state.news.filter(n => n.kind === 'tornado')).toEqual(state.news.filter(n => n.kind === 'tornado'));
      expect(replay.state.disasters).toEqual(state.disasters);
    }
  });
});
