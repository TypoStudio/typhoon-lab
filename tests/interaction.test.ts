import { describe, expect, it } from 'vitest';
import { createGame, stepGame, steeringFlow, placeTool, STEP_HOURS, MAX_INTERACTION_MS } from '../src/simulation/engine';
import { distanceKm, moveKm, offsetKm } from '../src/simulation/geo';
import type { GameState, Storm } from '../src/types';

function storm(id: number, lon = 145, lat = 16, wind = 40): Storm {
  return { id, lon, lat, wind, movementSpeedKmh: 0, pressure: 980, radiusKm: 40, galeRadiusKm: 200,
    stage: 'Typhoon', ageHours: 48, peakWind: wind, track: [{ lon, lat }], forecast: [], history: [], damageScore: 0, windDelta: 0 };
}
function world(...storms: Storm[]): GameState {
  const s = createGame(); s.storms = storms; return s;
}
function perturbation(s: GameState, st: Storm) {
  const coupled = steeringFlow(s, st);
  const alone = steeringFlow({ ...s, storms: [st] }, st);
  return { u: coupled.u - alone.u, v: coupled.v - alone.v };
}

describe('storm movement and mutual interaction', () => {
  it('reports actual travel per model hour, including wrapping across the dateline', () => {
    for (const lon of [145, -179.999]) {
      const s = world(storm(1, lon));
      const before = { ...s.storms[0] };
      stepGame(s);
      const after = s.storms[0];
      expect(after.movementSpeedKmh).toBeCloseTo(distanceKm(before.lon, before.lat, after.lon, after.lat) / STEP_HOURS, 9);
      expect(after.movementSpeedKmh).toBeGreaterThan(0);
      expect(after.movementSpeedKmh).not.toBeCloseTo(after.wind * 3.6, 1);
    }
  });

  it('rotates northern pairs counterclockwise and southern pairs clockwise, with close-range convergence', () => {
    for (const lat of [16, -16]) {
      const a = storm(1, 145, lat), b = storm(2, 147, lat);
      const s = world(a, b);
      const left = perturbation(s, a), right = perturbation(s, b);
      expect(left.u).toBeGreaterThan(0);
      expect(right.u).toBeLessThan(0);
      expect(left.v * Math.sign(lat)).toBeLessThan(0);
      expect(right.v * Math.sign(lat)).toBeGreaterThan(0);
    }
  });

  it('leaves isolated, newborn, far-away and opposite-spin storms unchanged', () => {
    for (const mode of ['alone', 'birth', 'far', 'opposite']) {
      const a = storm(1), b = storm(2, 147);
      if (mode === 'birth') b.ageHours = 0;
      if (mode === 'far') b.lon = 165;
      if (mode === 'opposite') { a.lat = 1; b.lat = -1; }
      expect(perturbation(world(a, ...(mode === 'alone' ? [] : [b])), a)).toEqual({ u: 0, v: 0 });
    }
  });

  it('keeps crowded/coincident centres finite and bounded, regardless of array order', () => {
    const a = storm(1);
    const neighbours = Array.from({ length: 40 }, (_, i) => storm(i + 2, 145.2 + i * .01, 16, 90));
    const s = world(a, ...neighbours, storm(99));
    const motion = perturbation(s, a);
    expect(Math.hypot(motion.u, motion.v)).toBeLessThanOrEqual(MAX_INTERACTION_MS + 1e-12);
    expect(Math.hypot(motion.u, motion.v)).toBeGreaterThan(0);
    const reversed = { ...s, storms: [...s.storms].reverse() };
    expect(steeringFlow(reversed, a)).toEqual(steeringFlow(s, a));
  });

  it('uses the nearby neighbour across the dateline rather than a 360-degree separation', () => {
    const a = storm(1, 179), b = storm(2, -179);
    const motion = perturbation(world(a, b), a);
    expect(motion.u).toBeGreaterThan(0);
    expect(motion.v).toBeLessThan(0);
  });

  it('lets a developed strong/weak pair converge and merge instead of sharing parallel tracks indefinitely', () => {
    const s = world(storm(1), storm(2, 147, 16, 19));
    const start = distanceKm(145, 16, 147, 16);
    stepGame(s);
    expect(s.storms).toHaveLength(2);
    expect(distanceKm(s.storms[0].lon, s.storms[0].lat, s.storms[1].lon, s.storms[1].lat)).toBeLessThan(start);
    for (let n = 0; n < 72 / STEP_HOURS && s.storms.length === 2; n++) stepGame(s);
    expect(s.news.some(n => n.kind === 'merger')).toBe(true);
    expect(s.storms).toHaveLength(1);
  });

  it('excludes the artificial merger-centre jump from the speed reading', () => {
    const s = world(storm(1), storm(2, 145.5, 16, 19));
    const before = structuredClone(s);
    // stepGame advances the clock first; this fixture has no aging tools to alter steering.
    const motion = steeringFlow(before, before.storms[0]);
    stepGame(s);
    expect(s.storms).toHaveLength(1);
    expect(s.storms[0].id).toBe(1);
    expect(s.storms[0].movementSpeedKmh).toBeCloseTo(Math.hypot(motion.u, motion.v) * 3.6, 8);
    const mergedTravel = distanceKm(before.storms[0].lon, before.storms[0].lat, s.storms[0].lon, s.storms[0].lat) / STEP_HOURS;
    expect(Math.abs(mergedTravel - s.storms[0].movementSpeedKmh)).toBeGreaterThan(1);
  });

  it('forecasts coupled paths without mutating live positions, ages, news or storm count', () => {
    const s = world(storm(1), storm(2, 147, 16, 19));
    const before = structuredClone(s.storms);
    const news = structuredClone(s.news);
    expect(placeTool(s, 'moisture', 145, 16).ok).toBe(true); // refreshes forecast
    expect(s.storms.map(({lon, lat, ageHours}) => ({lon, lat, ageHours})))
      .toEqual(before.map(({lon, lat, ageHours}) => ({lon, lat, ageHours})));
    expect(s.news).toEqual(news);
    expect(s.storms).toHaveLength(2);
    const a = s.storms[0], b = s.storms[1];
    expect(a.forecast.length).toBeGreaterThan(0);
    expect(b.forecast.length).toBeGreaterThan(0);
    expect(b.forecast.length).toBeLessThan(a.forecast.length); // absorbed path ends
    // One-step coupled velocity and actual motion agree; no sequential-update bias.
    const motions = s.storms.map(st => steeringFlow(s, st));
    const predicted = s.storms.map((st, i) => moveKm(st.lon, st.lat, motions[i].u * 3.6 * STEP_HOURS, motions[i].v * 3.6 * STEP_HOURS));
    stepGame(s);
    for (let i = 0; i < s.storms.length; i++) {
      const offset = offsetKm(predicted[i].lon, predicted[i].lat, s.storms[i].lon, s.storms[i].lat);
      expect(Math.hypot(offset.dx, offset.dy)).toBeLessThan(1e-8);
    }
  });
});
