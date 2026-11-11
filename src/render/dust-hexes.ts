import { hazardInfluence } from '../simulation/weather-hazards';
import type { GameState } from '../types';
import type { MapCamera } from './camera';
import type { GlobeView } from './globe-view';
import { sampleGrid, type FieldData } from './fields';
import { MAP_Y1, inOutline, unproject, type FlatView } from './view';

/**
 * Fine dust and yellow dust as a hexagon grid (pointy-top), drawn as vectors on the overlay so the edges stay crisp at any zoom. The hexes are regular on screen: in the flat view the lattice lives in the
 * Equal Earth plane (an affine image of the screen, so a hex is a regular hexagon at every zoom and latitude, and the area it covers is equal everywhere); in the globe view it is a regular lattice in the orthographic plane (screen px, anchored at the disc centre, i.e.
 * tangent to the sphere at the view centre); each centre is mapped back to lon/lat to sample the field. The lattice is regular by construction, so hexes never overlap or leave holes; it is rebuilt whenever the camera changes.
 * The size follows the zoom (about HEX_TARGET_PX across, in steps of √2 from HEX_WIDTH), only the visible area plus a margin is built, and a build is reused until the zoom crosses a step or the view leaves the built area.
 * Fine dust: tight tiling in the stepped FINE_RAMP, a constant 1 px gap and no outline. Yellow dust: smaller, spaced tiles with a dashed edge, sand-yellow.
 */
export interface DustHex {
  /** Geographic centre (what the field is sampled at). */
  lon: number; lat: number; kind: 'finedust' | 'dust'; level: number;
  /** Flat view: centre in world units. Globe view: centre in screen px (as of the build). */
  x: number; y: number;
}
/** Hexagons of one build. `width` is the hex width in world units (flat) or in degrees of latitude at the view centre (globe, px = width * scale); `area` is what was built, [x0, y0, x1, y1] in world units (flat; unused in the globe view). */
export interface DustHexes { hexes: DustHex[]; width: number; space: 'world' | 'screen'; area: readonly [number, number, number, number] }
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

function build(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera, width: number, area: readonly [number, number, number, number]): DustHex[] {
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
  // Globe: a regular pointy-top lattice in screen px about the disc centre, kept inside the disc.
  const g = view as GlobeView, cx = g.width / 2 + g.offsetX, cy = g.height / 2;
  const pitch = width * g.scale, pr = pitch / Math.sqrt(3), rowPx = 1.5 * pr, reach = g.radius - pr;
  for (let j = Math.floor(-cy / rowPx); j <= Math.ceil((g.height - cy) / rowPx); j++) {
    const y = cy + rowPx * j, dy = rowPx * j;
    if (Math.abs(dy) > reach) continue;
    const shift = j & 1 ? pitch / 2 : 0, half = Math.sqrt(reach * reach - dy * dy);
    for (let i = Math.ceil((-half - shift) / pitch); i <= Math.floor((half - shift) / pitch); i++) {
      const x = cx + shift + pitch * i;
      if (x < -pitch || x > g.width + pitch || y < -pitch || y > g.height + pitch) continue;
      const ll = g.pxToLonLat(x, y);
      if (!ll || !rowHasDust(sm, ll[1])) continue;
      visit(out, sm, state, field, ll[0], ll[1], x, y);
    }
  }
  return out;
}

/** Hexagons for a width, coarsened by √2 steps while a build would pass MAX_HEXES. */
export function buildDustHexes(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera, width = dustHexWidth(view.scale), margin = 0.3): DustHexes {
  const flat = view.kind === 'flat', v = viewArea(view);
  const mx = flat ? (v[2] - v[0]) * margin : 0, my = flat ? (v[3] - v[1]) * margin : 0;
  const area = [v[0] - mx, v[1] - my, v[2] + mx, v[3] + my] as const;
  let w = width, hexes = build(state, field, finedust, view, w, area);
  while (hexes.length > MAX_HEXES && w < HEX_WIDTH_MAX * 2) { w *= Math.SQRT2; hexes = build(state, field, finedust, view, w, area); }
  return { hexes, width: w, space: flat ? 'world' : 'screen', area };
}

const EMPTY: DustHexes = { hexes: [], width: HEX_WIDTH, space: 'world', area: [0, 0, 0, 0] };
let cached: { state: GameState; field: FieldData | null; finedust: boolean; kind: string; want: number; key: string; built: DustHexes } | null = null;
/** Hexagons for the drawn state and view, rebuilt only when the state, its field, the fine-dust switch or the zoom step changed, or the view left the built area (globe: whenever the camera changed). */
export function dustHexesFor(state: GameState, field: FieldData | null, finedust: boolean, view: MapCamera): DustHexes {
  if (!(state.fineDustRows || state.weatherHazards?.some(hazard => hazard.kind === 'dust'))) return EMPTY;
  const want = dustHexWidth(view.scale), globe = view.kind === 'globe';
  const key = globe ? `${view.version} ${view.width} ${view.height} ${(view as GlobeView).offsetX}` : '';
  if (cached && cached.state === state && cached.field === field && cached.finedust === finedust && cached.kind === view.kind && cached.want === want && cached.key === key) {
    const v = viewArea(view), a = cached.built.area;
    if (globe || (v[0] >= a[0] && v[1] >= a[1] && v[2] <= a[2] && v[3] <= a[3])) return cached.built;
  }
  const built = buildDustHexes(state, field, finedust, view, want);
  cached = { state, field, finedust, kind: view.kind, want, key, built };
  return built;
}

/** Yellow-dust tiles are drawn smaller than their cell, so the gaps between them tell them from the solid fine-dust tiling even when they are tiny. */
const YELLOW_SHRINK = 0.82;

export function drawDustHexes(ctx: CanvasRenderingContext2D, view: MapCamera, built: DustHexes): void {
  const { hexes, width, space } = built;
  if (!hexes.length) return;
  const flat = space === 'world', f = view as FlatView;
  const r = width / Math.sqrt(3);
  const corners = Array.from({ length: 6 }, (_, k) => [r * Math.cos(Math.PI / 6 + k * Math.PI / 3), r * Math.sin(Math.PI / 6 + k * Math.PI / 3)] as const);
  const hexPx = width * view.scale;
  // Fine dust keeps a 1 px gap whatever the zoom; yellow dust 0.82 of the cell, but never a gap under 2 px, so it stays looser than the fine-dust grid.
  const fineShrink = Math.max(0.5, 1 - 1 / hexPx), yellowShrink = Math.max(0.4, Math.min(YELLOW_SHRINK, 1 - 2 / hexPx));
  const xs = new Float64Array(6), ys = new Float64Array(6);
  ctx.save();
  ctx.lineJoin = 'miter';
  for (const kind of ['finedust', 'dust'] as const) {
    const shrink = kind === 'dust' ? yellowShrink : fineShrink;
    for (let level = 1; level <= (kind === 'dust' ? DUST_LEVELS : FINE_RAMP.length); level++) {
      ctx.beginPath();
      let any = false;
      for (const hex of hexes) {
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
        // Globe: the centre is already in screen px (the lattice is regular there), so the hexagon is regular too.
        if (hex.x < -20 || hex.x > view.width + 20 || hex.y < -20 || hex.y > view.height + 20) continue;
        const k = shrink * view.scale;
        for (let c = 0; c < 6; c++) { xs[c] = hex.x + corners[c][0] * k; ys[c] = hex.y - corners[c][1] * k; }
        ctx.moveTo(xs[0], ys[0]);
        for (let c = 1; c < 6; c++) ctx.lineTo(xs[c], ys[c]);
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
