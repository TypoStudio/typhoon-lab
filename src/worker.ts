/// <reference lib="webworker" />
import type { GameState, ToolType, WorkerRequest, WorkerResponse } from './types';
import { SCENARIO } from './data/world';
import { typhoonById } from './data/typhoons';
import { loadEnvironment } from './data/environment';
import { loadLiveWeather } from './data/live-weather';
import { focusTraffic } from './simulation/traffic';
import { DEFAULT_START_DOY, REPLAY_MAX_TICKS, STEP_HOURS, createGame, isValidDayOfYear, isValidSeed, loadHistoric, placeFormation, placeTool, replayGame, setClimate, setGenesis, setHistoricEnvironment, setSeason, stepGame, validateActions } from './simulation/engine';
import { DEFAULT_TIME_SPEED, isTimeSpeed } from './time';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const TIMER_MS = 250;
const STEP_MS = STEP_HOURS * 3_600_000;
const MAX_STEPS_PER_TICK = 64;

let state: GameState = createGame(SCENARIO.seed);
let playing = false;
let interacting = false;
let speed = DEFAULT_TIME_SPEED;
let carry = 0;
let lastWallMs = performance.now();
let timer: ReturnType<typeof setInterval> | null = null;

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}
function postState(): void {
  post({ type: 'state', state, clockHours: state.hours + carry * STEP_HOURS });
}
function fail(message: string): void {
  post({ type: 'error', message });
}

function syncTimer(): void {
  lastWallMs = performance.now();
  if (playing && !interacting) {
    if (timer === null) timer = setInterval(tick, TIMER_MS);
  } else {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }
}

/** Accumulate actual elapsed wall time; the weather model still advances in fixed 15-minute steps. */
function advanceTo(now: number): number {
  const elapsed = Math.max(0, now - lastWallMs);
  lastWallMs = now;
  if (!playing || interacting) return 0;
  carry += elapsed * speed / STEP_MS;
  const steps = Math.min(MAX_STEPS_PER_TICK, Math.floor(carry + 1e-9));
  carry -= steps;
  for (let k = 0; k < steps; k++) stepGame(state);
  return steps;
}

function tick(): void {
  if (advanceTo(performance.now())) postState();
  else post({ type: 'progress', clockHours: state.hours + carry * STEP_HOURS });
}

function seedFrom(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return isValidSeed(value) ? value : null;
}

async function ensureEnvironment(typhoonId: string): Promise<void> {
  if (typhoonById(typhoonId)) setHistoricEnvironment(typhoonId, await loadEnvironment(typhoonId));
}

async function handle(msg: WorkerRequest): Promise<void> {
  switch (msg.type) {
    case 'init':
    case 'reset': {
      const seed = seedFrom(msg.seed, msg.type === 'reset' ? state.seed : SCENARIO.seed);
      if (seed === null) return fail('Seed must be an integer between 0 and 4294967295.');
      const start = msg.startDayOfYear ?? DEFAULT_START_DOY;
      if (!isValidDayOfYear(start)) return fail('Start day of the year must be between 0 and 366.');
      playing = false;
      syncTimer();
      const weather = msg.weather === 'live' ? await loadLiveWeather() : undefined;
      state = createGame(seed, start, weather?.snapshot);
      if (weather) state.weatherSource = weather.source;
      speed = DEFAULT_TIME_SPEED;
      carry = 0;
      playing = true;
      syncTimer();
      return postState();
    }
    case 'play': {
      if (typeof msg.playing !== 'boolean') return fail('Play needs true or false.');
      advanceTo(performance.now());
      playing = msg.playing;
      syncTimer();
      return postState();
    }
    case 'interaction': {
      if (typeof msg.active !== 'boolean') return fail('Map interaction needs true or false.');
      advanceTo(performance.now());
      interacting = msg.active;
      syncTimer();
      // Acknowledge the final checkpoint after any already-running tick, before camera release.
      return post({ type: 'interaction', active: interacting, state, clockHours: state.hours + carry * STEP_HOURS });
    }
    case 'speed': {
      if (!isTimeSpeed(msg.speed)) return fail('Speed must be 1, 600, or 28800 model seconds per real second.');
      advanceTo(performance.now());
      speed = msg.speed;
      return postState();
    }
    case 'traffic-view': {
      if (!playing || interacting || msg.tick !== state.tick) return;
      const dispatchCount = state.traffic.dispatches.length;
      const result = focusTraffic(state, msg.departures, msg.visibleVehicles);
      if (!result.ok) return fail(result.reason ?? 'Invalid traffic view.');
      if (state.traffic.dispatches.length !== dispatchCount) postState();
      return;
    }
    case 'place': {
      const result = placeTool(state, msg.tool as ToolType, msg.lon, msg.lat);
      post({ type: 'placement', result });
      return postState();
    }
    case 'formation': {
      const result = placeFormation(state, msg.kind, msg.lon, msg.lat);
      post({ type: 'placement', result });
      return postState();
    }
    case 'genesis': {
      if (typeof msg.on !== 'boolean') return fail('Natural formation needs on or off.');
      const result = setGenesis(state, msg.on);
      post({ type: 'placement', result });
      return postState();
    }
    case 'climate': {
      const result = setClimate(state, msg.key, msg.value);
      post({ type: 'placement', result });
      return postState();
    }
    case 'season': {
      const result = setSeason(state, msg.dayOfYear);
      post({ type: 'placement', result });
      return postState();
    }
    case 'historic': {
      if (typeof msg.typhoonId !== 'string' || !typhoonById(msg.typhoonId)) return fail('Unknown typhoon.');
      await ensureEnvironment(msg.typhoonId);
      const result = loadHistoric(state, msg.typhoonId);
      post({ type: 'placement', result });
      return postState();
    }
    case 'replay': {
      // Every historic typhoon the log loads needs its reanalysis registered first; invalid logs fail in replayGame.
      const checked = validateActions(msg.actions, REPLAY_MAX_TICKS);
      if (checked.ok) {
        const ids = new Set(checked.actions.flatMap(a => (a.type === 'historic' ? [a.typhoonId] : [])));
        for (const id of ids) await ensureEnvironment(id);
      }
      const result = replayGame(msg.seed, msg.actions, msg.untilTick, msg.startDayOfYear, msg.trafficDispatches, msg.initialWeather);
      if (!result.ok) return fail(`Replay rejected: ${result.reason}`);
      state = result.state;
      playing = false; // replay loads a paused snapshot
      carry = 0;
      syncTimer();
      return postState();
    }
    default:
      return fail('Unknown worker request.');
  }
}

/** Requests run one at a time in arrival order, so a reset that waits for its environment file cannot be overtaken. */
let queue: Promise<void> = Promise.resolve();
ctx.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (typeof data !== 'object' || data === null || typeof (data as { type?: unknown }).type !== 'string') {
    return fail('Malformed worker request.');
  }
  queue = queue.then(async () => {
    try {
      await handle(data as WorkerRequest);
    } catch (err) {
      playing = false;
      syncTimer();
      fail(err instanceof Error ? err.message : 'Simulation error.');
    }
  });
});
