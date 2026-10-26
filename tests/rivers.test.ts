import { describe, expect, it } from 'vitest';
import generated from '../src/data/generated/world-rivers.json';
import { OVERRIDES, RIVERS, riverName, type River } from '../src/data/rivers';
import { RIVER_TIER_MIN_ZOOM, riverEligible, riverTier } from '../src/render/detail';
import { riverTierSegments, riverTierSegmentsLonLat } from '../src/render/geometry';
import { webZoom } from '../src/render/places';
import type { MapCamera } from '../src/render/camera';

const byName = (name: string): River => RIVERS.find(r => r.name === name)!;
const zoomAt = (scale: number): number => webZoom({ scale } as MapCamera);

describe('river data', () => {
  it('has at least 150 rivers with valid lines', () => {
    expect(RIVERS.length).toBeGreaterThanOrEqual(150);
    for (const r of RIVERS) {
      expect(r.lines.length, r.name).toBeGreaterThanOrEqual(1);
      expect(r.scalerank, r.name).toBeGreaterThanOrEqual(1);
      expect(r.scalerank, r.name).toBeLessThanOrEqual(6);
      for (const line of r.lines) {
        expect(line.length, r.name).toBeGreaterThanOrEqual(2);
        for (const [lon, lat] of line) {
          expect(Math.abs(lon), r.name).toBeLessThanOrEqual(180);
          expect(Math.abs(lat), r.name).toBeLessThanOrEqual(90);
        }
      }
    }
  });

  it('is sorted by scalerank, the great rivers first', () => {
    for (let i = 1; i < RIVERS.length; i++) expect(RIVERS[i].scalerank).toBeGreaterThanOrEqual(RIVERS[i - 1].scalerank);
  });

  it('names the great rivers in Korean and ranks them as great', () => {
    const expected: [string, string][] = [['Yellow River', '황하'], ['Yangtze', '장강'], ['Nile', '나일강'], ['Amazon', '아마존강'], ['Mississippi', '미시시피강']];
    for (const [name, ko] of expected) {
      const river = byName(name);
      expect(river, name).toBeDefined();
      expect(riverName(river, 'ko'), name).toBe(ko);
      expect(riverName(river, 'en'), name).toBe(name);
      expect(river.scalerank, name).toBeLessThanOrEqual(2);
    }
    expect(riverName(byName('Yellow River'), 'ja')).toBe('黄河');
    expect(riverName(byName('Yellow River'), 'zh-TW')).toBe('黃河');
    expect(riverName(byName('Yangtze'), 'zh-CN')).toBe('长江');
  });

  it('ranks every river of the brief as great', () => {
    for (const name of ['Yellow River', 'Yangtze', 'Nile', 'Amazon', 'Mississippi', 'Mekong', 'Ganges', 'Ob', 'Yenisey', 'Lena', 'Amur', 'Congo', 'Niger', 'Danube', 'Volga', 'Indus', 'Murray']) {
      expect(byName(name)?.scalerank, name).toBeLessThanOrEqual(2);
    }
  });

  it('keeps every override pointing at a river in the generated file', () => {
    const names = new Set((generated.rivers as { name: string }[]).map(r => r.name));
    for (const key of Object.keys(OVERRIDES)) expect(names.has(key), key).toBe(true);
  });
});

describe('river zoom tiers', () => {
  const eligible = (scale: number) => RIVERS.filter(r => riverEligible(r.scalerank, zoomAt(scale)));

  it('shows nothing at world zoom', () => {
    expect(eligible(2.5)).toEqual([]);
    expect(eligible(6)).toEqual([]); // zoom 3.1, still under 3.3
  });

  it('shows only the great rivers at 15 px/deg', () => {
    const list = eligible(15);
    expect(list.length).toBeGreaterThanOrEqual(20);
    expect(list.every(r => r.scalerank <= 2)).toBe(true);
    for (const name of ['Yellow River', 'Yangtze', 'Nile', 'Amazon', 'Mississippi']) expect(list.map(r => r.name)).toContain(name);
  });

  it('adds scalerank 3-4 rivers from zoom 4.5 and the rest from 5.5', () => {
    expect(riverTier(2)).toBe(0);
    expect(riverTier(3)).toBe(1);
    expect(riverTier(4)).toBe(1);
    expect(riverTier(5)).toBe(2);
    expect(riverTier(6)).toBe(2);
    expect(RIVER_TIER_MIN_ZOOM).toEqual([3.3, 4.5, 5.5]);
    expect(riverEligible(4, 4.4)).toBe(false);
    expect(riverEligible(4, 4.5)).toBe(true);
    expect(riverEligible(6, 5.4)).toBe(false);
    expect(riverEligible(6, 5.5)).toBe(true);
  });

  it('builds one segment buffer per tier for both views, with the same segment counts', () => {
    const flat = riverTierSegments();
    const lonLat = riverTierSegmentsLonLat();
    expect(flat).toHaveLength(RIVER_TIER_MIN_ZOOM.length);
    expect(lonLat).toHaveLength(RIVER_TIER_MIN_ZOOM.length);
    lonLat.forEach((buffer, t) => {
      expect(buffer.length % 4).toBe(0);
      expect(buffer.length, `tier ${t}`).toBeGreaterThan(0);
      // The flat buffer only loses the few segments that cross the map's edge meridian.
      expect(flat[t].length).toBeLessThanOrEqual(buffer.length);
      expect(flat[t].length).toBeGreaterThan(buffer.length * 0.97);
    });
  });
});
