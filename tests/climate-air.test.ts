import { expect, it } from 'vitest';
import { airClimatologyInto } from '../src/data/climate-air';
import { sstClimatologyInto } from '../src/data/climate-normals';
import { slpClimatologyInto } from '../src/data/climate-slp';
import { stepLiveWeather } from '../src/simulation/live-weather';

const at = (grid: Float32Array, lon: number, lat: number) => grid[((lat + 89) / 2) * 180 + (lon + 179) / 2];

it('gives the real October air temperatures on the weather grid and the opposite season in April', () => {
  const oct = new Float32Array(16200), apr = new Float32Array(16200);
  airClimatologyInto(299, oct); airClimatologyInto(105, apr);
  expect(at(oct, 91, 61)).toBeGreaterThan(-12); expect(at(oct, 91, 61)).toBeLessThan(-4); // Siberia, real October mean about -7
  expect(at(oct, 11, 25)).toBeGreaterThan(17); expect(at(oct, 11, 25)).toBeLessThan(25); // Sahara about 21
  expect(at(oct, 1, -79)).toBeLessThan(-30); // Antarctica about -40
  expect(at(oct, 131, 25)).toBeGreaterThan(23); expect(at(oct, 131, 25)).toBeLessThan(28); // Philippine Sea
  expect(at(apr, 91, 61)).toBeGreaterThan(at(oct, 91, 61)); // April is not October
  expect(oct.every(t => t > -80 && t < 40)).toBe(true);
});

it('wraps December into January and leaves the sea-temperature normal missing only where there is no sea', () => {
  const a = new Float32Array(16200), b = new Float32Array(16200), mid = new Float32Array(16200);
  airClimatologyInto(1 + 365.25 * (11.5 / 12), a); airClimatologyInto(1 + 365.25 * (0.5 / 12), b); airClimatologyInto(1 + 365.25 - 0.0001, mid);
  for (const k of [0, 5000, 9000, 16199]) expect(mid[k]).toBeCloseTo((a[k] + b[k]) / 2, 1);
  const sst = new Float32Array(16200); sstClimatologyInto(288, sst);
  expect(at(sst, 131, 25)).toBeGreaterThan(24); expect(at(sst, 131, 25)).toBeLessThan(31);
  expect(Number.isNaN(at(sst, 91, 61))).toBe(true); // Siberia
  expect(Number.isNaN(at(sst, 1, -79))).toBe(true); // Antarctica
});

it('live air relaxes to the real monthly mean over land and to sea temperature plus the real air-sea difference over water', () => {
  const day = 299, air = new Float32Array(16200), sstN = new Float32Array(16200), slp = new Float32Array(16200);
  airClimatologyInto(day, air); sstClimatologyInto(day, sstN); slpClimatologyInto(day, slp);
  const land = (k: number) => Number.isNaN(sstN[k]);
  const cells = Array.from({ length: 16200 }, (_, k) => ({ land: land(k), temperature: land(k) ? 0 : sstN[k] + (k % 180 < 90 ? 2 : 0), airTemperature: 0, airHeating: 0 }));
  const weather = { pressure: Array.from(slp), u: Array<number>(16200).fill(0), v: Array<number>(16200).fill(0), seaTemperature: cells.map(c => (c.land ? null : c.temperature)), airTemperature: Array<number>(16200).fill(0) };
  for (let i = 0; i < 240; i++) stepLiveWeather(weather, 1, { dayOfYear: day, cells: cells as never });
  const k = (lon: number, lat: number) => ((lat + 89) / 2) * 180 + (lon + 179) / 2;
  // ten days of a weak wind may move some air about, so land is checked to a few degrees
  expect(Math.abs(weather.airTemperature[k(91, 61)] - air[k(91, 61)])).toBeLessThan(4);
  expect(Math.abs(weather.airTemperature[k(11, 25)] - air[k(11, 25)])).toBeLessThan(4);
  const seaWest = k(-129, 25), seaEast = k(131, 25); // 2 degC warmer sea only in the western hemisphere columns
  expect(weather.airTemperature[seaWest] - air[seaWest]).toBeGreaterThan(0.8);
  expect(Math.abs(weather.airTemperature[seaEast] - air[seaEast])).toBeLessThan(1);
});
