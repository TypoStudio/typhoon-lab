import { describe, expect, it } from 'vitest';
import { buildContours, buildFieldData, buildIsobars, contourLattice, samplePressure, type FieldData, type Isobar } from '../src/render/fields';
import { attachStormPressure } from '../src/render/storm-wind';
import { createGame, readClimatePoint, stepGame, totalPressure } from '../src/simulation/engine';
import { distanceKm, moveKm, offsetKm } from '../src/simulation/geo';
import type { GameState, Storm } from '../src/types';

const stormAt = (id: number, lon: number, lat: number, wind = 60): Storm => ({
  id, lon, lat, wind, movementSpeedKmh: 0, pressure: 950, radiusKm: 30, galeRadiusKm: 300,
  ageHours: 48, peakWind: wind, stage: 'Typhoon', track: [], forecast: [], history: [], damageScore: 0, windDelta: 0,
});

/** The field the renderer draws from, as the map builds it for a state. */
function fieldFor(state: GameState, withStorms = true): FieldData {
  const f = buildFieldData(state.grid)!;
  if (withStorms) attachStormPressure(f, state);
  return f;
}

/** Area centroid, as an offset (km) from the point, of the lowest closed isobar of 1000 hPa or less that encloses it and spans under 600 km. */
function innermostRingOffset(lines: Isobar[], lon0: number, lat0: number): { km: number; level: number } | null {
  let best: { km: number; level: number } | null = null;
  for (const line of lines) {
    if (!line.closed || line.level > 1000 || (best && line.level >= best.level)) continue;
    const q = line.points, n = q.length / 2;
    const pts = Array.from({ length: n }, (_, k) => offsetKm(lon0, lat0, q[2 * k], q[2 * k + 1]));
    let area = 0, cx = 0, cy = 0, inside = false, reach = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = pts[j], b = pts[i], cross = a.dx * b.dy - b.dx * a.dy;
      area += cross; cx += (a.dx + b.dx) * cross; cy += (a.dy + b.dy) * cross;
      if ((b.dy > 0) !== (a.dy > 0) && 0 < ((a.dx - b.dx) * (0 - b.dy)) / (a.dy - b.dy) + b.dx) inside = !inside;
      reach = Math.max(reach, Math.hypot(b.dx, b.dy));
    }
    if (!inside || reach > 600 || Math.abs(area) < 1e-6) continue;
    best = { km: Math.hypot(cx / (3 * area), cy / (3 * area)), level: line.level };
  }
  return best;
}

/** Lowest drawn pressure within 60 km of the storm, found by scanning samplePressure on a 4 km spiral grid; returns its offset (km) from the storm. */
function drawnMinimumOffset(f: FieldData, lon0: number, lat0: number): number {
  let best = Infinity, at = 0;
  for (let e = -60; e <= 60; e += 4) for (let n = -60; n <= 60; n += 4) {
    const p = moveKm(lon0, lat0, e, n), v = samplePressure(f, p.lon, p.lat);
    if (v < best) { best = v; at = Math.hypot(e, n); }
  }
  return at;
}

/** Moves a storm by fractions of a 2° cell (about 222 km) and returns its drawn centres. */
function sweep(lon: number, lat: number, count = 9, stepKm = 37) {
  const state = createGame(1);
  const out: { lon: number; lat: number; ring: number | null; minimum: number; plainRing: number | null; plainMin: number; f: FieldData }[] = [];
  let storm = stormAt(901, lon, lat);
  for (let k = 0; k < count; k++) {
    state.storms = [storm];
    stepGame(state); // refreshes state.grid around the storm
    const st = state.storms[0];
    const f = fieldFor(state), plain = fieldFor(state, false);
    const ring = innermostRingOffset(buildIsobars(f), st.lon, st.lat);
    const plainRing = innermostRingOffset(buildIsobars(plain), st.lon, st.lat);
    out.push({ lon: st.lon, lat: st.lat, ring: ring ? ring.km : null, minimum: drawnMinimumOffset(f, st.lon, st.lat),
      plainRing: plainRing ? plainRing.km : null, plainMin: drawnMinimumOffset(plain, st.lon, st.lat), f });
    const p = moveKm(st.lon, st.lat, stepKm, 13);
    storm = { ...st, lon: p.lon, lat: p.lat };
  }
  return out;
}

describe('storm pressure is drawn centred on the storm', () => {
  for (const [lon, lat] of [[140.3, 20.2], [179.4, 18.7], [-120.6, -14.3]] as const) {
    it(`(${lon}, ${lat}): innermost closed isobar and pressure minimum sit within 10 km of the eye at every sub-cell position`, () => {
      const rows = sweep(lon, lat);
      const rings = rows.filter(r => r.ring !== null);
      expect(rings.length).toBeGreaterThanOrEqual(rows.length - 1);
      for (const r of rows) {
        expect(r.minimum).toBeLessThanOrEqual(10);
        if (r.ring !== null) expect(r.ring).toBeLessThanOrEqual(10);
      }
      const worst = (xs: (number | null)[]) => Math.max(...xs.filter((x): x is number => x !== null)).toFixed(0);
      console.log(`before/after offsets (${lon}, ${lat}): ring ${worst(rows.map(r => r.plainRing))} -> ${worst(rows.map(r => r.ring))} km, minimum ${worst(rows.map(r => r.plainMin))} -> ${worst(rows.map(r => r.minimum))} km`);
    }, 120_000);
  }

  it('the drawn minimum moves continuously with the storm, in steps of 5 km storm motion', () => {
    const state = createGame(1);
    let storm = stormAt(902, 140.0, 20.0), prev: { lon: number; lat: number } | null = null, prevMin: { lon: number; lat: number } | null = null;
    for (let k = 0; k < 24; k++) {
      state.storms = [storm]; stepGame(state);
      const st = state.storms[0], f = fieldFor(state);
      // Lattice minimum (a node) refined by sampling around it.
      const lat = contourLattice(f);
      let best = Infinity, bi = 0;
      for (let i = 0; i < lat.values.length; i++) if (lat.values[i] < best) { best = lat.values[i]; bi = i; }
      const nx = lat.xs.length - 1, min = { lon: lat.xs[bi % nx], lat: lat.ys[Math.floor(bi / nx)] };
      if (prev && prevMin) expect(Math.abs(distanceKm(prevMin.lon, prevMin.lat, min.lon, min.lat) - distanceKm(prev.lon, prev.lat, st.lon, st.lat))).toBeLessThanOrEqual(12);
      prev = { lon: st.lon, lat: st.lat }; prevMin = min;
      const p = moveKm(st.lon, st.lat, 5, 2); storm = { ...st, lon: p.lon, lat: p.lat };
    }
  }, 120_000);

  it('the hover value at the eye is the storm central pressure, and agrees with totalPressure and the Measure reading', () => {
    const state = createGame(1);
    state.storms = [stormAt(903, 142.37, 21.13)]; stepGame(state);
    const st = state.storms[0], f = fieldFor(state);
    const hover = samplePressure(f, st.lon, st.lat);
    expect(Math.abs(hover - st.pressure)).toBeLessThan(1);
    expect(Math.abs(hover - totalPressure(state, st.lon, st.lat))).toBeLessThan(1);
    expect(readClimatePoint(state, st.lon, st.lat).pressure).toBe(totalPressure(state, st.lon, st.lat));
    // Without storms the display falls back to plain grid interpolation.
    expect(samplePressure(fieldFor(state, false), 100.5, 10.5)).toBeCloseTo(samplePressure(f, 100.5, 10.5), 3);
  });

  it('costs a bounded time per contour rebuild with several storms', () => {
    const state = createGame(1);
    state.storms = [stormAt(1, 140, 20), stormAt(2, 125, 15), stormAt(3, 179.5, 25), stormAt(4, -120, -15), stormAt(5, 85, -12), stormAt(6, -60, 18)];
    stepGame(state);
    const all = state.storms.slice();
    expect(all.length).toBe(6);
    for (const n of [0, 1, 3, 6]) {
      state.storms = all.slice(0, n);
      const f = buildFieldData(state.grid)!; attachStormPressure(f, state);
      buildContours(f);
      const t0 = performance.now(); const runs = 5;
      for (let r = 0; r < runs; r++) buildContours(f);
      const ms = (performance.now() - t0) / runs;
      console.log(`contour rebuild, ${n} storms: ${ms.toFixed(1)} ms, lattice ${contourLattice(f).values.length} nodes`);
      if (n > 0) expect(contourLattice(f).values.length).toBeGreaterThan(16200);
      expect(ms).toBeLessThan(400);
    }
  }, 120_000);
});
