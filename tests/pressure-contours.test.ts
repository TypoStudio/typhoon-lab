import { describe, expect, it } from 'vitest';
import { buildContours, buildFieldData, buildIsobars, isobarLevels, layerLegend, type FieldData, type Isobar } from '../src/render/fields';
import { BOUNDS, GRID_STEP, createGame } from '../src/simulation/engine';
import { distanceKm } from '../src/simulation/geo';

const world = createGame();
/** The real background pressure plus a compact typhoon-like low (central pressure `centre`, e-folding radius sigmaKm). */
function withLow(lon: number, lat: number, centre = 930, sigmaKm = 260): FieldData {
  const f = buildFieldData(world.grid)!;
  for (let k = 0; k < f.pressure.length; k++) {
    const clon = BOUNDS.west + ((k % f.cols) + 0.5) * GRID_STEP;
    const clat = BOUNDS.south + (Math.floor(k / f.cols) + 0.5) * GRID_STEP;
    const d = distanceKm(lon, lat, clon, clat);
    f.pressure[k] -= (1010 - centre) * Math.exp(-((d / sigmaKm) ** 2));
  }
  return f;
}
/** Even–odd test on an unwrapped ring, after moving the point next to the ring's longitudes. */
function encloses(line: Isobar, lon: number, lat: number): boolean {
  const q = line.points; const n = q.length / 2;
  let x = lon; while (x - q[0] > 180) x -= 360; while (x - q[0] < -180) x += 360;
  let inside = false;
  for (let a = 0, b = n - 1; a < n; b = a++) {
    const [xa, ya, xb, yb] = [q[2 * a], q[2 * a + 1], q[2 * b], q[2 * b + 1]];
    if ((ya > lat) !== (yb > lat) && x < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
const ringsAround = (lines: Isobar[], lon: number, lat: number) => lines.filter(l => l.closed && encloses(l, lon, lat));
function maxTurnDeg(line: Isobar): number {
  const q = line.points; const n = q.length / 2; let worst = 0;
  for (let k = 0; k < n; k++) {
    const a = (k + n - 1) % n; const c = (k + 1) % n;
    const h1 = Math.atan2(q[2 * k + 1] - q[2 * a + 1], q[2 * k] - q[2 * a]);
    const h2 = Math.atan2(q[2 * c + 1] - q[2 * k + 1], q[2 * c] - q[2 * k]);
    let d = Math.abs(h2 - h1); if (d > Math.PI) d = 2 * Math.PI - d;
    worst = Math.max(worst, d * 180 / Math.PI);
  }
  return worst;
}

describe('display isobars', () => {
  it('uses 8 hPa spacing from 1000 hPa up and only 20 hPa steps in deep lows, as the legend says', () => {
    expect(isobarLevels(935, 1031)).toEqual([940, 960, 980, 1000, 1008, 1016, 1024]);
    expect(isobarLevels(1001, 1007)).toEqual([]);
    expect(isobarLevels(NaN, 1020)).toEqual([]);
    const note = layerLegend('pressure').note;
    expect(note).toContain('8 hPa'); expect(note).toContain('20 hPa'); expect(note).toContain('1000');
  });

  it('draws a deep typhoon low as a few whole, closed, nested rings instead of dozens', () => {
    const lines = buildIsobars(withLow(140, 20));
    const rings = ringsAround(lines, 140, 20);
    const levels = rings.map(r => r.level).sort((a, b) => a - b);
    // The 2° grid samples this low near 955 hPa; a 4 hPa rule would draw ~13 rings up to 1008 hPa.
    expect(levels).toEqual(expect.arrayContaining([960, 980, 1000]));
    expect(rings.length).toBeLessThanOrEqual(6);
    expect(new Set(levels).size).toBe(levels.length); // one ring per level, no fragments
    // No open pieces of these deep levels anywhere near the low: nothing is clipped into a fake trough.
    for (const l of lines.filter(l => l.level < 1000)) expect(l.closed).toBe(true);
    for (const l of lines) for (const v of l.points) expect(Number.isFinite(v)).toBe(true);
  });

  it('smooths the angular marching-squares corners', () => {
    const f = withLow(140, 20);
    const ring = (smoothing: number) => ringsAround(buildIsobars(f, smoothing), 140, 20).find(r => r.level === 980)!;
    expect(maxTurnDeg(ring(2))).toBeLessThan(30);
    expect(maxTurnDeg(ring(2))).toBeLessThan(maxTurnDeg(ring(0)));
  });

  it('keeps rings whole and continuous across the date line', () => {
    const lines = buildIsobars(withLow(179.5, 22));
    const rings = ringsAround(lines, 179.5, 22);
    expect(rings.map(r => r.level)).toEqual(expect.arrayContaining([960, 980, 1000]));
    for (const r of rings) {
      const q = r.points; const n = q.length / 2;
      for (let k = 0; k < n; k++) {
        const c = (k + 1) % n;
        let dx = Math.abs(q[2 * c] - q[2 * k]); if (k === n - 1) dx = Math.min(dx, Math.abs(dx - 360));
        expect(dx).toBeLessThan(3);
      }
    }
    // The segment form used by the overlay has no world-wide jumps either.
    const { minor, major } = buildContours(withLow(179.5, 22));
    for (const arr of [minor, major]) for (let i = 0; i < arr.length; i += 4) expect(Math.abs(arr[i + 2] - arr[i])).toBeLessThan(3);
  });

  it('returns nothing for a constant field and skips non-finite cells without NaN output', () => {
    const flat = buildFieldData(world.grid)!;
    flat.pressure.fill(1012);
    expect(buildIsobars(flat)).toEqual([]);
    const c = buildContours(flat);
    expect(c.minor.length + c.major.length).toBe(0);
    const holes = withLow(140, 20);
    for (let k = 0; k < holes.pressure.length; k += 97) holes.pressure[k] = NaN;
    const out = buildContours(holes);
    expect(out.major.length).toBeGreaterThan(0);
    for (const arr of [out.minor, out.major]) expect(arr.every(Number.isFinite)).toBe(true);
  });

  it('is deterministic, does not modify the field, and draws fewer segments than the old 4 hPa rule', () => {
    const f = withLow(140, 20);
    const before = Float32Array.from(f.pressure);
    const a = buildContours(f);
    expect(buildContours(f)).toEqual(a);
    expect(f.pressure).toEqual(before);
    // Old display: every 4 hPa; count rings the low alone would have had.
    let lo = Infinity; for (const v of f.pressure) lo = Math.min(lo, v);
    const oldRings = Math.floor((1008 - lo) / 4);
    expect(oldRings).toBeGreaterThanOrEqual(12);
    expect(ringsAround(buildIsobars(f), 140, 20).length).toBeLessThanOrEqual(oldRings / 3);
  });

  it('rebuilds the whole-world isobars quickly', () => {
    const f = withLow(140, 20);
    buildContours(f);
    const t0 = performance.now();
    for (let k = 0; k < 5; k++) buildContours(f);
    const ms = (performance.now() - t0) / 5;
    console.info(`isobars: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(250); // generous for a loaded machine
  });
});
