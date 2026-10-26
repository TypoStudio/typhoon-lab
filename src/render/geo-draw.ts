import type { GeoPoint } from '../types';
import { destination, geoToUnit, type MapCamera } from './camera';
import type { GlobeView } from './globe-view';
import { KM_PER_DEG_LAT, edgeBetween, lonDelta } from './view';

/**
 * Drawing helpers shared by the overlay on both views. Flat views keep today's behaviour exactly
 * (z is always 1, the Equal Earth cut meridian breaks paths); the globe projects through `projectZ`,
 * skips the far side and breaks paths at the horizon.
 */

const TAU = Math.PI * 2;
const MAX_RING = 64;

type Ctx = CanvasRenderingContext2D;
export interface PolylineOptions { closed?: boolean; maxDeg?: number }

const P = new Float64Array(3);
const RING_X = new Float64Array(MAX_RING + 1);
const RING_Y = new Float64Array(MAX_RING + 1);
const RING_Z = new Float64Array(MAX_RING + 1);
/** lon/lat pairs copied from GeoPoint arrays, grown on demand. */
let pairs = new Float64Array(512);

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Opacity for things anchored at depth z: 0 at z <= 0.08, 1 at z >= 0.3 (flat views always give 1). */
export const limbAlpha = (z: number): number => clamp((z - 0.08) / 0.22, 0, 1);

export const isGlobe = (view: MapCamera): view is GlobeView => view.kind === 'globe';

/** Calls `cb` with the pixel position and limb alpha of (lon, lat) when it is visible and within `margin` px of the viewport. */
export function each(view: MapCamera, lon: number, lat: number, margin: number, w: number, h: number, cb: (x: number, y: number, alpha: number) => void): void {
  view.projectZ(lon, lat, P);
  const x = P[0]; const y = P[1]; const z = P[2];
  if (z <= 0 || y < -margin || y > h + margin || x < -margin || x > w + margin) return;
  cb(x, y, limbAlpha(z));
}

// ---- horizon-aware path state (module scratch: the helpers below are not re-entrant) ---------------

let pen = false;
let have = false;
let px = 0;
let py = 0;
let pz = 0;

const penReset = (): void => { pen = false; have = false; };

/** Where the segment (px,py,pz) -> (x,y,z) crosses z = 0, snapped onto the limb circle. */
function horizonPoint(g: GlobeView, x: number, y: number, z: number, out: Float64Array): void {
  const t = pz / (pz - z);
  const cx = g.width / 2 + g.offsetX;
  const cy = g.height / 2;
  const dx = px + t * (x - px) - cx;
  const dy = py + t * (y - py) - cy;
  const len = Math.hypot(dx, dy);
  out[0] = len > 1e-9 ? cx + (dx / len) * g.radius : cx + dx;
  out[1] = len > 1e-9 ? cy + (dy / len) * g.radius : cy + dy;
}

/** Adds the projected point (x, y, z) to the current path, breaking the sub-path where it crosses the horizon. */
function penPoint(g: GlobeView, ctx: Ctx, x: number, y: number, z: number): void {
  if (z > 0) {
    if (!pen) {
      if (have && pz <= 0) { horizonPoint(g, x, y, z, P); ctx.moveTo(P[0], P[1]); ctx.lineTo(x, y); } else ctx.moveTo(x, y);
      pen = true;
    } else ctx.lineTo(x, y);
  } else if (pen) {
    horizonPoint(g, x, y, z, P);
    ctx.lineTo(P[0], P[1]);
    pen = false;
  }
  px = x; py = y; pz = z; have = true;
}

/**
 * Appends a polyline of `n` lon/lat pairs (`ll` = [lon0, lat0, lon1, lat1, …]) to the current path; the caller
 * owns beginPath/stroke. Flat: breaks at the Equal Earth cut meridian. Globe: segments longer than `maxDeg`
 * are densified along lon/lat, and the path breaks at the horizon.
 */
export function geoPolylineLL(view: MapCamera, ctx: Ctx, ll: ArrayLike<number>, n: number, opts: PolylineOptions = {}): void {
  if (n < 1) return;
  const total = opts.closed ? n + 1 : n;
  if (!isGlobe(view)) {
    let prev = 0;
    for (let k = 0; k < total; k++) {
      const lon = ll[2 * (k % n)];
      view.projectZ(lon, ll[2 * (k % n) + 1], P);
      if (k === 0 || edgeBetween(prev, lon)) ctx.moveTo(P[0], P[1]); else ctx.lineTo(P[0], P[1]);
      prev = lon;
    }
    return;
  }
  const maxDeg = opts.maxDeg ?? 2;
  penReset();
  let lon0 = 0; let lat0 = 0;
  for (let k = 0; k < total; k++) {
    const lon = ll[2 * (k % n)]; const lat = ll[2 * (k % n) + 1];
    if (k === 0) {
      view.projectZ(lon, lat, P);
      penPoint(view, ctx, P[0], P[1], P[2]);
    } else {
      const dLon = lonDelta(lon0, lon);
      const dLat = lat - lat0;
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / maxDeg));
      for (let s = 1; s <= steps; s++) {
        view.projectZ(lon0 + (dLon * s) / steps, lat0 + (dLat * s) / steps, P);
        penPoint(view, ctx, P[0], P[1], P[2]);
      }
    }
    lon0 = lon; lat0 = lat;
  }
}

/** `geoPolylineLL` for an array of geographic points. */
export function geoPolyline(view: MapCamera, ctx: Ctx, pts: ArrayLike<GeoPoint>, opts: PolylineOptions = {}): void {
  const n = pts.length;
  if (pairs.length < 2 * n) pairs = new Float64Array(2 * n * 2);
  for (let i = 0; i < n; i++) { pairs[2 * i] = pts[i].lon; pairs[2 * i + 1] = pts[i].lat; }
  geoPolylineLL(view, ctx, pairs, n, opts);
}

/**
 * Appends a ground circle (radius `km`, at least `minPx` on screen) to the current path and returns its
 * screen [minY, maxY]. Flat: the exact ellipse. Globe: a sampled great-circle ring; as a fill, hidden points
 * are pushed to the limb so the visible cap stays closed, as a stroke the ring breaks at the horizon.
 * A ring with no visible point adds nothing.
 */
export function groundCircle(view: MapCamera, ctx: Ctx, lon: number, lat: number, km: number, mode: 'fill' | 'stroke', minPx = 0): [number, number] {
  if (!isGlobe(view)) {
    view.projectZ(lon, lat, P);
    const x = P[0]; const y = P[1];
    const [kx, ky] = view.kmRadiiPx(km, lat);
    const rx = Math.max(kx, minPx); const ry = Math.max(ky, minPx);
    ctx.moveTo(x + rx, y);
    ctx.ellipse(x, y, rx, ry, 0, 0, TAU);
    return [y - ry, y + ry];
  }
  const rpx = Math.max(view.kmRadiiPx(km, lat)[0], minPx);
  const kmEff = Math.max(km, (minPx * KM_PER_DEG_LAT) / view.scale);
  const n = clamp(Math.ceil(rpx / 3), 16, MAX_RING);
  let visible = 0;
  for (let k = 0; k <= n; k++) {
    const [clon, clat] = destination(lon, lat, kmEff, (TAU * (k % n)) / n);
    view.projectZ(clon, clat, P);
    RING_X[k] = P[0]; RING_Y[k] = P[1]; RING_Z[k] = P[2];
    if (P[2] > 0) visible++;
  }
  if (visible === 0) return [view.height, view.height];
  const cx = view.width / 2 + view.offsetX;
  const cy = view.height / 2;
  let minY = Infinity; let maxY = -Infinity;
  if (mode === 'fill') {
    for (let k = 0; k <= n; k++) {
      if (RING_Z[k] <= 0) {
        const dx = RING_X[k] - cx; const dy = RING_Y[k] - cy;
        const len = Math.hypot(dx, dy);
        if (len < 1e-9) continue;
        RING_X[k] = cx + (dx / len) * view.radius; RING_Y[k] = cy + (dy / len) * view.radius;
      }
      if (RING_Y[k] < minY) minY = RING_Y[k];
      if (RING_Y[k] > maxY) maxY = RING_Y[k];
      if (k === 0) ctx.moveTo(RING_X[0], RING_Y[0]); else ctx.lineTo(RING_X[k], RING_Y[k]);
    }
    ctx.closePath();
    return [minY, maxY];
  }
  if (visible === n + 1) {
    for (let k = 0; k <= n; k++) {
      if (RING_Y[k] < minY) minY = RING_Y[k];
      if (RING_Y[k] > maxY) maxY = RING_Y[k];
      if (k === 0) ctx.moveTo(RING_X[0], RING_Y[0]); else ctx.lineTo(RING_X[k], RING_Y[k]);
    }
    ctx.closePath();
    return [minY, maxY];
  }
  penReset();
  for (let k = 0; k <= n; k++) {
    penPoint(view, ctx, RING_X[k], RING_Y[k], RING_Z[k]);
    if (RING_Z[k] > 0) {
      if (RING_Y[k] < minY) minY = RING_Y[k];
      if (RING_Y[k] > maxY) maxY = RING_Y[k];
    }
  }
  return [minY, maxY];
}

const unitCaches = new WeakMap<Float32Array, Float32Array>();

/** Unit vectors [ax, ay, az, bx, by, bz] per lon/lat segment [lon0, lat0, lon1, lat1]; built once per source array. */
export function unitCache(lonlatSegments: Float32Array): Float32Array {
  let out = unitCaches.get(lonlatSegments);
  if (out) return out;
  const n = lonlatSegments.length / 4;
  out = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    geoToUnit(lonlatSegments[4 * i], lonlatSegments[4 * i + 1], out, 6 * i);
    geoToUnit(lonlatSegments[4 * i + 2], lonlatSegments[4 * i + 3], out, 6 * i + 3);
  }
  unitCaches.set(lonlatSegments, out);
  return out;
}

/** Appends cached unit-vector segments (see `unitCache`) to the current path, skipping any with an end on the far side or off screen. */
export function segmentsUnit(view: GlobeView, ctx: Ctx, cache: Float32Array): void {
  const m = view.rotation();
  const m0 = m[0], m1 = m[1], m2 = m[2], m3 = m[3], m4 = m[4], m5 = m[5], m6 = m[6], m7 = m[7], m8 = m[8];
  const R = view.radius;
  const cx = view.width / 2 + view.offsetX;
  const cy = view.height / 2;
  const w = view.width; const h = view.height;
  for (let i = 0; i < cache.length; i += 6) {
    const ax = cache[i], ay = cache[i + 1], az = cache[i + 2];
    if (m6 * ax + m7 * ay + m8 * az <= 0) continue;
    const bx = cache[i + 3], by = cache[i + 4], bz = cache[i + 5];
    if (m6 * bx + m7 * by + m8 * bz <= 0) continue;
    const x0 = cx + R * (m0 * ax + m1 * ay + m2 * az); const y0 = cy - R * (m3 * ax + m4 * ay + m5 * az);
    const x1 = cx + R * (m0 * bx + m1 * by + m2 * bz); const y1 = cy - R * (m3 * bx + m4 * by + m5 * bz);
    if ((x0 < -4 && x1 < -4) || (x0 > w + 4 && x1 > w + 4) || (y0 < -4 && y1 < -4) || (y0 > h + 4 && y1 > h + 4)) continue;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
  }
}
