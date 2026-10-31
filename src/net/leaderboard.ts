/**
 * Online leaderboard on Firestore (anonymous auth). Pure helpers first; the Firebase SDK is only reached through
 * dynamic imports inside the async functions, so importing this module costs nothing until the leaderboard is used.
 * Only an anonymous uid, the user-chosen nickname and storm outcomes are sent.
 */
import { stormTotalLossUsd } from '../simulation/damage-news';
import { stageRank } from '../simulation/engine';
import { disasterDamage, disasterName } from '../simulation/disasters';
import type { DisasterRecord, StormRecord } from '../types';
import { getFirebase } from './firebase';

export type LbWindow = 'live' | '7d' | '30d' | 'all';
const HOUR_MS = 3_600_000;
export const LB_WINDOW_MS: Record<Exclude<LbWindow, 'all'>, number> = { live: 24 * HOUR_MS, '7d': 7 * 24 * HOUR_MS, '30d': 30 * 24 * HOUR_MS };
export const LB_TOP = 50;
/** Newest results fetched per window query, aggregated client-side. */
export const LB_RESULT_LIMIT = 500;
export const NICKNAME_MAX = 20;
const NICKNAME_KEY = 'typhoon-lab-nickname';
const NICKNAME_DIRTY_KEY = 'typhoon-lab-nickname-unsynced';
const QUEUE_KEY = 'typhoon-lab-lb-queue';
const MAX_QUEUE = 50;

/** One ended, world-born storm worth uploading. */
export interface StormResult { seed: number; stormId: number; disasterId?: string; name: string; lossUsd: number; grade: number; stage: string; lifetimeHours: number }
export interface ResultData { uid: string; nickname: string; lossUsd: number; grade: number; endedMs: number }
export interface LbRow { uid: string; nickname: string; storms: number; maxGrade: number; lossUsd: number }
export interface LbView { uid: string; rows: LbRow[]; me: LbRow | null; /** 1-based rank of `me` when within the table, else null. */ myRank: number | null; fromCache: boolean }

// ---- pure helpers -----------------------------------------------------------------------------
export const resultId = (uid: string, seed: number, stormId: number, disasterId?: string): string => `${uid}_${seed}_${disasterId ?? stormId}`;
export const defaultNickname = (uid: string): string => `Player-${uid.slice(0, 4).toUpperCase()}`;

/** Trims, collapses whitespace and strips control/format characters; null when empty or longer than NICKNAME_MAX. No profanity filter. */
export function sanitizeNickname(raw: string): string | null {
  const name = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  return name && name.length <= NICKNAME_MAX ? name : null;
}

/** The upload for an ended storm, or null for loaded historic typhoons and for trivial storms (no loss and below grade 3). */
export function resultFromRecord(seed: number, record: StormRecord): StormResult | null {
  if (record.record) return null;
  const lossUsd = stormTotalLossUsd(record);
  const grade = stageRank(record.peakWind);
  if (lossUsd === 0 && grade < 3) return null;
  const peak = record.history.reduce<StormRecord['history'][number] | null>((best, h) => (!best || h.wind > best.wind ? h : best), null);
  return {
    seed, stormId: record.id, name: (record.name ?? `#${record.id}`).slice(0, 60), lossUsd, grade, stage: (peak?.stage ?? record.stage).slice(0, 40),
    lifetimeHours: record.history.length ? record.endedHour - record.history[0].hour : record.ageHours,
  };
}

export function resultFromDisaster(seed: number, record: DisasterRecord): StormResult | null {
  if (record.endedHour === undefined) return null;
  const { lossUsd } = disasterDamage(record);
  if (lossUsd <= 0) return null;
  const name = disasterName(record.kind);
  return { seed, stormId: 0, disasterId: record.id, name, lossUsd, grade: 0, stage: name,
    lifetimeHours: record.endedHour - record.startedHour };
}

/** Sums results per uid (newest nickname wins), ranked by loss, then storms, then nickname. */
export function aggregateResults(results: ResultData[]): LbRow[] {
  const byUid = new Map<string, LbRow & { at: number }>();
  for (const r of results) {
    const row = byUid.get(r.uid) ?? { uid: r.uid, nickname: r.nickname, storms: 0, maxGrade: 0, lossUsd: 0, at: -Infinity };
    row.storms += 1; row.lossUsd += r.lossUsd; row.maxGrade = Math.max(row.maxGrade, r.grade);
    if (r.endedMs >= row.at) { row.at = r.endedMs; row.nickname = r.nickname; }
    byUid.set(r.uid, row);
  }
  return [...byUid.values()].map(({ at: _at, ...row }) => row).sort(compareRows);
}
function compareRows(a: LbRow, b: LbRow): number {
  return b.lossUsd - a.lossUsd || b.storms - a.storms || (a.nickname < b.nickname ? -1 : a.nickname > b.nickname ? 1 : a.uid < b.uid ? -1 : 1);
}

// ---- local state ------------------------------------------------------------------------------
function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
export function storedNickname(): string | null {
  try { return sanitizeNickname(storage()?.getItem(NICKNAME_KEY) ?? ''); } catch { return null; }
}
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
function loadQueue(): StormResult[] {
  try {
    const data: unknown = JSON.parse(storage()?.getItem(QUEUE_KEY) ?? '[]');
    if (!Array.isArray(data)) return [];
    return data.filter((v): v is StormResult => typeof v === 'object' && v !== null && Number.isSafeInteger(v.seed) && Number.isSafeInteger(v.stormId)
      && typeof v.name === 'string' && typeof v.stage === 'string'
      && (v.disasterId === undefined || typeof v.disasterId === 'string' && /^(weather|blizzard|thunderstorm|tornado)-\d+$/.test(v.disasterId))).slice(0, MAX_QUEUE)
      .map(v => ({ ...v, lossUsd: num(v.lossUsd), grade: num(v.grade), lifetimeHours: num(v.lifetimeHours) }));
  } catch { return []; }
}
function saveQueue(queue: StormResult[]): void {
  try { storage()?.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE))); } catch { /* storage is optional */ }
}
/** Number of results waiting to be uploaded. */
export const queuedCount = (): number => loadQueue().length;
const sameResult = (a: StormResult, b: StormResult): boolean => a.seed === b.seed && a.stormId === b.stormId && a.disasterId === b.disasterId;

// ---- Firestore writes -------------------------------------------------------------------------
type Fs = typeof import('firebase/firestore');
type PlayerData = Record<string, unknown>;

/** The full players document after (optionally) counting one more result; createdAt is kept once set. */
function playerDoc(fs: Fs, old: PlayerData | undefined, nickname: string, add?: StormResult): PlayerData {
  const best = num(old?.bestLossUsd);
  const better = !!add && add.lossUsd > best;
  return {
    nickname, createdAt: old?.createdAt ?? fs.serverTimestamp(), updatedAt: fs.serverTimestamp(),
    storms: num(old?.storms) + (add ? 1 : 0), maxGrade: Math.max(num(old?.maxGrade), add?.grade ?? 0),
    totalLossUsd: num(old?.totalLossUsd) + (add?.lossUsd ?? 0), bestLossUsd: better ? add.lossUsd : best,
    bestStormName: better ? add.name : typeof old?.bestStormName === 'string' ? old.bestStormName : '',
  };
}

let writes: Promise<unknown> = Promise.resolve();
/** Runs a player-document transaction after the previous one; two creating the same document at once would fail with already-exists, so it also retries that once. */
function serialWrite(run: () => Promise<void>): Promise<void> {
  const attempt = async () => {
    try { await run(); } catch (e) {
      if ((e as { code?: string }).code !== 'already-exists') throw e;
      await run();
    }
  };
  const next = writes.then(attempt, attempt);
  writes = next.catch(() => undefined);
  return next;
}

/** Writes one result and bumps the player totals in a single transaction; an already-written result id is skipped. */
async function sendResult(item: StormResult): Promise<void> {
  const { db, uid } = await getFirebase();
  const fs = await import('firebase/firestore');
  const nickname = storedNickname() ?? defaultNickname(uid);
  const resultRef = fs.doc(db, 'results', resultId(uid, item.seed, item.stormId, item.disasterId));
  const playerRef = fs.doc(db, 'players', uid);
  await serialWrite(() => fs.runTransaction(db, async tx => {
    if ((await tx.get(resultRef)).exists()) return;
    const player = await tx.get(playerRef);
    tx.set(resultRef, { uid, nickname, lossUsd: item.lossUsd, grade: item.grade, stage: item.stage, lifetimeHours: item.lifetimeHours, endedAt: fs.serverTimestamp(), client: 'web' });
    tx.set(playerRef, playerDoc(fs, player.exists() ? player.data() : undefined, nickname, item));
  }));
}

let flushing: Promise<void> | null = null;
/** Uploads queued results one at a time; stops (keeping the rest queued) at the first transient failure. */
export function flushQueue(): Promise<void> {
  flushing ??= (async () => {
    await Promise.resolve(); // let `flushing` be assigned before the `finally` below can clear it (an empty queue returns synchronously)
    try {
      for (let item = loadQueue()[0]; item; item = loadQueue()[0]) {
        try { await sendResult(item); } catch (e) {
          // A result the rules refuse can never succeed; drop it instead of blocking the queue.
          const code = (e as { code?: string }).code;
          if (code !== 'permission-denied' && code !== 'invalid-argument') throw e;
        }
        saveQueue(loadQueue().filter(q => !sameResult(q, item)));
      }
    } finally { flushing = null; }
  })();
  return flushing;
}

/** Queues a result (idempotent per seed and storm) and tries to upload it now; failures stay queued for a later flush. */
export function submit(result: StormResult): Promise<void> {
  const queue = loadQueue();
  if (!queue.some(q => sameResult(q, result))) saveQueue([...queue, result]);
  return flushQueue().catch(() => undefined);
}

async function pushNickname(nickname: string): Promise<void> {
  const { db, uid } = await getFirebase();
  const fs = await import('firebase/firestore');
  const playerRef = fs.doc(db, 'players', uid);
  await serialWrite(() => fs.runTransaction(db, async tx => {
    const player = await tx.get(playerRef);
    tx.set(playerRef, playerDoc(fs, player.exists() ? player.data() : undefined, nickname));
  }));
  storage()?.removeItem(NICKNAME_DIRTY_KEY);
}

/** Validates and stores the nickname locally, then updates the player document; returns null when invalid. A failed sync is retried by `prepare`. */
export async function setNickname(raw: string): Promise<string | null> {
  const nickname = sanitizeNickname(raw);
  if (!nickname) return null;
  try { storage()?.setItem(NICKNAME_KEY, nickname); storage()?.setItem(NICKNAME_DIRTY_KEY, '1'); } catch { /* storage is optional */ }
  await pushNickname(nickname).catch(() => undefined);
  return nickname;
}

const DELETE_BATCH = 300;
/** Erases this device's uid from the board: every result, then the player document; also empties the upload queue. Throws `Leaderboard unavailable` when not signed in or the SDK cannot load. */
export async function deleteMyData(): Promise<{ results: number; player: boolean }> {
  const session = await getFirebase().catch(() => { throw new Error('Leaderboard unavailable'); });
  const { db, uid } = session;
  const fs = await import('firebase/firestore').catch(() => { throw new Error('Leaderboard unavailable'); });
  // Empty the queue first so a running flush uploads nothing more, then wait for it and any write already in flight.
  saveQueue([]);
  await flushing?.catch(() => undefined);
  await writes;
  let results = 0;
  for (;;) {
    const snap = await fs.getDocs(fs.query(fs.collection(db, 'results'), fs.where('uid', '==', uid), fs.limit(DELETE_BATCH)));
    if (snap.empty) break;
    const batch = fs.writeBatch(db);
    for (const d of snap.docs) batch.delete(d.ref);
    await batch.commit();
    results += snap.size;
  }
  const playerRef = fs.doc(db, 'players', uid);
  const player = (await fs.getDoc(playerRef)).exists();
  await fs.deleteDoc(playerRef);
  // The nickname stays in localStorage, but it is no longer waiting to be synced, so `prepare` does not recreate the player document; the next upload or nickname save does.
  try { storage()?.removeItem(NICKNAME_DIRTY_KEY); } catch { /* storage is optional */ }
  return { results, player };
}

/** Signs in, retries queued uploads and any unsynced nickname; resolves with the anonymous uid. Rejects when Firebase is unavailable. */
export async function prepare(): Promise<{ uid: string }> {
  const { uid } = await getFirebase();
  const nickname = storedNickname();
  if (nickname && storage()?.getItem(NICKNAME_DIRTY_KEY)) await pushNickname(nickname).catch(() => undefined);
  void flushQueue().catch(() => undefined);
  return { uid };
}

// ---- live views -------------------------------------------------------------------------------
const toRow = (uid: string, d: PlayerData): LbRow => ({ uid, nickname: typeof d.nickname === 'string' ? d.nickname : defaultNickname(uid), storms: num(d.storms), maxGrade: num(d.maxGrade), lossUsd: num(d.totalLossUsd) });

/** Live-updating leaderboard for one window; returns the unsubscribe function. Errors (including SDK/network failure) go to `onError`. */
export function subscribe(window: LbWindow, onView: (view: LbView) => void, onError: (e: unknown) => void): () => void {
  let stopped = false;
  const stops: (() => void)[] = [];
  void (async () => {
    const { uid } = await prepare();
    const { db } = await getFirebase();
    const fs = await import('firebase/firestore');
    if (stopped) return;
    const fail = (e: unknown) => { if (!stopped) onError(e); };
    if (window === 'all') {
      let top: { rows: LbRow[]; fromCache: boolean } | null = null;
      let mine: LbRow | null = null;
      const emit = () => {
        if (!top || stopped) return;
        const at = top.rows.findIndex(r => r.uid === uid);
        onView({ uid, rows: top.rows, me: at >= 0 ? top.rows[at] : mine, myRank: at >= 0 ? at + 1 : null, fromCache: top.fromCache });
      };
      stops.push(fs.onSnapshot(fs.query(fs.collection(db, 'players'), fs.orderBy('totalLossUsd', 'desc'), fs.limit(LB_TOP)), snap => {
        top = { rows: snap.docs.map(d => toRow(d.id, d.data())).filter(r => r.storms > 0), fromCache: snap.metadata.fromCache };
        emit();
      }, fail));
      stops.push(fs.onSnapshot(fs.doc(db, 'players', uid), snap => {
        mine = snap.exists() && num(snap.data().storms) > 0 ? toRow(uid, snap.data()) : null;
        emit();
      }, fail));
      return;
    }
    // Firestore needs the range field as the first sort key, so this takes the newest results rather than the biggest.
    const since = Date.now() - LB_WINDOW_MS[window];
    stops.push(fs.onSnapshot(fs.query(fs.collection(db, 'results'), fs.where('endedAt', '>=', fs.Timestamp.fromMillis(since)), fs.orderBy('endedAt', 'desc'), fs.limit(LB_RESULT_LIMIT)), snap => {
      const results = snap.docs.map((d): ResultData => {
        const data = d.data({ serverTimestamps: 'estimate' });
        return { uid: String(data.uid), nickname: String(data.nickname), lossUsd: num(data.lossUsd), grade: num(data.grade), endedMs: data.endedAt?.toMillis?.() ?? Date.now() };
      }).filter(r => r.endedMs >= Date.now() - LB_WINDOW_MS[window]);
      const all = aggregateResults(results);
      const at = all.findIndex(r => r.uid === uid);
      onView({ uid, rows: all.slice(0, LB_TOP), me: at >= 0 ? all[at] : null, myRank: at >= 0 && at < LB_TOP ? at + 1 : null, fromCache: snap.metadata.fromCache });
    }, fail));
  })().catch(e => { if (!stopped) onError(e); });
  return () => { stopped = true; for (const stop of stops.splice(0)) stop(); };
}
