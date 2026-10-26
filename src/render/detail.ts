import type { LandPolygon } from '../types';

/**
 * Zoom-dependent detail. Lakes, small islands and rivers are split into tiers when their geometry is built;
 * a frame then only compares the web zoom (`webZoom`) with a tier's minimum, instead of filtering anything.
 */

/** Smallest web zoom at which each tier shows; tiers are ordered, so the visible ones are always a prefix. */
export const visibleTierCount = (minZoom: readonly number[], zoom: number): number => {
  let n = 0;
  while (n < minZoom.length && zoom >= minZoom[n]) n++;
  return n;
};

/** Lake polygons by area (deg²): 0 = >= 2 (always), 1 = 0.5 to 2, 2 = 0.1 to 0.5, 3 = smaller. */
export const LAKE_TIER_MIN_ZOOM = [-Infinity, 3.3, 4.5, 5.5] as const;
export const lakeTier = (areaDeg2: number): number => (areaDeg2 >= 2 ? 0 : areaDeg2 >= 0.5 ? 1 : areaDeg2 >= 0.1 ? 2 : 3);

/** Area of a polygon in deg² (outer ring minus holes, shoelace on lon/lat). */
export function polygonAreaDeg2(polygon: LandPolygon): number {
  const ring = (points: readonly (readonly number[])[]): number => {
    let sum = 0;
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      sum += x1 * y2 - x2 * y1;
    }
    return Math.abs(sum) / 2;
  };
  return ring(polygon.outer) - (polygon.holes ?? []).reduce((a, h) => a + ring(h), 0);
}

/** Coast rings by bounding box (its larger side, degrees): 0 = >= 0.25 (always), 1 = 0.05 to 0.25, 2 = smaller. Pinned islands are never in tier 2. */
export const COAST_TIER_MIN_ZOOM = [-Infinity, 4.5, 6] as const;
export const coastTier = (sizeDeg: number, pinned = false): number => (sizeDeg >= 0.25 ? 0 : sizeDeg >= 0.05 || pinned ? 1 : 2);

/** Below this web zoom the coast is drawn thin and faint; the land fill carries the shape. */
export const COAST_THIN_ZOOM = 3;

/** Rivers by Natural Earth scalerank: 0 = 1 to 2 (the great rivers), 1 = 3 to 4, 2 = 5 to 6. Nothing is drawn below the first minimum. */
export const RIVER_TIER_MIN_ZOOM = [3.3, 4.5, 5.5] as const;
export const riverTier = (scalerank: number): number => (scalerank <= 2 ? 0 : scalerank <= 4 ? 1 : 2);
export const riverEligible = (scalerank: number, zoom: number): boolean => zoom >= RIVER_TIER_MIN_ZOOM[riverTier(scalerank)];

/** Rivers up to scalerank 2 are labelled from this web zoom. */
export const RIVER_LABEL_MIN_ZOOM = 4;
