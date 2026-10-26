/// <reference lib="webworker" />
import type { GameState, ToolType, WorkerRequest, WorkerResponse } from './types';
import { SCENARIO } from './data/world';
import { typhoonById } from './data/typhoons';
import { loadEnvironment } from './data/environment';
import { DEFAULT_START_DOY, REPLAY_MAX_TICKS, STEP_HOURS, createGame, isValidDayOfYear, isValidSeed, loadHistoric, placeTool, replayGame, setClimate, setGenesis, setHistoricEnvironment, setSeason, stepGame, validateActions } from './simulation/engine';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const TIMER_MS = 250;
const SPEEDS = [1, 4, 12];
/** Base 1x = 1 simulated hour per real second; steps per timer tick at speed s = s * STEPS_PER_TICK_1X. */
const STEPS_PER_TICK_1X = (TIMER_MS / 1000) / STEP_HOURS;

let state: GameState = createGame(SCENARIO.seed);
let playing = false;
let speed = 1;
let carry = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}
function postState(): void {
  post({ type: 'state', state });
}
function fail(message: string): void {
  post({ type: 'error', message });
}

function syncTimer(): void {
  if (playing) {
    if (timer === null) timer = setInterval(tick, TIMER_MS);
  } else {
    if (timer !== null) clearInterval(timer);
    timer = null;
    carry = 0;
  }
}

/** Fixed steps only; speed changes how many steps run per timer tick, never the step size. */
function tick(): void {
  carry += speed * STEPS_PER_TICK_1X;
  const steps = Math.floor(carry + 1e-9);
  carry -= steps;
  for (let k = 0; k < steps; k++) stepGame(state);
  postState();
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
      state = createGame(seed, start);
      speed = 1;
      playing = true; // the live world starts running at 1×
      syncTimer();
      return postState();
    }
    case 'play': {
      if (typeof msg.playing !== 'boolean') return fail('Play needs true or false.');
      playing = msg.playing;
      syncTimer();
      return postState();
    }
    case 'speed': {
      if (!SPEEDS.includes(msg.speed)) return fail(`Speed must be one of ${SPEEDS.join(', ')}.`);
      speed = msg.speed;
      return postState();
    }
    case 'place': {
      const result = placeTool(state, msg.tool as ToolType, msg.lon, msg.lat);
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
      const result = replayGame(msg.seed, msg.actions, msg.untilTick, msg.startDayOfYear);
      if (!result.ok) return fail(`Replay rejected: ${result.reason}`);
      state = result.state;
      playing = false; // replay loads a paused snapshot
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
