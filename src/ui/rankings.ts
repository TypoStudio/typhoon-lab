/** Persistent disaster ranking: pure entry/ordering helpers plus a swappable store (no DOM). */
import { estimateStormDamage, stormTotalLossUsd } from '../simulation/damage-news';
import { TICKS_PER_HOUR, isValidSeed, stageRank } from '../simulation/engine';
import { disasterDamage, disasterName } from '../simulation/disasters';
import { isWeatherHazardKind } from '../data/weather-hazards';
import type { ActionRecord, DisasterKind, DisasterRecord, Storm, StormRecord, TrafficDispatch } from '../types';

export interface RankingEntry {
  /** `${seed}:${stormId}:${actionsHash}`: replaying the same world yields the same keys; other sessions do not collide. */
  key: string; seed: number; stormId: number; name: string;
  disasterId?: string; kind?: DisasterKind;
  lossUsd: number; displaced: number; deaths: number; floodedHomes: number;
  /** Peak game grade reached (stageRank of the peak wind). */
  grade: number;
  /** Ending hour (or current hour while active) minus the first history sample hour; age when there is no history. */
  lifetimeHours: number;
  endReason: StormRecord['endReason'] | 'active' | 'ended'; recordedAt: string;
}
export type RankingMetric = 'lossUsd' | 'displaced' | 'deaths' | 'floodedHomes' | 'grade' | 'lifetimeHours';
export const RANKING_METRICS: { id: RankingMetric; label: string }[] = [
  { id: 'lossUsd', label: 'Estimated loss' },
  { id: 'displaced', label: 'Displaced people' },
  { id: 'deaths', label: 'Deaths (estimated)' },
  { id: 'floodedHomes', label: 'Damaged homes' },
  { id: 'grade', label: 'Grade' },
  { id: 'lifetimeHours', label: 'Survival time' },
];
export const RANKING_KEY = 'typhoon-lab-rankings';
export const MAX_RANKING_ENTRIES = 500;
const MAX_RANKING_BYTES = 1_000_000;

/** 32-bit FNV-1a (hex) over the actions up to `untilTick`, serialised like the replay signature. */
export function actionsHash(actions: ActionRecord[], untilTick: number, dispatches: TrafficDispatch[] = []): string {
  let text = JSON.stringify(actions.filter(a => a.tick <= untilTick).map(a => a.type === 'genesis' ? [a.tick, a.type, a.on]
    : a.type === 'historic' ? [a.tick, a.type, a.typhoonId] : a.type === 'climate' ? [a.tick, a.type, a.key, a.value] : a.type === 'season' ? [a.tick, a.type, a.dayOfYear] : [a.tick, a.type, a.lon, a.lat, ...(a.formation ? [a.formation] : [])]));
  const traffic = dispatches.filter(dispatch => dispatch.tick <= untilTick);
  if (traffic.length) text += JSON.stringify(traffic);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function entryFromDisaster(seed: number, record: DisasterRecord, hours: number, actions: ActionRecord[], recordedAt = new Date().toISOString(), dispatches: TrafficDispatch[] = []): RankingEntry {
  const end = record.endedHour ?? hours, endTick = Math.round(end * TICKS_PER_HOUR);
  const traffic = record.endedHour === undefined ? dispatches : dispatches.filter(dispatch => dispatch.tick < endTick);
  const { displaced, deaths, floodedHomes, lossUsd } = disasterDamage(record);
  return { key: `${seed}:${record.id}:${actionsHash(actions, endTick, traffic)}`, seed, stormId: 0,
    disasterId: record.id, kind: record.kind, name: disasterName(record.kind), lossUsd, displaced, deaths, floodedHomes,
    grade: 0, lifetimeHours: end - record.startedHour, endReason: record.endedHour === undefined ? 'active' : 'ended', recordedAt };
}

export function entryFromStorm(seed: number, storm: Storm | StormRecord, hours: number, actions: ActionRecord[], recordedAt = new Date().toISOString(), dispatches: TrafficDispatch[] = []): RankingEntry {
  const ended = 'endReason' in storm;
  const end = ended ? storm.endedHour : hours;
  const endTick = Math.round(end * TICKS_PER_HOUR);
  // Dispatches made after a storm ended cannot affect that record, including later in its ending tick.
  const traffic = ended ? dispatches.filter(dispatch => dispatch.tick < endTick) : dispatches;
  const { displaced, deaths, floodedHomes } = estimateStormDamage(storm.damageScore);
  return {
    key: `${seed}:${storm.id}:${actionsHash(actions, endTick, traffic)}`, seed, stormId: storm.id,
    name: (storm.name ?? `#${storm.id}`).slice(0, 60),
    lossUsd: stormTotalLossUsd(storm), displaced, deaths, floodedHomes,
    grade: stageRank(storm.peakWind),
    lifetimeHours: storm.history.length ? end - storm.history[0].hour : storm.ageHours,
    endReason: ended ? storm.endReason : 'active', recordedAt,
  };
}

const byRecent = (a: RankingEntry, b: RankingEntry) => (a.recordedAt < b.recordedAt ? 1 : a.recordedAt > b.recordedAt ? -1 : 0);

/** Replaces any entry with the same key (keeping its first `recordedAt`); keeps the most recent MAX_RANKING_ENTRIES. */
export function upsert(entries: RankingEntry[], entry: RankingEntry): RankingEntry[] {
  const old = entries.find(e => e.key === entry.key);
  const next = [...entries.filter(e => e.key !== entry.key), old ? { ...entry, recordedAt: old.recordedAt } : entry];
  return next.length > MAX_RANKING_ENTRIES ? next.sort(byRecent).slice(0, MAX_RANKING_ENTRIES) : next;
}

/** Highest first; ties go to the larger loss, then the earlier record. Zero values are not ranked. */
export function rankBy(entries: RankingEntry[], metric: RankingMetric, limit = 10): RankingEntry[] {
  return entries.filter(e => e[metric] > 0)
    .sort((a, b) => b[metric] - a[metric] || b.lossUsd - a.lossUsd || -byRecent(a, b) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, limit);
}

const END_REASONS = new Set(['dissipated', 'extratropical', 'merged', 'ended']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** Strictly validates one untrusted stored entry and rebuilds it from known fields only. */
function parseEntry(v: unknown): RankingEntry | null {
  if (!isRecord(v)) return null;
  const { key, seed, stormId, name, lossUsd, displaced, deaths, floodedHomes, grade, lifetimeHours, endReason, recordedAt } = v;
  const disaster = typeof v.disasterId === 'string' && /^(weather|blizzard|thunderstorm|tornado)-\d+$/.test(v.disasterId)
    && (isWeatherHazardKind(v.kind) || v.kind === 'blizzard' || v.kind === 'thunderstorm' || v.kind === 'tornado');
  const identity = disaster ? v.disasterId : stormId;
  if (!isValidSeed(seed) || !count(stormId) || typeof key !== 'string' || !/^[0-9]+:(?:\d+|(?:weather|blizzard|thunderstorm|tornado)-\d+):[0-9a-f]{8}$/.test(key) || !key.startsWith(`${seed}:${identity}:`)) return null;
  if (typeof name !== 'string' || !name || name.length > 60) return null;
  if (!count(lossUsd) || !count(displaced) || !count(deaths) || !count(floodedHomes) || !count(grade) || grade > 99) return null;
  if (typeof lifetimeHours !== 'number' || !Number.isFinite(lifetimeHours) || lifetimeHours < 0 || lifetimeHours > 1e6) return null;
  if (typeof endReason !== 'string' || !END_REASONS.has(endReason)) return null;
  if (typeof recordedAt !== 'string' || recordedAt.length > 40) return null;
  return {
    key, seed, stormId, name, lossUsd, displaced, deaths, floodedHomes, grade, lifetimeHours,
    endReason: endReason as RankingEntry['endReason'], recordedAt,
    ...(disaster ? { disasterId: v.disasterId as string, kind: v.kind as DisasterKind } : {}),
  };
}

/** Parses stored ranking JSON; anything that is not a valid list yields []. Invalid entries are dropped. */
export function parseRankings(text: string | null): RankingEntry[] {
  if (!text || text.length > MAX_RANKING_BYTES) return [];
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.map(parseEntry).reduce<RankingEntry[]>((list, e) => (e ? upsert(list, e) : list), []);
}

/** Swappable persistence; a server-backed RankingStore is the planned follow-up. */
export interface RankingStore { load(): RankingEntry[]; save(entries: RankingEntry[]): void }

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>;
function browserStorage(): KeyValueStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
export function localRankingStore(storage: KeyValueStorage | null = browserStorage()): RankingStore {
  return {
    load() {
      try { return parseRankings(storage?.getItem(RANKING_KEY) ?? null); } catch { return []; }
    },
    save(entries) {
      try { storage?.setItem(RANKING_KEY, JSON.stringify(entries.filter(e => e.endReason !== 'active'))); } catch { /* storage is optional */ }
    },
  };
}
