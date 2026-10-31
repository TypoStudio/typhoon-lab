import { describe, expect, it, vi } from 'vitest';
import { CITIES } from '../src/data/world';
import { placeName } from '../src/data/places';
import { seaName } from '../src/data/seas';
import { cityLabel, getLanguage, t as translate } from '../src/i18n';
import { buildContours, buildFieldData, type Contours, type Isobar } from '../src/render/fields';
import { groundCircle } from '../src/render/geo-draw';
import { GlobeView } from '../src/render/globe-view';
import { EMPTY_OVERLAY, OverlayPainter, type MapOverlay } from '../src/render/overlay';
import { visiblePlaces } from '../src/render/places';
import { visibleSeas } from '../src/render/seas';
import type { Theme } from '../src/render/theme';
import { FlatView } from '../src/render/view';
import { createGame, TOOLS } from '../src/simulation/engine';
import type { Effect, GameState, MapOverlays, Storm } from '../src/types';

const W = 1440;
const H = 900;

interface Call { name: string; args: unknown[]; align?: unknown; alpha?: unknown }

/** A recording stand-in for CanvasRenderingContext2D: every method call is logged, assignments are remembered. */
function recorder() {
  const calls: Call[] = [];
  const store: Record<string, unknown> = {};
  const ctx = new Proxy({}, {
    get(_, key: string) {
      if (key in store) return store[key];
      if (key === 'measureText') return (text: string) => ({ width: text.length * 6 });
      return (...args: unknown[]) => { calls.push({ name: key, args, align: store.textAlign, alpha: store.globalAlpha }); };
    },
    set(_, key: string, value) { store[key] = value; return true; },
  }) as unknown as CanvasRenderingContext2D;
  const count = (...names: string[]) => calls.filter(c => names.includes(c.name)).length;
  const texts = () => calls.filter(c => c.name === 'fillText').map(c => String(c.args[0]));
  return { ctx, calls, count, texts };
}

class FakePath2D {
  constructor() { return new Proxy(this, { get: (_, key) => (key in this ? (this as never)[key] : () => undefined) }); }
}
(globalThis as { Path2D?: unknown }).Path2D ??= FakePath2D;

const theme = new Proxy({}, { get: (_, key) => (key === 'fx' ? new Proxy({}, { get: () => '#f00' }) : '#000') }) as unknown as Theme;

function setup(view: GlobeView | FlatView) {
  const rec = recorder();
  const painter = new OverlayPainter({ getContext: () => rec.ctx, width: 0, height: 0 } as unknown as HTMLCanvasElement, theme);
  painter.resize(W, H, 1);
  rec.calls.length = 0;
  return { ...rec, painter, priv: painter as unknown as Record<string, (...args: unknown[]) => unknown>, view };
}

const globe = (lon = 150, lat = 20): GlobeView => { const v = new GlobeView(); v.resize(W, H); v.setHome(lon, lat, 60); return v; };
const flat = (lon = 150, lat = 20): FlatView => { const v = new FlatView(); v.resize(W, H); v.setHome(lon, lat, 60); return v; };

const mkStorm = (id: number, lon: number, lat: number, extra: Partial<Storm> = {}): Storm => ({
  id, name: `Storm${id}`, lon, lat, wind: 40, movementSpeedKmh: 15, pressure: 960, radiusKm: 40, galeRadiusKm: 300, stage: 'Typhoon',
  ageHours: 100, peakWind: 40, track: [], forecast: [], history: [], damageScore: 0, windDelta: 0, ...extra,
});
const stateWith = (patch: Partial<GameState>): GameState => ({ storms: [], stormArchive: [], thunderstorms: [], candidates: [], effects: [], cities: [], ...patch }) as unknown as GameState;
const NO_LAYERS: MapOverlays = { wind: false, humidity: false, rain: false, pressure: false, temperature: false, population: false, ships: false, planes: false };

describe('placed condition markers', () => {
  const effect: Effect = { id: 1, type: 'moisture', lon: 150, lat: 20, radiusKm: 500, remainingHours: 144, ageHours: 0 };

  it.each([['flat', flat], ['globe', globe]] as const)('shrinks and fades after one real second on the %s map, including while paused with reduced motion', (_kind, makeView) => {
    const view = makeView();
    const t = setup(view);
    t.painter.reducedMotion = true;
    let glyphAlpha = 0;
    vi.spyOn(t.painter, 'glyph').mockImplementation(() => { glyphAlpha = t.ctx.globalAlpha; });
    const draw = (now: number, tick: number) => {
      t.calls.length = 0;
      t.painter.draw(view, stateWith({ seed: 7, tick, effects: [{ ...effect }] }), NO_LAYERS, EMPTY_OVERLAY, null, now);
      const scale = t.calls.filter(c => c.name === 'scale').at(-1)?.args;
      const labelAlpha = t.calls.find(c => c.name === 'fillText' && c.args[0] === '144h')?.alpha;
      return { scale, glyphAlpha, labelAlpha };
    };
    expect(draw(10_000, 50)).toEqual({ scale: [1, 1], glyphAlpha: 0.95, labelAlpha: 1 });
    // A new worker snapshot keeps the timer; pausing the tick does not stop it.
    expect(draw(10_999, 51)).toEqual({ scale: [1, 1], glyphAlpha: 0.95, labelAlpha: 1 });
    expect(draw(11_000, 51)).toEqual({ scale: [0.75, 0.75], glyphAlpha: 0.76, labelAlpha: 0.8 });
  });

  it('gives each drop its own delay and clears old timers when conditions disappear or the world resets', () => {
    const view = flat();
    const t = setup(view);
    t.painter.reducedMotion = true;
    const alphas: number[] = [];
    vi.spyOn(t.painter, 'glyph').mockImplementation(() => { alphas.push(t.ctx.globalAlpha); });
    const draw = (now: number, effects: Effect[], seed = 7, tick = 50) => {
      alphas.length = 0;
      t.painter.draw(view, stateWith({ seed, tick, effects }), NO_LAYERS, EMPTY_OVERLAY, null, now);
      return [...alphas];
    };
    expect(draw(100, [effect])).toEqual([0.95]);
    expect(draw(1100, [effect, { ...effect, id: 2 }])).toEqual([0.76, 0.95]);
    draw(1200, []);
    expect(draw(1300, [effect])).toEqual([0.95]);
    expect(draw(2300, [effect])).toEqual([0.76]);
    expect(draw(2400, [effect], 8)).toEqual([0.95]);
    expect(draw(3400, [effect], 8)).toEqual([0.76]);
    expect(draw(3500, [effect], 8, 0)).toEqual([0.95]);
  });

  it.each([['flat', flat], ['globe', globe]] as const)('restores the original marker on hover or touch on the %s map, including with an armed tool', (_kind, makeView) => {
    const view = makeView();
    const t = setup(view);
    t.painter.reducedMotion = true;
    const state = stateWith({ seed: 7, tick: 50, effects: [effect] });
    let glyphAlpha = 0;
    vi.spyOn(t.painter, 'glyph').mockImplementation(() => { glyphAlpha = t.ctx.globalAlpha; });
    t.painter.draw(view, state, NO_LAYERS, EMPTY_OVERLAY, null, 100);
    for (const tool of [null, TOOLS[0]]) {
      t.calls.length = 0;
      t.painter.draw(view, state, NO_LAYERS, { ...EMPTY_OVERLAY, tool, hover: { lon: effect.lon, lat: effect.lat } }, null, 1100);
      expect(glyphAlpha).toBe(0.95);
      expect(t.calls.filter(c => c.name === 'scale').at(-1)?.args).toEqual([1, 1]);
      expect(t.calls.find(c => c.name === 'fillText' && c.args[0] === '144h')?.alpha).toBe(1);
    }
    t.calls.length = 0;
    t.painter.draw(view, state, NO_LAYERS, { ...EMPTY_OVERLAY, hover: { lon: 170, lat: 20 } }, null, 1200);
    expect(glyphAlpha).toBe(0.76);
    expect(t.calls.filter(c => c.name === 'scale').at(-1)?.args).toEqual([0.75, 0.75]);
  });

  it.each([['flat', flat], ['globe', globe]] as const)('animates both directions on the %s map and reverses smoothly mid-flight', (_kind, makeView) => {
    const view = makeView();
    const t = setup(view);
    const state = stateWith({ seed: 7, tick: 50, effects: [effect] });
    const draw = (clockNow: number, hovered = false) => {
      t.calls.length = 0;
      t.painter.draw(view, state, NO_LAYERS, { ...EMPTY_OVERLAY, hover: hovered ? { lon: effect.lon, lat: effect.lat } : null }, null, 0, null, clockNow);
      const [scale] = t.calls.filter(c => c.name === 'scale').at(-1)!.args as number[];
      return scale;
    };
    expect(draw(1000)).toBe(1);
    expect(draw(1999)).toBe(1);
    expect(draw(2000)).toBe(1); // the transition begins after the one-second delay
    const partway = draw(2060);
    expect(partway).toBeGreaterThan(0.75);
    expect(partway).toBeLessThan(1);
    expect(draw(2060, true)).toBe(partway); // reversing does not jump
    expect(draw(2180, true)).toBeGreaterThan(partway);
    expect(draw(2300, true)).toBe(1);
    expect(draw(2300)).toBe(1);
    expect(draw(2420)).toBeCloseTo(0.875);
    expect(draw(2540)).toBe(0.75);
    expect(draw(2540, true)).toBe(0.75);
    expect(draw(2660, true)).toBeCloseTo(0.875);
    expect(draw(2780, true)).toBe(1);
  });

  it('draws live storms above placed markers and the dragged tool preview', () => {
    const view = flat();
    const t = setup(view);
    const order: string[] = [];
    for (const method of ['effect', 'targetPreview', 'thunderstorm', 'storm']) t.priv[method] = () => { order.push(method); };
    const state = stateWith({
      effects: [effect], storms: [mkStorm(1, 150, 20)],
      thunderstorms: [{ id: 2, lon: 150, lat: 20, intensity: 1, radiusKm: 20, gustMs: 15, cloudTopC: -40, ageHours: 1, durationHours: 4 }],
    });
    t.painter.draw(view, state, NO_LAYERS, { ...EMPTY_OVERLAY, tool: TOOLS[0], target: { lon: 150, lat: 20 }, dragging: true }, null, 100);
    expect(order).toEqual(['effect', 'targetPreview', 'thunderstorm', 'storm']);
  });
});

/** Every coordinate pair of moveTo/lineTo lies on the disc (within a pixel). */
function pathInsideDisc(calls: Call[], g: GlobeView): boolean {
  const cx = W / 2 + g.offsetX; const cy = H / 2;
  return calls.filter(c => c.name === 'moveTo' || c.name === 'lineTo')
    .every(c => Math.hypot((c.args[0] as number) - cx, (c.args[1] as number) - cy) <= g.radius + 1);
}

describe('overlay on the globe', () => {
  it('draws nothing for a storm on the far side and does not pick it', () => {
    const g = globe();
    const t = setup(g);
    const far = mkStorm(1, -30, -20); // antipode of (150, 20)
    t.priv.storm(g, far, false, 0);
    expect(t.calls).toEqual([]);
    expect(t.count('fillText', 'arc', 'ellipse')).toBe(0);
    expect(t.painter.pickStorm(g, [far], W / 2, H / 2)).toBeNull();
    // Sanity: the same call for a near-side storm does draw and can be picked.
    const near = mkStorm(2, 150, 20);
    t.priv.storm(g, near, false, 0);
    expect(t.count('fillText')).toBeGreaterThan(0);
    const [nx, ny] = g.lonLatToPx(150, 20)!;
    expect(t.painter.pickStorm(g, [far, near], nx, ny)).toBe(2);
  });

  it('keeps a far-side storm out of the whole frame', () => {
    const g = globe();
    const t = setup(g);
    const far = mkStorm(3, -30, -20, { name: 'Antipode', track: [{ lon: -31, lat: -19 }], forecast: [{ lon: -29, lat: -21 }] });
    t.painter.draw(g, stateWith({ storms: [far] }), NO_LAYERS, EMPTY_OVERLAY, null, 0);
    expect(t.texts().some(text => text.includes('Antipode'))).toBe(false);
    expect(t.texts().length).toBeGreaterThan(0); // graticule and city labels still draw
  });

  it('labels only the cities on the visible side', () => {
    const g = globe();
    const t = setup(g);
    t.priv.cities(g, null, false, null);
    const hidden = CITIES.filter(c => g.projectZ(c.lon, c.lat)[2] < 0);
    const visible = CITIES.filter(c => g.projectZ(c.lon, c.lat)[2] >= 0.3);
    expect(hidden.length).toBeGreaterThan(0);
    expect(visible.length).toBeGreaterThan(0);
    const texts = t.texts();
    for (const c of hidden) expect(texts).not.toContain(translate(c.name));
    expect(visible.some(c => texts.includes(translate(c.name)))).toBe(true);
    expect(t.count('arc')).toBeLessThanOrEqual(CITIES.filter(c => g.projectZ(c.lon, c.lat)[2] > 0).length);
    const far = hidden[0];
    expect(t.painter.pickCity(g, W / 2, H / 2, 1e6)).not.toBe(far.id);
  });

  it('breaks a track at the horizon', () => {
    const g = globe();
    // (120, 10) east to (-60, 10) leaves the disc and ends on the far side.
    const exits = setup(g);
    exits.priv.track(g, mkStorm(1, -60, 10, { track: [{ lon: 120, lat: 10 }] }), false);
    expect(exits.count('moveTo')).toBeGreaterThanOrEqual(1);
    expect(exits.count('lineTo')).toBeGreaterThan(10);
    expect(pathInsideDisc(exits.calls, g)).toBe(true);
    // Out of sight and back again makes a second sub-path.
    const reenters = setup(g);
    reenters.priv.track(g, mkStorm(1, 100, 10, { track: [{ lon: 120, lat: 10 }, { lon: -60, lat: 10 }] }), false);
    expect(reenters.count('moveTo')).toBeGreaterThanOrEqual(2);
    expect(pathInsideDisc(reenters.calls, g)).toBe(true);
  });
});

describe('groundCircle', () => {
  it('samples a 500 km globe circle into a closed polyline', () => {
    const g = globe();
    const t = setup(g);
    for (const mode of ['fill', 'stroke'] as const) {
      t.calls.length = 0;
      const [top, bottom] = groundCircle(g, t.ctx, 150, 20, 500, mode);
      expect(t.count('lineTo')).toBeGreaterThanOrEqual(16);
      expect(t.count('ellipse')).toBe(0);
      expect(top).toBeLessThan(H / 2);
      expect(bottom).toBeGreaterThan(H / 2);
    }
  });

  it('keeps circles that straddle the horizon on the disc and drops hidden ones', () => {
    const g = globe();
    const t = setup(g);
    for (const mode of ['fill', 'stroke'] as const) {
      t.calls.length = 0;
      groundCircle(g, t.ctx, 150 + 88, 20, 1500, mode);
      expect(t.count('lineTo')).toBeGreaterThan(0);
      expect(pathInsideDisc(t.calls, g)).toBe(true);
      t.calls.length = 0;
      groundCircle(g, t.ctx, -30, -20, 500, mode);
      expect(t.calls).toEqual([]);
    }
  });

  it('draws a single ellipse on the flat map', () => {
    const f = flat();
    const t = setup(f);
    groundCircle(f, t.ctx, 150, 20, 500, 'fill');
    expect(t.count('ellipse')).toBe(1);
    expect(t.count('lineTo')).toBe(0);
    const [rx, ry] = f.kmRadiiPx(500, 20);
    const call = t.calls.find(c => c.name === 'ellipse')!;
    expect(call.args[2]).toBeCloseTo(rx, 9);
    expect(call.args[3]).toBeCloseTo(ry, 9);
  });

  it('still paints a storm and its rings on the flat map', () => {
    const f = flat();
    const t = setup(f);
    t.priv.storm(f, mkStorm(1, 150, 20), false, 0);
    expect(t.count('ellipse')).toBe(2); // gale and radius of maximum wind
    expect(t.count('fillText')).toBe(2);
  });
});

describe('isobar labels', () => {
  const line = (level: number, lat: number): Isobar => {
    const pts: number[] = [];
    for (let lon = 105; lon <= 145; lon += 2) pts.push(lon, lat);
    return { level, closed: false, points: Float64Array.from(pts) };
  };
  const contours = (lines: Isobar[]): Contours => ({ minor: new Float32Array(0), major: new Float32Array(0), lines });
  const pressureLabels = (texts: string[]) => texts.filter(text => /^\d{3,4}$/.test(text));
  const overlays: MapOverlays = { ...NO_LAYERS, pressure: true };

  for (const [name, make] of [['flat', flat], ['globe', globe]] as const) {
    it(`places one label per visible line on the ${name} view`, () => {
      const view = make(125, 22);
      const t = setup(view);
      t.painter.draw(view, null, overlays, EMPTY_OVERLAY, contours([line(1008, 22), line(1000, 30)]), 0);
      expect(pressureLabels(t.texts()).sort()).toEqual(['1000', '1008']);
    });

    it(`labels real contours at most once per line on the ${name} view`, () => {
      const view = make(125, 22);
      const t = setup(view);
      const game = createGame();
      const c = buildContours(buildFieldData(game.grid)!);
      t.painter.draw(view, null, overlays, EMPTY_OVERLAY, c, 0);
      const labels = pressureLabels(t.texts());
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.length).toBeLessThanOrEqual(c.lines.length);
    });
  }

  it('omits labels for lines that are on the far side of the globe', () => {
    const g = globe(125, 22);
    const t = setup(g);
    const far: Isobar = { level: 996, closed: false, points: Float64Array.from([-60, 0, -55, 0, -50, 0, -45, 0, -40, 0, -35, 0, -30, 0]) };
    t.painter.draw(g, null, overlays, EMPTY_OVERLAY, contours([far]), 0);
    expect(pressureLabels(t.texts())).toEqual([]);
  });
});

describe('layer order', () => {
  for (const [name, make] of [['flat', flat], ['globe', globe]] as const) {
    it(`draws the storm glyph and label after every city on the ${name} view`, () => {
      const view = make(135, 34);
      const t = setup(view);
      t.painter.draw(view, stateWith({ storms: [mkStorm(1, 135, 34, { name: 'Maemi' })] }), NO_LAYERS, EMPTY_OVERLAY, null, 0);
      const cityNames = new Set(CITIES.map(c => translate(c.name)));
      const textAt = (i: number) => String(t.calls[i].args[0]);
      const fillTexts = t.calls.map((c, i) => (c.name === 'fillText' ? i : -1)).filter(i => i >= 0);
      const cityTexts = fillTexts.filter(i => cityNames.has(textAt(i)));
      const stormLabel = fillTexts.find(i => textAt(i).startsWith('Maemi'))!;
      // The cyclone symbol is the only evenodd fill; a storm's gale and RMW rings are stroked circles drawn just before it.
      const glyph = t.calls.findIndex(c => c.name === 'fill' && c.args[1] === 'evenodd');
      expect(cityTexts.length).toBeGreaterThan(0);
      expect(glyph).toBeGreaterThan(-1);
      expect(stormLabel).toBeGreaterThan(-1);
      expect(cityTexts[0]).toBeLessThan(glyph);
      expect(stormLabel).toBeGreaterThan(cityTexts[cityTexts.length - 1]);
    });
  }
});

describe('label layers', () => {
  const overlays: MapOverlays = { ...NO_LAYERS, pressure: true };
  const lines: Isobar[] = [1008, 1000].map((level, i) => {
    const pts: number[] = [];
    for (let lon = 105; lon <= 145; lon += 2) pts.push(lon, 20 + 4 * i);
    return { level, closed: false, points: Float64Array.from(pts) };
  });
  const contours: Contours = { minor: new Float32Array(0), major: new Float32Array(0), lines };
  const withLabels = (labels: MapOverlay['labels'], selectedCityId: string | null = null): MapOverlay => ({ ...EMPTY_OVERLAY, selectedCityId, labels });
  const plain = (text: string) => text.replace(/\u200A/g, '').toLowerCase();

  const zoomed = (make: typeof flat | typeof globe) => (lon = 125, lat = 22) => { const v = make(lon, lat); v.setHome(lon, lat, 12); return v; };
  for (const [name, make0] of [['flat', flat], ['globe', globe]] as const) {
    const make = zoomed(make0);
    describe(`on the ${name} view`, () => {
      const frame = (overlay: MapOverlay, view = make(125, 22)) => {
        const t = setup(view);
        t.painter.draw(view, null, overlays, overlay, contours, 0);
        return { t, view };
      };
      const names = (view: FlatView | GlobeView) => {
        const lang = getLanguage();
        return {
          cities: new Set(CITIES.map(c => cityLabel(c))),
          places: new Set(visiblePlaces(view, lang).map(p => placeName(p, lang))),
          seas: new Set(visibleSeas(view, lang).map(s => plain(seaName(s, lang)))),
        };
      };

      it('draws every label layer by default', () => {
        const { t, view } = frame(EMPTY_OVERLAY);
        const n = names(view);
        const texts = t.texts();
        expect(texts.some(x => n.cities.has(x))).toBe(true);
        expect(texts.some(x => n.places.has(x))).toBe(true);
        expect(texts.some(x => n.seas.has(plain(x)))).toBe(true);
        expect(texts.filter(x => /^\d{3,4}$/.test(x)).sort()).toEqual(['1000', '1008']);
        expect(frame(withLabels({ cities: true, isobars: true, seas: true, recordedPaths: true }), view).t.texts()).toEqual(texts);
      });

      it('cities: false drops city and place labels but keeps the dots', () => {
        const view = make(125, 22);
        const on = frame(EMPTY_OVERLAY, view).t;
        const off = frame(withLabels({ cities: false }), view).t;
        const n = names(view);
        expect(off.texts().some(x => n.cities.has(x) || n.places.has(x))).toBe(false);
        expect(off.texts().filter(x => /^\d{3,4}$/.test(x)).length).toBe(2);
        expect(off.count('arc')).toBeGreaterThan(0);
        expect(off.count('arc')).toBeGreaterThanOrEqual(on.count('arc'));
      });

      it('cities: false keeps the selected city label', () => {
        const view = make(139.7, 35.7);
        const tokyo = CITIES.find(c => c.id === 'tokyo') ?? CITIES[0];
        const { t } = frame(withLabels({ cities: false }, tokyo.id), view);
        const n = names(view);
        expect(t.texts().filter(x => n.cities.has(x))).toEqual([cityLabel(tokyo)]);
      });

      it('isobars: false keeps the lines but drops the pressure labels', () => {
        const view = make(125, 22);
        const on = frame(EMPTY_OVERLAY, view).t;
        const off = frame(withLabels({ isobars: false }), view).t;
        expect(off.texts().filter(x => /^\d{3,4}$/.test(x))).toEqual([]);
        expect(off.count('stroke')).toBeGreaterThan(0);
        expect(off.count('stroke')).toBe(on.count('stroke'));
      });

      it('seas: false drops the sea names', () => {
        const view = make(125, 22);
        const n = names(view);
        expect(n.seas.size).toBeGreaterThan(0);
        expect(frame(EMPTY_OVERLAY, view).t.texts().some(x => n.seas.has(plain(x)))).toBe(true);
        expect(frame(withLabels({ seas: false }), view).t.texts().some(x => n.seas.has(plain(x)))).toBe(false);
      });
    });
  }
});

describe('rivers and pinned islands', () => {
  const plain = (text: string) => text.replace(/ /g, '');
  const at = (make: typeof flat | typeof globe, lon: number, lat: number, span: number) => { const v = make(lon, lat); v.setHome(lon, lat, span); return v; };
  for (const [name, make] of [['flat', flat], ['globe', globe]] as const) {
    it(`labels the great rivers once each at country zoom on the ${name} view`, () => {
      const view = at(make, -62, -5, 60); // 15 px/deg
      const t = setup(view);
      t.painter.draw(view, null, NO_LAYERS, EMPTY_OVERLAY, null, 0);
      const texts = t.texts().map(plain);
      expect(texts.filter(x => x === 'Amazon')).toHaveLength(1);
    });

    it(`drops river names with the sea names toggle and at world zoom on the ${name} view`, () => {
      const view = at(make, -62, -5, 60);
      const off = setup(view);
      off.painter.draw(view, null, NO_LAYERS, { ...EMPTY_OVERLAY, labels: { seas: false } }, null, 0);
      expect(off.texts().map(plain)).not.toContain('Amazon');
      const world = at(make, -62, -5, 180);
      const t = setup(world);
      t.painter.draw(world, null, NO_LAYERS, EMPTY_OVERLAY, null, 0);
      expect(t.texts().map(plain)).not.toContain('Amazon');
    });

    it(`labels Ulleungdo and Dokdo from zoom 4.5 even with city labels off on the ${name} view`, () => {
      const view = at(make, 131.3, 37.4, 12); // 75 px/deg
      const on = setup(view);
      on.painter.draw(view, null, NO_LAYERS, EMPTY_OVERLAY, null, 0);
      expect(on.texts()).toEqual(expect.arrayContaining(['Ulleungdo', 'Dokdo']));
      const far = at(make, 131.3, 37.4, 60); // 15 px/deg, zoom 4.4
      const low = setup(far);
      low.painter.draw(far, null, NO_LAYERS, EMPTY_OVERLAY, null, 0);
      expect(low.texts()).not.toContain('Dokdo');
    });
  }
});

describe('graticule labels', () => {
  for (const [name, make] of [['globe', globe], ['flat', flat]] as const) {
    it(`draws no two graticule labels on top of each other on the ${name} view`, () => {
      const view = make(140, 40); // setHome span 60 on a 900 px tall viewport: 15 px/deg
      view.setHome(140, 40, 60);
      expect(view.scale).toBeCloseTo(15);
      const t = setup(view);
      t.priv.graticuleLabels(view, 0);
      const labels = t.calls.filter(c => c.name === 'fillText').map(c => {
        const text = String(c.args[0]); const x = c.args[1] as number; const y = c.args[2] as number;
        const width = text.length * 7;
        const x0 = c.align === 'center' ? x - width / 2 : x;
        return { text, rect: [x0, y - 12, x0 + width, y] as const };
      });
      expect(labels.length).toBeGreaterThan(4);
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const a = labels[i].rect; const b = labels[j].rect;
          const overlap = a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
          expect(overlap, `${labels[i].text} vs ${labels[j].text}`).toBe(false);
        }
      }
    });
  }
});
