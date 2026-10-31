import type { GeoPoint, Thunderstorm } from '../types';
import { clamp, distanceKm, hash01, moveKm } from './geo';

const TAU = 2 * Math.PI;
const MAX_STEP_HOURS = 1 / 16;
const TURN_RESPONSE_HOURS = 0.65;
const MAX_TURN_RADIANS_PER_HOUR = Math.PI / 3;
type Flow = { u: number; v: number; shear: number };

/** Game approximation: follow the steering flow with slowly varying, seeded lateral motion.
 * Short midpoint steps and limited turning keep both the actual path and its damage track curved. */
export function moveTornado(storm: Thunderstorm, seed: number, dt: number, sample: (point: GeoPoint) => Flow): void {
  if (dt <= 0) return;
  const steps = Math.ceil(dt / MAX_STEP_HOURS), step = dt / steps;
  const phase = hash01(seed, 8820, storm.id) * TAU;
  const secondary = hash01(seed, 8821, storm.id) * TAU;
  const age = storm.ageHours - (storm.tornadoStartAgeHours ?? 0);
  for (let n = 0; n < steps; n++) {
    const flow = sample(storm), speed = Math.hypot(flow.u, flow.v);
    const baseHeading = speed > 1 ? Math.atan2(flow.v, flow.u) : Math.atan2(0.44, 0.9);
    const elapsed = age + (n + 0.5) * step;
    const bend = 0.5 * Math.sin(TAU * elapsed / 4.5 + phase) + 0.18 * Math.sin(TAU * elapsed / 8 + secondary);
    const target = baseHeading + bend;
    const previous = storm.tornadoMotion?.headingRad ?? target;
    const delta = Math.atan2(Math.sin(target - previous), Math.cos(target - previous));
    const turn = clamp(delta * (1 - Math.exp(-step / TURN_RESPONSE_HOURS)), -MAX_TURN_RADIANS_PER_HOUR * step, MAX_TURN_RADIANS_PER_HOUR * step);
    const heading = previous + turn;
    const motion = clamp(Math.max(speed, 18 + 0.35 * flow.shear), 20, 30);
    const u = Math.cos(previous + turn / 2) * motion, v = Math.sin(previous + turn / 2) * motion;
    const point = moveKm(storm.lon, storm.lat, u * step * 3.6, v * step * 3.6);
    storm.tornadoDistanceKm = (storm.tornadoDistanceKm ?? 0) + distanceKm(storm.lon, storm.lat, point.lon, point.lat);
    storm.lon = point.lon; storm.lat = point.lat;
    storm.tornadoMotion = { headingRad: Math.atan2(Math.sin(heading), Math.cos(heading)), u, v };
    storm.tornadoTrack ??= [];
    storm.tornadoTrack.push(point);
  }
}
