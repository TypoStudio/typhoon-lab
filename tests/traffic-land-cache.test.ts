import { describe, expect, it, vi } from 'vitest';
import { isLand, isLandCached, wrapLon } from '../src/data/world';
import { TRAFFIC_ROUTES } from '../src/data/traffic';
import { trafficDistance, trafficPoint, trafficSegmentClear, type TrafficHazard } from '../src/simulation/traffic-routing';
import type { GeoPoint } from '../src/types';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const RAD = Math.PI / 180, EARTH_KM = 6371;
/** The original per-point formulas, kept verbatim as the reference. */
function referencePoint(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  const angle = trafficDistance(a, b) / EARTH_KM;
  if (angle < 1e-9) return { lon: a.lon, lat: a.lat };
  const sin = Math.sin(angle), u = Math.sin((1 - t) * angle) / sin, v = Math.sin(t * angle) / sin;
  const x = u * Math.cos(a.lat * RAD) * Math.cos(a.lon * RAD) + v * Math.cos(b.lat * RAD) * Math.cos(b.lon * RAD);
  const y = u * Math.cos(a.lat * RAD) * Math.sin(a.lon * RAD) + v * Math.cos(b.lat * RAD) * Math.sin(b.lon * RAD);
  const z = u * Math.sin(a.lat * RAD) + v * Math.sin(b.lat * RAD);
  return { lon: wrapLon(Math.atan2(y, x) / RAD), lat: Math.atan2(z, Math.hypot(x, y)) / RAD };
}
function referenceClear(a: GeoPoint, b: GeoPoint): boolean {
  const count = Math.max(1, Math.ceil(trafficDistance(a, b) / 4));
  for (let i = 0; i <= count; i++) { const p = referencePoint(a, b, i / count); if (isLand(p.lon, p.lat)) return false; }
  return true;
}

describe('ship routing land cache', () => {
  it('answers exactly like isLand, including on the coastline', () => {
    const next = rng(11);
    for (let i = 0; i < 100_000; i++) {
      const lon = 95 + next() * 60, lat = -12 + next() * 60;
      expect(isLandCached(lon, lat)).toBe(isLand(lon, lat));
    }
    for (let i = 0; i < 200_000; i++) {
      const lon = next() * 720 - 360, lat = next() * 180 - 90;
      expect(isLandCached(lon, lat)).toBe(isLand(lon, lat));
    }
    for (const [lon, lat] of [[0, 90], [0, -90], [180, 0], [-180, 0], [179.99999, 10], [NaN, 0], [10, NaN], [10, 91]]) {
      expect(isLandCached(lon, lat)).toBe(isLand(lon, lat));
    }
  });

  it('interpolates bit-for-bit like the original formula', () => {
    const next = rng(5);
    for (let i = 0; i < 2000; i++) {
      const a = { lon: next() * 360 - 180, lat: next() * 140 - 70 }, b = { lon: next() * 360 - 180, lat: next() * 140 - 70 }, t = next();
      expect(trafficPoint(a, b, t)).toEqual(referencePoint(a, b, t));
    }
  });

  it('judges thousands of coastal Asian segments like the exact test', () => {
    const next = rng(2026);
    let clear = 0, blocked = 0;
    for (let i = 0; i < 4000; i++) {
      const a = { lon: 95 + next() * 60, lat: -10 + next() * 55 };
      const b = { lon: a.lon + (next() - 0.5) * 8, lat: a.lat + (next() - 0.5) * 8 };
      const exact = referenceClear(a, b);
      expect(trafficSegmentClear(a, b, 'ships', [])).toBe(exact);
      if (exact) clear++; else blocked++;
    }
    expect(clear).toBeGreaterThan(300);
    expect(blocked).toBeGreaterThan(300);
  });

  it('plans identical routes for every service with the cached and the exact land test', async () => {
    const storm: TrafficHazard = { lon: 128, lat: 22, radiusKm: 450 };
    const plan = async (exactLand: boolean) => {
      vi.resetModules();
      if (exactLand) vi.doMock('../src/data/world', async importOriginal => ({ ...(await importOriginal<typeof import('../src/data/world')>()), isLandCached: isLand }));
      const routing = await import('../src/simulation/traffic-routing');
      vi.doUnmock('../src/data/world');
      return TRAFFIC_ROUTES.flatMap(r => [[r.start, r.end, []], [r.end, r.start, [storm]]] as [GeoPoint, GeoPoint, TrafficHazard[]][]
        ).map(([s, e, h], i) => routing.planTrafficRoute(s, e, TRAFFIC_ROUTES[i >> 1].kind, h));
    };
    const cached = await plan(false), exact = await plan(true);
    expect(cached).toEqual(exact);
    expect(cached.some(route => route && route.length > 2)).toBe(true);
  }, 120_000);
});
