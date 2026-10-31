import { expect, it } from 'vitest';
import { createGame, isLand, LAND_WIND_FACTOR, steeringFlow, stormVortexAt, stepGame } from '../src/simulation/engine';
import { moveKm } from '../src/simulation/geo';
import { buildFieldData, sampleWind } from '../src/render/fields';
import { attachStormWind } from '../src/render/storm-wind';
import { ParticleSystem } from '../src/render/particles';
import { MapView } from '../src/render/view';
import type { Storm } from '../src/types';

const stormAt = (lon: number, lat: number): Storm => ({
  id: 999, lon, lat, wind: 60, movementSpeedKmh: 0, pressure: 950, radiusKm: 30, galeRadiusKm: 300,
  ageHours: 48, peakWind: 60, stage: 'Typhoon', track: [], forecast: [], history: [], damageScore: 0, windDelta: 0,
});

it.each([[140.4, 20.3], [179.9, 18.4], [80.4, -18.6]])('resolves a sub-grid cyclone at its actual centre (%s, %s)', (lon, lat) => {
  const state = createGame(1), storm = stormAt(lon, lat);
  state.storms = [storm];
  const motion = steeringFlow(state, storm);
  const expectedWind = (x: number, y: number) => {
    const vortex = stormVortexAt(storm, motion, x, y);
    const factor = isLand(x, y) ? LAND_WIND_FACTOR : 1;
    return [3 + vortex.u * factor, -2 + vortex.v * factor];
  };
  for (const cell of state.grid) [cell.u, cell.v] = expectedWind(cell.lon, cell.lat);
  const field = buildFieldData(state.grid)!, out = new Float64Array(2);
  sampleWind(field, lon, lat, out);
  expect(Math.hypot(out[0] - 3, out[1] + 2)).toBeGreaterThan(1);
  attachStormWind(field, state);
  sampleWind(field, lon, lat, out);
  expect(out[0]).toBeCloseTo(3, 4);
  expect(out[1]).toBeCloseTo(-2, 4);
  for (const [east, north] of [[30, 0], [-30, 0], [0, 30], [0, -30], [800, 500]]) {
    const p = moveKm(lon, lat, east, north), expected = expectedWind(p.lon, p.lat);
    sampleWind(field, p.lon, p.lat, out);
    expect(out[0]).toBeCloseTo(expected[0], 4);
    expect(out[1]).toBeCloseTo(expected[1], 4);
  }
  const particles = new ParticleSystem();
  particles.resize(1); particles.lon[0] = lon; particles.lat[0] = lat;
  particles.life[0] = 100; particles.age[0] = 0;
  particles.update(0, field, { west: -180, east: 180, south: -90, north: 90 });
  expect(particles.speed[0]).toBeCloseTo(Math.hypot(3, -2), 4);
});

it('preserves actual simulation wind at grid centres without doubling overlapping vortices', () => {
  const state = createGame(1);
  state.storms = [stormAt(140.4, 20.3), { ...stormAt(143.2, 22.4), id: 1000 }];
  state.remnants = [{ ...stormAt(136.2, 18.3), id: 1001, hours: 1 }];
  stepGame(state);
  const field = buildFieldData(state.grid)!, originalU = field.u.slice(), originalV = field.v.slice();
  attachStormWind(field, state);
  const out = new Float64Array(2);
  for (const cell of state.grid) {
    sampleWind(field, cell.lon, cell.lat, out);
    expect(out[0]).toBeCloseTo(cell.u, 4);
    expect(out[1]).toBeCloseTo(cell.v, 4);
  }
  expect(field.u).toEqual(originalU);
  expect(field.v).toEqual(originalV);
});

it('keeps ordinary wind sampling when no cyclone or remnant is present', () => {
  const state = createGame(1), field = buildFieldData(state.grid)!;
  const before = new Float64Array(2), after = new Float64Array(2);
  sampleWind(field, 140.4, 20.3, before);
  attachStormWind(field, state);
  sampleWind(field, 140.4, 20.3, after);
  expect(field.windAt).toBeUndefined();
  expect(after).toEqual(before);
});

it('clears the mature eye while keeping the eyewall and weak depressions visible', () => {
  const state = createGame(1), storm = stormAt(140.4, 20.3);
  state.storms = [storm];
  const field = buildFieldData(state.grid)!;
  attachStormWind(field, state);
  const view = new MapView(); view.resize(800, 800); view.setHome(storm.lon, storm.lat, 5);
  const particles = new ParticleSystem(); particles.resize(1);
  particles.lon[0] = storm.lon; particles.lat[0] = storm.lat; particles.life[0] = 100; particles.age[0] = 20;
  particles.update(0, field, view.visibleBounds(), view.scale);
  expect(particles.fade(0)).toBe(0);
  expect(particles.traceStreak(0, view, new Float64Array(18))).toBe(0);
  particles.frozen = true;
  expect(particles.fade(0)).toBe(0);
  const eyewall = moveKm(storm.lon, storm.lat, storm.radiusKm, 0);
  expect(field.windVisibilityAt!(eyewall.lon, eyewall.lat)).toBe(1);
  storm.wind = 20;
  attachStormWind(field, state);
  expect(field.windVisibilityAt).toBeUndefined();
  expect(particles.fade(0)).toBeGreaterThan(0);
});

it('slows the displayed inner rotation while preserving outer motion and measured wind', () => {
  const state = createGame(1);
  const storm = stormAt(140.4, 20.3);
  state.storms = [storm];
  stepGame(state);
  const field = buildFieldData(state.grid)!;
  attachStormWind(field, state);
  const radius = field.windAnimationRadiusKm;
  const particles = new ParticleSystem();
  particles.resize(1); particles.life[0] = 100;
  for (const distance of [10, 800]) {
    const p = moveKm(storm.lon, storm.lat, distance, 0);
    particles.lon[0] = p.lon; particles.lat[0] = p.lat;
    field.windAnimationRadiusKm = undefined;
    particles.update(0, field, { west: -180, east: 180, south: -90, north: 90 }, 100);
    const original = Math.hypot(particles.vLon[0], particles.vLat[0]), measured = particles.speed[0];
    field.windAnimationRadiusKm = radius;
    particles.update(0, field, { west: -180, east: 180, south: -90, north: 90 }, 100);
    const adjusted = Math.hypot(particles.vLon[0], particles.vLat[0]);
    if (distance === 10) expect(adjusted).toBeLessThan(original * 0.6);
    else expect(adjusted).toBeCloseTo(original, 6);
    expect(particles.speed[0]).toBe(measured);
  }
});

it('follows a tight circular flow without spiralling outward at accelerated playback', () => {
  const field = buildFieldData(createGame(1).grid)!;
  // An ideal circular flow isolates integration error from the model's inward wind.
  field.windAt = (lon, lat, out) => {
    out[0] = -lat * 100 * Math.cos(lat * Math.PI / 180) * 111.32 / 110.57;
    out[1] = (lon - 140) * 100;
  };
  field.windAnimationRadiusKm = (lon, lat) => Math.hypot(lon - 140, lat) * 110.57;
  const particles = new ParticleSystem();
  particles.resize(1); particles.lon[0] = 141; particles.lat[0] = 0;
  particles.life[0] = 1000; particles.age[0] = 0;
  for (let frame = 0; frame < 300; frame++) {
    particles.update(1 / 30, field, { west: -180, east: 180, south: -90, north: 90 }, 100, undefined, undefined, 5);
  }
  expect(Math.hypot(particles.lon[0] - 140, particles.lat[0])).toBeCloseTo(1, 2);
});
