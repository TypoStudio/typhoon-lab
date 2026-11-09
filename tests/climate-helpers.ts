import { STEP_HOURS, TICKS_PER_HOUR, genesisPotential, sampleEnvironment, stepGame } from '../src/simulation/engine';
import type { GameState } from '../src/types';

export const TICKS_PER_DAY = 24 * TICKS_PER_HOUR;

/** Full physics for whole days (tools age, storms move). */
export function fullDays(s: GameState, days: number): void {
  const until = s.tick + Math.round(days * TICKS_PER_DAY);
  while (s.tick < until) stepGame(s);
}

/**
 * Cheap time skip for experiments that only read the environment: the clock jumps to one tick before each day boundary and one real
 * step crosses it, which advances the climate layer by exactly one day. Tools and storms do not age, so only use it when none is
 * active (run `fullDays` first until the tools have expired).
 */
export function skipDays(s: GameState, days: number): void {
  while (s.tick % TICKS_PER_DAY !== 0) stepGame(s);
  if (s.effects.length || s.storms.length) throw new Error('skipDays needs a world without active tools or storms');
  for (let d = 0; d < days; d++) { s.tick += TICKS_PER_DAY - 1; s.hours = s.tick * STEP_HOURS; stepGame(s); }
}

/** Longitude-latitude centroid of the engine's own genesis score over the western North Pacific (105E-185E, 5N-30N, 5 degree spacing). */
export function genesisCentroid(s: GameState): { lon: number; lat: number; total: number } {
  let w = 0, x = 0, y = 0;
  for (let lon = 105; lon <= 185; lon += 5) for (let lat = 5; lat <= 30; lat += 5) {
    const g = genesisPotential(sampleEnvironment(s, lon > 180 ? lon - 360 : lon, lat), lat);
    w += g; x += g * lon; y += g * lat;
  }
  return { lon: x / w, lat: y / w, total: w };
}

/** Mean vertical wind shear over the main development region of the tropical Atlantic (10N-20N, 90W-20W). */
export function atlanticShear(s: GameState): number {
  let sum = 0, n = 0;
  for (let lon = -90; lon <= -20; lon += 10) for (let lat = 10; lat <= 20; lat += 5) { sum += sampleEnvironment(s, lon, lat).shear; n++; }
  return sum / n;
}
