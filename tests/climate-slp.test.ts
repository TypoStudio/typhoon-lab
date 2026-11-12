import { expect, it } from 'vitest';
import { slpClimatologyInto } from '../src/data/climate-slp';

const at = (grid: Float32Array, lon: number, lat: number) => grid[((lat + 89) / 2) * 180 + (lon + 179) / 2];

it('gives the real November pressure pattern on the weather grid and the opposite season in July', () => {
  const nov = new Float32Array(16200), jul = new Float32Array(16200);
  slpClimatologyInto(319, nov); slpClimatologyInto(197, jul); // mid-month centres
  expect(at(nov, 111, 45)).toBeGreaterThan(1020); // Siberian-Mongolian high
  expect(at(jul, 111, 45)).toBeLessThan(1011);
  expect(at(nov, 111, 45) - at(nov, 111, 21)).toBeGreaterThan(5);
  expect(nov.every(p => p > 950 && p < 1050)).toBe(true);
});

it('interpolates between month centres and wraps December into January', () => {
  const a = new Float32Array(16200), b = new Float32Array(16200), mid = new Float32Array(16200);
  slpClimatologyInto(1 + 365.25 * (11.5 / 12), a); slpClimatologyInto(1 + 365.25 * (0.5 / 12), b);
  slpClimatologyInto(1 + 365.25 * (12 / 12) - 0.0001, mid);
  for (const k of [0, 5000, 9000, 16199]) expect(mid[k]).toBeCloseTo((a[k] + b[k]) / 2, 1);
});
