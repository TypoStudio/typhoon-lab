import type { Coordinate, LandPolygon } from '../types';

export const KM_PER_DEG_LAT = 110.57;
export const KM_PER_DEG_LON_EQ = 111.32;
/** cos(latitude) floor so east–west distances stay finite at the poles. */
export const MIN_COS = 0.02;

export const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Longitude wrapped to [-180, 180). */
export function wrapLon(lon: number): number {
  const w = ((((lon + 180) % 360) + 360) % 360) - 180;
  return w;
}

export function cosLat(lat: number): number {
  return Math.max(MIN_COS, Math.cos(lat * (Math.PI / 180)));
}

/** Local tangent-plane offset (km east, km north) from (lon0,lat0) to (lon,lat), wrapped across the dateline. */
export function offsetKm(lon0: number, lat0: number, lon: number, lat: number): { dx: number; dy: number } {
  return { dx: wrapLon(lon - lon0) * KM_PER_DEG_LON_EQ * cosLat((lat0 + lat) / 2), dy: (lat - lat0) * KM_PER_DEG_LAT };
}

export function distanceKm(lon0: number, lat0: number, lon: number, lat: number): number {
  const { dx, dy } = offsetKm(lon0, lat0, lon, lat);
  return Math.hypot(dx, dy);
}

/** Move a point by a displacement in km; longitude wraps, latitude is clamped short of the poles. */
export function moveKm(lon: number, lat: number, eastKm: number, northKm: number): { lon: number; lat: number } {
  const newLat = clamp(lat + northKm / KM_PER_DEG_LAT, -89.5, 89.5);
  return { lon: wrapLon(lon + eastKm / (KM_PER_DEG_LON_EQ * cosLat((lat + newLat) / 2))), lat: newLat };
}

/**
 * Even-odd point-in-polygon index over land rings. Edges are bucketed into latitude bands so a
 * query only tests edges that can cross the horizontal ray through the point.
 */
export class LandIndex {
  private readonly south: number;
  private readonly bands: Float64Array[];
  private static readonly BAND = 0.25;

  constructor(polygons: LandPolygon[]) {
    let south = Infinity;
    let north = -Infinity;
    const rings: Coordinate[][] = [];
    for (const p of polygons) for (const ring of [p.outer, ...(p.holes ?? [])]) {
      if (ring.length < 3) continue;
      rings.push(ring);
      for (const [, y] of ring) { if (y < south) south = y; if (y > north) north = y; }
    }
    if (!Number.isFinite(south)) { south = 0; north = 0; }
    this.south = south;
    const count = Math.floor((north - south) / LandIndex.BAND) + 1;
    const lists: number[][] = Array.from({ length: count }, () => []);
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        if (y1 === y2) continue; // horizontal edges never cross a horizontal ray
        const first = Math.floor((Math.min(y1, y2) - south) / LandIndex.BAND);
        const last = Math.floor((Math.max(y1, y2) - south) / LandIndex.BAND);
        for (let b = first; b <= last; b++) lists[b].push(x1, y1, x2, y2);
      }
    }
    this.bands = lists.map(l => Float64Array.from(l));
  }

  /** Sorted longitudes where the parallel `lat` crosses a land edge. */
  crossings(lat: number): number[] {
    const out: number[] = [];
    const e = this.bands[Math.floor((lat - this.south) / LandIndex.BAND)];
    if (!e) return out;
    for (let i = 0; i < e.length; i += 4) {
      const y1 = e[i + 1];
      const y2 = e[i + 3];
      if ((y1 > lat) !== (y2 > lat)) out.push(e[i] + ((lat - y1) * (e[i + 2] - e[i])) / (y2 - y1));
    }
    return out.sort((a, b) => a - b);
  }

  contains(lon: number, lat: number): boolean {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    const x = wrapLon(lon);
    const e = this.bands[Math.floor((lat - this.south) / LandIndex.BAND)];
    if (!e) return false;
    let inside = false;
    for (let i = 0; i < e.length; i += 4) {
      const y1 = e[i + 1];
      const y2 = e[i + 3];
      if ((y1 > lat) !== (y2 > lat)) {
        const x1 = e[i];
        if (x < x1 + ((lat - y1) * (e[i + 2] - x1)) / (y2 - y1)) inside = !inside;
      }
    }
    return inside;
  }
}

/** Deterministic hash → [0,1). Stateless so it can be replayed from (seed, tick) alone. */
export function hash01(seed: number, a: number, b = 0): number {
  let h = (seed ^ Math.imul(a + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x7f4a7c15, 0xc2b2ae35)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
