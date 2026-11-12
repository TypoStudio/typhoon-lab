import { describe, expect, it } from 'vitest';
import { SKIP_STEPS, createGame, placeTool, replayGame, skipAhead, stepGame, STEP_HOURS } from '../src/simulation/engine';
import { addSample, createSeries, elapsedTicks } from '../src/ui/measure-store';

const SEED = 42;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe('time skip', () => {
  it('is 16 steps of 15 minutes, 4 model hours', () => {
    expect(SKIP_STEPS * STEP_HOURS).toBe(4);
    const s = createGame(SEED);
    skipAhead(s);
    expect(s.tick).toBe(16);
    expect(s.hours).toBe(4);
  });

  it('gives the same state as 16 normal steps, with storms, and records nothing', () => {
    const a = createGame(SEED, 213), b = createGame(SEED, 213);
    for (const s of [a, b]) {
      for (const [tool, lon, lat] of [['warm', 140, 16], ['moisture', 140, 16], ['low', 140, 16]] as const) placeTool(s, tool, lon, lat);
      for (let i = 0; i < 40; i++) stepGame(s);
    }
    const actions = a.actions.length;
    skipAhead(a);
    for (let i = 0; i < 16; i++) stepGame(b);
    expect(a.tick).toBe(56);
    expect(a.actions.length).toBe(actions);
    expect(clone(a)).toEqual(clone(b));
  });

  it('replays exactly: actions before and after a skip rebuild the same state', () => {
    const s = createGame(SEED, 213);
    placeTool(s, 'warm', 140, 16); placeTool(s, 'moisture', 140, 16); placeTool(s, 'low', 140, 16);
    for (let i = 0; i < 30; i++) stepGame(s);
    skipAhead(s);
    placeTool(s, 'high', 160, 30);
    for (let i = 0; i < 10; i++) stepGame(s);
    skipAhead(s);
    skipAhead(s);
    const r = replayGame(s.seed, s.actions, s.tick, s.initialStartDayOfYear, s.traffic.dispatches);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.tick).toBe(30 + 16 + 10 + 32);
    expect(clone(r.state)).toEqual(clone(s));
  });
});

describe('Measure after a skip', () => {
  it('takes one sample at the new time and the axis stays in elapsed time', () => {
    const line = createSeries();
    expect(addSample(line, 1, 10)).toBe(true);
    expect(addSample(line, 1 + 4 / 24, 11)).toBe(true); // the skip: one point, no filler
    expect(line.t).toEqual([1, 1 + 4 / 24]);
    expect(addSample(line, 1 + 4 / 24, 12)).toBe(false);
    expect(elapsedTicks(4 / 24, 3).map(tick => [tick.value, tick.unit])).toEqual([[0, 'h'], [2, 'h'], [4, 'h']]);
  });
});
