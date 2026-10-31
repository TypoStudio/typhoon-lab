import { expect, it } from 'vitest';
import { buildFieldData } from '../src/render/fields';
import { ParticleSystem, WIND_STREAK_PX, WIND_STREAK_SEGMENTS } from '../src/render/particles';
import { MapView } from '../src/render/view';
import { createGame } from '../src/simulation/engine';

it('curves wind streaks along the field within the requested length', () => {
  const trace = (strength: number) => {
    const state = createGame();
    for (const cell of state.grid) {
      cell.u = -(cell.lat - 20) * strength;
      cell.v = (cell.lon - 130) * strength;
    }
    const field = buildFieldData(state.grid)!;
    const view = new MapView();
    view.resize(800, 800); view.setHome(130, 20, 15);
    const particles = new ParticleSystem();
    particles.resize(1); particles.lon[0] = 131; particles.lat[0] = 20; particles.life[0] = 100;
    particles.update(0, field, view.visibleBounds(), view.scale);
    const points = new Float64Array((WIND_STREAK_SEGMENTS + 1) * 2);
    expect(particles.traceStreak(0, view, points)).toBe(WIND_STREAK_SEGMENTS + 1);
    return { points, speed: particles.speed[0] };
  };
  const slow = trace(15), fast = trace(60);
  const length = (points: Float64Array) => {
    let total = 0;
    for (let i = 1; i <= WIND_STREAK_SEGMENTS; i++) {
      total += Math.hypot(points[i * 2] - points[(i - 1) * 2], points[i * 2 + 1] - points[(i - 1) * 2 + 1]);
    }
    return total;
  };
  expect(length(slow.points)).toBeGreaterThan(WIND_STREAK_PX);
  expect(length(slow.points)).toBeLessThanOrEqual(WIND_STREAK_PX * 3);
  expect(length(fast.points)).toBeGreaterThan(WIND_STREAK_PX);
  expect(length(fast.points)).toBeLessThanOrEqual(WIND_STREAK_PX * 5);
  const points = slow.points;
  const cross = (points[2] - points[0]) * (points[5] - points[3]) - (points[3] - points[1]) * (points[4] - points[2]);
  expect(Math.abs(cross)).toBeGreaterThan(0.1);
});

it('draws longer streaks above typhoon strength and hides calm air', () => {
  const state = createGame(), field = buildFieldData(state.grid)!;
  const view = new MapView(); view.resize(800, 800); view.setHome(130, 20, 15);
  const particles = new ParticleSystem(); particles.resize(1);
  const points = new Float64Array((WIND_STREAK_SEGMENTS + 1) * 2);
  const lengths = [0, 5, 15, 35, 70, 150].map(speed => {
    field.u.fill(speed); field.v.fill(0);
    particles.lon[0] = 130; particles.lat[0] = 20; particles.life[0] = 100;
    particles.update(0, field, view.visibleBounds(), view.scale);
    const count = particles.traceStreak(0, view, points);
    let length = 0;
    for (let i = 1; i < count; i++) length += Math.hypot(points[i * 2] - points[(i - 1) * 2], points[i * 2 + 1] - points[(i - 1) * 2 + 1]);
    return length;
  });
  expect(lengths[0]).toBe(0);
  expect(lengths[1]).toBeLessThan(lengths[2]);
  expect(lengths[3]).toBeGreaterThan(lengths[2]);
  expect(lengths[4]).toBeCloseTo(lengths[3], 4);
  expect(lengths[5]).toBeCloseTo(135, 4);
});

it.each([15, 45, 100])('keeps a zoomed-out circular tail smooth and on its streamline at span %s', async span => {
  const { GlobeView } = await import('../src/render/globe-view');
  const field = buildFieldData(createGame(1).grid)!;
  field.windAt = (lon, lat, out) => {
    out[0] = -lat * 100 * Math.cos(lat * Math.PI / 180) * 111.32 / 110.57;
    out[1] = (lon - 140) * 100;
  };
  for (const view of [new MapView(), new GlobeView()]) {
    view.resize(800, 800); view.setHome(140, 0, span);
    const particles = new ParticleSystem(); particles.resize(1);
    particles.lon[0] = 140.5; particles.lat[0] = 0; particles.life[0] = 100;
    particles.update(0, field, view.visibleBounds(), view.scale);
    const points = new Float64Array((WIND_STREAK_SEGMENTS + 1) * 2);
    const count = particles.traceStreak(0, view, points);
    expect(count).toBe(WIND_STREAK_SEGMENTS + 1);
    for (let j = 1; j < count; j++) {
      const at = view.pxToLonLat(points[j * 2], points[j * 2 + 1])!;
      // The old long Euler steps spiralled out of the sub-grid vortex when zoomed out.
      expect(Math.hypot(at[0] - 140, at[1])).toBeCloseTo(0.5, 2);
      if (j < 2) continue;
      const ax = points[(j - 1) * 2] - points[(j - 2) * 2];
      const ay = points[(j - 1) * 2 + 1] - points[(j - 2) * 2 + 1];
      const bx = points[j * 2] - points[(j - 1) * 2];
      const by = points[j * 2 + 1] - points[(j - 1) * 2 + 1];
      const angle = Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by)))));
      expect(angle).toBeLessThan(Math.PI / 10);
    }
  }
});
