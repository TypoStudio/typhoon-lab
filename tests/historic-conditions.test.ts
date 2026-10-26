import { describe, expect, it } from 'vitest';
import { typhoonById } from '../src/data/typhoons';
import { createGame, loadHistoric, placeTool, replayGame, stepGame, trackAt } from '../src/simulation/engine';
import type { GameState, ToolType } from '../src/types';

const maemi = typhoonById('maemi-2003')!;
const START = 10;
const first = maemi.points[0];
const STRENGTHEN: ToolType[] = ['warm', 'moisture', 'updraft'];
const WEAKEN: ToolType[] = ['cool', 'dry', 'downdraft'];

function stepHours(s: GameState, hours: number): void {
  const until = s.hours + hours;
  while (s.hours < until - 1e-9) stepGame(s);
}
/** A running world at hour 10 with Maemi just loaded. */
function historic(): GameState {
  const s = createGame(1);
  stepHours(s, START);
  expect(loadHistoric(s, 'maemi-2003')).toEqual({ ok: true });
  return s;
}
function place(s: GameState, tools: ToolType[]): void {
  for (const t of tools) expect(placeTool(s, t, s.storms[0].lon, s.storms[0].lat)).toEqual({ ok: true });
}
const recordedWind = (s: GameState) => trackAt(maemi, s.hours - START)!.wind;
const recordedPressure = (s: GameState) => trackAt(maemi, s.hours - START)!.pressure;

describe('historic typhoons: conditions on a recorded typhoon', () => {
  it('without actions the wind equals the record and the player effect is zero', () => {
    const s = historic();
    stepHours(s, 48);
    expect(Math.abs(s.storms[0].wind - recordedWind(s))).toBeLessThan(1e-6);
    expect(s.storms[0].windDelta).toBe(0);
  });

  it('weakening conditions on the storm lower its wind below the record', () => {
    const s = historic();
    expect(first.lat).toBeCloseTo(s.storms[0].lat, 6);
    place(s, WEAKEN);
    stepHours(s, 24);
    expect(s.storms[0].windDelta).toBeLessThan(-2);
    expect(s.storms[0].wind).toBeLessThan(recordedWind(s));
    expect(s.storms[0].pressure).toBeGreaterThan(recordedPressure(s));
  });

  it('strengthening conditions raise its wind above the record and lower the pressure', () => {
    const s = historic();
    place(s, STRENGTHEN);
    stepHours(s, 24);
    expect(s.storms[0].windDelta).toBeGreaterThan(1);
    expect(s.storms[0].wind).toBeGreaterThan(recordedWind(s));
    expect(s.storms[0].pressure).toBeLessThan(recordedPressure(s));
  });

  it('keeps the recorded track', () => {
    const a = historic();
    const b = historic();
    place(b, WEAKEN);
    stepHours(a, 24); stepHours(b, 24);
    expect(b.storms[0].lon).toBe(a.storms[0].lon);
    expect(b.storms[0].lat).toBe(a.storms[0].lat);
  });

  it('conditions act only where they are: a distant second load is unaffected', () => {
    const s = historic();
    place(s, WEAKEN);
    stepHours(s, 6);
    expect(loadHistoric(s, 'hinnamnor-2022').ok).toBe(true);
    stepHours(s, 1);
    expect(s.storms[1].windDelta).toBe(0);
    expect(s.storms[0].windDelta).toBeLessThan(0);
  });

  it('replays to the identical wind', () => {
    const s = historic();
    place(s, WEAKEN);
    stepHours(s, 24);
    const replay = replayGame(s.seed, s.actions, s.tick);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.state.storms[0].wind).toBe(s.storms[0].wind);
      expect(replay.state.storms[0].windDelta).toBe(s.storms[0].windDelta);
    }
  });

  it('leaves sandbox storms with a zero player effect', () => {
    const s = createGame();
    for (const t of ['warm', 'moisture', 'low'] as ToolType[]) expect(placeTool(s, t, 140, 16)).toEqual({ ok: true });
    let seen = false;
    for (let i = 0; i < 200; i++) {
      stepGame(s);
      for (const storm of s.storms) { expect(storm.windDelta).toBe(0); seen = true; }
    }
    for (const storm of s.stormArchive) expect(storm.windDelta).toBe(0);
    expect(seen || s.storms.length === 0).toBe(true);
  });
});
