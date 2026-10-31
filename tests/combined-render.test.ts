import { describe, expect, it } from 'vitest';
import { buildCombinedImage, buildSurfaceImages, FIELD_IMAGE_COLS, FIELD_IMAGE_ROWS, type FieldData } from '../src/render/fields';
import { Ramp, type Theme } from '../src/render/theme';
import { DEFAULT_MAP_OVERLAYS, type MapOverlays } from '../src/types';

const theme = {
  rgb: { sea: [10, 30, 60], land: [50, 60, 70] },
  ramps: {
    temperature: new Ramp([[30, 60, 160], [240, 200, 60], [220, 40, 40]], [22, 27, 32]),
    airTemperature: new Ramp([[70, 110, 210], [110, 200, 220], [240, 200, 80], [220, 60, 50]], [-40, 0, 20, 40]),
    population: new Ramp([[40, 40, 40], [255, 220, 120]], [4.5, 7.2]),
    rain: new Ramp([[40, 90, 180], [100, 180, 240]], [0, 60]),
    snow: new Ramp([[180, 200, 220], [240, 250, 255]], [0, 60]),
  },
} as unknown as Theme;

const count = 180 * 90;
function field(): FieldData {
  const zero = () => new Float32Array(count);
  const u = zero(), v = zero(), speed = zero(), pressure = zero(), temperature = new Float32Array(count).fill(29);
  const airTemperature = zero(), updraft = zero(), humidity = zero(), rain = zero(), snow = zero(), snowCm = zero(), population = zero();
  population[59 * 180 + 128] = 10_000_000;
  return { cols: 180, rows: 90, u, v, speed, pressure, temperature, airTemperature, updraft, humidity, rain, snow, snowCm,
    population, land: new Uint8Array(count), blizzard: new Uint8Array(count), blizzardF: zero(), maxSpeed: 0 };
}
const f = field();
const image = () => new Uint8Array(FIELD_IMAGE_COLS * FIELD_IMAGE_ROWS * 4);
const pixel = (lon: number, lat: number): number => (Math.floor(lat + 90) * FIELD_IMAGE_COLS + Math.floor(lon + 180)) * 4;
const color = (image: Uint8Array, lon: number, lat: number) => Array.from(image.subarray(pixel(lon, lat), pixel(lon, lat) + 3));
function surfaces(over: Partial<MapOverlays> = {}, source = f, sea = image(), land = image()) {
  buildSurfaceImages(source, { ...DEFAULT_MAP_OVERLAYS, ...over }, theme, sea, land);
  return { sea, land };
}

describe('direct surface colours', () => {
  it('colours sea and land independently without a transparent surface overlay', () => {
    const { sea, land } = surfaces();
    expect(color(sea, -140, 0)).not.toEqual(theme.rgb.sea);
    expect(color(land, 77, 29)).not.toEqual(theme.rgb.land);
    expect(surfaces({ population: false }).sea).toEqual(sea);
    expect(surfaces({ temperature: false }).land).not.toEqual(land);
    for (let i = 3; i < sea.length; i += 4) { expect(sea[i]).toBe(255); expect(land[i]).toBe(255); }
    const overlay = image();
    buildCombinedImage(f, { ...DEFAULT_MAP_OVERLAYS, rain: false }, theme, overlay);
    expect(overlay.every(value => value === 0)).toBe(true);
  });

  it('keeps population colour near its source and clears the former outer halo', () => {
    const { land } = surfaces();
    const base = surfaces({ population: false }).land;
    const difference = (lon: number) => color(land, lon, 29).reduce((sum, value, i) => sum + Math.abs(value - color(base, lon, 29)[i]), 0);
    expect(difference(77)).toBeGreaterThan(difference(78));
    expect(difference(77)).toBeGreaterThan(0);
    expect(difference(78)).toBe(0);
    expect(color(land, 90, 29)).toEqual(color(base, 90, 29));
  });

  it('samples temperature continuously instead of grouping samples into hexagons', () => {
    const source = field();
    for (let j = 0; j < source.rows; j++) for (let i = 0; i < source.cols; i++) source.temperature[j * source.cols + i] = -40 + i / 3;
    const { sea } = surfaces({}, source);
    expect(color(sea, 140, 20)).not.toEqual(color(sea, 142, 20));
  });

  it('uses near-surface air temperature on land while leaving sea temperature unchanged', () => {
    const source = field(); source.airTemperature.fill(-20);
    const cold = surfaces({ population: false }, source);
    source.airTemperature.fill(30);
    const warm = surfaces({ population: false }, source);
    expect(warm.sea).toEqual(cold.sea);
    expect(color(warm.land, 90, 29)).not.toEqual(color(cold.land, 90, 29));
    const plain = surfaces({ temperature: false, population: false }, source);
    expect(color(plain.land, 90, 29)).toEqual(theme.rgb.land);
  });

  it('restores base surface colours when toggled off, including reused buffers', () => {
    const { sea, land } = surfaces();
    surfaces({ temperature: false, population: false }, f, sea, land);
    expect(color(sea, -140, 0)).toEqual(theme.rgb.sea);
    expect(color(land, 77, 29)).toEqual(theme.rgb.land);
  });

  it('keeps precipitation above either surface and clears it when toggled off', () => {
    const source = field(); source.rain.fill(10); source.airTemperature.fill(5);
    const overlay = image();
    buildCombinedImage(source, DEFAULT_MAP_OVERLAYS, theme, overlay);
    expect(overlay[pixel(-140, 0) + 3]).toBeGreaterThan(0);
    expect(overlay[pixel(77, 29) + 3]).toBeGreaterThan(0);
    buildCombinedImage(source, { ...DEFAULT_MAP_OVERLAYS, rain: false }, theme, overlay);
    expect(overlay.every(value => value === 0)).toBe(true);
  });

  it('is deterministic and leaves the simulation grid unchanged', () => {
    const before = structuredClone(f);
    expect(surfaces()).toEqual(surfaces());
    expect(f).toEqual(before);
  });
});
