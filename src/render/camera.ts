/**
 * Camera contract shared by the flat Equal Earth map (FlatView) and the 3D globe (GlobeView).
 * Renderers go through projectZ(lon, lat) → [x, y, z], where z is visibility: flat views always
 * return z = 1, the globe returns the depth of the point (z <= 0 means it is on the far side).
 */
export type MapMode = 'flat' | 'globe';

/** west<east, may pass ±180 (unwrapped); east-west >= 360 means all longitudes. */
export interface GeoBounds { west: number; east: number; south: number; north: number }

export interface MapCamera {
  readonly kind: MapMode;
  readonly width: number;
  readonly height: number;
  /** Px per degree of latitude at the view centre (both views). */
  readonly scale: number;
  readonly fitScale: number;
  readonly zoom: number;
  readonly version: number;
  readonly isAtHome: boolean;
  resize(w: number, h: number): void;
  /** span = degrees across min(W, H). */
  setHome(lon: number, lat: number, span: number): void;
  reset(): void;
  centerOn(lon: number, lat: number): void;
  centerLonLat(): [number, number];
  fitTrack(points: { lon: number; lat: number }[], rightInset?: number): void;
  /** The point under (px, py) stays fixed. */
  zoomAt(factor: number, px: number, py: number): void;
  /** Content moves by (dx, dy). */
  panPx(dx: number, dy: number): void;
  /** The point grabbed at (x0, y0) follows the cursor to (x1, y1). */
  dragPx(x0: number, y0: number, x1: number, y1: number): void;
  /** [x, y, z]; z <= 0 hidden; flat views always return z = 1. Allocation-free when `out` is given. */
  projectZ(lon: number, lat: number, out?: Float64Array): Float64Array;
  /** Null when the point is hidden (z <= 0). */
  lonLatToPx(lon: number, lat: number): [number, number] | null;
  /** Null off the globe (or outside the flat map outline). */
  pxToLonLat(px: number, py: number): [number, number] | null;
  /** Flat: exact ellipse; globe: nominal [r, r] for margins only. */
  kmRadiiPx(km: number, lat: number): [number, number];
  visibleBounds(): GeoBounds;
  /**
   * Row-major 3×3 rotation (r0 r1 r2) taking a unit vector from geoToUnit to camera space
   * (X right, Y up, Z towards the viewer). Identity for the flat view. Treat as read-only; the
   * array may be the camera's live state.
   */
  rotation(): Float64Array;
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const EARTH_RADIUS_KM = 6371;

/** Unit vector (cosφ sinλ, sinφ, cosφ cosλ) written to out[o..o+2]. */
export const geoToUnit = (lon: number, lat: number, out: ArrayLike<number> & { [i: number]: number }, o = 0): typeof out => {
  const phi = lat * D2R;
  const lam = lon * D2R;
  const c = Math.cos(phi);
  out[o] = c * Math.sin(lam);
  out[o + 1] = Math.sin(phi);
  out[o + 2] = c * Math.cos(lam);
  return out;
};

/** Great-circle destination from (lon, lat) after `km` along `bearingRad` (0 = north, π/2 = east); lon in [-180, 180). */
export function destination(lon: number, lat: number, km: number, bearingRad: number): [number, number] {
  const phi = lat * D2R;
  const delta = km / EARTH_RADIUS_KM;
  const sinPhi = Math.sin(phi);
  const cosPhi = Math.cos(phi);
  const sinD = Math.sin(delta);
  const cosD = Math.cos(delta);
  const sinPhi2 = Math.max(-1, Math.min(1, sinPhi * cosD + cosPhi * sinD * Math.cos(bearingRad)));
  const dLam = Math.atan2(Math.sin(bearingRad) * sinD * cosPhi, cosD - sinPhi * sinPhi2);
  const lon2 = ((((lon + dLam * R2D + 180) % 360) + 360) % 360) - 180;
  return [lon2, Math.asin(sinPhi2) * R2D];
}

/** Fade-out near the globe limb: 0 at z <= 0.05, 1 at z >= 0.2. */
export const limbFade = (z: number): number => {
  const t = (z - 0.05) / 0.15;
  return t < 0 ? 0 : t > 1 ? 1 : t;
};
