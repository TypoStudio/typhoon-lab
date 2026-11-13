import { afterEach, describe, expect, it } from 'vitest';
import type { HistoricEnvironment } from '../src/types';
import { buildFieldData, buildIsobars, samplePressure, type FieldData } from '../src/render/fields';
import { attachStormPressure } from '../src/render/storm-wind';
import { createGame, loadHistoric, sampleEnvironment, setHistoricEnvironment, stepGame } from '../src/simulation/engine';
import { distanceKm, moveKm } from '../src/simulation/geo';
import sarah from '../src/data/generated/environment/sarah-1959.json';
import maemi from '../src/data/generated/environment/maemi-2003.json';

const datasets: Record<string, HistoricEnvironment> = { 'sarah-1959': sarah as unknown as HistoricEnvironment, 'maemi-2003': maemi as unknown as HistoricEnvironment };
afterEach(() => { for (const id of Object.keys(datasets)) setHistoricEnvironment(id, null); });

/** Tolerance in km for the innermost isobar's centroid: the deficit is drawn at the storm's exact position, so only the environment's own slope moves a wide ring (seen up to about 14 km in these replays; the synthetic tests in pressure-storm-centre hold 10 km). */
const TOLERANCE_KM = 20;

/** How much lower (hPa) the lowest drawn pressure within 60 km is than the drawn pressure at the point: a storm's deficit is nearly flat inside its radius, so the environment's slope can move the exact minimum a few tens of km without changing the value there. */
function drawnMinimumDepth(f: FieldData, lon0: number, lat0: number): number {
  let best = Infinity;
  for (let e = -60; e <= 60; e += 4) for (let n = -60; n <= 60; n += 4) {
    const p = moveKm(lon0, lat0, e, n);
    best = Math.min(best, samplePressure(f, p.lon, p.lat));
  }
  return samplePressure(f, lon0, lat0) - best;
}

/** Centroid distance (km) of the lowest closed isobar of 1000 hPa or less that encloses the storm and spans under 600 km, or null. */
function innermostIsobarOffset(field: FieldData, lon0: number, lat0: number): number | null {
  let level = Infinity, offset: number | null = null;
  for (const line of buildIsobars(field)) {
    if (!line.closed || line.level > 1000 || line.level >= level) continue;
    const pts = line.points, n = pts.length / 2;
    let inside = false, cx = 0, cy = 0, reach = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[2 * i], yi = pts[2 * i + 1], xj = pts[2 * j], yj = pts[2 * j + 1];
      if ((yi > lat0) !== (yj > lat0) && lon0 < ((xj - xi) * (lat0 - yi)) / (yj - yi) + xi) inside = !inside;
      cx += xi; cy += yi; reach = Math.max(reach, distanceKm(lon0, lat0, xi, yi));
    }
    if (inside && n >= 3 && reach <= 600) { level = line.level; offset = distanceKm(lon0, lat0, cx / n, cy / n); }
  }
  return offset;
}

describe('historic replay: the eye and the low-pressure centre coincide', () => {
  for (const id of Object.keys(datasets)) {
    it(`${id}: the drawn pressure minimum and innermost isobar sit on the storm, and the reanalysis vortex is gone`, () => {
      setHistoricEnvironment(id, datasets[id]);
      const state = createGame(1);
      expect(loadHistoric(state, id).ok).toBe(true);
      let next = 0, checked = 0, isobars = 0;
      while (state.storms[0] && state.hours < 500) {
        stepGame(state);
        if (state.hours < next) continue;
        next += 6;
        const st = state.storms[0];
        if (!st || st.wind < 25) continue;
        const field = buildFieldData(state.grid)!;
        attachStormPressure(field, state);
        expect(drawnMinimumDepth(field, st.lon, st.lat), `hour ${state.hours.toFixed(0)}`).toBeLessThanOrEqual(0.5);
        const off = innermostIsobarOffset(field, st.lon, st.lat);
        if (off !== null) { expect(off, `isobar at hour ${state.hours.toFixed(0)}`).toBeLessThanOrEqual(TOLERANCE_KM); isobars++; }
        // The storm-free recorded field has no low of its own at the storm: it is no lower than the mean of the ring 700 km out (plus its small gradient).
        const centre = sampleEnvironment(state, st.lon, st.lat).pressure;
        const ring = [0, 1, 2, 3, 4, 5, 6, 7].map(k => { const p = moveKm(st.lon, st.lat, 700 * Math.cos(k * Math.PI / 4), 700 * Math.sin(k * Math.PI / 4)); return sampleEnvironment(state, p.lon, p.lat).pressure; });
        expect(centre - ring.reduce((a, b) => a + b, 0) / ring.length, `environment at hour ${state.hours.toFixed(0)}`).toBeGreaterThan(-2);
        checked++;
      }
      expect(checked).toBeGreaterThan(15);
      expect(isobars).toBeGreaterThan(5);
    }, 600_000);
  }
});
