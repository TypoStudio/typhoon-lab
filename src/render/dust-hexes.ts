import { hazardInfluence } from '../simulation/weather-hazards';
import type { GameState } from '../types';
import type { MapCamera } from './camera';
import type { GlobeView } from './globe-view';
import { sampleGrid, type FieldData } from './fields';
import { MAP_Y1, inOutline, unproject, type FlatView } from './view';

/**
 * Fine dust and yellow dust as a hexagon grid (pointy-top), drawn as vectors on the overlay so the edges stay crisp at any zoom. The hexes are regular on screen: in the flat view the lattice lives in the
 * Equal Earth plane (an affine image of the screen, so a hex is a regular hexagon at every zoom and latitude, and the area it covers is equal everywhere), so panning only re-projects it; in the globe view it is a regular lattice in the plane tangent to the sphere at an
 * anchor (the view centre at build time), lifted onto the sphere orthographically. Centres and corners are stored as unit vectors on the Earth, so each frame only rotates them with the camera: during a rotate or pan the hexes travel rigidly with the ground and keep their colour.
 * The lattice is one continuous map of the plane, so hexes never overlap or leave holes. The globe lattice is rebuilt only on a new state/field, a zoom step, or when the view has moved far enough from the anchor (see dustHexesFor).
 * The size follows the zoom (about HEX_TARGET_PX across, in steps of √2 from HEX_WIDTH), only the visible area plus a margin is built, and a build is reused until the zoom crosses a step or the view leaves the built area.
 * Fine dust: tight tiling in the stepped FINE_RAMP, a constant 1 px gap and no outline. Yellow dust: smaller, spaced tiles with a dashed edge, sand-yellow.
 */
export interface DustHex {
  /** Geographic centre (what the field is sampled at). */
  lon: number; lat: number; kind: 'finedust' | 'dust'; level: number;
  /** Flat view: centre in world units. Globe view: centre in the anchor's tangent plane, in unit-sphere units (east, north). */
  x: number; y: number;
}
/**
 * Hexagons of one build. `width` is the hex width in world units (flat) or in degrees of latitude at the anchor (globe, px = width * scale); `area` is what was built, [x0, y0, x1, y1] in world units (flat; unused in the globe view).
 * Globe only: `anchor` is the tangent point [lon, lat], `cap` the angular radius (deg) around it that was built, `thr` how far (deg) the view centre may move before a rebuild, and `geo` holds GLOBE_STRIDE numbers per hex: the unit vector of the centre, then of its six corners.
 */
export interface DustHexes {
  hexes: DustHex[]; width: number; space: 'world' | 'globe'; area: readonly [number, number, number, number];
  anchor?: readonly [number, number]; cap?: number; thr?: number; geo?: Float64Array;
}
export const GLOBE_STRIDE = 21;
/** The built cap never exceeds this angle from the anchor: beyond it the tangent-plane lift is too stretched (and the limb is skipped). */
export const GLOBE_CAP_MAX = 82;
/** The view centre may drift this far (deg, at most; less when zoomed in) from the anchor before the globe lattice is rebuilt. */
export const GLOBE_REBUILD_MAX = 25;
/** Without further camera changes for this long (ms) a pending globe rebuild is done; during a gesture the old lattice keeps moving with the ground. */
export const DUST_SETTLE_MS = 120
/**
 * Fine-dust ramp, one step per band edge in FINE_EDGES: cream -> peach -> orange -> red -> crimson -> purple -> indigo. Lightness falls
 * steadily and the hue moves from warm to purple, so neighbouring steps differ in both; the hue stays away from yellow dust's sand-yellow.
 * Alpha stays low (0.28..0.6) so the map shows through; the steps are told apart by colour, not opacity.
 */
export const FINE_RAMP = ['rgba(255, 238, 205, 0.28)', 'rgba(255, 168, 110, 0.34)', 'rgba(245, 100, 40, 0.4)', 'rgba(214, 36, 48, 0.46)', 'rgba(170, 20, 104, 0.52)', 'rgba(112, 22, 140, 0.57)', 'rgba(48, 12, 118, 0.6)'] as const;
export const HEX_YELLOW_RGB = '230, 196, 84';
/** PM2.5 (µg/m³) below which no hexagon is drawn: the "good" air band. */
export const FINE_DUST_HEX_MIN = 12;
/** Yellow-dust load (0..1: the event's footprint times its life cycle) below which no hexagon is drawn. */
export const YELLOW_DUST_HEX_MIN = 0.1;
export const DUST_LEVELS = 8;
/** Finest hexagon width (an eighth of a 2° weather cell; the field is sampled bilinearly at each centre). Zooming out grows it in steps of √2 up to HEX_WIDTH_MAX. */
export const HEX_WIDTH = 0.25;
export const HEX_WIDTH_MAX = 4;
/** On-screen width the zoom aims for, in px. */
export const HEX_TARGET_PX = 12;
export const MAX_HEXES = 9000;
/** Lower edge of each fine-dust step (µg/m³); 12, 35.5, 55.5, 150.5 and 250.5 are the AQI band edges, 20 and 80 split the two widest bands. */
export const FINE_EDGES = [12, 20, 35.5, 55.5, 80, 150.5, 250.5] as const;

/** Level 1..FINE_RAMP.length from the concentration (0 below the hidden good-air band). */
export function fineDustLevel(pm25: number): number {
  if (pm25 < FINE_DUST_HEX_MIN) return 0;
  let level = 1;
  for (const edge of FINE_EDGES) if (pm25 >= edge && edge > FINE_DUST_HEX_MIN) level++;
  return level;
}
export const yellowDustLevel = (load: number): number => load < YELLOW_DUST_HEX_MIN ? 0 : Math.min(DUST_LEVELS, 1 + Math.floor(load * (DUST_LEVELS - 0.01)));
/** Opacity of a yellow-dust level: a sequential ramp 0.25..0.6. */
export const dustHexAlpha = (level: number): number => 0.25 + 0.05 * (level - 1);

export function yellowDustLoad(state: Pick<GameState, 'weatherHazards'>, lon: number, lat: number): number {
  let load = 0;
  for (const hazard of state.weatherHazards ?? []) if (hazard.kind === 'dust') load = Math.max(load, hazardInfluence(hazard, { lon, lat }) * Math.min(1, hazard.ageHours / 3));
  return load;
}

/** Hexagon width for a zoom: HEX_TARGET_PX on screen, snapped to HEX_WIDTH * √2^k so a build is reused across a whole step. `pxPerUnit` is px per world unit (flat) or per degree of latitude (globe). */
export function dustHexWidth(pxPerUnit: number): number {
  const k = Math.round(Math.log(HEX_TARGET_PX / Math.max(1e-6, pxPerUnit) / HEX_WIDTH) / Math.log(Math.SQRT2));
  return Math.min(HEX_WIDTH_MAX, HEX_WIDTH * Math.SQRT2 ** Math.max(0, k));
}

/** The area a build must cover now, [x0, y0, x1, y1] (flat world units, or globe [west, south, east, north]), without margin. */
function viewArea(view: MapCamera): [number, number, number, number] {
  return view.kind === 'flat' ? (view as FlatView).worldRect() : [0, 0, view.width, view.height];
}

interface Sampler { fine: boolean; hazards: { lat: number; lon: number; reach: number; lonReach: number }[]; rowLo: number; rowHi: number; used: Uint8Array | null }

function sampler(state: GameState, field: FieldData | null, finedust: boolean): Sampler {
  const rows = state.fineDustRows;
  const fine = !!(finedust && field && rows && field.maxPm25 >= FINE_DUST_HEX_MIN);
  let used: Uint8Array | null = null;
  if (fine && field && rows) {
    used = new Uint8Array(field.cols);
    for (let j = rows[0]; j <= rows[1]; j++) for (let i = 0; i < field.cols; i++) {
      if (field.pm25[j * field.cols + i] > 0) { used[i] = 1; used[(i + 1) % field.cols] = 1; used[(i + field.cols - 1) % field.cols] = 1; }
    }
  }
  const hazards = (state.weatherHazards ?? []).filter(h => h.kind === 'dust').map(h => {
    const reach = h.radiusKm / 110.57 + 1;
    return { lat: h.lat, lon: h.lon, reach, lonReach: reach / Math.max(0.05, Math.cos(Math.min(89, Math.abs(h.lat) + reach) * Math.PI / 180)) };
  });
  return { fine, hazards, rowLo: rows ? -90 + 2 * rows[0] - 3 : 0, rowHi: rows ? -90 + 2 * rows[1] + 5 : 0, used };
}

/** Whether any dust can lie on this latitude (a cheap row filter). */
const rowHasDust = (sm: Sampler, lat: number): boolean => (sm.fine && lat >= sm.rowLo && lat <= sm.rowHi) || sm.hazards.some(h => Math.abs(lat - h.lat) <= h.reach);

function visit(out: DustHex[], sm: Sampler, state: GameState, field: FieldData | null, lon: number, lat: number, x: number, y: number): void {
  if (sm.fine && field && lat >= sm.rowLo && lat <= sm.rowHi && sm.used![Math.min(field.cols - 1, Math.floor((lon + 180) / 2))]) {
    const level = fineDustLevel(sampleGrid(field, field.pm25, lon, lat));
    if (level) out.push({ lon, lat, kind: 'finedust', level, x, y });
  }
  for (const h of sm.hazards) {
    const dLon = Math.abs(((lon - h.lon + 540) % 360) - 180);
    if (Math.abs(lat - h.lat) > h.reach || dLon > h.lonReach) continue;
    const level = yellowDustLevel(yellowDustLoad(state, lon, lat));
    if (level) out.push({ lon, lat, kind: 'dust', level, x, y });
    break; // yellowDustLoad already covers every hazard
  }
}

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
interface GlobeFrame { a: Float64Array; e: Float64Array; n: Float64Array }
/** Anchor, east and north unit vectors at a geographic point (same axes as geoToUnit). */
function globeFrame(lon: number, lat: number): GlobeFrame {
  const l = lon * D2R, p = lat * D2R, sl = Math.sin(l), cl = Math.cos(l), sp = Math.sin(p), cp = Math.cos(p);
  return { a: Float64Array.of(cp * sl, sp, cp * cl), e: Float64Array.of(cl, 0, -sl), n: Float64Array.of(-sp * sl, cp, -sp * cl) };
}
/** Tangent-plane point (u, v) on the sphere: a·√(1−ρ²) + e·u + n·v, ρ clamped just inside the limb. */
function planeToUnit(f: GlobeFrame, u: number, v: number, out: Float64Array, o: number): void {
  let r2 = u * u + v * v;
  if (r2 > 0.9998) { const k = Math.sqrt(0.9998 / r2); u *= k; v *= k; r2 = 0.9998; }
  const c = Math.sqrt(1 - r2);
  for (let k = 0; k < 3; k++) out[o + k] = f.a[k] * c + f.e[k] * u + f.n[k] * v;
}
/** Angular radius (deg) of the cap around the disc centre that can reach the viewport. */
function viewCap(g: GlobeView): number {
  const cx = g.width / 2 + g.offsetX, cy = g.height / 2, d = Math.hypot(Math.max(cx, g.width - cx), Math.max(cy, g.height - cy));
  return d >= g.radius ? 90 : Math.asin(d / g.radius) * R2D;
}
/** Angle (deg) between two geographic points. */
function arcDeg(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const a = lat1 * D2R, b = lat2 * D2R, c = Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lon1 - lon2) * D2R);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}
const globeThreshold = (theta: number): number => Math.max(8, Math.min(GLOBE_REBUILD_MAX, theta));

function build(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera, width: number, area: readonly [number, number, number, number], anchor?: readonly [number, number], cap?: number): DustHex[] {
  const out: DustHex[] = [];
  const sm = sampler(state, field, finedust);
  if (!sm.fine && !sm.hazards.length) return out;
  const r = width / Math.sqrt(3), rowH = 1.5 * r;
  if (view.kind === 'flat') {
    for (let j = Math.floor(area[1] / rowH); j <= Math.ceil(area[3] / rowH); j++) {
      const y = rowH * j;
      if (Math.abs(y) > MAP_Y1 || !rowHasDust(sm, unproject(0, y)[1])) continue;
      const shift = j & 1 ? width / 2 : 0;
      for (let i = Math.floor((area[0] - shift) / width); i <= Math.ceil((area[2] - shift) / width); i++) {
        const x = shift + width * i;
        if (!inOutline(x, y)) continue;
        const [lon, lat] = unproject(x, y);
        visit(out, sm, state, field, lon, lat, x, y);
      }
    }
    return out;
  }
  // Globe: a regular pointy-top lattice in the plane tangent at the anchor, lifted onto the sphere (orthographic inverse), out to angular radius `cap`.
  const f = globeFrame(anchor![0], anchor![1]), w = width * D2R, pr = w / Math.sqrt(3), gRow = 1.5 * pr, rho = Math.sin(cap! * D2R), p = new Float64Array(3);
  for (let j = Math.floor(-rho / gRow); j <= Math.ceil(rho / gRow); j++) {
    const v = gRow * j;
    if (Math.abs(v) > rho) continue;
    const shift = j & 1 ? w / 2 : 0, half = Math.sqrt(rho * rho - v * v);
    for (let i = Math.ceil((-half - shift) / w); i <= Math.floor((half - shift) / w); i++) {
      const u = shift + w * i;
      planeToUnit(f, u, v, p, 0);
      const lat = Math.asin(p[1]) * R2D;
      if (!rowHasDust(sm, lat)) continue;
      visit(out, sm, state, field, Math.atan2(p[0], p[2]) * R2D, lat, u, v);
    }
  }
  return out;
}

/** Hexagons for a width, coarsened by √2 steps while a build would pass MAX_HEXES. The globe lattice is anchored at the current view centre and built out to the visible cap plus a margin. */
export function buildDustHexes(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera, width = dustHexWidth(view.scale), margin = 0.3): DustHexes {
  const flat = view.kind === 'flat', v = viewArea(view);
  const mx = flat ? (v[2] - v[0]) * margin : 0, my = flat ? (v[3] - v[1]) * margin : 0;
  const area = [v[0] - mx, v[1] - my, v[2] + mx, v[3] + my] as const;
  let anchor: [number, number] | undefined, cap: number | undefined, thr: number | undefined;
  if (!flat) {
    const g = view as GlobeView, theta = viewCap(g);
    anchor = g.centerLonLat(); thr = globeThreshold(theta); cap = Math.min(GLOBE_CAP_MAX, theta + thr);
  }
  let w = width, hexes = build(state, field, finedust, view, w, area, anchor, cap);
  while (hexes.length > MAX_HEXES && w < HEX_WIDTH_MAX * 2) { w *= Math.SQRT2; hexes = build(state, field, finedust, view, w, area, anchor, cap); }
  if (flat) return { hexes, width: w, space: 'world', area };
  const f = globeFrame(anchor![0], anchor![1]), geo = new Float64Array(hexes.length * GLOBE_STRIDE), r = w * D2R / Math.sqrt(3);
  hexes.forEach((h, i) => {
    const o = i * GLOBE_STRIDE;
    planeToUnit(f, h.x, h.y, geo, o);
    for (let c = 0; c < 6; c++) planeToUnit(f, h.x + r * Math.cos(Math.PI / 6 + c * Math.PI / 3), h.y + r * Math.sin(Math.PI / 6 + c * Math.PI / 3), geo, o + 3 + 3 * c);
  });
  return { hexes, width: w, space: 'globe', area, anchor, cap, thr, geo };
}

let screen = new Float64Array(0);
/**
 * Screen position of every globe hexagon with the current camera: 14 numbers per hex (centre x, y, then six corner x, y); cx is NaN for a hex that is not wholly on the visible side.
 * Only a rotation per point, no trig: this is the whole per-frame cost, and it is why hexes move with the ground.
 */
export function projectGlobeHexes(g: GlobeView, built: DustHexes): Float64Array {
  const n = built.hexes.length, geo = built.geo!, m = g.rotation(), R = g.radius, ox = g.width / 2 + g.offsetX, oy = g.height / 2;
  if (screen.length < n * 14) screen = new Float64Array(n * 14);
  for (let i = 0; i < n; i++) {
    const o = i * 14, q = i * GLOBE_STRIDE;
    let ok = true;
    for (let k = 0; k < 7 && ok; k++) {
      const x = geo[q + 3 * k], y = geo[q + 3 * k + 1], z = geo[q + 3 * k + 2];
      if (m[6] * x + m[7] * y + m[8] * z <= 0.02) { ok = false; break; } // limb: skip the whole hexagon
      screen[o + 2 * k] = ox + R * (m[0] * x + m[1] * y + m[2] * z);
      screen[o + 2 * k + 1] = oy - R * (m[3] * x + m[4] * y + m[5] * z);
    }
    if (!ok) screen[o] = NaN;
  }
  return screen;
}

const EMPTY: DustHexes = { hexes: [], width: HEX_WIDTH, space: 'world', area: [0, 0, 0, 0] };
let cached: { state: GameState; field: FieldData | null; finedust: boolean; kind: string; want: number; built: DustHexes } | null = null;
let seenVersion = -1, changedAt = 0;
/**
 * Hexagons for the drawn state and view. Flat: rebuilt only when the state, its field, the fine-dust switch or the zoom step changed, or the view left the built area (panning just re-projects).
 * Globe: also rebuilt when the view centre is more than `thr` (8..25 deg, by zoom) from the anchor or the visible cap is no longer covered; that rebuild waits until the camera has been still for DUST_SETTLE_MS
 * (unless the centre is over GLOBE_FAR deg from the anchor), so a gesture never makes the lattice jump.
 */
export function dustHexesFor(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera, now = performance.now()): DustHexes {
  if (!(state.fineDustRows || state.weatherHazards?.some(hazard => hazard.kind === 'dust'))) return EMPTY;
  const want = dustHexWidth(view.scale), globe = view.kind === 'globe';
  if (view.version !== seenVersion) { seenVersion = view.version; changedAt = now; }
  if (cached && cached.state === state && cached.field === field && cached.finedust === finedust && cached.kind === view.kind && cached.want === want) {
    const b = cached.built;
    if (!globe) {
      const v = viewArea(view), a = b.area;
      if (v[0] >= a[0] && v[1] >= a[1] && v[2] <= a[2] && v[3] <= a[3]) return b;
    } else {
      const g = view as GlobeView, [lon, lat] = g.centerLonLat(), dist = arcDeg(lon, lat, b.anchor![0], b.anchor![1]);
      const stale = dist > b.thr! || Math.min(GLOBE_CAP_MAX, dist + viewCap(g)) > b.cap! + 1e-9;
      if (!stale || (now - changedAt < DUST_SETTLE_MS && dist < GLOBE_FAR)) return b;
    }
  }
  const built = buildDustHexes(state, field, finedust, view, want);
  cached = { state, field, finedust, kind: view.kind, want, built };
  return built;
}
const GLOBE_FAR = 50;

/** Yellow-dust tiles are drawn smaller than their cell, so the gaps between them tell them from the solid fine-dust tiling even when they are tiny. */
const YELLOW_SHRINK = 0.82;

export function drawDustHexes(ctx: CanvasRenderingContext2D, view: MapCamera, built: DustHexes): void {
  const { hexes, width, space } = built;
  if (!hexes.length) return;
  const flat = space === 'world', f = view as FlatView;
  const proj = flat ? null : projectGlobeHexes(view as GlobeView, built);
  const r = width / Math.sqrt(3);
  const corners = Array.from({ length: 6 }, (_, k) => [r * Math.cos(Math.PI / 6 + k * Math.PI / 3), r * Math.sin(Math.PI / 6 + k * Math.PI / 3)] as const);
  const hexPx = width * view.scale;
  // Fine dust keeps a 1 px gap whatever the zoom; yellow dust 0.82 of the cell, but never a gap under 2 px, so it stays looser than the fine-dust grid.
  const fineShrink = Math.max(0.5, 1 - 1 / hexPx), yellowShrink = Math.max(0.4, Math.min(YELLOW_SHRINK, 1 - 2 / hexPx));
  ctx.save();
  ctx.lineJoin = 'miter';
  for (const kind of ['finedust', 'dust'] as const) {
    const shrink = kind === 'dust' ? yellowShrink : fineShrink;
    for (let level = 1; level <= (kind === 'dust' ? DUST_LEVELS : FINE_RAMP.length); level++) {
      ctx.beginPath();
      let any = false;
      for (let hi = 0; hi < hexes.length; hi++) {
        const hex = hexes[hi];
        if (hex.kind !== kind || hex.level !== level) continue;
        if (flat) {
          // The lattice is in world units, so a hexagon is a regular hexagon on screen: scale and shift only.
          const cx = (hex.x - f.cx) * f.scale + f.width / 2, cy = f.height / 2 - (hex.y - f.cy) * f.scale;
          if (cx < -20 || cx > f.width + 20 || cy < -20 || cy > f.height + 20) continue;
          const k = shrink * f.scale;
          ctx.moveTo(cx + corners[0][0] * k, cy - corners[0][1] * k);
          for (let c = 1; c < 6; c++) ctx.lineTo(cx + corners[c][0] * k, cy - corners[c][1] * k);
          ctx.closePath();
          any = true;
          continue;
        }
        // Globe: centre and corners were rotated with the camera; shrink each corner towards the centre on screen for the gap.
        const o = hi * 14, px = proj![o];
        if (px !== px) continue; // limb
        const py = proj![o + 1];
        if (px < -40 || px > view.width + 40 || py < -40 || py > view.height + 40) continue;
        ctx.moveTo(px + (proj![o + 2] - px) * shrink, py + (proj![o + 3] - py) * shrink);
        for (let c = 1; c < 6; c++) ctx.lineTo(px + (proj![o + 2 + 2 * c] - px) * shrink, py + (proj![o + 3 + 2 * c] - py) * shrink);
        ctx.closePath();
        any = true;
      }
      if (!any) continue;
      if (kind === 'finedust') { ctx.fillStyle = FINE_RAMP[level - 1]; ctx.fill(); continue; }
      ctx.fillStyle = `rgba(${HEX_YELLOW_RGB}, ${dustHexAlpha(level)})`;
      ctx.fill();
      if (hexPx >= 7) { // edges only where a tile is big enough to carry one
        ctx.lineWidth = 0.8;
        ctx.strokeStyle = `rgba(${HEX_YELLOW_RGB}, 0.9)`;
        ctx.setLineDash([2, 2]);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}
