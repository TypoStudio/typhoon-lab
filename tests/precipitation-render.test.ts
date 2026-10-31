import { describe, expect, it } from 'vitest';
import { createGame } from '../src/simulation/engine';
import { buildFieldData, sampleGrid, sampleSmoothGrid } from '../src/render/fields';
import { samplePrecipitation } from '../src/render/precipitation';
import { ParticleSystem } from '../src/render/particles';

function field() {
  const state = createGame(1);
  for (const c of state.grid) {
    c.rain = 10; c.airTemperature = 8; c.snow = 0; c.u = 20; c.v = 0; c.blizzard = false;
  }
  return buildFieldData(state.grid)!;
}

describe('continuous rain and snow rendering', () => {
  it('does not paint a warm area as snow just because a neighbouring snowy cell contributes a trace', () => {
    const f = field(), index = 45 * f.cols + 90; // Cell centre 1°E, 1°N.
    f.snow[index] = 10; f.airTemperature[index] = -8; f.blizzardF[index] = 1;
    expect(sampleGrid(f, f.snow, 2.8, 1)).toBeGreaterThan(0);
    const weather = samplePrecipitation(f, 2.8, 1);
    expect(weather.rain).toBe(10);
    expect(weather.snowFraction).toBe(0);
    expect(weather.snow).toBe(0);
    expect(weather.blizzard).toBe(0);
  });

  it('blends continuously through freezing without a binary rain/snow colour switch', () => {
    const f = field();
    for (let row = 0; row < f.rows; row++) for (let col = 0; col < f.cols; col++) {
      f.airTemperature[row * f.cols + col] = -180 + (col + 0.5) * 2;
    }
    expect(samplePrecipitation(f, -1, 1).snowFraction).toBe(1);
    expect(samplePrecipitation(f, 0, 1).snowFraction).toBeCloseTo(0.5);
    expect(samplePrecipitation(f, 1, 1).snowFraction).toBe(0);
    let previous = 1;
    for (let lon = -1; lon <= 1; lon += 0.01) {
      const current = samplePrecipitation(f, lon, 1).snowFraction;
      expect(current).toBeLessThanOrEqual(previous + 1e-9);
      expect(previous - current).toBeLessThan(0.01);
      previous = current;
    }
  });

  it('has matching rainfall slopes on either side of a calculation cell boundary', () => {
    const f = field();
    for (let row = 0; row < f.rows; row++) {
      f.rain[row * f.cols + 89] = 2;
      f.rain[row * f.cols + 90] = 8;
      f.rain[row * f.cols + 91] = 20;
    }
    const epsilon = 0.0001, read = (lon: number) => sampleSmoothGrid(f, f.rain, lon, 1);
    expect(read(1)).toBe(8);
    const left = (read(1) - read(1 - epsilon)) / epsilon;
    const right = (read(1 + epsilon) - read(1)) / epsilon;
    expect(left).toBeGreaterThan(0);
    expect(Math.abs(left - right)).toBeLessThan(0.01);
    for (let lon = -1; lon < 3; lon += 0.02) {
      expect(read(lon)).toBeGreaterThanOrEqual(2);
      expect(read(lon)).toBeLessThanOrEqual(20);
    }
  });

  it('fades blizzard trails from continuous snow and wind instead of square binary masks', () => {
    const f = field();
    f.airTemperature.fill(-5);
    const particles = new ParticleSystem(); particles.resize(3); particles.frozen = true;
    particles.lon.set([0, 1, 2]); particles.lat.fill(1);
    particles.update(0, f, { west: -180, east: 180, south: -90, north: 90 }, 10);
    expect(Array.from(particles.blizzard)).toEqual([1, 1, 1]);
    expect(Array.from(particles.snow)).toEqual([10, 10, 10]);
    f.u.fill(15);
    particles.update(0, f, { west: -180, east: 180, south: -90, north: 90 }, 10);
    expect(particles.blizzardFactor(1)).toBeCloseTo(0.5);
    f.airTemperature.fill(2);
    particles.update(0, f, { west: -180, east: 180, south: -90, north: 90 }, 10);
    expect(particles.snowFactor(1)).toBe(0);
    expect(particles.blizzardFactor(1)).toBe(0);
  });

  it('wraps the date line, clamps polar samples and keeps dry fields transparent', () => {
    const f = field();
    for (let row = 0; row < f.rows; row++) f.rain[row * f.cols] = 2;
    f.airTemperature.fill(-2);
    expect(samplePrecipitation(f, 179.5, 90)).toEqual(samplePrecipitation(f, -180.5, 90));
    expect(samplePrecipitation(f, 0, 95)).toEqual(samplePrecipitation(f, 0, 89));
    f.rain.fill(0);
    expect(samplePrecipitation(f, 0, 0)).toEqual({ rain: 0, snow: 0, snowFraction: 0, blizzard: 0 });
  });
});
