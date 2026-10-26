import { geoToUnit, type GeoBounds, type MapCamera } from './camera';
import { KM_PER_DEG_LAT, LON0, wrapLon } from './view';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MAX_LAT = 80;
const MIN_ZOOM = 0.6;
const MAX_ZOOM = 20;
/** Smallest extent (unit-disc coordinates) fitTrack frames: sin(3°). */
const MIN_EXTENT = Math.sin(3 * D2R);

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/**
 * Orthographic camera over the unit globe. The disc centre sits at (width/2 + offsetX, height/2) with
 * radius R px; `scale` (px per degree of latitude at the centre) is the primary state, R = scale·180/π.
 * Camera space is X right, Y up, Z towards the viewer; a point is visible iff Z > 0.
 */
export class GlobeView implements MapCamera {
  readonly kind = 'globe';
  width = 800;
  height = 600;
  lon0 = LON0;
  lat0 = 0;
  /** Horizontal shift of the disc centre from the viewport centre, px. */
  offsetX = 0;
  scale: number;
  /** Disc radius R in px (= scale·180/π). */
  radius: number;
  version = 0;
  private home: { lon: number; lat: number; span: number } | null = null;
  private atHome = true;
  /** Row-major rotation, rows r0 r1 r2: M = Rx(φ0)·Ry(−λ0). */
  private readonly m = new Float64Array(9);
  private readonly tmp = new Float64Array(3);

  constructor() {
    this.scale = this.fitScale;
    this.radius = this.scale * R2D;
    this.rebuild();
  }

  get fitRadius(): number { return 0.45 * Math.min(this.width, this.height); }
  get fitScale(): number { return this.fitRadius * D2R; }
  get minScale(): number { return this.fitScale * MIN_ZOOM; }
  get maxScale(): number { return this.fitScale * MAX_ZOOM; }
  get zoom(): number { return this.scale / this.fitScale; }
  get isAtHome(): boolean { return this.atHome; }

  private rebuild(): void {
    this.radius = this.scale * R2D;
    const l = this.lon0 * D2R, p = this.lat0 * D2R;
    const sl = Math.sin(l), cl = Math.cos(l), sp = Math.sin(p), cp = Math.cos(p);
    const m = this.m;
    m[0] = cl; m[1] = 0; m[2] = -sl;
    m[3] = -sp * sl; m[4] = cp; m[5] = -sp * cl;
    m[6] = cp * sl; m[7] = sp; m[8] = cp * cl;
  }

  /** Clamp, recompute the rotation and bump the version. */
  private touch(): void {
    this.scale = clamp(this.scale, this.minScale, this.maxScale);
    this.lat0 = clamp(this.lat0, -MAX_LAT, MAX_LAT);
    this.rebuild();
    this.version++;
  }

  resize(width: number, height: number): void {
    const wasFit = Math.abs(this.scale - this.fitScale) < 1e-6;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    if (this.home && this.atHome) {
      this.scale = Math.min(this.width, this.height) / this.home.span;
      this.lon0 = this.home.lon; this.lat0 = this.home.lat; this.offsetX = 0;
    } else if (wasFit) this.scale = this.fitScale;
    this.touch();
  }

  /** Opening region: `span` degrees across the shorter viewport dimension, so scale = min(W, H) / span as in the flat view. */
  setHome(lon: number, lat: number, span: number): void {
    this.home = { lon: wrapLon(lon), lat, span };
    this.reset();
  }

  reset(): void {
    this.atHome = true;
    this.scale = this.home ? Math.min(this.width, this.height) / this.home.span : this.fitScale;
    this.lon0 = this.home?.lon ?? LON0;
    this.lat0 = this.home?.lat ?? 0;
    this.offsetX = 0;
    this.touch();
  }

  centerOn(lon: number, lat: number): void {
    this.atHome = false;
    this.lon0 = wrapLon(lon); this.lat0 = lat; this.offsetX = 0;
    this.touch();
  }

  /** Geographic position at the disc centre. */
  centerLonLat(): [number, number] { return [this.lon0, this.lat0]; }

  rotation(): Float64Array { return this.m; }

  /** Camera-space [X, Y, Z] of a unit vector, written to out[o..o+2]; px = W/2 + offsetX + R·X, py = H/2 − R·Y. No trig. */
  projectUnit(ux: number, uy: number, uz: number, out: Float64Array, o = 0): Float64Array {
    const m = this.m;
    out[o] = this.width / 2 + this.offsetX + this.radius * (m[0] * ux + m[1] * uy + m[2] * uz);
    out[o + 1] = this.height / 2 - this.radius * (m[3] * ux + m[4] * uy + m[5] * uz);
    out[o + 2] = m[6] * ux + m[7] * uy + m[8] * uz;
    return out;
  }

  projectZ(lon: number, lat: number, out: Float64Array = new Float64Array(3)): Float64Array {
    const u = geoToUnit(lon, lat, this.tmp) as Float64Array;
    return this.projectUnit(u[0], u[1], u[2], out);
  }

  lonLatToPx(lon: number, lat: number): [number, number] | null {
    const p = this.projectZ(lon, lat);
    return p[2] > 0 ? [p[0], p[1]] : null;
  }

  /** Geo position of a point on the unit disc at depth Z (Mᵀ applied). */
  private unitToGeo(X: number, Y: number, Z: number): [number, number] {
    const m = this.m;
    const ux = m[0] * X + m[3] * Y + m[6] * Z;
    const uy = m[1] * X + m[4] * Y + m[7] * Z;
    const uz = m[2] * X + m[5] * Y + m[8] * Z;
    return [wrapLon(Math.atan2(ux, uz) * R2D), Math.asin(clamp(uy, -1, 1)) * R2D];
  }

  pxToLonLat(px: number, py: number): [number, number] | null {
    const X = (px - this.width / 2 - this.offsetX) / this.radius;
    const Y = (this.height / 2 - py) / this.radius;
    const r2 = X * X + Y * Y;
    if (r2 > 1) return null;
    return this.unitToGeo(X, Y, Math.sqrt(1 - r2));
  }

  /** Unit-disc coordinates of a screen point. */
  private unitXY(px: number, py: number): [number, number] {
    return [(px - this.width / 2 - this.offsetX) / this.radius, (this.height / 2 - py) / this.radius];
  }

  /** Rotate so that geo point (lg, pg) lies at unit-disc position (X, Y). Does not touch(). */
  private solveGrab(lg: number, pg: number, X: number, Y: number): void {
    const r2 = X * X + Y * Y;
    if (r2 > 0.999 * 0.999) { const k = 0.999 / Math.sqrt(r2); X *= k; Y *= k; }
    const Z = Math.sqrt(Math.max(0, 1 - X * X - Y * Y));
    const phi = pg * D2R;
    const cph = Math.cos(phi);
    const delta = cph < 1e-9 ? 0 : Math.asin(clamp(X / cph, -1, 1));
    const A = Math.sin(phi);
    const B = cph * Math.cos(delta);
    this.lon0 = wrapLon(lg - delta * R2D);
    this.lat0 = clamp(Math.atan2(A * Z - B * Y, A * Y + B * Z) * R2D, -MAX_LAT, MAX_LAT);
  }

  dragPx(x0: number, y0: number, x1: number, y1: number): void {
    this.atHome = false;
    const g = this.pxToLonLat(x0, y0);
    if (g) {
      const [X, Y] = this.unitXY(x1, y1);
      this.solveGrab(g[0], g[1], X, Y);
    } else {
      this.lon0 = wrapLon(this.lon0 - ((x1 - x0) / this.radius) * R2D);
      this.lat0 += ((y1 - y0) / this.radius) * R2D;
    }
    this.touch();
  }

  panPx(dx: number, dy: number): void {
    const cx = this.width / 2 + this.offsetX, cy = this.height / 2;
    this.dragPx(cx, cy, cx + dx, cy + dy);
  }

  zoomAt(factor: number, px: number, py: number): void {
    this.atHome = false;
    const g = this.pxToLonLat(px, py);
    this.scale = clamp(this.scale * factor, this.minScale, this.maxScale);
    this.radius = this.scale * R2D;
    if (g) {
      const [X, Y] = this.unitXY(px, py);
      this.solveGrab(g[0], g[1], X, Y);
    }
    this.touch();
  }

  /** Unit-disc extents (and whether any point is hidden) of unit vectors packed xyz in `u`. */
  private extents(u: Float64Array, n: number): { minX: number; maxX: number; minY: number; maxY: number; hidden: boolean } {
    const m = this.m;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, hidden = false;
    for (let i = 0; i < n; i++) {
      const ux = u[3 * i], uy = u[3 * i + 1], uz = u[3 * i + 2];
      const X = m[0] * ux + m[1] * uy + m[2] * uz;
      const Y = m[3] * ux + m[4] * uy + m[5] * uz;
      if (m[6] * ux + m[7] * uy + m[8] * uz <= 0) hidden = true;
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
    }
    return { minX, maxX, minY, maxY, hidden };
  }

  /** Fit a whole track in the area left of the sidebar: centred on the track, disc shifted left by rightInset/2. */
  fitTrack(points: { lon: number; lat: number }[], rightInset = 0): void {
    this.atHome = false;
    const n = points.length;
    if (!n) return;
    const u = new Float64Array(3 * n);
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      geoToUnit(points[i].lon, points[i].lat, u, 3 * i);
      sx += u[3 * i]; sy += u[3 * i + 1]; sz += u[3 * i + 2];
    }
    const len = Math.hypot(sx, sy, sz);
    if (len < 1e-6) { this.lon0 = wrapLon(points[0].lon); this.lat0 = points[0].lat; }
    else { this.lon0 = wrapLon(Math.atan2(sx, sz) * R2D); this.lat0 = Math.asin(clamp(sy / len, -1, 1)) * R2D; }
    this.lat0 = clamp(this.lat0, -MAX_LAT, MAX_LAT);
    this.rebuild();
    let e = this.extents(u, n);
    // The mean is not the middle of the projected box; re-centre on the box midpoint until it settles.
    for (let it = 0; it < 12; it++) {
      let mx = (e.minX + e.maxX) / 2, my = (e.minY + e.maxY) / 2;
      if (Math.abs(mx) + Math.abs(my) < 1e-9) break;
      const r2 = mx * mx + my * my;
      if (r2 > 0.998) { const k = 0.999 / Math.sqrt(r2); mx *= k; my *= k; }
      const [lon, lat] = this.unitToGeo(mx, my, Math.sqrt(Math.max(0, 1 - mx * mx - my * my)));
      this.lon0 = lon; this.lat0 = clamp(lat, -MAX_LAT, MAX_LAT);
      this.rebuild();
      e = this.extents(u, n);
    }
    const usable = Math.max(160, this.width - rightInset);
    const radius = Math.min(
      (usable - 100) / Math.max(2 * MIN_EXTENT, e.maxX - e.minX),
      (this.height - 240) / Math.max(2 * MIN_EXTENT, e.maxY - e.minY),
    );
    this.scale = e.hidden ? this.fitScale : radius * D2R;
    this.offsetX = -rightInset / 2;
    this.touch();
  }

  kmRadiiPx(km: number, _lat: number): [number, number] {
    const r = (km / KM_PER_DEG_LAT) * this.scale;
    return [r, r];
  }

  /** Bounding box of the geographic cap that can reach the viewport (conservative). */
  visibleBounds(): GeoBounds {
    const cx = this.width / 2 + this.offsetX, cy = this.height / 2;
    const d = Math.hypot(Math.max(cx, this.width - cx), Math.max(cy, this.height - cy));
    const theta = d >= this.radius ? Math.PI / 2 : Math.asin(d / this.radius);
    const phi0 = this.lat0 * D2R;
    const south = Math.max(-90, (phi0 - theta) * R2D);
    const north = Math.min(90, (phi0 + theta) * R2D);
    if (phi0 + theta >= Math.PI / 2 || phi0 - theta <= -Math.PI / 2) {
      return { west: this.lon0 - 180, east: this.lon0 + 180, south, north };
    }
    const dLam = Math.asin(clamp(Math.sin(theta) / Math.cos(phi0), -1, 1)) * R2D;
    return { west: this.lon0 - dLam, east: this.lon0 + dLam, south, north };
  }
}
