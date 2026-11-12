import { describe, expect, it } from 'vitest';
import { createGame, placeFormation, stepGame } from '../src/simulation/engine';
import { buildFieldData } from '../src/render/fields';
import { HEX_TARGET_PX, HEX_WIDTH, MAX_HEXES, GLOBE_STRIDE, buildDustHexes, dustHexWidth, dustHexesFor, projectGlobeHexes } from '../src/render/dust-hexes';
import { GlobeView } from '../src/render/globe-view';
import { FlatView } from '../src/render/view';

function scene() {
  const state = createGame(17, 213);
  placeFormation(state, 'finedust', 117, 39);
  for (let i = 0; i < 192; i++) stepGame(state);
  return { state, field: buildFieldData(state.grid)! };
}

describe('dust hexagon grid follows the zoom', () => {
  it('keeps the on-screen width near the target, finer when zoomed in, within the limits', () => {
    for (const px of [3, 6.67, 20, 80, 400]) {
      const w = dustHexWidth(px);
      expect(w).toBeGreaterThanOrEqual(HEX_WIDTH);
      expect(w).toBeLessThanOrEqual(4);
      if (w > HEX_WIDTH && w < 4) expect(Math.abs(w * px / HEX_TARGET_PX - 1)).toBeLessThan(0.25);
    }
    expect(dustHexWidth(80)).toBeLessThan(dustHexWidth(6.67));
    expect(dustHexWidth(20)).toBe(dustHexWidth(19.5)); // one build serves a whole step
  });

  it('builds the visible area only, regular in the flat view, and reuses the build until the view leaves it', () => {
    const state = createGame(17, 213);
    placeFormation(state, 'finedust', 117, 39);
    for (let i = 0; i < 192; i++) stepGame(state);
    const field = buildFieldData(state.grid)!;
    for (const View of [FlatView, GlobeView]) {
      const v = new View();
      v.resize(1280, 800); v.setHome(119, 37, 40);
      const a = dustHexesFor(state, field, true, v);
      expect(a.hexes.length).toBeGreaterThan(20);
      expect(a.hexes.length).toBeLessThanOrEqual(MAX_HEXES);
      expect(dustHexesFor(state, field, true, v)).toBe(a);
      v.setHome(119, 37, 12); // a finer step
      expect(dustHexesFor(state, field, true, v)).not.toBe(a);
    }
    const flat = new FlatView();
    flat.resize(1280, 800); flat.setHome(119, 37, 40);
    const { hexes, width } = buildDustHexes(state, field, true, flat);
    const rowH = 1.5 * width / Math.sqrt(3);
    for (const h of hexes) { // lattice rows are exactly 1.5 r apart and neighbours exactly one width: regular hexagons in the plane the screen shows
      expect(Math.abs(h.y / rowH - Math.round(h.y / rowH))).toBeLessThan(1e-9);
      const shift = Math.round(h.y / rowH) & 1 ? 0.5 : 0;
      expect(Math.abs(h.x / width - shift - Math.round(h.x / width - shift))).toBeLessThan(1e-9);
    }
  });

  it('globe lattice is regular in the tangent plane at the anchor: equal neighbour spacing, no overlap, centres match lon/lat', () => {
    const { state, field } = scene();
    const g = new GlobeView();
    g.resize(1280, 800);
    for (const span of [60, 25, 8]) {
      g.setHome(117, 37, span);
      const t0 = performance.now();
      const built = buildDustHexes(state, field, true, g);
      const { hexes, width, space } = built;
      console.log(`globe span ${span}: ${hexes.length} hexes, build ${(performance.now() - t0).toFixed(1)} ms, cap ${built.cap!.toFixed(1)} deg, thr ${built.thr!.toFixed(1)} deg`);
      expect(space).toBe('globe');
      expect(built.anchor).toEqual(g.centerLonLat());
      expect(hexes.length).toBeGreaterThan(20);
      const pitch = width * Math.PI / 180;
      for (const [i, h] of hexes.entries()) { // the stored centre is the lattice point lifted onto the sphere
        const u = built.geo!.subarray(i * GLOBE_STRIDE, i * GLOBE_STRIDE + 3);
        expect(Math.abs(Math.asin(u[1]) * 180 / Math.PI - h.lat)).toBeLessThan(1e-9);
      }
      let pairs = 0;
      const sorted = [...hexes].sort((a, b) => a.x - b.x);
      for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length && sorted[j].x - sorted[i].x < pitch * 1.02; j++) {
        const d = Math.hypot(sorted[i].x - sorted[j].x, sorted[i].y - sorted[j].y);
        expect(d).toBeGreaterThan(pitch * 0.999); // never closer than one pitch: no overlap
        if (d < pitch * 1.01) { pairs++; expect(Math.abs(d - pitch)).toBeLessThan(pitch * 0.01); }
      }
      expect(pairs).toBeGreaterThan(10);
    }
  });

  it('globe hexes move with the ground when the camera rotates, and nothing is rebuilt below the threshold', () => {
    const { state, field } = scene();
    const g = new GlobeView();
    g.resize(1280, 800); g.setHome(117, 37, 25);
    const built = dustHexesFor(state, field, true, g, 0);
    const before = Float64Array.from(projectGlobeHexes(g, built).subarray(0, built.hexes.length * 14));
    const ground = built.hexes.map(h => g.lonLatToPx(h.lon, h.lat)!);
    g.centerOn(117 + 6, 37 - 3); // rotate by about 6.7 degrees
    expect(dustHexesFor(state, field, true, g, 10_000)).toBe(built); // below the threshold: same build
    const t0 = performance.now();
    let after = projectGlobeHexes(g, built);
    for (let k = 0; k < 50; k++) after = projectGlobeHexes(g, built);
    const frameMs = (performance.now() - t0) / 51;
    console.log(`globe ${built.hexes.length} hexes: per-frame projection ${frameMs.toFixed(3)} ms`);
    let worst = 0, moved = 0, checked = 0;
    built.hexes.forEach((h, i) => {
      const now = g.lonLatToPx(h.lon, h.lat);
      if (!now || Number.isNaN(after[i * 14])) return;
      const dx = now[0] - ground[i][0], dy = now[1] - ground[i][1]; // how far the ground point under the hex moved
      moved = Math.max(moved, Math.hypot(dx, dy));
      worst = Math.max(worst, Math.hypot(after[i * 14] - before[i * 14] - dx, after[i * 14 + 1] - before[i * 14 + 1] - dy));
      checked++;
    });
    console.log(`checked ${checked} hexes, ground moved up to ${moved.toFixed(1)} px, worst hex-vs-ground difference ${worst.toExponential(2)} px`);
    expect(checked).toBeGreaterThan(20);
    expect(moved).toBeGreaterThan(50);
    expect(worst).toBeLessThan(1e-6);
    // far enough: once the camera has settled it rebuilds, anchored at the new centre; during a gesture it keeps the old lattice
    g.centerOn(117 + 40, 37);
    expect(dustHexesFor(state, field, true, g, 10_100)).toBe(built);
    const again = dustHexesFor(state, field, true, g, 20_000);
    expect(again).not.toBe(built);
    expect(again.anchor).toEqual(g.centerLonLat());
    const t1 = performance.now();
    buildDustHexes(state, field, true, g);
    console.log(`rebuild ${(performance.now() - t1).toFixed(1)} ms`);
  });
});
