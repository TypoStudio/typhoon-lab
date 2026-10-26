import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StormRecord } from '../src/types';

const docs = new Map<string, Record<string, unknown>>();
const batchSizes: number[] = [];
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, col: string) => ({ col }),
  where: (_field: string, _op: string, value: unknown) => ({ uid: value }),
  limit: (n: number) => ({ n }),
  query: (c: { col: string }, w: { uid: unknown }, l: { n: number }) => ({ col: c.col, uid: w.uid, n: l.n }),
  getDocs: async (q: { col: string; uid: unknown; n: number }) => {
    const found = [...docs.entries()].filter(([path, d]) => path.startsWith(`${q.col}/`) && d.uid === q.uid).slice(0, q.n).map(([path]) => ({ ref: { path } }));
    return { docs: found, size: found.length, empty: found.length === 0 };
  },
  getDoc: async (ref: { path: string }) => ({ exists: () => docs.has(ref.path) }),
  deleteDoc: async (ref: { path: string }) => { docs.delete(ref.path); },
  writeBatch: () => {
    const paths: string[] = [];
    return { delete: (ref: { path: string }) => { paths.push(ref.path); }, commit: async () => { batchSizes.push(paths.length); for (const p of paths) docs.delete(p); } };
  },
  doc: (_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` }),
  serverTimestamp: () => 'SERVER_TS',
  runTransaction: async (_db: unknown, run: (tx: unknown) => Promise<void>) => {
    const writes: [string, Record<string, unknown>][] = [];
    await run({
      get: async (ref: { path: string }) => ({ exists: () => docs.has(ref.path), data: () => docs.get(ref.path) }),
      set: (ref: { path: string }, data: Record<string, unknown>) => { writes.push([ref.path, data]); },
    });
    for (const [path, data] of writes) docs.set(path, data);
  },
}));
vi.mock('../src/net/firebase', () => ({ getFirebase: vi.fn() }));

import { getFirebase } from '../src/net/firebase';
import {
  aggregateResults, defaultNickname, deleteMyData, flushQueue, prepare, queuedCount, resultFromRecord, resultId, sanitizeNickname, setNickname, storedNickname, submit,
  type ResultData, type StormResult,
} from '../src/net/leaderboard';

const online = () => vi.mocked(getFirebase).mockResolvedValue({ db: {} as never, uid: 'abcd1234' });
const result = (over: Partial<StormResult> = {}): StormResult => ({ seed: 7, stormId: 1, name: '#1', lossUsd: 5_000_000, grade: 4, stage: 'Very Strong Typhoon', lifetimeHours: 80, ...over });
const record = (over: Partial<StormRecord> = {}): StormRecord => ({
  id: 3, wind: 20, peakWind: 55, damageScore: 2000, stage: 'Tropical Depression', ageHours: 90, endedHour: 130, endReason: 'dissipated',
  history: [{ hour: 40, wind: 18, stage: 'Tropical Depression' }, { hour: 80, wind: 55, stage: 'Very Strong Typhoon' }, { hour: 130, wind: 15, stage: 'Tropical Depression' }],
  ...over,
} as unknown as StormRecord);

beforeEach(() => {
  docs.clear();
  batchSizes.length = 0;
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
  vi.mocked(getFirebase).mockReset();
});

describe('result building', () => {
  it('uses {uid}_{seed}_{stormId} as the document id', () => {
    expect(resultId('abcd1234', 7, 3)).toBe('abcd1234_7_3');
  });
  it('maps an ended world storm and takes the stage from its peak sample', () => {
    expect(resultFromRecord(7, record())).toEqual({
      seed: 7, stormId: 3, name: '#3', lossUsd: 8_240_000, grade: 5, stage: 'Very Strong Typhoon', lifetimeHours: 90,
    });
  });
  it('excludes loaded historic typhoons', () => {
    expect(resultFromRecord(7, record({ record: { typhoonId: 'maemi-2003', startHour: 0 } }))).toBeNull();
  });
  it('skips storms with no loss below grade 3', () => {
    expect(resultFromRecord(7, record({ damageScore: 0, peakWind: 20 }))).toBeNull();
    expect(resultFromRecord(7, record({ damageScore: 0, peakWind: 55 }))).not.toBeNull();
  });
});

describe('submit', () => {
  it('writes the result and player totals once, however often it is submitted', async () => {
    online();
    await submit(result());
    await submit(result());
    expect([...docs.keys()].sort()).toEqual(['players/abcd1234', 'results/abcd1234_7_1']);
    expect(docs.get('results/abcd1234_7_1')).toMatchObject({ uid: 'abcd1234', nickname: 'Player-ABCD', lossUsd: 5_000_000, grade: 4, client: 'web', endedAt: 'SERVER_TS' });
    expect(docs.get('players/abcd1234')).toMatchObject({ storms: 1, maxGrade: 4, totalLossUsd: 5_000_000, bestLossUsd: 5_000_000, bestStormName: '#1' });
    expect(queuedCount()).toBe(0);
  });
  it('accumulates totals, max grade and the best storm across results', async () => {
    online();
    await submit(result());
    await submit(result({ stormId: 2, name: 'Big', lossUsd: 9_000_000, grade: 3 }));
    await submit(result({ stormId: 3, name: 'Small', lossUsd: 1_000_000, grade: 6 }));
    expect(docs.get('players/abcd1234')).toMatchObject({ storms: 3, maxGrade: 6, totalLossUsd: 15_000_000, bestLossUsd: 9_000_000, bestStormName: 'Big' });
  });
  it('keeps results queued while offline and uploads them on a later flush', async () => {
    vi.mocked(getFirebase).mockRejectedValue(new Error('offline'));
    await submit(result());
    await submit(result({ stormId: 2 }));
    expect(queuedCount()).toBe(2);
    expect(docs.size).toBe(0);
    online();
    await flushQueue();
    expect(queuedCount()).toBe(0);
    expect(docs.has('results/abcd1234_7_1') && docs.has('results/abcd1234_7_2')).toBe(true);
    expect(docs.get('players/abcd1234')).toMatchObject({ storms: 2 });
  });
  it('still uploads after a flush that found an empty queue', async () => {
    online();
    await flushQueue();
    await submit(result());
    expect(queuedCount()).toBe(0);
    expect(docs.has('results/abcd1234_7_1')).toBe(true);
  });
  it('carries the saved nickname and drops results the rules refuse', async () => {
    online();
    await setNickname('  Typhoon   Fan ');
    await submit(result());
    expect(docs.get('results/abcd1234_7_1')).toMatchObject({ nickname: 'Typhoon Fan' });
    expect(docs.get('players/abcd1234')).toMatchObject({ nickname: 'Typhoon Fan' });
    vi.mocked(getFirebase).mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await submit(result({ stormId: 2 }));
    expect(queuedCount()).toBe(0);
    expect(docs.has('results/abcd1234_7_2')).toBe(false);
  });
});

describe('deleteMyData', () => {
  it('deletes every result in batches of at most 300, the player document and the queue, but keeps other players and the nickname', async () => {
    online();
    await setNickname('Typhoon Fan');
    await submit(result());
    for (let i = 2; i <= 650; i++) docs.set(`results/abcd1234_7_${i}`, { uid: 'abcd1234' });
    docs.set('results/zzzz9999_7_1', { uid: 'zzzz9999' });
    docs.set('players/zzzz9999', { nickname: 'Other' });
    vi.mocked(getFirebase).mockRejectedValueOnce(new Error('offline'));
    await submit(result({ stormId: 900 }));
    expect(queuedCount()).toBe(1);
    online();
    expect(await deleteMyData()).toEqual({ results: 650, player: true });
    expect(batchSizes).toEqual([300, 300, 50]);
    expect([...docs.keys()].sort()).toEqual(['players/zzzz9999', 'results/zzzz9999_7_1']);
    expect(queuedCount()).toBe(0);
    expect(storedNickname()).toBe('Typhoon Fan');
  });
  it('recreates the player document on the next upload and does not recreate it on prepare', async () => {
    online();
    await setNickname('Typhoon Fan');
    await submit(result());
    await deleteMyData();
    await prepare();
    expect(docs.has('players/abcd1234')).toBe(false);
    await submit(result({ stormId: 2 }));
    expect(docs.get('players/abcd1234')).toMatchObject({ nickname: 'Typhoon Fan', storms: 1, totalLossUsd: 5_000_000 });
    expect([...docs.keys()].sort()).toEqual(['players/abcd1234', 'results/abcd1234_7_2']);
  });
  it('reports nothing to delete for a fresh uid', async () => {
    online();
    expect(await deleteMyData()).toEqual({ results: 0, player: false });
  });
  it('fails with a clear error when Firebase is unavailable', async () => {
    vi.mocked(getFirebase).mockRejectedValue(new Error('no sdk'));
    await expect(deleteMyData()).rejects.toThrow('Leaderboard unavailable');
  });
});

describe('nickname', () => {
  it('trims, collapses whitespace and strips control characters', () => {
    expect(sanitizeNickname('  a\u0000b​c   d\n')).toBe('abc d');
    expect(sanitizeNickname('태풍연구소')).toBe('태풍연구소');
  });
  it('rejects empty, whitespace-only and over-long names', () => {
    expect(sanitizeNickname('')).toBeNull();
    expect(sanitizeNickname(' \t​ ')).toBeNull();
    expect(sanitizeNickname('x'.repeat(21))).toBeNull();
    expect(sanitizeNickname('x'.repeat(20))).toBe('x'.repeat(20));
  });
  it('suggests Player-XXXX from the uid and refuses to save an invalid name', async () => {
    expect(defaultNickname('k3j9zq')).toBe('Player-K3J9');
    expect(await setNickname('   ')).toBeNull();
  });
});

describe('aggregateResults', () => {
  const r = (uid: string, nickname: string, lossUsd: number, grade: number, endedMs = 0): ResultData => ({ uid, nickname, lossUsd, grade, endedMs });
  it('sums loss, counts storms, takes the max grade and the newest nickname', () => {
    const rows = aggregateResults([r('a', 'Old', 100, 3, 1), r('a', 'New', 50, 5, 2), r('b', 'Bee', 120, 2)]);
    expect(rows).toEqual([
      { uid: 'a', nickname: 'New', storms: 2, maxGrade: 5, lossUsd: 150 },
      { uid: 'b', nickname: 'Bee', storms: 1, maxGrade: 2, lossUsd: 120 },
    ]);
  });
  it('breaks loss ties by storm count, then nickname', () => {
    const rows = aggregateResults([r('a', 'Zed', 100, 1), r('b', 'Amy', 100, 1), r('c', 'Bob', 50, 1), r('c', 'Bob', 50, 1), r('d', 'Cat', 100, 1)]);
    expect(rows.map(x => x.uid)).toEqual(['c', 'b', 'd', 'a']);
  });
});
