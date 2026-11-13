/// <reference lib="webworker" />
import type { GameState, ToolType, WorkerRequest, WorkerResponse } from './types';
import { SCENARIO } from './data/world';
import { typhoonById } from './data/typhoons';
import { loadEnvironment } from './data/environment';
import { loadLiveWeather } from './data/live-weather';
import { focusTraffic } from './simulation/traffic';
import {
  DEFAULT_START_DOY, REPLAY_MAX_TICKS, STEP_HOURS, CLIMATE_MAX_DAYS, advanceClimateTime, createGame, fastDaysLeft, isValidDayOfYear, isValidSeed, loadHistoric, placeFormation, placeTool, refreshClimateView, replayGame, setClimate, setClimateMode,
  loadClimateScenario, endClimateScenarioNow, resetClimateNow, resetDisastersNow, resetConditionsNow, setGenesis, setHistoricEnvironment, setSeason, skipAhead, stepGame, validateActions,
} from './simulation/engine';
import { DEFAULT_TIME_SPEED, MAX_WEATHER_SPEED, TIME_SPEEDS, isFastClimateSpeed, isTimeSpeed, takeSteps } from './time';

const ctx = self as unknown as DedicatedWorkerGlobalScope;
const TIMER_MS = 250;
const STEP_MS = STEP_HOURS * 3_600_000;
const MAX_STEPS_PER_TICK = 64;
/** Wall-clock budget for one tick's steps, leaving the rest of the timer interval for the state post and incoming messages. */
const TICK_BUDGET_MS = 200;

let state: GameState = createGame(SCENARIO.seed);
let playing = false;
let interacting = false;
let speed = DEFAULT_TIME_SPEED;
let carry = 0;
let lastWallMs = performance.now();
let timer: ReturnType<typeof setInterval> | null = null;

// Fast climate path: above MAX_WEATHER_SPEED the weather engine is not stepped; the ENSO layer advances day by day instead.
const FAST_CHUNK_DAYS = 30; // days per engine call, so the tick budget is checked often
let fastCarry = 0; // fractional model days not yet advanced
let fastViewStale = false; // days have passed since the anomaly fields and the grid were last rebuilt for the map

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}
function postState(): void {
  post({ type: 'state', state, clockHours: state.hours + carry * STEP_HOURS });
}
function fail(message: string): void {
  post({ type: 'error', message });
}

/** Takes the fast path while the speed is above the weather speeds and leaves it when it is back down. Both switches are recorded actions, so replays follow. */
function syncPath(): void {
  const wantFast = isFastClimateSpeed(speed);
  if (wantFast === (state.climateTime?.active ?? false)) return;
  const result = setClimateMode(state, wantFast);
  if (!result.ok) { fail(result.reason ?? 'The climate path could not be switched.'); return; }
  fastCarry = 0;
  fastViewStale = false;
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
  syncPath();
  if (state.climateTime?.active) { advanceFast(elapsed); return 0; }
  carry += elapsed * speed / STEP_MS;
  const due = takeSteps(carry, MAX_STEPS_PER_TICK);
  carry = due.carry;
  const began = performance.now();
  let steps = 0;
  while (steps < due.steps) {
    stepGame(state);
    steps++;
    if (performance.now() - began > TICK_BUDGET_MS) break;
  }
  carry = Math.min(MAX_STEPS_PER_TICK, carry + due.steps - steps);
  return steps;
}

/** The run's fast climate time is used up: the speed drops to the fastest weather speed (once, so Play does not fail again and again) and the player is told. */
function fastTimeUsedUp(): void {
  speed = MAX_WEATHER_SPEED;
  syncPath();
  post({ type: 'speed', speed });
  fail(`Fast climate time is limited to ${CLIMATE_MAX_DAYS / 365} model years per run.`);
}

/** Advances the ENSO layer for `elapsedMs` of real time within the tick budget and the days the run has left; what is not done stays in the carry. The map's fields are rebuilt once per tick, not per model day. */
function advanceFast(elapsedMs: number): void {
  let left = fastDaysLeft(state);
  if (left <= 0) return fastTimeUsedUp();
  const daysPerSecond = speed / 86_400;
  fastCarry = Math.min(daysPerSecond, fastCarry + (elapsedMs / 1000) * daysPerSecond); // at most a second's worth after a stall
  let due = Math.floor(fastCarry);
  fastCarry -= due;
  const began = performance.now();
  while (due > 0 && left > 0) {
    const n = Math.min(due, FAST_CHUNK_DAYS, left);
    const result = advanceClimateTime(state, n);
    if (!result.ok) { fail(result.reason ?? 'Climate time cannot advance.'); due = 0; break; }
    fastViewStale = true;
    due -= n;
    left -= n;
    if (performance.now() - began > TICK_BUDGET_MS) break;
  }
  fastCarry += due;
  if (fastViewStale) { refreshClimateView(state); fastViewStale = false; }
  if (left <= 0) fastTimeUsedUp();
}

function tick(): void {
  const before = state.climateTime?.total ?? 0;
  if (advanceTo(performance.now()) || (state.climateTime?.total ?? 0) !== before) postState();
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
      fastCarry = 0;
      fastViewStale = false;
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
      if (!isTimeSpeed(msg.speed)) return fail(`Speed must be one of ${TIME_SPEEDS.join(', ')} model seconds per real second.`);
      advanceTo(performance.now());
      if (isFastClimateSpeed(msg.speed) && fastDaysLeft(state) <= 0) return fail(`Fast climate time is limited to ${CLIMATE_MAX_DAYS / 365} model years per run.`);
      speed = msg.speed;
      if (playing && !interacting) syncPath();
      return postState();
    }
    case 'skip': {
      advanceTo(performance.now());
      if (isFastClimateSpeed(speed) || state.climateTime?.active) return fail('Time cannot be skipped at the fast climate speed.');
      skipAhead(state);
      lastWallMs = performance.now(); // the skip's own run time is not played time
      return post({ type: 'state', state, clockHours: state.hours + carry * STEP_HOURS, skipped: true });
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
    case 'climate-scenario': {
      const result = loadClimateScenario(state, msg.scenarioId);
      post({ type: 'placement', result });
      return postState();
    }
    case 'climate-scenario-off': {
      const result = endClimateScenarioNow(state);
      post({ type: 'placement', result });
      return postState();
    }
    case 'climate-reset': {
      const result = resetClimateNow(state);
      post({ type: 'placement', result });
      return postState();
    }
    case 'disaster-reset': {
      const result = resetDisastersNow(state);
      post({ type: 'placement', result });
      return postState();
    }
    case 'conditions-reset': {
      const result = resetConditionsNow(state);
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
      const result = replayGame(msg.seed, msg.actions, msg.untilTick, msg.startDayOfYear, msg.trafficDispatches, msg.initialWeather,
        tick => post({ type: 'replay-progress', tick, untilTick: msg.untilTick }));
      if (!result.ok) return fail(`Replay rejected: ${result.reason}`);
      state = result.state;
      playing = false; // replay loads a paused snapshot
      carry = 0;
      fastCarry = 0;
      fastViewStale = false;
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
