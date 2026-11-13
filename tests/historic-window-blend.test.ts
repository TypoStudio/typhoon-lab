import { afterEach, describe, expect, it } from 'vitest';
import type { HistoricEnvironment } from '../src/types';
import { createGame, loadHistoric, sampleEnvironment, setHistoricEnvironment, stepGame, totalPressure } from '../src/simulation/engine';
import { HISTORIC_BLEND_DEG, windowWeight } from '../src/simulation/historic';
import sarah from '../src/data/generated/environment/sarah-1959.json';

const data = sarah as unknown as HistoricEnvironment;
afterEach(() => setHistoricEnvironment('sarah-1959', null));

// Window 97°E to 161°W (across the dateline), 5°S to 65°N; its edges lie half a cell beyond the outer centres: 96°E, 160°W, 6°S, 66°N.
describe('recorded environment weight at the data window edge', () => {
  it('is 1 well inside, between 0 and 1 in the band, 0 outside', () => {
    expect(windowWeight(data, 140, 25)).toBe(1);
    expect(windowWeight(data, 180, 30)).toBe(1);
    expect(windowWeight(data, 96 + HISTORIC_BLEND_DEG, 30)).toBeCloseTo(1, 10);
    for (const [lon, lat] of [[99, 30], [100, 30], [105, 30], [140, 63], [140, 0], [-165, 30], [-168, 10]]) {
      const w = windowWeight(data, lon, lat);
      expect(w, `${lon},${lat}`).toBeGreaterThan(0);
      expect(w, `${lon},${lat}`).toBeLessThan(1);
    }
    expect(windowWeight(data, 96, 30)).toBe(0);
    for (const [lon, lat] of [[90, 30], [-150, 30], [140, -8], [140, 70], [10, 10]]) expect(windowWeight(data, lon, lat)).toBe(0);
  });

  it('falls monotonically and smoothly towards each edge', () => {
    for (const [a, b] of [[[96, 30], [106, 30]], [[-160, 30], [-170, 30]], [[140, -6], [140, 4]], [[140, 66], [140, 56]]]) {
      let last = -1;
      for (let k = 0; k <= 50; k++) {
        const w = windowWeight(data, a[0] + ((b[0] - a[0]) * k) / 50, a[1] + ((b[1] - a[1]) * k) / 50);
        expect(w).toBeGreaterThanOrEqual(last);
        if (last >= 0) expect(w - last).toBeLessThan(0.08);
        last = w;
      }
      expect(last).toBe(1);
    }
  });

  it('is continuous across the dateline', () => {
    for (const lat of [0, 30, 60]) expect(Math.abs(windowWeight(data, 179.99, lat) - windowWeight(data, -179.99, lat))).toBeLessThan(1e-3);
    expect(windowWeight(data, 190, 30)).toBe(windowWeight(data, -170, 30));
  });

  it('leaves only a small jump in the environment between neighbouring points across the edge', () => {
    setHistoricEnvironment('sarah-1959', data);
    const s = createGame(1);
    for (let k = 0; k < 24 * 4; k++) stepGame(s);
    expect(loadHistoric(s, 'sarah-1959').ok).toBe(true);
    const cuts: [number, number, number, number][] = [[95.5, 30, 96.5, 30], [-159.5, 30, -160.5, 30], [140, 66.5, 140, 65.5], [140, -6.5, 140, -5.5]]; // one degree apart, either side of each edge
    for (const [lon0, lat0, lon1, lat1] of cuts) {
      const a = sampleEnvironment(s, lon0, lat0), b = sampleEnvironment(s, lon1, lat1);
      expect(Math.abs(a.temperature - b.temperature)).toBeLessThan(1);
      expect(Math.abs(a.humidity - b.humidity)).toBeLessThan(0.1);
      expect(Math.abs(totalPressure(s, lon0, lat0) - totalPressure(s, lon1, lat1))).toBeLessThan(2);
    }
  });
});
