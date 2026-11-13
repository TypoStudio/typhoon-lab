import { describe, expect, it } from 'vitest';
import { typhoonById } from '../src/data/typhoons';
import { TRACK_STEER_CAP_MS, createGame, loadHistoric, placeTool, replayGame, stepGame, trackAt } from '../src/simulation/engine';
import { distanceKm, offsetKm } from '../src/simulation/geo';
import type { GameState, ToolType } from '../src/types';

const START = 10;
function stepHours(s: GameState, hours: number): void {
  const until = s.hours + hours;
  while (s.hours < until - 1e-9) stepGame(s);
}
function historic(id: string): GameState {
  const s = createGame(1);
  stepHours(s, START);
  expect(loadHistoric(s, id)).toEqual({ ok: true });
  return s;
}
const offsetOf = (s: GameState) => Math.hypot(s.storms[0].trackOffset!.east, s.storms[0].trackOffset!.north);

describe('historic typhoons: conditions bend the track', () => {
  for (const id of ['sarah-1959', 'maemi-2003', 'tip-1979']) {
    it(`${id}: with no tools the track is exactly the record and the offset is 0`, () => {
      const typhoon = typhoonById(id);
      if (!typhoon) return;
      const s = historic(id);
      for (let i = 0; i < 4 * 24 * 4 && s.storms.length; i++) {
        stepGame(s);
        if (!s.storms.length) break;
        const at = trackAt(typhoon, s.hours - START)!;
        expect(s.storms[0].lon).toBe(at.lon);
        expect(s.storms[0].lat).toBe(at.lat);
        expect(s.storms[0].trackOffset).toEqual({ east: 0, north: 0 });
      }
    });
  }

  it('a High beside the storm pushes it clockwise (east of a high goes south, west of it north) and the offset stays after it expires', () => {
    const s = historic('maemi-2003');
    const st = s.storms[0];
    // High 600 km east of the storm: clockwise flow around it blows southward at the storm
    const spot = { ...{ lon: st.lon, lat: st.lat } };
    const east = offsetKm(spot.lon, spot.lat, spot.lon + 6, spot.lat);
    expect(east.dx).toBeGreaterThan(0);
    expect(placeTool(s, 'high', spot.lon - 6, spot.lat)).toEqual({ ok: true }); // high to the WEST: storm sits east of it -> flow toward south
    stepHours(s, 12);
    const off = s.storms[0].trackOffset!;
    expect(off.north).toBeLessThan(-5);
    const recorded = trackAt(typhoonById('maemi-2003')!, s.hours - START)!;
    expect(s.storms[0].lat).toBeLessThan(recorded.lat);
    const hours = s.effects.length ? Math.max(...s.effects.map(e => e.remainingHours)) : 0;
    stepHours(s, hours + 2);
    expect(s.effects.length).toBe(0);
    const frozen = { ...s.storms[0].trackOffset! };
    expect(offsetOf(s)).toBeGreaterThan(5);
    stepHours(s, 12);
    expect(s.storms[0].trackOffset).toEqual(frozen);
    const rec = trackAt(typhoonById('maemi-2003')!, s.hours - START)!;
    expect(distanceKm(rec.lon, rec.lat, s.storms[0].lon, s.storms[0].lat)).toBeGreaterThan(5);
  });

  it('caps the offset rate', () => {
    const s = historic('maemi-2003');
    const tools: ToolType[] = ['high', 'high', 'low', 'high'];
    for (const t of tools) placeTool(s, t, s.storms[0].lon - 3, s.storms[0].lat);
    let prev = 0;
    for (let i = 0; i < 40; i++) {
      stepGame(s);
      const now = offsetOf(s);
      expect(now - prev).toBeLessThanOrEqual((TRACK_STEER_CAP_MS * 0.25 * 3600) / 1000 + 1e-9);
      prev = now;
    }
  });

  it('replays and survives a JSON round trip', () => {
    const s = historic('maemi-2003');
    placeTool(s, 'high', s.storms[0].lon - 5, s.storms[0].lat);
    stepHours(s, 24);
    expect(offsetOf(s)).toBeGreaterThan(1);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.state.storms[0].trackOffset).toEqual(s.storms[0].trackOffset);
      expect(replay.state.storms[0].lon).toBe(s.storms[0].lon);
      expect(replay.state.storms[0].lat).toBe(s.storms[0].lat);
    }
    expect(JSON.parse(JSON.stringify(s.storms[0])).trackOffset).toEqual(s.storms[0].trackOffset);
  });
});
