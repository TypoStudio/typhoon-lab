import { describe, expect, it } from 'vitest';
import { typhoonById } from '../src/data/typhoons';
import { STEP_HOURS, TICKS_PER_HOUR, createGame, loadHistoric, placeTool, replayGame, stepGame } from '../src/simulation/engine';
import { distanceKm, wrapLon } from '../src/simulation/geo';
import type { GameState } from '../src/types';

const maemi = typhoonById('maemi-2003')!;
const START = 10; // hour of the running world at which typhoons are loaded
const hoursAt = (k: number) => (Date.parse(maemi.points[k].t) - Date.parse(maemi.points[0].t)) / 3_600_000;
const END_TICK = Math.ceil(hoursAt(maemi.points.length - 1) * TICKS_PER_HOUR) + 2 * TICKS_PER_HOUR;
function stepTo(state: GameState, hours: number): void {
  while (state.hours < hours - 1e-9) stepGame(state);
}
/** A running sandbox at hour 10 with Maemi loaded. */
function world(seed = 1): GameState {
  const s = createGame(seed);
  stepTo(s, START);
  expect(loadHistoric(s, 'maemi-2003')).toEqual({ ok: true });
  return s;
}

describe('historic typhoons: loading a recorded typhoon into a running world', () => {
  it('adds one named storm at the first recorded point and records the load', () => {
    const s = world();
    const first = maemi.points[0];
    expect(s.storms).toHaveLength(1);
    expect(s.storms[0]).toMatchObject({ id: 1, name: 'Maemi', lat: first.lat, lon: wrapLon(first.lon), pressure: first.pressure, windDelta: 0, record: { typhoonId: 'maemi-2003', startHour: START } });
    expect(s.historic).toEqual([{ typhoonId: 'maemi-2003', stormId: 1, startHour: START, finished: false, environment: 'missing' }]);
    expect(s.nextStormId).toBe(2);
    expect(s.actions).toEqual([{ tick: START * TICKS_PER_HOUR, type: 'historic', typhoonId: 'maemi-2003' }]);
    expect(s.phase).toBe('active');
    expect(s.news.at(-1)).toMatchObject({ title: 'Maemi (2003)', hour: START });
    expect(s.news.at(-1)!.text).toContain('JMA');
    expect(s.news.at(-1)!.text).toContain('base climate');
  });

  it('rejects an unknown typhoon without touching the world', () => {
    const s = createGame(1);
    expect(loadHistoric(s, 'nope')).toEqual({ ok: false, reason: 'Unknown typhoon.' });
    expect(s.actions).toHaveLength(0);
    expect(s.storms).toHaveLength(0);
    expect(s.historic).toHaveLength(0);
    expect(s.nextStormId).toBe(1);
  });

  it('follows the record relative to the load hour', () => {
    const s = world();
    stepTo(s, START + hoursAt(2));
    expect(Math.abs(s.storms[0].lat - maemi.points[2].lat)).toBeLessThan(0.05);
    expect(Math.abs(wrapLon(s.storms[0].lon - maemi.points[2].lon))).toBeLessThan(0.05);
    expect(s.storms[0].pressure).toBeCloseTo(maemi.points[2].pressure, 5);
    const k = maemi.points.findIndex((p, i) => i > 2 && p.windMs !== null);
    stepTo(s, START + hoursAt(k));
    expect(Math.abs(s.storms[0].wind - maemi.points[k].windMs!)).toBeLessThan(0.5);
  });

  it('interpolates between rows and reports real movement', () => {
    const s = world();
    const [a, b] = maemi.points;
    stepGame(s);
    const f = STEP_HOURS / hoursAt(1);
    expect(distanceKm(s.storms[0].lon, s.storms[0].lat, wrapLon(a.lon + (b.lon - a.lon) * f), a.lat + (b.lat - a.lat) * f)).toBeLessThan(1);
    expect(s.storms[0].movementSpeedKmh).toBeGreaterThan(0);
  });

  it('accepts placements alongside the loaded typhoon', () => {
    const s = world();
    expect(placeTool(s, 'warm', 140, 16)).toEqual({ ok: true });
    expect(s.actions).toHaveLength(2);
  });

  it('estimates wind from pressure when the record has none', () => {
    const s = createGame(1);
    expect(loadHistoric(s, 'sarah-1959').ok).toBe(true);
    expect(s.storms[0].wind).toBeGreaterThanOrEqual(13);
    expect(s.storms[0].stage).toBeTruthy();
  });

  it('keeps two loads side by side, each on its own clock, and never merges them', () => {
    const s = world();
    stepTo(s, START + 6);
    expect(loadHistoric(s, 'maemi-2003').ok).toBe(true); // the same typhoon twice
    expect(loadHistoric(s, 'sarah-1959').ok).toBe(true);
    expect(s.storms.map(x => x.id)).toEqual([1, 2, 3]);
    expect(s.historic.map(h => h.startHour)).toEqual([START, START + 6, START + 6]);
    stepTo(s, START + 6 + hoursAt(2));
    const [early, late] = s.storms;
    expect(Math.abs(late.lat - maemi.points[2].lat)).toBeLessThan(0.05);
    expect(early.lat).not.toBeCloseTo(late.lat, 1); // the earlier load is 6 h further along the same track
    // Two loads at one instant sit on top of each other for days: the merger rule must still ignore them.
    const t = createGame(2);
    loadHistoric(t, 'maemi-2003'); loadHistoric(t, 'maemi-2003');
    stepTo(t, 60);
    expect(t.storms).toHaveLength(2);
    expect(t.storms.every(x => x.ageHours >= 24 && x.wind >= 17.2)).toBe(true);
    expect(distanceKm(t.storms[0].lon, t.storms[0].lat, t.storms[1].lon, t.storms[1].lat)).toBeLessThan(1);
    expect(t.stormArchive).toHaveLength(0);
    expect(t.news.some(n => n.kind === 'merger')).toBe(false);
  });

  it('is not absorbed by, and does not absorb, a natural storm on top of it', () => {
    const s = world();
    stepTo(s, START + 30);
    const hist = s.storms[0];
    const natural = { ...structuredClone(hist), id: 7, record: undefined, name: undefined, wind: hist.wind + 10, ageHours: 40 };
    s.storms.push(natural);
    stepGame(s);
    expect(s.storms.map(x => x.id).sort((a, b) => a - b)).toEqual([1, 7]);
    expect(s.stormArchive).toHaveLength(0);
  });

  it('forecasts natural storms but not recorded ones', () => {
    const s = createGame(1);
    for (const tool of ['warm', 'moisture', 'low'] as const) placeTool(s, tool, 140, 16);
    loadHistoric(s, 'maemi-2003');
    while (!s.storms.some(x => !x.record) && s.tick < 400) stepGame(s);
    while (s.tick % TICKS_PER_HOUR !== 0) stepGame(s);
    const naturalStorm = s.storms.find(x => !x.record)!;
    expect(naturalStorm.forecast.length).toBeGreaterThan(0);
    expect(s.storms.find(x => x.record)!.forecast).toEqual([]);
  });

  it('archives the storm when its record ends and flags only that load as finished', () => {
    const s = world();
    stepTo(s, START + 10);
    expect(loadHistoric(s, 'maemi-2003').ok).toBe(true); // a second copy, 10 h behind
    while (s.tick < START * TICKS_PER_HOUR + END_TICK) stepGame(s);
    expect(s.historic.map(h => h.finished)).toEqual([true, false]);
    expect(s.storms.map(x => x.id)).toEqual([2]);
    expect(s.stormArchive).toHaveLength(1);
    const record = s.stormArchive[0];
    expect(record).toMatchObject({ id: 1, name: 'Maemi' });
    expect(record.endReason).toBe(maemi.points.at(-1)!.grade === 'L' ? 'extratropical' : 'dissipated');
    expect(record.damageScore).toBeGreaterThanOrEqual(0);
    expect(s.news.some(n => n.kind === 'ended')).toBe(true);
    while (s.tick < (START + 10) * TICKS_PER_HOUR + END_TICK) stepGame(s);
    expect(s.historic.map(h => h.finished)).toEqual([true, true]);
    expect(s.storms).toHaveLength(0);
    expect(s.phase).toBe('seeding');
  }, 60_000);

  it('reproduces an identical world from seed and actions', () => {
    const live = world(7);
    stepTo(live, START + 8);
    placeTool(live, 'cool', live.storms[0].lon, live.storms[0].lat);
    while (live.tick < START * TICKS_PER_HOUR + END_TICK) stepGame(live);
    const result = replayGame(7, live.actions, live.tick);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.state.stormArchive).toEqual(live.stormArchive);
      expect(result.state.historic).toEqual(live.historic);
      expect(result.state.nextStormId).toBe(live.nextStormId);
      expect(result.state.news).toEqual(live.news);
    }
    expect(replayGame(7, [{ tick: 0, type: 'historic', typhoonId: 'nope' }], 0).ok).toBe(false);
  }, 60_000);
});
