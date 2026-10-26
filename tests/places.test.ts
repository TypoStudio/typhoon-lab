import { describe, expect, it } from 'vitest';
import generated from '../src/data/generated/places.json';
import { PLACES, placeName } from '../src/data/places';
import { CITIES } from '../src/data/world';
import { MAX_DRAWN, cityLabelEligible, minPopForDot, minPopForLabel, placeEligible, visiblePlaces, webZoom } from '../src/render/places';
import { GlobeView } from '../src/render/globe-view';
import { FlatView } from '../src/render/view';

const fold = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const eligibleAt = (scale: number) => PLACES.filter(p => placeEligible(p, Math.log2((scale * 360) / 256)));
const inBox = (p: { lon: number; lat: number }, w: number, e: number, s: number, n: number): boolean => p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;

describe('places data', () => {
  it('loads a compact array with plausible entries', () => {
    expect(Array.isArray(generated)).toBe(true);
    expect(PLACES.length).toBeGreaterThanOrEqual(500);
    expect(PLACES.length).toBeLessThanOrEqual(1000);
    for (const p of PLACES) {
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.lon).toBeGreaterThanOrEqual(-180); expect(p.lon).toBeLessThanOrEqual(180);
      expect(p.lat).toBeGreaterThanOrEqual(-90); expect(p.lat).toBeLessThanOrEqual(90);
      expect(p.popMax).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(p.minZoom)).toBe(true);
    }
  });

  it('is sorted by popMax, largest first', () => {
    for (let i = 1; i < PLACES.length; i++) expect(PLACES[i - 1].popMax).toBeGreaterThanOrEqual(PLACES[i].popMax);
  });

  it('keeps only places below the impact-city size, plus a few small capitals', () => {
    expect(PLACES.every(p => p.popMax < 500_000)).toBe(true);
    const small = PLACES.filter(p => p.popMax < 250_000);
    expect(small.length).toBeGreaterThan(0);
    expect(small.length).toBeLessThan(PLACES.length * 0.15);
  });

  it('does not repeat an impact city', () => {
    for (const c of CITIES) {
      for (const p of PLACES) {
        if (Math.hypot(p.lon - c.lon, p.lat - c.lat) < 0.3) expect(fold(p.name), `${p.name} near ${c.name}`).not.toBe(fold(c.name));
      }
    }
  });

  it('has Korean names for East Asian cities', () => {
    const ko = (name: string) => PLACES.find(p => p.name === name)?.nameKo;
    expect(ko('Pohang')).toBe('포항');
    expect(ko('Jeju')).toBe('제주');
    expect(ko('Yeosu')).toBe('여수');
    expect(ko('Mokpo')).toBe('목포');
  });

  it('has Japanese and Chinese names for East Asian cities', () => {
    const pohang = PLACES.find(p => p.name === 'Pohang')!;
    expect(pohang.names).toEqual({ ja: '浦項', 'zh-CN': '浦项', 'zh-TW': '浦項' });
    expect(PLACES.filter(p => p.names).length).toBeGreaterThan(PLACES.length * 0.9);
    for (const p of PLACES) for (const value of Object.values(p.names ?? {})) expect(value.length, p.name).toBeGreaterThan(0);
  });

  it('labels in the requested language, falling back to the English name', () => {
    const pohang = PLACES.find(p => p.name === 'Pohang')!;
    expect(placeName(pohang, 'ko')).toBe('포항');
    expect(placeName(pohang, 'en')).toBe('Pohang');
    expect(placeName({ ...pohang, nameKo: null }, 'ko')).toBe('Pohang');
    expect(placeName(pohang, 'ja')).toBe('浦項');
    expect(placeName(pohang, 'zh-CN')).toBe('浦项');
    expect(placeName(pohang, 'zh-TW')).toBe('浦項');
    expect(placeName({ ...pohang, names: {} }, 'ja')).toBe('Pohang');
    expect(placeName({ ...pohang, names: undefined }, 'zh-TW')).toBe('Pohang');
  });
});

describe('places eligibility', () => {
  it('shows hardly any places at world zoom, because the large cities are impact cities', () => {
    const f = new FlatView(); f.resize(1440, 900);
    expect(eligibleAt(f.scale).length).toBeLessThan(40);
  });

  it('shows no East Asian places at the home view and a few dozen at 45 px/deg', () => {
    expect(eligibleAt(15).filter(p => inBox(p, 105, 146, 20, 46)).length).toBe(0);
    const n = eligibleAt(45).filter(p => inBox(p, 105, 146, 20, 46)).length;
    expect(n).toBeGreaterThan(15);
    expect(n).toBeLessThan(60);
  });

  it('reads the label threshold ahead of the view, so towns under 500 k appear at country zoom', () => {
    const town = { ...PLACES[0], popMax: 450_000 };
    expect(placeEligible(town, 3)).toBe(false);
    expect(placeEligible(town, 6)).toBe(true);
    expect(placeEligible({ ...town, popMax: 150_000 }, 6)).toBe(false);
  });

  it('grows monotonically with zoom', () => {
    let prev = 0;
    for (const scale of [3, 6, 12, 24, 48, 96]) {
      const n = eligibleAt(scale).length;
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });
});

describe('population thresholds', () => {
  const world = Math.log2((3 * 360) / 256);
  const home = Math.log2((15 * 360) / 256);
  const korea = Math.log2((45 * 360) / 256);
  it('hits the label anchors and thins monotonically', () => {
    expect(minPopForLabel(2.7)).toBeCloseTo(8_000_000, -2);
    expect(minPopForLabel(4.4)).toBeCloseTo(3_000_000, -2);
    expect(minPopForLabel(6)).toBeCloseTo(1_500_000, -2);
    expect(minPopForLabel(7.5)).toBeCloseTo(250_000, -2);
    expect(minPopForLabel(0)).toBe(8_000_000);
    expect(minPopForLabel(12)).toBe(250_000);
    for (let z = 2.7; z < 7.5; z += 0.1) expect(minPopForLabel(z + 0.1)).toBeLessThanOrEqual(minPopForLabel(z));
    for (let z = 2.7; z < 7.5; z += 0.1) expect(minPopForDot(z)).toBeLessThan(minPopForLabel(z));
  });

  it('always labels cities of 8 M or more', () => {
    expect(cityLabelEligible(8_000_000, 0)).toBe(true);
    expect(cityLabelEligible(35_000_000, world)).toBe(true);
  });

  it('thins smaller cities at world zoom and admits them as the view zooms in', () => {
    expect(cityLabelEligible(2_000_000, world)).toBe(false);
    expect(cityLabelEligible(2_000_000, home)).toBe(false);
    expect(cityLabelEligible(3_100_000, home)).toBe(true);
    expect(cityLabelEligible(1_600_000, korea)).toBe(true);
    expect(cityLabelEligible(1_000_000, korea)).toBe(false);
    expect(cityLabelEligible(300_000, 8)).toBe(true);
  });

  it('keeps the number of labelled cities small in a world view', () => {
    const f = new FlatView(); f.resize(1440, 900);
    const labelled = CITIES.filter(c => cityLabelEligible(c.population, webZoom(f))).length;
    expect(labelled).toBeLessThan(40);
  });
});

describe('visiblePlaces', () => {
  it('stays inside the viewport and the cap, and is cached per view version and language', () => {
    const f = new FlatView(); f.resize(1440, 900); f.setHome(128, 33, 20);
    const list = visiblePlaces(f, 'ko');
    const b = f.visibleBounds();
    expect(list.length).toBeGreaterThan(10);
    expect(list.length).toBeLessThanOrEqual(MAX_DRAWN);
    for (const p of list) expect(inBox(p, b.west, b.east, b.south, b.north)).toBe(true);
    expect(visiblePlaces(f, 'ko')).toBe(list);
    expect(visiblePlaces(f, 'en')).not.toBe(list);
    f.zoomAt(2, 720, 450);
    expect(visiblePlaces(f, 'en')).not.toBe(list);
  });

  it('skips the far side of the globe', () => {
    const g = new GlobeView(); g.resize(1440, 900); g.setHome(128, 33, 20);
    expect(webZoom(g)).toBeGreaterThan(4);
    const list = visiblePlaces(g, 'en');
    expect(list.length).toBeGreaterThan(10);
    const out = new Float64Array(3);
    for (const p of list) { g.projectZ(p.lon, p.lat, out); expect(out[2]).toBeGreaterThan(0.09); }
  });
});
