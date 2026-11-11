import { describe, expect, it } from 'vitest';
import { createGame, placeFormation, stepGame } from '../src/simulation/engine';
import { buildFieldData } from '../src/render/fields';
import { HEX_TARGET_PX, HEX_WIDTH, MAX_HEXES, buildDustHexes, dustHexWidth, dustHexesFor } from '../src/render/dust-hexes';
import { GlobeView } from '../src/render/globe-view';
import { FlatView } from '../src/render/view';

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

  it('globe lattice is regular in screen space: equal neighbour spacing, no overlap, and fast', () => {
    const state = createGame(17, 213);
    placeFormation(state, 'finedust', 117, 39);
    for (let i = 0; i < 192; i++) stepGame(state);
    const field = buildFieldData(state.grid)!;
    const g = new GlobeView();
    g.resize(1280, 800);
    for (const span of [60, 25, 8]) {
      g.setHome(117, 37, span);
      const t0 = performance.now();
      const { hexes, width, space } = buildDustHexes(state, field, true, g);
      const ms = performance.now() - t0;
      console.log(`globe span ${span}: ${hexes.length} hexes, build ${ms.toFixed(1)} ms`);
      expect(space).toBe('screen');
      expect(hexes.length).toBeGreaterThan(20);
      const pitch = width * g.scale;
      for (const h of hexes) { // same lon/lat as the lattice point it came from, to within the inverse projection
        const p = g.lonLatToPx(h.lon, h.lat)!;
        expect(Math.hypot(p[0] - h.x, p[1] - h.y)).toBeLessThan(1e-6 * g.radius + 1e-6);
      }
      let pairs = 0;
      for (const a of hexes) for (const b of hexes) {
        if (a === b) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        expect(d).toBeGreaterThan(pitch * 0.999); // never closer than one pitch: no overlap
        if (d < pitch * 1.01) { pairs++; expect(Math.abs(d - pitch)).toBeLessThan(pitch * 0.01); }
      }
      expect(pairs).toBeGreaterThan(10);
    }
  });
});
