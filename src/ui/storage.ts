import { SCENARIO } from '../data/world';
import {
  REPLAY_FILE_VERSION, REPLAY_MAX_ACTIONS, REPLAY_MAX_TICKS, TICKS_PER_HOUR, isValidDayOfYear, isValidSeed, isValidUntilTick, validateActions,
} from '../simulation/engine';
import type { ActionRecord, GameState, LiveWeatherSnapshot, TrafficDispatch } from '../types';
import { isLiveWeatherSnapshot } from '../simulation/live-weather';
import { MAX_TRAFFIC_DISPATCHES, validateTrafficDispatches } from '../simulation/traffic';

/** `?seed=<uint32>` from a query string; null when absent or not a plain non-negative integer. */
export function parseSeedParam(search: string): number | null {
  const raw = new URLSearchParams(search).get('seed');
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const seed = Number(raw);
  return isValidSeed(seed) ? seed : null;
}

export function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

export const REPLAY_FORMAT = 'typhoon-lab-replay';
export const REPLAY_VERSION = REPLAY_FILE_VERSION;
/** Room for placements, the initial five-field weather snapshot and replay headers. */
export const MAX_REPLAY_BYTES = 2_000_000;

export interface ReplayFile {
  format: typeof REPLAY_FORMAT; formatVersion: number;
  scenarioId: string; version: string; seed: number; untilTick: number; startDayOfYear: number;
  actions: ActionRecord[]; exportedAt?: string; trafficDispatches?: TrafficDispatch[]; initialWeather?: LiveWeatherSnapshot;
}

/** Why the world can no longer be exported as a replay, or null when it can. Live play is never limited. */
export function replayExportProblem(state: GameState): string | null {
  if (state.traffic.dispatches.length > MAX_TRAFFIC_DISPATCHES) return 'Too many traffic dispatches to export this replay.';
  if (state.tick > REPLAY_MAX_TICKS) {
    return `Replays cover at most ${Math.round(REPLAY_MAX_TICKS / TICKS_PER_HOUR / 24)} model days (tick ${REPLAY_MAX_TICKS}); this world is at tick ${state.tick}. The world keeps running; reset to record a new replay.`;
  }
  if (state.actions.length > REPLAY_MAX_ACTIONS) {
    return `Replays hold at most ${REPLAY_MAX_ACTIONS} placements; this world has ${state.actions.length}. The world keeps running; reset to record a new replay.`;
  }
  if ((state.initialWeather || state.traffic.dispatches.length) && new TextEncoder().encode(JSON.stringify(buildReplay(state), null, 2)).length > MAX_REPLAY_BYTES) {
    return `Replay is larger than ${Math.round(MAX_REPLAY_BYTES / 1000)} kB.`;
  }
  return null;
}

/** Snapshot of the world as seed + placements up to the current tick. */
export function buildReplay(state: GameState): ReplayFile {
  return {
    format: REPLAY_FORMAT, formatVersion: REPLAY_VERSION,
    scenarioId: state.scenarioId, version: state.version, seed: state.seed, untilTick: state.tick, startDayOfYear: state.initialStartDayOfYear,
    actions: state.actions.map((a): ActionRecord => a.type === 'genesis' ? { tick: a.tick, type: a.type, on: a.on }
      : a.type === 'climate' ? { tick: a.tick, type: a.type, key: a.key, value: a.value }
      : a.type === 'season' ? { tick: a.tick, type: a.type, dayOfYear: a.dayOfYear }
      : a.type === 'historic' ? { tick: a.tick, type: a.type, typhoonId: a.typhoonId }
      : { tick: a.tick, type: a.type, lon: a.lon, lat: a.lat, ...(a.formation ? { formation: a.formation } : {}) }),
    exportedAt: new Date().toISOString(),
    ...(state.initialWeather ? { initialWeather: structuredClone(state.initialWeather) } : {}),
    ...(state.traffic.dispatches.length ? { trafficDispatches: structuredClone(state.traffic.dispatches) } : {}),
  };
}

const TOP_KEYS = new Set(['format', 'formatVersion', 'scenarioId', 'version', 'seed', 'untilTick', 'startDayOfYear', 'actions', 'exportedAt', 'trafficDispatches', 'initialWeather']);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Strictly validates untrusted replay JSON text with the simulation's own limits. */
export function parseReplay(text: string): { ok: true; replay: ReplayFile } | { ok: false; error: string } {
  if (text.length > MAX_REPLAY_BYTES) return { ok: false, error: `Replay is larger than ${Math.round(MAX_REPLAY_BYTES / 1000)} kB.` };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { ok: false, error: 'The file is not valid JSON.' }; }
  if (!isRecord(data)) return { ok: false, error: 'A replay must be a JSON object.' };
  if (data.format !== REPLAY_FORMAT) return { ok: false, error: 'This is not a Typhoon Lab replay file.' };
  if (data.formatVersion !== REPLAY_VERSION) {
    return { ok: false, error: `Replay format version ${String(data.formatVersion).slice(0, 12)} is not supported; this build reads version ${REPLAY_VERSION} (older regional replays cannot be loaded).` };
  }
  for (const key of Object.keys(data)) if (!TOP_KEYS.has(key)) return { ok: false, error: `Unexpected field "${key.slice(0, 40)}".` };
  if (data.scenarioId !== SCENARIO.id) return { ok: false, error: `Replay is for scenario "${String(data.scenarioId).slice(0, 60)}", not "${SCENARIO.id}".` };
  if (data.version !== SCENARIO.version) return { ok: false, error: `Replay was recorded with simulation ${String(data.version).slice(0, 20)}; this build is ${SCENARIO.version}.` };
  if (!isValidSeed(data.seed)) return { ok: false, error: 'Replay seed must be an integer from 0 to 4294967295.' };
  if (!isValidUntilTick(data.untilTick)) return { ok: false, error: `Replay untilTick must be a whole number from 0 to ${REPLAY_MAX_TICKS}.` };
  if (!isValidDayOfYear(data.startDayOfYear)) return { ok: false, error: 'Replay startDayOfYear must be a number from 0 to 366.' };
  if (data.initialWeather !== undefined && !isLiveWeatherSnapshot(data.initialWeather)) return { ok: false, error: 'Replay starting weather is invalid.' };
  const checked = validateActions(data.actions, data.untilTick);
  if (!checked.ok) return { ok: false, error: checked.reason };
  const traffic = validateTrafficDispatches(data.trafficDispatches === undefined ? [] : data.trafficDispatches, data.untilTick);
  if (!traffic.ok) return { ok: false, error: traffic.reason };
  if (data.exportedAt !== undefined && (typeof data.exportedAt !== 'string' || data.exportedAt.length > 40)) return { ok: false, error: 'Replay export time is invalid.' };
  return {
    ok: true,
    replay: {
      format: REPLAY_FORMAT, formatVersion: REPLAY_VERSION, scenarioId: SCENARIO.id, version: SCENARIO.version,
      seed: data.seed, untilTick: data.untilTick, startDayOfYear: data.startDayOfYear, actions: checked.actions, exportedAt: data.exportedAt as string | undefined,
      ...(traffic.dispatches.length ? { trafficDispatches: traffic.dispatches } : {}),
      ...(data.initialWeather ? { initialWeather: data.initialWeather as LiveWeatherSnapshot } : {}),
    },
  };
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
