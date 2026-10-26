import { describe, expect, it } from 'vitest';
import { MANUAL_ISLANDS, PINNED_PLACES, pinnedPlaceName } from '../src/data/islands';
import { LAKES } from '../src/data/lakes';
import { LAND_POLYGONS, isLand } from '../src/data/world';
import { COAST_TIER_MIN_ZOOM, LAKE_TIER_MIN_ZOOM, coastTier, lakeTier, polygonAreaDeg2, visibleTierCount } from '../src/render/detail';
import { coastSegments, coastSegmentsLonLat, coastTierSegments, coastTierSegmentsLonLat, lakeLonLat, lakeLonLatTiers, projectedLakeTiers, projectedLakes } from '../src/render/geometry';

describe('visibleTierCount', () => {
  it('counts the tiers whose minimum zoom is reached', () => {
    expect(visibleTierCount(LAKE_TIER_MIN_ZOOM, 0)).toBe(1);
    expect(visibleTierCount(LAKE_TIER_MIN_ZOOM, 3.29)).toBe(1);
    expect(visibleTierCount(LAKE_TIER_MIN_ZOOM, 3.3)).toBe(2);
    expect(visibleTierCount(LAKE_TIER_MIN_ZOOM, 4.5)).toBe(3);
    expect(visibleTierCount(LAKE_TIER_MIN_ZOOM, 5.5)).toBe(4);
    expect(visibleTierCount(COAST_TIER_MIN_ZOOM, 4.49)).toBe(1);
    expect(visibleTierCount(COAST_TIER_MIN_ZOOM, 4.5)).toBe(2);
    expect(visibleTierCount(COAST_TIER_MIN_ZOOM, 6)).toBe(3);
  });
});

describe('lake area tiers', () => {
  it('splits at 2, 0.5 and 0.1 deg²', () => {
    expect([5, 2, 1.99, 0.5, 0.49, 0.1, 0.09, 0].map(lakeTier)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
  });

  it('measures a polygon minus its holes', () => {
    const square = (x: number, s: number): [number, number][] => [[x, x], [x + s, x], [x + s, x + s], [x, x + s]];
    expect(polygonAreaDeg2({ outer: square(0, 2) })).toBeCloseTo(4);
    expect(polygonAreaDeg2({ outer: square(0, 2), holes: [square(0.5, 1)] })).toBeCloseTo(3);
  });

  it('keeps every lake in exactly one tier of each renderer input, with big lakes first', () => {
    const lonLat = lakeLonLatTiers();
    expect(lonLat).toHaveLength(LAKE_TIER_MIN_ZOOM.length);
    expect(lakeLonLat().length).toBe(lonLat.reduce((n, t) => n + t.length, 0));
    expect(lonLat.every(t => t.length > 0)).toBe(true);
    expect(projectedLakeTiers()).toHaveLength(LAKE_TIER_MIN_ZOOM.length);
    expect(projectedLakes().length).toBe(projectedLakeTiers().reduce((n, t) => n + t.length, 0));
    // The always-visible tier is a handful of big lakes; the last tier holds the most polygons.
    expect(lonLat[0].length).toBeLessThan(lonLat[3].length);
    expect(lonLat[0].length).toBeLessThan(60);
  });

  it('puts the Great Lakes and Baikal in the always-visible tier', () => {
    const large = LAKES.filter(l => l.rank === 2).map(l => l.name);
    expect(large).toContain('Lake Baikal');
    // Superior's polygon contains its label anchor, so the anchor must lie in a tier-0 outline.
    const superior = LAKES.find(l => l.name === 'Lake Superior')!;
    const outers = lakeLonLatTiers()[0].map(p => p.outer);
    const inside = outers.some(ring => {
      let inRing = false;
      for (let i = 0, j = ring.length / 2 - 1; i < ring.length / 2; j = i++) {
        const xi = ring[i * 2], yi = ring[i * 2 + 1], xj = ring[j * 2], yj = ring[j * 2 + 1];
        if ((yi > superior.lat) !== (yj > superior.lat) && superior.lon < ((xj - xi) * (superior.lat - yi)) / (yj - yi) + xi) inRing = !inRing;
      }
      return inRing;
    });
    expect(inside).toBe(true);
  });
});

describe('coast ring tiers', () => {
  it('splits by the larger bounding-box side at 0.25 and 0.05 degrees', () => {
    expect([10, 0.25, 0.249, 0.05, 0.049, 0.001].map(s => coastTier(s))).toEqual([0, 0, 1, 1, 2, 2]);
  });

  it('never leaves a pinned island in the smallest tier', () => {
    expect(coastTier(0.002, true)).toBe(1);
    expect(coastTier(0.002, false)).toBe(2);
    expect(coastTier(10, true)).toBe(0);
  });

  it('builds every land tier and a buffer per lake tier for both coordinate systems', () => {
    for (const tiers of [coastTierSegments(), coastTierSegmentsLonLat()]) {
      expect(tiers.land).toHaveLength(COAST_TIER_MIN_ZOOM.length);
      expect(tiers.lakes).toHaveLength(LAKE_TIER_MIN_ZOOM.length);
      for (const b of [...tiers.land, ...tiers.lakes]) { expect(b.length % 4).toBe(0); expect(b.length).toBeGreaterThan(0); }
      // Most of the coast length is in the always-visible tier; tiny islands are a small tail.
      expect(tiers.land[0].length).toBeGreaterThan(tiers.land[1].length);
      expect(tiers.land[1].length).toBeGreaterThan(tiers.land[2].length);
    }
  });

  it('concatenates the tiers into the full coast', () => {
    const sum = (b: Float32Array[]) => b.reduce((n, x) => n + x.length, 0);
    const ll = coastTierSegmentsLonLat();
    expect(coastSegmentsLonLat().length).toBe(sum(ll.land) + sum(ll.lakes));
    const world = coastTierSegments();
    expect(coastSegments().length).toBe(sum(world.land) + sum(world.lakes));
  });
});

describe('Dokdo and Ulleungdo', () => {
  const near = (b: Float32Array, lon: number, lat: number, r: number): boolean => {
    for (let i = 0; i < b.length; i += 4) if (Math.hypot(b[i] - lon, b[i + 1] - lat) < r) return true;
    return false;
  };

  it('has a Dokdo polygon from Natural Earth 10m and a manual one for the eastern island', () => {
    const ne = LAND_POLYGONS.find(p => p.source === 'ne10m' && p.outer.every(([lon, lat]) => Math.abs(lon - 131.86) < 0.01 && Math.abs(lat - 37.243) < 0.01));
    expect(ne?.pinned).toBe(true);
    expect(MANUAL_ISLANDS).toHaveLength(1);
    expect(MANUAL_ISLANDS[0].pinned).toBe(true);
    expect(LAND_POLYGONS).toContain(MANUAL_ISLANDS[0]);
  });

  it('keeps the land mask at sea between the two islands', () => {
    expect(isLand(131.867, 37.242)).toBe(false);
  });

  it('draws the Dokdo coast from tier 1, not in the smallest tier', () => {
    const { land } = coastTierSegmentsLonLat();
    expect(near(land[1], 131.862, 37.2424, 0.005)).toBe(true);
    expect(near(land[1], 131.8695, 37.241, 0.005)).toBe(true);
    expect(near(land[2], 131.862, 37.2424, 0.005)).toBe(false);
    expect(near(land[2], 131.8695, 37.241, 0.005)).toBe(false);
  });

  it('has Ulleungdo as a detailed pinned polygon', () => {
    const ulleung = LAND_POLYGONS.find(p => p.outer.some(([lon, lat]) => Math.abs(lon - 130.87) < 0.1 && Math.abs(lat - 37.5) < 0.1))!;
    expect(ulleung.pinned).toBe(true);
    expect(ulleung.outer.length).toBeGreaterThanOrEqual(6);
    expect(isLand(130.87, 37.5)).toBe(true);
  });

  it('names both places in every language', () => {
    const name = (en: string, lang: 'en' | 'ko' | 'ja' | 'zh-CN' | 'zh-TW') => pinnedPlaceName(PINNED_PLACES.find(p => p.name === en)!, lang);
    expect(['en', 'ko', 'ja', 'zh-CN', 'zh-TW'].map(l => name('Dokdo', l as 'en'))).toEqual(['Dokdo', '독도', '独島', '独岛', '獨島']);
    expect(['en', 'ko', 'ja', 'zh-CN', 'zh-TW'].map(l => name('Ulleungdo', l as 'en'))).toEqual(['Ulleungdo', '울릉도', '鬱陵島', '郁陵岛', '鬱陵島']);
  });
});
