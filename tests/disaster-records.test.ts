import { expect, it } from 'vitest';
import { createGame, placeFormation, replayGame, stepGame } from '../src/simulation/engine';
import { disasterDamage } from '../src/simulation/disasters';
import { entryFromDisaster, localRankingStore, parseRankings, rankBy } from '../src/ui/rankings';
import { resultFromDisaster } from '../src/net/leaderboard';

it('retains ended disaster damage, history and identities through replay and ranking storage', () => {
  const state = createGame(17, 213);
  placeFormation(state, 'gust', 127, 37);
  for (let i = 0; i < 29; i++) stepGame(state);
  const active = state.disasters!.find(record => record.kind === 'gust')!;
  expect(active.endedHour).toBeUndefined();
  expect(active.damageScore).toBeGreaterThan(0);
  expect(resultFromDisaster(state.seed, active)).toBeNull();
  expect(entryFromDisaster(state.seed, active, state.hours, state.actions).endReason).toBe('active');
  for (let i = 0; i < 8; i++) stepGame(state);
  const record = state.disasters!.find(record => record.id === active.id)!;
  expect(record.endedHour).toBeDefined();
  expect(record.history.at(-1)!.hour).toBe(record.endedHour);
  expect(record.history.at(-1)!.damageScore).toBe(record.damageScore);
  expect(record.damageScore).toBeCloseTo(state.score, 6);
  const loss = disasterDamage(record).lossUsd;
  expect(loss).toBeGreaterThan(0);
  const entry = entryFromDisaster(state.seed, record, state.hours, state.actions, '2026-10-28T00:00:00Z');
  expect(entry).toMatchObject({ kind: 'gust', disasterId: record.id, lossUsd: loss, grade: 0, endReason: 'ended' });
  expect(parseRankings(JSON.stringify([entry]))).toEqual([entry]);
  expect(rankBy([entry], 'lossUsd')).toEqual([entry]);
  expect(rankBy([entry], 'grade')).toEqual([]);
  let saved = '';
  const store = localRankingStore({ getItem: () => saved, setItem: (_key, value) => { saved = value; } });
  store.save([entry]);
  expect(store.load()).toEqual([entry]);
  expect(resultFromDisaster(state.seed, record)).toMatchObject({ disasterId: record.id, lossUsd: loss, stage: 'Wind gust', grade: 0 });
  const replay = replayGame(state.seed, state.actions, state.tick, state.initialStartDayOfYear);
  expect(replay.ok).toBe(true);
  if (replay.ok) expect(replay.state.disasters).toEqual(state.disasters);
});

it('attributes overlapping disaster damage once rather than copying city totals into each ranking', () => {
  const state = createGame(17, 213);
  for (const kind of ['heatwave', 'drought', 'gust'] as const) placeFormation(state, kind, 127, 37);
  for (let i = 0; i < 36; i++) stepGame(state);
  expect(state.disasters!.filter(record => ['heatwave', 'drought', 'gust'].includes(record.kind))).toHaveLength(3);
  const attributed = state.disasters!.reduce((sum, record) => sum + record.damageScore, 0)
    + state.storms.reduce((sum, storm) => sum + storm.damageScore, 0);
  expect(attributed).toBeCloseTo(state.score, 5);
});
