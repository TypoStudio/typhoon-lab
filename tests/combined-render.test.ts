import { describe, expect, it } from 'vitest';
import { buildCombinedImage, buildLayerImage, type FieldData } from '../src/render/fields';
import { Ramp, type Theme } from '../src/render/theme';
import { DEFAULT_MAP_OVERLAYS, type MapOverlays } from '../src/types';

// Real Ramps without the DOM; only `ramps` is read by the raster builders.
const theme = {
  ramps: {
    wind: new Ramp([[20, 40, 80], [240, 240, 255]], [0, 40]),
    pressure: new Ramp([[80, 40, 120], [200, 200, 200], [200, 120, 40]], [960, 1010, 1035]),
    temperature: new Ramp([[30, 60, 160], [240, 200, 60], [220, 40, 40]], [22, 27, 32]),
    population: new Ramp([[40, 40, 40], [255, 220, 120]], [4.5, 7.2]),
    rain: new Ramp([[140, 190, 230], [60, 90, 200], [110, 50, 150]], [0, 15, 50]),
    snow: new Ramp([[215, 222, 230], [248, 250, 252], [232, 246, 255]], [0, 5, 20]),
  },
} as unknown as Theme;

/** One row of synthetic 2° cells with known land, SST and population. */
const CELLS = [
  { name: 'ocean', land: 0, sst: 29, pop: 0 },
  { name: 'cool ocean', land: 0, sst: 23, pop: 0 },
  { name: 'empty land', land: 1, sst: 31, pop: 0 },
  { name: 'city', land: 1, sst: 31, pop: 5_000_000 },
  { name: 'coastal town', land: 0, sst: 28, pop: 400_000 }, // mostly-water cell with people
] as const;
const cell = (name: (typeof CELLS)[number]['name']) => CELLS.findIndex(c => c.name === name);
function field(): FieldData {
  const n = CELLS.length;
  const f: FieldData = {
    cols: n, rows: 1,
    u: new Float32Array(n).fill(5), v: new Float32Array(n).fill(-3), speed: new Float32Array(n).fill(Math.hypot(5, 3)),
    pressure: new Float32Array(n).fill(985), temperature: new Float32Array(CELLS.map(c => c.sst)),
    airTemperature: new Float32Array(n).fill(25), updraft: new Float32Array(n), humidity: new Float32Array(n).fill(0.7), rain: new Float32Array(n), snow: new Float32Array(n), snowCm: new Float32Array(n),
    population: new Float32Array(CELLS.map(c => c.pop)), land: new Uint8Array(CELLS.map(c => c.land)), blizzard: new Uint8Array(n), blizzardF: new Float32Array(n), maxSpeed: Math.hypot(5, 3),
  };
  return f;
}
const f = field();
function combined(over: Partial<MapOverlays> = {}, out: Uint8Array = new Uint8Array(CELLS.length * 4)): Uint8Array {
  buildCombinedImage(f, { ...DEFAULT_MAP_OVERLAYS, ...over }, theme, out);
  return out;
}
function layer(kind: 'temperature' | 'population'): Uint8Array {
  const out = new Uint8Array(CELLS.length * 4);
  buildLayerImage(f, kind, theme, out);
  return out;
}
const alpha = (img: Uint8Array, k: number) => img[k * 4 + 3];
const rgba = (img: Uint8Array, k: number) => Array.from(img.subarray(k * 4, k * 4 + 4));
const SST_ALPHA = 64;

describe('combined map raster', () => {
  it('turns every overlay on by default', () => {
    expect(DEFAULT_MAP_OVERLAYS).toEqual({ wind: true, humidity: true, rain: true, pressure: true, temperature: true, population: true });
  });

  it('shows translucent ocean-only SST and population together when all overlays are on', () => {
    const img = combined();
    expect(alpha(img, cell('ocean'))).toBe(SST_ALPHA);
    expect(alpha(img, cell('cool ocean'))).toBe(SST_ALPHA);
    expect(rgba(img, cell('ocean'))).not.toEqual(rgba(img, cell('cool ocean'))); // SST colour still varies
    expect(alpha(img, cell('empty land'))).toBe(0);
    const pop = layer('population');
    expect(alpha(img, cell('city'))).toBe(alpha(pop, cell('city')));
    expect(alpha(img, cell('city'))).toBeGreaterThan(0);
    // People over water blend on top of SST: more opaque than either layer alone.
    const town = cell('coastal town');
    expect(alpha(img, town)).toBeGreaterThan(Math.max(SST_ALPHA, alpha(pop, town)));
    expect(alpha(img, town)).toBeLessThanOrEqual(255);
  });

  it('keeps the individual SST layer at the new translucent alpha, ocean only', () => {
    const sst = layer('temperature');
    for (const [k, c] of CELLS.entries()) expect(alpha(sst, k), c.name).toBe(c.land ? 0 : SST_ALPHA);
  });

  it('draws only water SST, with zero land alpha, when population is off', () => {
    const img = combined({ population: false });
    const sst = layer('temperature');
    for (const [k, c] of CELLS.entries()) {
      expect(alpha(img, k), c.name).toBe(c.land ? 0 : SST_ALPHA);
      if (!c.land) expect(rgba(img, k), c.name).toEqual(rgba(sst, k));
    }
  });

  it('removes population without touching SST when the population toggle goes off', () => {
    const on = combined(); const off = combined({ population: false });
    for (const name of ['ocean', 'cool ocean', 'empty land'] as const) expect(rgba(off, cell(name)), name).toEqual(rgba(on, cell(name)));
    expect(alpha(off, cell('city'))).toBe(0);
    expect(alpha(off, cell('coastal town'))).toBe(SST_ALPHA);
  });

  it('draws population alone with SST off; empty cells stay transparent', () => {
    const img = combined({ temperature: false });
    const pop = layer('population');
    for (const [k, c] of CELLS.entries()) {
      if (c.pop === 0) expect(alpha(img, k), c.name).toBe(0);
      else expect(rgba(img, k), c.name).toEqual(rgba(pop, k));
    }
  });

  it('has no pressure or wind heatmap: their toggles and fields never change the raster', () => {
    for (const temperature of [true, false]) for (const population of [true, false]) {
      expect(combined({ temperature, population, pressure: false })).toEqual(combined({ temperature, population, pressure: true }));
      expect(combined({ temperature, population, wind: false })).toEqual(combined({ temperature, population, wind: true }));
      expect(combined({ temperature, population, humidity: false })).toEqual(combined({ temperature, population, humidity: true }));
    }
    const base = combined();
    const stormy = field();
    stormy.pressure.fill(940); stormy.speed.fill(60); stormy.u.fill(-40); stormy.v.fill(45); stormy.maxSpeed = 60;
    const out = new Uint8Array(CELLS.length * 4);
    buildCombinedImage(stormy, DEFAULT_MAP_OVERLAYS, theme, out);
    expect(out).toEqual(base);
  });

  it('does not draw rain or snow into the raster: hexagons on the overlay canvas carry them', () => {
    const wet = field();
    wet.rain[cell('ocean')] = 30;
    wet.rain[cell('coastal town')] = 12; wet.snow[cell('coastal town')] = 12;
    const render = (rain: boolean, data: FieldData) => {
      const out = new Uint8Array(CELLS.length * 4);
      buildCombinedImage(data, { ...DEFAULT_MAP_OVERLAYS, rain }, theme, out);
      return out;
    };
    expect(render(true, wet)).toEqual(render(false, wet));
    expect(render(true, wet)).toEqual(render(true, field()));
    const alone = new Uint8Array(CELLS.length * 4);
    buildCombinedImage(wet, { ...DEFAULT_MAP_OVERLAYS, temperature: false, population: false, rain: true }, theme, alone);
    for (let k = 0; k < CELLS.length; k++) expect(alpha(alone, k)).toBe(0);
  });

  it('clears everything, including a reused buffer, when both raster overlays are off', () => {
    for (const pressure of [true, false]) {
      const reused = combined();
      reused.fill(255);
      combined({ temperature: false, population: false, rain: false, pressure }, reused);
      for (let k = 0; k < CELLS.length; k++) expect(alpha(reused, k)).toBe(0);
    }
  });

  it('is deterministic and does not modify the field', () => {
    const before = structuredClone(f);
    expect(combined()).toEqual(combined());
    expect(f).toEqual(before);
  });
});
