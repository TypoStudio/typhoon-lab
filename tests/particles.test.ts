import { describe, expect, it } from 'vitest';
import { buildFieldData } from '../src/render/fields';
import { ParticleSystem, WIND_STREAK_PX, setWindStreakTail } from '../src/render/particles';
import { KM_PER_DEG_LAT, KM_PER_DEG_LON, MapView } from '../src/render/view';
import { createGame } from '../src/simulation/engine';
import { TIME_SPEEDS, windAnimationMultiplier } from '../src/time';

const uniformField = (u: number, v: number) => {
  const state = createGame();
  for (const cell of state.grid) { cell.u = u; cell.v = v; }
  return buildFieldData(state.grid)!;
};
const WORLD = { west: -180, east: 180, south: -90, north: 90 };

describe('particle system', () => {
  it('keeps projected streak speed consistent while zooming', () => {
    const field = uniformField(12, 5);
    const particles = new ParticleSystem();
    particles.resize(1);
    const tail = new Float64Array(2);
    const lengths: number[] = [];
    for (const zoom of [1, 2, 3]) {
      const view = new MapView();
      view.resize(1200, 800);
      view.setHome(130, 10, 30);
      view.zoomAt(zoom, 600, 400);
      particles.lon[0] = 130; particles.lat[0] = 10; particles.life[0] = 100; particles.age[0] = 0;
      particles.update(0, field, view.visibleBounds(), view.scale);
      particles.tailLonLat(0, tail);
      const head = view.projectZ(130, 10);
      const end = view.projectZ(tail[0], tail[1]);
      const drawn = new Float64Array(2);
      setWindStreakTail(head[0], head[1], end[0], end[1], drawn);
      lengths.push(Math.hypot(head[0] - drawn[0], head[1] - drawn[1]));
    }
    expect(lengths[0]).toBeCloseTo(WIND_STREAK_PX);
    expect(lengths[1] / lengths[0]).toBeCloseTo(1, 1);
    expect(lengths[2] / lengths[0]).toBeCloseTo(1, 1);
  });

  it('restores the initial wind display speed across real-time frames', () => {
    const field = uniformField(20, 0), particles = new ParticleSystem();
    const scale = 100;
    particles.resize(1); particles.life[0] = 100; particles.lon[0] = 140; particles.lat[0] = 0;
    for (let i = 0; i < 60; i++) particles.update(1 / 60, field, WORLD, scale);
    const expected = 20 * 2.4 / scale * KM_PER_DEG_LAT / KM_PER_DEG_LON;
    expect(particles.lon[0] - 140).toBeCloseTo(expected, 6);
    expect(particles.lat[0]).toBe(0);
  });

  it('holds the initial speed per screen pixel and limits exceptionally fast winds', () => {
    const particles = new ParticleSystem(); particles.resize(1); particles.life[0] = 100;
    for (const scale of [1, 10, 100]) {
      particles.lon[0] = 140; particles.lat[0] = 0; particles.age[0] = 0;
      particles.update(0.1, uniformField(20, 0), WORLD, scale);
      expect(particles.vLon[0] * scale * KM_PER_DEG_LON / KM_PER_DEG_LAT).toBeCloseTo(48, 4);
      particles.update(0, uniformField(1000, 0), WORLD, scale);
      expect(particles.vLon[0] * scale * KM_PER_DEG_LON / KM_PER_DEG_LAT).toBeCloseTo(500, 4);
    }
  });

  it('caps wind movement at the third time-speed step', () => {
    const field = uniformField(20, 0);
    const distances = TIME_SPEEDS.map(speed => {
      const particles = new ParticleSystem();
      particles.resize(1); particles.life[0] = 100; particles.age[0] = 0; particles.lon[0] = 140; particles.lat[0] = 0;
      particles.update(0.1, field, WORLD, 100, undefined, undefined, windAnimationMultiplier(speed));
      expect(particles.age[0]).toBeCloseTo(0.1);
      return particles.lon[0] - 140;
    });
    const expectedMultipliers = [1, 2, 3, 3, 3, 3];
    distances.forEach((distance, index) => expect(distance / distances[0]).toBeCloseTo(expectedMultipliers[index], 5));
  });

  it('pauses particle motion and lifetime and resumes at the same speed', () => {
    const field = uniformField(0, 30), particles = new ParticleSystem();
    particles.resize(1); particles.life[0] = 100; particles.lon[0] = 140; particles.lat[0] = 10;
    particles.update(1, field, WORLD, 10);
    expect(particles.lat[0] - 10).toBeCloseTo(7.2, 5);
    particles.paused = true;
    const before = { lon: particles.lon[0], lat: particles.lat[0], age: particles.age[0] };
    particles.update(10, field, WORLD, 10);
    expect({ lon: particles.lon[0], lat: particles.lat[0], age: particles.age[0] }).toEqual(before);
    particles.paused = false;
    particles.update(1, field, WORLD, 10);
    expect(particles.lat[0] - before.lat).toBeCloseTo(7.2, 5);
  });

  it('reports a blizzard factor without lengthening the streak', () => {
    const tailLength = (blizzard: number) => {
      const field = uniformField(20, 0);
      const k = field.cols * Math.floor(field.rows / 2) + Math.floor(field.cols / 2);
      const lon = -180 + (Math.floor(field.cols / 2) + 0.5) * (360 / field.cols);
      const lat = -90 + (Math.floor(field.rows / 2) + 0.5) * (180 / field.rows);
      field.rain[k] = 10; field.airTemperature[k] = blizzard ? -5 : 5;
      field.snow[k] = blizzard ? 10 : 0; field.blizzardF[k] = blizzard; field.blizzard[k] = blizzard;
      const particles = new ParticleSystem();
      particles.resize(1);
      particles.lon[0] = lon; particles.lat[0] = lat; particles.life[0] = 100; particles.age[0] = 0;
      particles.update(0, field, WORLD, 1);
      const out = new Float64Array(2);
      particles.tailLonLat(0, out);
      return { factor: particles.blizzardFactor(0), snow: particles.snowFactor(0), len: Math.abs(lon - out[0]) };
    };
    const calm = tailLength(0);
    const storm = tailLength(1);
    expect(storm.factor).toBeCloseTo(1, 5);
    expect(calm.factor).toBe(0);
    expect(storm.snow).toBeCloseTo(0.5, 5);
    expect(storm.len / calm.len).toBeCloseTo(1.0, 3);
  });

  it('seeds equally in strong and calm wind', () => {
    const state = createGame(1);
    for (const cell of state.grid) { cell.u = cell.lon >= 0 ? 35 : 0; cell.v = 0; cell.blizzard = false; }
    const field = buildFieldData(state.grid)!;
    const particles = new ParticleSystem();
    particles.resize(4000); particles.life.fill(0); particles.age.fill(0);
    particles.update(0.001, field, { west: -20, east: 20, south: -10, north: 10 }, 10);
    const strong = Array.from(particles.lon).filter(lon => lon >= 0).length;
    expect(strong / particles.count).toBeGreaterThan(0.47);
    expect(strong / particles.count).toBeLessThan(0.53);
  });

  it('does not concentrate wind particles inside blizzard cells', () => {
    const shareInCell = (withBlizzard: boolean) => {
      const field = uniformField(0, 0);
      const col = 120; const row = 60;
      if (withBlizzard) field.blizzard[row * field.cols + col] = 1;
      const particles = new ParticleSystem();
      particles.resize(400);
      particles.life.fill(0); particles.age.fill(0);
      particles.update(0.1, field, WORLD, 1);
      const west = -180 + col * 2; const south = -90 + row * 2;
      let inside = 0;
      for (let i = 0; i < particles.count; i++) {
        if (particles.lon[i] >= west && particles.lon[i] < west + 2 && particles.lat[i] >= south && particles.lat[i] < south + 2) inside++;
      }
      return { share: inside / particles.count, minLife: Math.min(...particles.life) };
    };
    const calm = shareInCell(false);
    const storm = shareInCell(true);
    expect(calm.share).toBeLessThan(0.02);
    expect(storm.share).toBe(calm.share);
    expect(storm.minLife).toBe(calm.minLife);
  });

  it('wraps eastward motion across the dateline', () => {
    const field = uniformField(10, 0);
    const particles = new ParticleSystem();
    particles.resize(1);
    particles.lon[0] = 179.999999; particles.lat[0] = 0; particles.life[0] = 100; particles.age[0] = 0;
    particles.update(0.1, field, WORLD, 1);
    expect(particles.lon[0]).toBeLessThan(-170);
    expect(particles.lon[0]).toBeGreaterThanOrEqual(-180);
  });

  it('seeds with equal density per area: latitude counts follow cos(lat)', () => {
    const particles = new ParticleSystem();
    particles.resize(20000);
    particles.reseed(WORLD);
    const bands = [[0, 20], [20, 40], [40, 60], [60, 80]];
    const counts = bands.map(([a, b]) => {
      let c = 0;
      for (let i = 0; i < particles.count; i++) { const l = Math.abs(particles.lat[i]); if (l >= a && l < b) c++; }
      return c;
    });
    bands.forEach(([a, b], k) => {
      const expected = 20000 * (Math.sin((b * Math.PI) / 180) - Math.sin((a * Math.PI) / 180));
      expect(Math.abs(counts[k] / expected - 1)).toBeLessThan(0.1);
    });
  });

  it('respects the visible filter on reseed', () => {
    const particles = new ParticleSystem();
    particles.resize(2000);
    // Half the world is visible; 4 tries leave a 1/16 chance of a miss, so most must land inside.
    const visible = (lon: number) => lon > 0;
    particles.reseed(WORLD, visible);
    let inside = 0;
    for (let i = 0; i < particles.count; i++) if (visible(particles.lon[i])) inside++;
    expect(inside / particles.count).toBeGreaterThan(0.9);
    // A fully visible window is seeded exactly inside the bounds.
    particles.reseed({ west: 170, east: 200, south: -10, north: 10 }, () => true);
    for (let i = 0; i < particles.count; i++) {
      expect(particles.lon[i] >= 170 || particles.lon[i] <= -160).toBe(true);
      expect(Math.abs(particles.lat[i])).toBeLessThanOrEqual(10);
    }
  });

  it('respawns particles that are no longer visible during update', () => {
    const field = uniformField(0, 0);
    const particles = new ParticleSystem();
    particles.resize(1);
    particles.lon[0] = -90; particles.lat[0] = 0; particles.life[0] = 100; particles.age[0] = 1;
    particles.update(0.1, field, { west: 0, east: 180, south: -90, north: 90 }, 1, lon => lon > 0);
    expect(particles.lon[0]).toBeGreaterThan(0);
  });

  it('the geographic direction probe follows the wind velocity', () => {
    const field = uniformField(8, -6);
    const particles = new ParticleSystem();
    particles.resize(1);
    particles.lon[0] = 100; particles.lat[0] = 45; particles.life[0] = 100; particles.age[0] = 0;
    particles.update(0, field, WORLD, 3);
    const tail = new Float64Array(2);
    particles.tailLonLat(0, tail);
    const dx = particles.lon[0] - tail[0], dy = particles.lat[0] - tail[1];
    expect(Math.hypot(dx, dy)).toBeCloseTo(0.001, 8);
    expect(dx / dy).toBeCloseTo(particles.vLon[0] / particles.vLat[0], 6);
    expect(tail[0]).toBeLessThan(particles.lon[0]);
    expect(tail[1]).toBeGreaterThan(particles.lat[0]);
  });
});
