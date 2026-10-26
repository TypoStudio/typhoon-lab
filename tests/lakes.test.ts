import { describe, expect, it } from 'vitest';
import { LAKE_POLYGONS, LAKES, isLake, lakeName } from '../src/data/lakes';
import { SEAS } from '../src/data/seas';
import type { Coordinate } from '../src/types';
import { isLand } from '../src/simulation/engine';
import { coastSegments, coastSegmentsLonLat, projectedLakes } from '../src/render/geometry';
import { FlatView } from '../src/render/view';
import { lakeEligible, visibleLakes } from '../src/render/seas';

const inRing = (ring: Coordinate[], x: number, y: number): boolean => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = (p: (typeof LAKE_POLYGONS)[number], x: number, y: number): boolean =>
  inRing(p.outer, x, y) && !(p.holes ?? []).some(h => inRing(h, x, y));
const byName = (name: string) => LAKES.find(l => l.name === name);

describe('lake data', () => {
  it('has at least 100 polygons and sane coordinates', () => {
    expect(LAKE_POLYGONS.length).toBeGreaterThanOrEqual(100);
    for (const p of LAKE_POLYGONS) for (const ring of [p.outer, ...(p.holes ?? [])]) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      for (const [lon, lat] of ring) {
        expect(Math.abs(lon)).toBeLessThanOrEqual(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      }
    }
  });

  it('names Superior, Baikal and Victoria in Korean', () => {
    expect(lakeName(byName('Lake Superior')!, 'ko')).toBe('슈피리어호');
    expect(lakeName(byName('Lake Baikal')!, 'ko')).toBe('바이칼호');
    expect(lakeName(byName('Lake Victoria')!, 'ko')).toBe('빅토리아호');
    expect(lakeName(byName('Lake Baikal')!, 'en')).toBe('Lake Baikal');
    expect(lakeName(byName('Lake Baikal')!, 'ja')).toBe('バイカル湖');
    expect(lakeName(byName('Lake Baikal')!, 'zh-CN')).toBe('贝加尔湖');
    expect(lakeName(byName('Lake Victoria')!, 'zh-TW')).toBe('維多利亞湖');
  });

  it('gives every large lake a Korean name and ranks the Great Lakes as large', () => {
    const large = LAKES.filter(l => l.rank === 2);
    expect(large.length).toBeGreaterThanOrEqual(12);
    for (const l of large) expect(l.nameKo, l.name).toBeTruthy();
    for (const n of ['Lake Superior', 'Lake Michigan', 'Lake Huron', 'Lake Erie', 'Lake Ontario', 'Lake Baikal', 'Lake Victoria', 'Great Bear Lake', 'Great Slave Lake', 'Lake Ladoga'])
      expect(byName(n)?.rank, n).toBe(2);
    expect(byName('Lake Titicaca')).toBeDefined();
  });

  it('puts every label anchor inside its own polygon', () => {
    for (const l of LAKES) {
      expect(inPolygon(LAKE_POLYGONS[l.polygon], l.lon, l.lat), `${l.name} (${l.lon}, ${l.lat})`).toBe(true);
    }
  });

  it('does not duplicate the Caspian Sea, which is a hole in the land data and a sea label', () => {
    expect(LAKES.some(l => /caspian/i.test(l.name))).toBe(false);
    expect(SEAS.some(s => s.name === 'Caspian Sea')).toBe(true);
    expect(LAKE_POLYGONS.some(p => inPolygon(p, 51, 42))).toBe(false);
  });

  it('lists each lake name once', () => {
    const names = LAKES.map(l => `${l.name}|${l.areaDeg2}`);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('lakes are rendering only', () => {
  it('leaves lake cells as land for the simulation', () => {
    expect(isLand(-87.77, 47.55)).toBe(true); // Lake Superior
    expect(isLand(107.7, 53.4)).toBe(true); // Lake Baikal
  });

  it('projects lakes for the flat map and adds their shorelines to both coast sources', () => {
    expect(projectedLakes().length).toBeGreaterThanOrEqual(100);
    const lakeEdges = LAKE_POLYGONS.reduce((n, p) => n + p.outer.length + (p.holes ?? []).reduce((m, h) => m + h.length, 0), 0);
    expect(coastSegmentsLonLat().length / 4).toBeGreaterThan(lakeEdges);
    expect(coastSegments().length / 4).toBeGreaterThan(lakeEdges);
  });
});

describe('lake labels', () => {
  it('shows large lakes from 4 web zoom and small ones from 5.5', () => {
    const superior = byName('Lake Superior')!;
    const small = LAKES.find(l => l.rank === 3)!;
    expect(lakeEligible(superior, 3.9)).toBe(false);
    expect(lakeEligible(superior, 4)).toBe(true);
    expect(lakeEligible(small, 5.4)).toBe(false);
    expect(lakeEligible(small, 5.5)).toBe(true);
  });

  it('lists no lake at world zoom and the Great Lakes at 25 px/deg', () => {
    const world = new FlatView(); world.resize(1440, 900);
    world.zoomAt(0.0001, 720, 450);
    expect(visibleLakes(world, 'en')).toHaveLength(0);
    const view = new FlatView(); view.resize(1440, 900);
    view.zoomAt(25 / view.scale, 720, 450);
    view.centerOn(-84, 45);
    const names = visibleLakes(view, 'ko').map(l => l.name);
    for (const n of ['Lake Superior', 'Lake Michigan', 'Lake Huron', 'Lake Erie', 'Lake Ontario']) expect(names, n).toContain(n);
    expect(names).not.toContain('Lake Baikal');
  });
});

describe('isLake', () => {
  it('finds mapped lakes only', () => {
    expect(isLake(108, 53.5)).toBe(true); // Lake Baikal
    expect(isLake(-87.5, 47.5)).toBe(true); // Lake Superior
    expect(isLake(140, 16)).toBe(false); // open Pacific
    expect(isLake(105, 47)).toBe(false); // Mongolian steppe
    expect(isLake(NaN, 10)).toBe(false);
  });
  it('treats lake points as land for the simulation', () => {
    expect(isLand(108, 53.5)).toBe(true);
  });
});
