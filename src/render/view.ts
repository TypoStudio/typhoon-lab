import { MIN_COS } from '../simulation/geo';
import type { GeoBounds, MapCamera } from './camera';

export type { MapCamera };

/**
 * Map projection: Equal Earth (Šavrič, Patterson & Jenny 2018), a pseudocylindrical equal-area
 * projection with curved meridians and flat poles. World x/y are the projection's metres-free
 * coordinates multiplied by 180/π so numbers stay degree-like (one unit is about one degree).
 * The map is centred on LON0 and has a bounded outline (MAP_X0..MAP_X1 at the equator, narrowing to
 * the flat top/bottom edge at ±MAP_Y1); there is no horizontal repeat. Anything that holds a
 * longitude/latitude must go through project() before it is drawn; world y is never a latitude and
 * world x is never a longitude.
 */
export const LON0 = 150;
export const KM_PER_DEG_LAT = 110.57;
export const KM_PER_DEG_LON = 111.32;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const A1 = 1.340264;
const A2 = -0.081106;
const A3 = 0.000893;
const A4 = 0.003796;
const M = Math.sqrt(3) / 2;
const K = (2 * Math.sqrt(3)) / 3;

/** y(θ) / (180/π) and its derivative; θ is the auxiliary latitude asin(M·sin φ). */
const yPoly = (t: number): number => { const t2 = t * t; const t6 = t2 * t2 * t2; return t * (A1 + A2 * t2 + t6 * (A3 + A4 * t2)); };
const yDeriv = (t: number): number => { const t2 = t * t; const t6 = t2 * t2 * t2; return A1 + 3 * A2 * t2 + t6 * (7 * A3 + 9 * A4 * t2); };

/** Longitude folded into [-180, 180). */
export const wrapLon = (lon: number): number => ((((lon + 180) % 360) + 360) % 360) - 180;
/** Shortest signed longitude difference b − a in (-180, 180]. */
export const lonDelta = (a: number, b: number): number => {
  const d = wrapLon(b - a);
  return d === -180 ? 180 : d;
};
/** The meridian opposite the centre, where the map is cut: LON0 ± 180 = -30°. */
export const EDGE_LON = wrapLon(LON0 + 180);
/** True when the shortest longitude path from `lon1` to `lon2` crosses the cut meridian (the map edge). */
export const edgeBetween = (lon1: number, lon2: number): boolean => Math.abs(wrapLon(lon1 - LON0) - wrapLon(lon2 - LON0)) > 180;

/** Projects a longitude already relative to the central meridian (degrees, not wrapped: ±180 are the two map edges). */
export const projectLambda = (lambda: number, lat: number): [number, number] => {
  const theta = Math.asin(M * Math.sin(lat * D2R));
  return [(K * lambda * Math.cos(theta)) / yDeriv(theta), yPoly(theta) * R2D];
};
export const project = (lon: number, lat: number): [number, number] => projectLambda(wrapLon(lon - LON0), lat);

export const MAP_X1 = projectLambda(180, 0)[0];
export const MAP_X0 = -MAP_X1;
export const MAP_Y1 = projectLambda(0, 90)[1];
export const MAP_Y0 = -MAP_Y1;
export const MAP_W = MAP_X1 - MAP_X0;
export const MAP_H = MAP_Y1 - MAP_Y0;

/** Half the map's width at world height y (0 above/below the flat poles). */
const halfWidthAt = (y: number): number => {
  const theta = thetaFromY(y);
  return (K * 180 * Math.cos(theta)) / yDeriv(theta);
};
/** Auxiliary latitude θ for a world y (Newton's method; y is clamped to the poles). */
const thetaFromY = (y: number): number => {
  const target = Math.max(MAP_Y0, Math.min(MAP_Y1, y)) * D2R;
  let t = target;
  for (let i = 0; i < 12; i++) {
    const d = (yPoly(t) - target) / yDeriv(t);
    t -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return t;
};

/** True when the world point lies inside the map outline (`eps` widens it). */
export const inOutline = (x: number, y: number, eps = 1e-9): boolean =>
  Math.abs(y) <= MAP_Y1 + eps && Math.abs(x) <= halfWidthAt(y) + eps;

/** World point → [lon, lat] with lon in [-180, 180). Points outside the outline are clamped onto it. */
export const unproject = (x: number, y: number): [number, number] => {
  const theta = thetaFromY(y);
  const half = (K * 180 * Math.cos(theta)) / yDeriv(theta);
  const xc = Math.max(-half, Math.min(half, x));
  const lat = Math.asin(Math.max(-1, Math.min(1, Math.sin(theta) / M))) * R2D;
  const lambda = Math.cos(theta) < 1e-12 ? 0 : (xc * yDeriv(theta)) / (K * Math.cos(theta));
  return [wrapLon(LON0 + lambda), lat];
};

/** Outline of the whole map in world units, counter-clockwise from the bottom-right corner, sampled every degree of latitude. */
export const MAP_OUTLINE: [number, number][] = (() => {
  const pts: [number, number][] = [];
  for (let lat = -90; lat <= 90; lat++) pts.push(projectLambda(180, lat));
  for (let lat = 90; lat >= -90; lat--) pts.push(projectLambda(-180, lat));
  return pts;
})();

/**
 * World-space semi-axes [rx, ry] of a ground circle of `km` radius centred at latitude `lat`, from
 * the projection's local scale factors on the central meridian: ∂x/∂λ = K·cos θ / y'(θ) world units
 * per degree of longitude, ∂y/∂φ = M·cos φ·y'(θ) / cos θ per degree of latitude (their product is
 * cos φ: the projection is equal-area). Ground circles are drawn as axis-aligned ellipses with
 * these radii; the shear away from the central meridian is ignored.
 */
export function kmToWorld(km: number, lat: number): [number, number] {
  const phi = lat * D2R;
  const theta = Math.asin(M * Math.sin(phi));
  const c = Math.max(MIN_COS, Math.cos(phi));
  const dxdLon = (K * Math.cos(theta)) / yDeriv(theta);
  const dydLat = (M * Math.cos(phi) * yDeriv(theta)) / Math.cos(theta);
  return [(km / (KM_PER_DEG_LON * c)) * dxdLon, (km / KM_PER_DEG_LAT) * dydLat];
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

const IDENTITY = new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Camera over the world map. Pixel units are CSS pixels; the map fills the whole viewport. */
export class FlatView implements MapCamera {
  readonly kind = 'flat';
  width = 800;
  height = 600;
  cx = 0;
  cy = 0;
  scale = 4;
  fitScale = 4;
  version = 0;
  private home: { x: number; y: number; span: number } | null = null;
  private atHome = true;

  resize(width: number, height: number): void {
    const wasFit = Math.abs(this.scale - this.fitScale) < 1e-6;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    // The whole bounded map fits in either orientation.
    this.fitScale = Math.min(this.width / MAP_W, this.height / MAP_H);
    if (this.home && this.atHome) {
      this.scale = Math.min(this.width, this.height) / this.home.span;
      this.cx = this.home.x; this.cy = this.home.y;
    } else if (wasFit) this.scale = this.fitScale;
    this.constrain();
    this.version++;
  }

  /**
   * Configure the opening region. Span is world units across the shorter viewport dimension
   * (about 1.16 degrees of latitude or 0.86 degrees of longitude per unit at the equator).
   */
  setHome(lon: number, lat: number, span: number): void {
    const [x, y] = project(lon, lat);
    this.home = { x, y, span };
    this.reset();
  }

  /** Back to the configured opening region, or the world view before it is configured. */
  reset(): void {
    this.atHome = true;
    this.scale = this.home ? Math.min(this.width, this.height) / this.home.span : this.fitScale;
    this.cx = this.home?.x ?? 0;
    this.cy = this.home?.y ?? 0;
    this.constrain();
    this.version++;
  }

  get minScale(): number { return this.fitScale; }
  get maxScale(): number { return this.fitScale * 24; }
  get zoom(): number { return this.scale / this.fitScale; }
  get isAtHome(): boolean { return this.atHome; }

  /** Keeps the viewport inside the map's bounding box; an axis the map does not fill is centred. */
  private constrain(): void {
    this.scale = clamp(this.scale, this.minScale, this.maxScale);
    const maxCx = Math.max(0, MAP_X1 - this.width / this.scale / 2);
    const maxCy = Math.max(0, MAP_Y1 - this.height / this.scale / 2);
    this.cx = clamp(this.cx, -maxCx, maxCx);
    this.cy = clamp(this.cy, -maxCy, maxCy);
  }

  zoomAt(factor: number, px: number, py: number): void {
    this.atHome = false;
    const [wx, wy] = this.pxToWorld(px, py);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    this.cx = wx - (px - this.width / 2) / this.scale;
    this.cy = wy + (py - this.height / 2) / this.scale;
    this.constrain();
    this.version++;
  }

  panPx(dx: number, dy: number): void {
    this.atHome = false;
    this.cx -= dx / this.scale;
    this.cy += dy / this.scale;
    this.constrain();
    this.version++;
  }

  dragPx(x0: number, y0: number, x1: number, y1: number): void { this.panPx(x1 - x0, y1 - y0); }

  centerOn(lon: number, lat: number): void {
    this.atHome = false;
    [this.cx, this.cy] = project(lon, lat);
    this.constrain();
    this.version++;
  }

  /** Fit an entire track (by its projected extent) in the visible area left of the sidebar. */
  fitTrack(points: { lon: number; lat: number }[], rightInset = 0): void {
    this.atHome = false;
    if (!points.length) return;
    let [west, south] = project(points[0].lon, points[0].lat);
    let east = west, north = south;
    for (let i = 1; i < points.length; i++) {
      const [x, y] = project(points[i].lon, points[i].lat);
      west = Math.min(west, x); east = Math.max(east, x);
      south = Math.min(south, y); north = Math.max(north, y);
    }
    const usable = Math.max(160, this.width - rightInset);
    this.scale = Math.min((usable - 100) / Math.max(6, east - west), (this.height - 240) / Math.max(6, north - south));
    this.scale = clamp(this.scale, this.minScale, this.maxScale);
    this.cx = (west + east) / 2 + rightInset / (2 * this.scale);
    this.cy = (south + north) / 2;
    this.constrain(); this.version++;
  }

  worldToPx(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, this.height / 2 - (y - this.cy) * this.scale];
  }

  pxToWorld(px: number, py: number): [number, number] {
    return [(px - this.width / 2) / this.scale + this.cx, (this.height / 2 - py) / this.scale + this.cy];
  }

  /** Screen position of (lon, lat). */
  lonLatToPx(lon: number, lat: number): [number, number] {
    const [x, y] = project(lon, lat);
    return this.worldToPx(x, y);
  }

  /** [x, y, 1]: flat views have no hidden side, so z is always 1 (also outside the outline). */
  projectZ(lon: number, lat: number, out: Float64Array = new Float64Array(3)): Float64Array {
    const [x, y] = project(lon, lat);
    out[0] = (x - this.cx) * this.scale + this.width / 2;
    out[1] = this.height / 2 - (y - this.cy) * this.scale;
    out[2] = 1;
    return out;
  }

  rotation(): Float64Array { return IDENTITY; }

  /** Geographic position under a screen point; longitude is wrapped into [-180, 180). Null outside the map outline. */
  pxToLonLat(px: number, py: number): [number, number] | null {
    const [x, y] = this.pxToWorld(px, py);
    return inOutline(x, y) ? unproject(x, y) : null;
  }

  /** Geographic position at the viewport centre (clamped onto the outline when the centre lies outside it). */
  centerLonLat(): [number, number] {
    return unproject(this.cx, this.cy);
  }

  /** Visible world rectangle [x0, y0, x1, y1] in world units (not longitude/latitude; use unproject). */
  worldRect(): [number, number, number, number] {
    const hw = this.width / this.scale / 2;
    const hh = this.height / this.scale / 2;
    return [this.cx - hw, this.cy - hh, this.cx + hw, this.cy + hh];
  }

  /** Screen-space semi-axes [rx, ry] in px of a ground circle of `km` radius at latitude `lat`. */
  kmRadiiPx(km: number, lat: number): [number, number] {
    const [rx, ry] = kmToWorld(km, lat);
    return [rx * this.scale, ry * this.scale];
  }

  /**
   * Bounding box of the visible world rectangle (corners and edge midpoints), latitudes within ±90 and
   * longitudes unwrapped around LON0. A rectangle reaching the map's left/right edge extends to LON0 ∓ 180.
   */
  visibleBounds(): GeoBounds {
    const [x0, y0, x1, y1] = this.worldRect();
    const xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
    let south = 90, north = -90, lamMin = Infinity, lamMax = -Infinity;
    for (const [x, y] of [[x0, y0], [xm, y0], [x1, y0], [x0, ym], [x1, ym], [x0, y1], [xm, y1], [x1, y1]]) {
      const [lon, lat] = unproject(x, y);
      south = Math.min(south, lat); north = Math.max(north, lat);
      const half = halfWidthAt(y);
      if (x <= -half + 1e-9) lamMin = -180;
      else if (x >= half - 1e-9) lamMax = 180;
      else { const d = lonDelta(LON0, lon); lamMin = Math.min(lamMin, d); lamMax = Math.max(lamMax, d); }
    }
    if (lamMin === Infinity) lamMin = lamMax;
    if (lamMax === -Infinity) lamMax = lamMin;
    if (x0 <= MAP_X0 && x1 >= MAP_X1) { lamMin = -180; lamMax = 180; }
    return { west: LON0 + lamMin, east: LON0 + lamMax, south: Math.max(-90, south), north: Math.min(90, north) };
  }
}

export { FlatView as MapView };
