import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createGame } from '../src/simulation/engine';
import { buildFieldData } from '../src/render/fields';
import { ParticleSystem } from '../src/render/particles';
import { HUMIDITY_BUCKETS, humidityBucket } from '../src/render/base';
import { Ramp, type RGB } from '../src/render/theme';

describe('humidity on wind trails', () => {
  it('samples local moisture independently of wind speed and refreshes it with motion frozen', () => {
    const state = createGame();
    for (const cell of state.grid) {
      cell.humidity = cell.lon < 130 ? 0.2 : 0.9;
      cell.u = 10; cell.v = 3;
    }
    const field = buildFieldData(state.grid)!;
    const particles = new ParticleSystem();
    particles.resize(2);
    particles.lon.set([120, 140]); particles.lat.fill(20);
    particles.frozen = true;
    particles.update(1, field, { west: 100, east: 160, south: 0, north: 40 }, 4);
    expect(particles.humidity[0]).toBeCloseTo(0.2);
    expect(particles.humidity[1]).toBeCloseTo(0.9);
    expect(particles.speed[0]).toBe(particles.speed[1]);
    const velocities = particles.vLon.slice();
    field.humidity.fill(0.65);
    particles.update(1, field, { west: 100, east: 160, south: 0, north: 40 }, 4);
    expect(Array.from(particles.lon)).toEqual([120, 140]);
    expect(particles.humidity[0]).toBeCloseTo(0.65);
    expect(particles.vLon).toEqual(velocities);
  });

  it('samples the same humidity on either world copy at the dateline', () => {
    const field = buildFieldData(createGame().grid)!;
    const particles = new ParticleSystem();
    particles.resize(2); particles.frozen = true;
    particles.lon.set([-179, 181]); particles.lat.fill(20);
    particles.update(0, field, { west: 170, east: 190, south: 10, north: 30 }, 4);
    expect(particles.humidity[0]).toBeCloseTo(particles.humidity[1], 7);
    expect(particles.humidity[0]).toBeGreaterThan(0);
    expect(particles.humidity[0]).toBeLessThanOrEqual(1);
  });

  it('makes every wetter colour bucket brighter using the actual design tokens', () => {
    const tokens = readFileSync(new URL('../tokens.css', import.meta.url), 'utf8');
    const colours: RGB[] = [0, 1, 2].map(i => {
      const hex = tokens.match(new RegExp(`--ramp-humidity-${i}:\\s*#([0-9a-f]{6})`, 'i'))![1];
      return [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) as RGB;
    });
    const ramp = new Ramp(colours, [0, 0.5, 1]);
    const rgb = new Uint8Array(3);
    const linear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    let previous = -1;
    for (let bucket = 0; bucket < HUMIDITY_BUCKETS; bucket++) {
      const humidity = bucket / (HUMIDITY_BUCKETS - 1);
      expect(humidityBucket(humidity)).toBe(bucket);
      ramp.at(humidity, rgb, 0);
      const luminance = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
      expect(luminance).toBeGreaterThan(previous);
      previous = luminance;
    }
    expect(humidityBucket(-1)).toBe(0);
    expect(humidityBucket(2)).toBe(HUMIDITY_BUCKETS - 1);
  });
});
