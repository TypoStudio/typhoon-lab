import { describe, expect, it } from 'vitest';
import { REPLAY_FILE_VERSION, REPLAY_MAX_ACTIONS, REPLAY_MAX_TICKS, createGame } from '../src/simulation/engine';
import { MAX_REPLAY_BYTES, buildReplay, parseReplay, replayExportProblem } from '../src/ui/storage';

describe('portable world snapshots (replay files, version 6)', () => {
  const state = createGame();
  state.tick = 40;
  state.actions.push(
    { tick: 4, type: 'warm', lon: 140, lat: 16 }, { tick: 4, type: 'low', lon: -55, lat: 16 },
    { tick: 8, type: 'genesis', on: true }, { tick: 12, type: 'historic', typhoonId: 'maemi-2003' }, { tick: 20, type: 'genesis', on: false },
  );
  const file = buildReplay(state);

  it('exports seed, placements and the snapshot tick, with no budget or result fields', () => {
    expect(file.formatVersion).toBe(REPLAY_FILE_VERSION);
    expect(file.untilTick).toBe(40);
    expect(file.actions).toHaveLength(5);
    expect(file).not.toHaveProperty('mode');
    expect(file).not.toHaveProperty('typhoonId');
    expect(file).not.toHaveProperty('budget');
    expect(file).not.toHaveProperty('result');
  });

  it('round-trips through strict parsing', () => {
    const parsed = parseReplay(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.replay).toEqual(file);
  });

  it('keeps all three action kinds, and drops stray fields from each', () => {
    const parsed = parseReplay(JSON.stringify(file));
    expect(parsed.ok && parsed.replay.actions).toEqual([
      { tick: 4, type: 'warm', lon: 140, lat: 16 }, { tick: 4, type: 'low', lon: -55, lat: 16 },
      { tick: 8, type: 'genesis', on: true }, { tick: 12, type: 'historic', typhoonId: 'maemi-2003' }, { tick: 20, type: 'genesis', on: false },
    ]);
    const stray = { ...file, actions: [{ tick: 1, type: 'genesis', on: true, lon: 1, lat: 1 }, { tick: 2, type: 'historic', typhoonId: 'tip-1979', on: false }] };
    const strayParsed = parseReplay(JSON.stringify(stray));
    expect(strayParsed.ok && strayParsed.replay.actions).toEqual([{ tick: 1, type: 'genesis', on: true }, { tick: 2, type: 'historic', typhoonId: 'tip-1979' }]);
  });

  it('accepts southern and dateline positions', () => {
    const odd = { ...file, actions: [{ tick: 0, type: 'moisture', lon: 179.99, lat: -33 }, { tick: 1, type: 'high', lon: -180, lat: -90 }] };
    expect(parseReplay(JSON.stringify(odd)).ok).toBe(true);
  });

  it('rejects other scenarios, old versions, bad ticks, bad positions and unknown fields', () => {
    const bad: Record<string, unknown>[] = [
      { scenarioId: 'another-world' }, { version: '0.1.0' }, { version: '0.2.0' }, { version: '0.2.1' }, { version: '0.3.0' }, { formatVersion: 1 }, { formatVersion: 2 }, { formatVersion: 3 }, { formatVersion: 4 }, { formatVersion: 5 }, { formatVersion: 7 }, { format: 'something-else' },
      { seed: -1 }, { seed: 1.5 }, { untilTick: -1 }, { untilTick: REPLAY_MAX_TICKS + 1 }, { untilTick: 2.5 },
      { actions: [{ tick: 41, type: 'warm', lon: 140, lat: 16 }] },
      { actions: [{ tick: 0, type: 'warm', lon: 999, lat: 16 }] },
      { actions: [{ tick: 0, type: 'warm', lon: 10, lat: 91 }] },
      { actions: [{ tick: 0, type: 'unknown', lon: 140, lat: 16 }] },
      { actions: [{ tick: 5, type: 'warm', lon: 1, lat: 1 }, { tick: 2, type: 'warm', lon: 1, lat: 1 }] },
      { actions: [{ tick: 0, type: 'genesis' }] }, { actions: [{ tick: 0, type: 'genesis', on: 'yes' }] }, { actions: [{ tick: 0, type: 'genesis', on: 1 }] },
      { actions: [{ tick: 0, type: 'historic' }] }, { actions: [{ tick: 0, type: 'historic', typhoonId: 'nope' }] }, { actions: [{ tick: 0, type: 'historic', typhoonId: 7 }] },
      { actions: [{ tick: 0, type: 'defense', on: true }] }, { actions: [{ tick: 41, type: 'genesis', on: true }] },
      { actions: [{ tick: 5, type: 'genesis', on: true }, { tick: 2, type: 'historic', typhoonId: 'maemi-2003' }] },
      { mode: 'sandbox' }, { typhoonId: 'maemi-2003' },
      { actions: 'nope' }, { budget: 120 }, { result: { score: 1 } },
    ];
    for (const change of bad) expect(parseReplay(JSON.stringify({ ...file, ...change })).ok, JSON.stringify(change)).toBe(false);
    expect(parseReplay('{not json').ok).toBe(false);
    expect(parseReplay('[]').ok).toBe(false);
    expect(parseReplay(' '.repeat(MAX_REPLAY_BYTES + 1)).ok).toBe(false);
  });

  it('rejects older replay versions with the not-supported message, even when they carry a game mode', () => {
    const v3 = parseReplay(JSON.stringify({ ...file, formatVersion: 3, mode: 'sandbox' }));
    expect(v3.ok).toBe(false);
    if (!v3.ok) expect(v3.error).toContain('is not supported');
    const v2 = parseReplay(JSON.stringify({ ...file, formatVersion: 2, version: '0.4.0', mode: 'sandbox' }));
    expect(v2.ok).toBe(false);
    if (!v2.ok) expect(v2.error).toContain('is not supported');
  });

  it('uses the simulation action limit, and allows a file full of placements', () => {
    const actions = Array.from({ length: REPLAY_MAX_ACTIONS }, (_, i) => ({ tick: i, type: 'warm' as const, lon: 140, lat: 16 }));
    const full = JSON.stringify({ ...file, untilTick: REPLAY_MAX_ACTIONS, actions }, null, 2);
    expect(full.length).toBeLessThan(MAX_REPLAY_BYTES);
    expect(parseReplay(full).ok).toBe(true);
    const tooMany = { ...file, untilTick: REPLAY_MAX_ACTIONS, actions: [...actions, { tick: REPLAY_MAX_ACTIONS, type: 'warm', lon: 1, lat: 1 }] };
    expect(parseReplay(JSON.stringify(tooMany)).ok).toBe(false);
  });

  it('refuses to export a world beyond the replay limits, without limiting live play', () => {
    expect(replayExportProblem(state)).toBeNull();
    const late = structuredClone(state);
    late.tick = REPLAY_MAX_TICKS + 1;
    expect(replayExportProblem(late)).toMatch(/at most/);
    const crowded = structuredClone(state);
    crowded.actions = Array.from({ length: REPLAY_MAX_ACTIONS + 1 }, (_, i) => ({ tick: i, type: 'warm' as const, lon: 0, lat: 0 }));
    expect(replayExportProblem(crowded)).toMatch(/at most/);
  });
});
