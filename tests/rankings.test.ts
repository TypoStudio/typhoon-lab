import { describe, expect, it } from 'vitest';
import { estimateStormDamage, stormLossUsd } from '../src/simulation/damage-news';
import { stageRank } from '../src/simulation/engine';
import {
  MAX_RANKING_ENTRIES, RANKING_KEY, RANKING_METRICS, actionsHash, entryFromStorm, localRankingStore, parseRankings, rankBy, upsert, type RankingEntry,
} from '../src/ui/rankings';
import { TICKS_PER_HOUR } from '../src/simulation/engine';
import type { ActionRecord, Storm, StormRecord } from '../src/types';

const sample = (hour: number) => ({ hour, lon: 140, lat: 16, wind: 20, pressure: 990, stage: 'Tropical Storm', grade: 1, movementSpeedKmh: 10, circulationRadiusKm: 300, galeRadiusKm: 100 });
const storm = (over: Partial<Storm> = {}): Storm => ({
  id: 3, lon: 140, lat: 16, wind: 30, movementSpeedKmh: 12, pressure: 970, radiusKm: 40, galeRadiusKm: 150,
  stage: 'Typhoon', ageHours: 30, peakWind: 45, track: [], forecast: [], history: [sample(12), sample(20)],
  damageScore: 200_000, windDelta: 0, ...over,
});
const record = (over: Partial<StormRecord> = {}): StormRecord => ({ ...storm(), endedHour: 90, endReason: 'dissipated', ...over });
const actions: ActionRecord[] = [{ tick: 0, type: 'warm', lon: 140, lat: 16 }, { tick: 0, type: 'genesis', on: true }, { tick: 95 * TICKS_PER_HOUR, type: 'low', lon: 150, lat: 15 }];
const entry = (over: Partial<RankingEntry>): RankingEntry => ({
  key: '1:1:00000000', seed: 1, stormId: 1, name: '#1', lossUsd: 0, displaced: 0, deaths: 0, floodedHomes: 0, grade: 0, lifetimeHours: 0,
  endReason: 'dissipated', recordedAt: '2026-10-24T00:00:00.000Z', ...over,
});
const fakeStorage = (initial: string | null = null) => {
  let value = initial;
  return { getItem: (k: string) => (k === RANKING_KEY ? value : null), setItem: (k: string, v: string) => { if (k === RANKING_KEY) value = v; }, get value() { return value; } };
};

describe('storm ranking', () => {
  it('distinguishes traffic dispatches while ignoring dispatches after the storm ends', () => {
    const dispatches = [{ tick: 4, assignments: [{ vehicleId: 'AIR-0', departureId: 'air-1:0' }] }];
    expect(actionsHash(actions, 3, dispatches)).toBe(actionsHash(actions, 3));
    expect(actionsHash(actions, 4, dispatches)).not.toBe(actionsHash(actions, 4));
    const other = [{ tick: 4, assignments: [{ vehicleId: 'AIR-0', departureId: 'air-2:0' }] }];
    expect(actionsHash(actions, 4, dispatches)).not.toBe(actionsHash(actions, 4, other));
    const endTick = record().endedHour * TICKS_PER_HOUR;
    const atEnd = [{ ...dispatches[0], tick: endTick }];
    expect(entryFromStorm(7, record(), 120, actions, 'T', atEnd).key).toBe(entryFromStorm(7, record(), 120, actions, 'T').key);
    expect(entryFromStorm(7, record(), 120, actions, 'T', [{ ...dispatches[0], tick: endTick - 1 }]).key)
      .not.toBe(entryFromStorm(7, record(), 120, actions, 'T').key);
  });

  it('derives per-storm figures from the storm damage score with the city rates', () => {
    const damage = estimateStormDamage(200_000);
    expect(damage).toEqual({ displaced: 12_400, missing: 4, deaths: 20, floodedHomes: 8_060, lossUsd: stormLossUsd(200_000) });
    const { missing: _, ...figures } = damage;
    const hash = actionsHash(actions, 90 * TICKS_PER_HOUR);
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
    expect(hash).toBe(actionsHash(actions.slice(0, 2), 1e9));
    expect(hash).not.toBe(actionsHash(actions, 1e9));
    expect(hash).not.toBe(actionsHash([], 1e9));
    expect(entryFromStorm(7, record(), 120, actions, 'T')).toEqual({
      key: `7:3:${hash}`, seed: 7, stormId: 3, name: '#3', ...figures, grade: stageRank(45), lifetimeHours: 78, endReason: 'dissipated', recordedAt: 'T',
    });
    const active = entryFromStorm(7, storm({ name: 'Maemi' }), 50, actions, 'T');
    expect(active).toMatchObject({ key: `7:3:${actionsHash(actions, 50 * TICKS_PER_HOUR)}`, name: 'Maemi', endReason: 'active', lifetimeHours: 38 });
    // Later actions of the same seed give a new key: an unrelated storm #3 in another session never overwrites this one.
    expect(entryFromStorm(7, record(), 120, [{ tick: 4, type: 'low', lon: 0, lat: 0 }], 'T').key).not.toBe(`7:3:${hash}`);
    expect(entryFromStorm(7, storm({ history: [], name: 'x'.repeat(80) }), 50, actions, 'T')).toMatchObject({ lifetimeHours: 30, name: 'x'.repeat(60) });
  });

  it('upserts by key idempotently and caps to the most recent entries', () => {
    const a = entryFromStorm(7, record(), 120, actions, '2026-10-24T01:00:00.000Z');
    const once = upsert([], a);
    const again = entryFromStorm(7, record(), 120, actions, '2026-10-25T09:00:00.000Z');
    expect(upsert(once, again)).toEqual(once);
    expect(upsert(once, { ...again, lossUsd: 5 })).toEqual([{ ...a, lossUsd: 5 }]);
    let many: RankingEntry[] = [];
    for (let i = 0; i <= MAX_RANKING_ENTRIES; i++) many = upsert(many, entry({ key: `1:${i}:00000000`, stormId: i, recordedAt: `2026-10-24T00:00:${String(i % 60).padStart(2, '0')}.${String(i).padStart(3, '0')}Z` }));
    expect(many).toHaveLength(MAX_RANKING_ENTRIES);
  });

  it('orders every metric descending with loss then earlier-record tie breaks', () => {
    for (const { id } of RANKING_METRICS) {
      const list = [
        entry({ key: '1:1:00000000', stormId: 1, [id]: 5, lossUsd: id === 'lossUsd' ? 5 : 100, recordedAt: '2026-10-24T02:00:00.000Z' }),
        entry({ key: '1:2:00000000', stormId: 2, [id]: 9, lossUsd: id === 'lossUsd' ? 9 : 1 }),
        entry({ key: '1:3:00000000', stormId: 3, [id]: 5, lossUsd: id === 'lossUsd' ? 5 : 100, recordedAt: '2026-10-24T01:00:00.000Z' }),
        entry({ key: '1:4:00000000', stormId: 4, [id]: 5, lossUsd: id === 'lossUsd' ? 5 : 200 }),
        entry({ key: '1:5:00000000', stormId: 5 }),
      ];
      expect(rankBy(list, id).map(e => e.key), id).toEqual(['1:2:00000000', '1:4:00000000', '1:3:00000000', '1:1:00000000']);
      expect(rankBy(list, id, 2)).toHaveLength(2);
    }
  });

  it('stores ended entries and rejects untrusted or malformed JSON', () => {
    const good = entryFromStorm(7, record(), 120, actions, '2026-10-24T01:00:00.000Z');
    const storage = fakeStorage();
    const store = localRankingStore(storage);
    store.save([good, entryFromStorm(7, storm({ id: 4 }), 120, actions)]);
    expect(store.load()).toEqual([good]);
    for (const bad of ['not json', '{"a":1}', 'null', JSON.stringify('x'.repeat(1_000_001))]) expect(localRankingStore(fakeStorage(bad)).load()).toEqual([]);
    const invalid = [
      { ...good, key: '7:9:00000000' }, { ...good, key: '7:3' }, { ...good, key: '7:3:XYZ' }, { ...good, seed: -1, key: '-1:3:00000000' },
      { ...good, lifetimeHours: 2e6 }, { ...good, lossUsd: -1 }, { ...good, deaths: 1.5 },
      { ...good, grade: 'x' }, { ...good, lifetimeHours: Infinity }, { ...good, endReason: 'active' }, { ...good, name: '' },
      { ...good, recordedAt: 5 }, 'entry', null,
    ];
    expect(parseRankings(JSON.stringify([...invalid, { ...good, extra: '<b>' }]))).toEqual([good]);
    expect(localRankingStore(null).load()).toEqual([]);
    expect(localRankingStore({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }).load()).toEqual([]);
  });
});
