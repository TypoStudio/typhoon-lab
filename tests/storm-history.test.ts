import { describe, it, expect } from 'vitest';
import { createGame, placeTool, stepGame, replayGame, stageRank } from '../src/simulation/engine';
import { stormLossUsd } from '../src/simulation/damage-news';
import { stageChanges, stormGradeLabel } from '../src/storm-info';
import { MapView } from '../src/render/view';

describe('storm life records', () => {
  it('retains natural formation, growth, weakening and dissipation, and restores them by replay', () => {
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low'] as const) placeTool(s, tool, 140, 16);
    for (let i = 0; i < 1600 && !s.stormArchive.length; i++) stepGame(s);
    expect(s.stormArchive).toHaveLength(1);
    expect(s.storms).toHaveLength(0);
    const record = s.stormArchive[0];
    expect(record.endReason).toBe('dissipated');
    expect(record.forecast).toEqual([]);
    expect(record.history[0].wind).toBe(13);
    expect(record.history.at(-1)!.hour).toBe(record.endedHour);
    expect(record.track[0]).toEqual({ lon: 140, lat: 16 });
    expect(record.track.at(-1)).toEqual({ lon: record.lon, lat: record.lat });
    const changes = stageChanges(record);
    expect(changes.length).toBeGreaterThan(3);
    expect(changes.some(s => s.grade >= 3)).toBe(true);
    expect(changes.some((s, i) => i > 0 && s.grade < changes[i - 1].grade)).toBe(true);
    for (const sample of record.history) {
      expect(sample.grade).toBe(stageRank(sample.wind));
      expect(Number.isFinite(sample.pressure + sample.circulationRadiusKm)).toBe(true);
    }
    const saved = structuredClone(record);
    for (let i = 0; i < 8; i++) stepGame(s);
    expect(s.stormArchive[0]).toEqual(saved);
    const restored = replayGame(s.seed, s.actions, s.tick);
    expect(restored.ok).toBe(true);
    if (restored.ok) expect(restored.state).toEqual(s);
  }, 30_000);

  it('archives the absorbed storm once, but never archives a predicted merger', () => {
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low', 'low'] as const) placeTool(s, tool, 140, 16);
    while (!s.storms.length && s.tick < 200) stepGame(s);
    expect(s.storms).toHaveLength(2);
    expect(s.stormArchive).toHaveLength(0);
    // Forecasts may merge this pair; they must leave the live archive empty.
    placeTool(s, 'moisture', 140, 16);
    expect(s.stormArchive).toHaveLength(0);
    for (let i = 0; i < 200 && !s.stormArchive.length; i++) stepGame(s);
    expect(s.stormArchive).toHaveLength(1);
    expect(s.storms).toHaveLength(1);
    const record = s.stormArchive[0];
    expect(record.endReason).toBe('merged');
    expect(record.mergedIntoId).toBe(s.storms[0].id);
    expect(record.history.at(-1)!.hour).toBe(record.endedHour);
    const preserved = structuredClone(record);
    for (let i = 0; i < 8; i++) stepGame(s);
    expect(s.stormArchive).toEqual([preserved]);
    expect(createGame().stormArchive).toEqual([]);
  });

  it('records the damage each storm caused, keeps it in history, and prices it with the shared loss formula', () => {
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low'] as const) placeTool(s, tool, 140, 16);
    while (!s.storms.length && s.tick < 200) stepGame(s);
    s.effects = [];
    Object.assign(s.storms[0], { lon: 121.2, lat: 15.2, wind: 45, ageHours: 48 });
    let convective = false;
    for (let i = 0; i < 1600 && !s.stormArchive.length; i++) { stepGame(s); convective ||= s.thunderstorms.length > 0; }
    expect(s.stormArchive).toHaveLength(1);
    const all = [...s.storms, ...s.stormArchive];
    for (const storm of all) { expect(typeof storm.damageScore).toBe('number'); expect(storm.damageScore).toBeGreaterThanOrEqual(0); }
    const record = s.stormArchive[0];
    expect(record.damageScore).toBeGreaterThan(0);
    const sum = all.reduce((a, storm) => a + storm.damageScore, 0);
    if (convective) expect(sum).toBeLessThanOrEqual(s.score + 1e-6); else expect(sum).toBeCloseTo(s.score, 6);
    const saved = record.damageScore;
    for (let i = 0; i < 8; i++) stepGame(s);
    expect(s.stormArchive[0].damageScore).toBe(saved);
    expect(stormLossUsd(saved)).toBe(Math.round(saved * 4_120 / 1_000) * 1_000);
  }, 30_000);

  it('map grade labels follow current strength, not IDs or lifetime peak', () => {
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low'] as const) placeTool(s, tool, 140, 16);
    while (!s.storms.length && s.tick < 200) stepGame(s);
    const storm = s.storms[0]; storm.id = 99; storm.peakWind = 90;
    for (const [wind, grade] of [[13, 0], [17.2, 1], [24.5, 2], [32.7, 3], [44, 4], [54, 5], [20, 1], [64, 6], [104, 10]]) {
      storm.wind = wind;
      expect(stormGradeLabel(storm)).toBe(`Grade ${grade}`);
    }
  });

  it('fits an archived dateline-crossing path beside the sidebar without a world-spanning jump', () => {
    const view = new MapView(); view.resize(1440, 900);
    const track = [{ lon: 175, lat: 10 }, { lon: -179, lat: 15 }, { lon: -168, lat: 27 }];
    view.fitTrack(track, 352);
    for (const p of track) {
      const [x, y] = view.lonLatToPx(p.lon, p.lat);
      expect(x).toBeGreaterThan(25); expect(x).toBeLessThan(1440 - 352 - 25);
      expect(y).toBeGreaterThan(80); expect(y).toBeLessThan(800);
    }
    expect(view.zoom).toBeGreaterThan(2);
  });
});
