import { LAKE_POLYGONS } from '../data/lakes';
import { RIVERS } from '../data/rivers';
import { LAND_POLYGONS } from '../data/world';
import type { LandPolygon } from '../types';
import { LAKE_TIER_MIN_ZOOM, RIVER_TIER_MIN_ZOOM, coastTier, COAST_TIER_MIN_ZOOM, lakeTier, polygonAreaDeg2, riverTier } from './detail';
import { LON0, edgeBetween, lonDelta, project as projectLonLat, projectLambda, wrapLon } from './view';

export interface ProjectedPolygon { outer: Float32Array; holes: Float32Array[] }

/** A ring in shifted longitude (degrees east of LON0, inside [-180, 180]) and latitude: [x0, lat0, x1, lat1, …], open. */
type GeoRing = number[];
interface GeoPolygon { outer: GeoRing; holes: GeoRing[]; pinned?: boolean }

/**
 * Shifted longitude of each vertex, unwrapped so consecutive vertices are never more than 180°
 * apart. A ring that winds once around a pole (Antarctica) is rotated to start at its most polar
 * vertex and closed along the pole line, which is a seam, instead of across the whole map.
 */
function unwrapRing(raw: [number, number][]): GeoRing {
  const n = raw.length;
  let wind = 0;
  for (let i = 0; i < n; i++) wind += lonDelta(raw[i][0], raw[(i + 1) % n][0]);
  const polar = Math.abs(wind) > 180;
  let r = raw;
  if (polar) {
    let k = 0;
    for (let i = 1; i < n; i++) if (Math.abs(raw[i][1]) > Math.abs(raw[k][1])) k = i;
    r = raw.slice(k).concat(raw.slice(0, k));
  }
  const out: GeoRing = [];
  let x = wrapLon(r[0][0] - LON0);
  out.push(x, r[0][1]);
  for (let i = 1; i < n; i++) {
    x += lonDelta(r[i - 1][0], r[i][0]);
    out.push(x, r[i][1]);
  }
  if (polar) out.push(x, r[0][1] < 0 ? -90 : 90, out[0], r[0][1] < 0 ? -90 : 90);
  return out;
}

/** Sutherland–Hodgman against the half-plane x ≥ bound (keepAbove) or x ≤ bound. */
function clipX(ring: GeoRing, bound: number, keepAbove: boolean): GeoRing {
  const out: GeoRing = [];
  const n = ring.length / 2;
  const inside = (x: number) => (keepAbove ? x >= bound : x <= bound);
  for (let i = 0; i < n; i++) {
    const x0 = ring[(((i + n - 1) % n) * 2)]; const y0 = ring[(((i + n - 1) % n) * 2) + 1];
    const x1 = ring[i * 2]; const y1 = ring[i * 2 + 1];
    const in0 = inside(x0); const in1 = inside(x1);
    if (in0 !== in1) out.push(bound, y0 + ((y1 - y0) * (bound - x0)) / (x1 - x0));
    if (in1) out.push(x1, y1);
  }
  return out;
}

/** Adds a vertex every degree of latitude along edges lying on the map edge, so cut land follows the curved outline. */
function densifyEdges(ring: GeoRing): GeoRing {
  const out: GeoRing = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2]; const y0 = ring[i * 2 + 1]; const x1 = ring[j * 2]; const y1 = ring[j * 2 + 1];
    out.push(x0, y0);
    if (Math.abs(x0) === 180 && x0 === x1) {
      const steps = Math.floor(Math.abs(y1 - y0));
      for (let s = 1; s <= steps; s++) out.push(x0, y0 + ((y1 - y0) * s) / (steps + 1));
    }
  }
  return out;
}

/** Copies of an unwrapped ring (shifted by whole turns) that overlap the map, clipped to λ ∈ [-180, 180]. */
function cutToMap(ring: GeoRing): GeoRing[] {
  let lo = Infinity; let hi = -Infinity;
  for (let i = 0; i < ring.length; i += 2) { lo = Math.min(lo, ring[i]); hi = Math.max(hi, ring[i]); }
  const pieces: GeoRing[] = [];
  for (let n = Math.ceil((-180 - hi) / 360); n <= Math.floor((180 - lo) / 360); n++) {
    const shifted = ring.map((v, i) => (i % 2 === 0 ? v + 360 * n : v));
    const clipped = clipX(clipX(shifted, -180, true), 180, false);
    if (clipped.length >= 6) pieces.push(densifyEdges(clipped));
  }
  return pieces;
}

const inRing = (ring: GeoRing, x: number, y: number): boolean => {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2]; const yi = ring[i * 2 + 1]; const xj = ring[j * 2]; const yj = ring[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};

/** Polygons cut at the map edge (the meridian opposite LON0), in shifted-longitude/latitude space. */
function cutPolygons(polygons: readonly LandPolygon[]): GeoPolygon[] {
  const out: GeoPolygon[] = [];
  for (const p of polygons) {
    if (p.outer.length < 3) continue;
    const outers = cutToMap(unwrapRing(p.outer as [number, number][])).map(outer => ({ outer, holes: [] as GeoRing[], pinned: p.pinned }));
    for (const hole of p.holes ?? []) {
      if (hole.length < 3) continue;
      for (const piece of cutToMap(unwrapRing(hole as [number, number][]))) {
        outers.find(o => inRing(o.outer, piece[0], piece[1]))?.holes.push(piece);
      }
    }
    out.push(...outers);
  }
  return out;
}

let geoCache: GeoPolygon[] | null = null;
let geoLakeCache: GeoPolygon[][] | null = null;

const geoLand = (): GeoPolygon[] => (geoCache ??= cutPolygons(LAND_POLYGONS));

/** Lake polygons of one area tier (see `lakeTier`), in the same order as `LAKE_POLYGONS`. */
const lakePolygonsOfTier = (tier: number): LandPolygon[] => LAKE_POLYGONS.filter(p => lakeTier(polygonAreaDeg2(p)) === tier);
const geoLakeTiers = (): GeoPolygon[][] => (geoLakeCache ??= LAKE_TIER_MIN_ZOOM.map((_, tier) => cutPolygons(lakePolygonsOfTier(tier))));

const project = (r: GeoRing): Float32Array => {
  const out = new Float32Array(r.length);
  for (let i = 0; i < r.length; i += 2) { const [x, y] = projectLambda(r[i], r[i + 1]); out[i] = x; out[i + 1] = y; }
  return out;
};

let cache: ProjectedPolygon[] | null = null;
let lakeCache: ProjectedPolygon[][] | null = null;

/** Natural Earth land polygons in Equal Earth world units (open rings, x/y interleaved), cut at the map's edge meridian. */
export function projectedLand(): ProjectedPolygon[] {
  cache ??= geoLand().map(p => ({ outer: project(p.outer), holes: p.holes.map(project) }));
  return cache;
}

/** Natural Earth lakes in the same world units as `projectedLand`, one list per area tier (`LAKE_TIER_MIN_ZOOM`). */
export function projectedLakeTiers(): ProjectedPolygon[][] {
  lakeCache ??= geoLakeTiers().map(tier => tier.map(p => ({ outer: project(p.outer), holes: p.holes.map(project) })));
  return lakeCache;
}

/** Every lake, all tiers together. */
export const projectedLakes = (): ProjectedPolygon[] => projectedLakeTiers().flat();

// Edges that are cuts, not coastline: along the map edge (shifted ±180°), along a pole (the flat top
// and bottom of the outline), or along the original ±180° split Natural Earth made, which is
// interior to this map and joins two polygons.
const EPS = 1e-6;
const isSeam = (x0: number, y0: number, x1: number, y1: number): boolean =>
  (Math.abs(Math.abs(x0) - 180) < EPS && Math.abs(Math.abs(x1) - 180) < EPS && Math.sign(x0) === Math.sign(x1))
  || (Math.abs(y0) > 90 - 1e-3 && Math.abs(y1) > 90 - 1e-3)
  || (Math.abs(Math.abs(wrapLon(x0 + LON0)) - 180) < EPS && Math.abs(Math.abs(wrapLon(x1 + LON0)) - 180) < EPS);

const sizeOf = (ring: ArrayLike<number>): number => {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
    y0 = Math.min(y0, ring[i + 1]); y1 = Math.max(y1, ring[i + 1]);
  }
  return Math.max(x1 - x0, y1 - y0);
};

/** Shoreline segments of polygons' rings [x0,y0,x1,y1,…] with cut seams removed, bucketed by `tierOf(ring, pinned)`. */
function ringSegments(
  polygons: readonly { outer: ArrayLike<number>; holes: readonly ArrayLike<number>[]; pinned?: boolean }[],
  isCut: (x0: number, y0: number, x1: number, y1: number) => boolean,
  at: (x: number, y: number) => readonly [number, number],
  tierOf: (ring: ArrayLike<number>, pinned: boolean) => number,
  tiers: number,
): Float32Array[] {
  const out: number[][] = Array.from({ length: tiers }, () => []);
  for (const p of polygons) {
    for (const r of [p.outer, ...p.holes]) {
      const bucket = out[tierOf(r, !!p.pinned)];
      const n = r.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        if (isCut(r[i * 2], r[i * 2 + 1], r[j * 2], r[j * 2 + 1])) continue;
        bucket.push(...at(r[i * 2], r[i * 2 + 1]), ...at(r[j * 2], r[j * 2 + 1]));
      }
    }
  }
  return out.map(list => new Float32Array(list));
}

/** Shoreline segments split by detail tier: `land[t]` by ring size (`coastTier`), `lakes[t]` by lake area (`lakeTier`). */
export interface CoastTiers { land: Float32Array[]; lakes: Float32Array[] }

const concat = (lists: readonly Float32Array[]): Float32Array => {
  const out = new Float32Array(lists.reduce((n, l) => n + l.length, 0));
  let at = 0;
  for (const l of lists) { out.set(l, at); at += l.length; }
  return out;
};

const landTier = (ring: ArrayLike<number>, pinned: boolean): number => coastTier(sizeOf(ring), pinned);

let coastCache: CoastTiers | null = null;

/** Coast segments [x0,y0,x1,y1,…] in world units with cut seams removed, by tier; built once. Lake shorelines are in `lakes`. */
export function coastTierSegments(): CoastTiers {
  coastCache ??= {
    land: ringSegments(geoLand(), isSeam, projectLambda, landTier, COAST_TIER_MIN_ZOOM.length),
    lakes: geoLakeTiers().map(tier => ringSegments(tier, isSeam, projectLambda, () => 0, 1)[0]),
  };
  return coastCache;
}

/** Coast segments [x0,y0,x1,y1,…] in world units with cut seams removed; lake shorelines are included. */
export const coastSegments = (): Float32Array => concat([...coastTierSegments().land, ...coastTierSegments().lakes]);

export interface LonLatPolygon { outer: Float32Array; holes: Float32Array[]; pinned?: boolean }

let lonLatCache: LonLatPolygon[] | null = null;
let lakeLonLatCache: LonLatPolygon[][] | null = null;

const flatRing = (ring: readonly (readonly number[])[]): Float32Array => {
  const out = new Float32Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) { out[i * 2] = ring[i][0]; out[i * 2 + 1] = ring[i][1]; }
  return out;
};

const toLonLat = (polygons: readonly LandPolygon[]): LonLatPolygon[] => polygons
  .filter(p => p.outer.length >= 3)
  .map(p => ({ outer: flatRing(p.outer), holes: (p.holes ?? []).filter(h => h.length >= 3).map(flatRing), pinned: p.pinned }));

/** Natural Earth land polygons as raw lon/lat degrees (open rings, lon/lat interleaved); split at ±180, not cut anywhere else. */
export function landLonLat(): LonLatPolygon[] {
  lonLatCache ??= toLonLat(LAND_POLYGONS);
  return lonLatCache;
}

/** Natural Earth lakes as raw lon/lat degrees, like `landLonLat`, one list per area tier (`LAKE_TIER_MIN_ZOOM`). */
export function lakeLonLatTiers(): LonLatPolygon[][] {
  lakeLonLatCache ??= LAKE_TIER_MIN_ZOOM.map((_, tier) => toLonLat(lakePolygonsOfTier(tier)));
  return lakeLonLatCache;
}

/** Every lake, all tiers together. */
export const lakeLonLat = (): LonLatPolygon[] => lakeLonLatTiers().flat();

const isLonLatSeam = (lon0: number, lat0: number, lon1: number, lat1: number): boolean =>
  (Math.abs(Math.abs(lon0) - 180) < EPS && Math.abs(Math.abs(lon1) - 180) < EPS)
  || (Math.abs(lat0) > 90 - 1e-3 && Math.abs(lat1) > 90 - 1e-3);

let coastLonLatCache: CoastTiers | null = null;

/** Coast segments [lon0,lat0,lon1,lat1,…] in degrees with the ±180° split and the pole line removed, by tier like `coastTierSegments`. */
export function coastTierSegmentsLonLat(): CoastTiers {
  const same = (x: number, y: number): readonly [number, number] => [x, y];
  coastLonLatCache ??= {
    land: ringSegments(landLonLat(), isLonLatSeam, same, landTier, COAST_TIER_MIN_ZOOM.length),
    lakes: lakeLonLatTiers().map(tier => ringSegments(tier, isLonLatSeam, same, () => 0, 1)[0]),
  };
  return coastLonLatCache;
}

/** Coast segments [lon0,lat0,lon1,lat1,…] in degrees with the ±180° split and the pole line removed; lake shorelines are included. */
export const coastSegmentsLonLat = (): Float32Array => concat([...coastTierSegmentsLonLat().land, ...coastTierSegmentsLonLat().lakes]);

/** River segments [x0,y0,x1,y1,…] per tier (`riverTier`); `at` maps lon/lat, segments across the map's edge meridian are dropped when `cut` is set. */
function riverSegments(at: (lon: number, lat: number) => readonly [number, number], cut: boolean): Float32Array[] {
  const out: number[][] = RIVER_TIER_MIN_ZOOM.map(() => []);
  for (const river of RIVERS) {
    const bucket = out[riverTier(river.scalerank)];
    for (const line of river.lines) {
      for (let i = 1; i < line.length; i++) {
        if (cut && edgeBetween(line[i - 1][0], line[i][0])) continue;
        bucket.push(...at(line[i - 1][0], line[i - 1][1]), ...at(line[i][0], line[i][1]));
      }
    }
  }
  return out.map(list => new Float32Array(list));
}

let riverCache: Float32Array[] | null = null;
let riverLonLatCache: Float32Array[] | null = null;

/** River segments in world units (the flat map), one buffer per tier; built once. */
export const riverTierSegments = (): Float32Array[] => (riverCache ??= riverSegments(projectLonLat, true));

/** River segments [lon0,lat0,lon1,lat1,…] in degrees (the globe), one buffer per tier; built once. */
export const riverTierSegmentsLonLat = (): Float32Array[] => (riverLonLatCache ??= riverSegments((lon, lat) => [lon, lat], false));
