import { CITIES } from '../data/world';
import { typhoonById } from '../data/typhoons';
import { placeName } from '../data/places';
import { lakeName } from '../data/lakes';
import { PINNED_PLACES, PINNED_PLACE_MIN_ZOOM, pinnedPlaceName } from '../data/islands';
import { RIVERS, riverName } from '../data/rivers';
import { seaName } from '../data/seas';
import { cityLabel, getLanguage, t as translate } from '../i18n';
import { stageChanges, stormGradeLabel, stormOutcome } from '../storm-info';
import { GENESIS_HOURS, stageRank } from '../simulation/engine';
import { estimateCityDamage } from '../simulation/damage-news';
import { fmtMoneyCompact } from '../ui/dom';
import { drawTraffic, type TrafficCounts, type TrafficMarker } from './traffic';
import { drawWeatherHazards } from './weather-hazards';
import type { Effect, GameState, GeoPoint, MapOverlays, Storm, StormRecord, Thunderstorm, ToolDefinition, ToolType } from '../types';
import { type Contours, type FieldData, type Isobar } from './fields';
import { geoToUnit, type MapCamera } from './camera';
import { each, geoPolyline, geoPolylineLL, groundCircle, isGlobe, segmentsUnit, unitCache } from './geo-draw';
import { COAST_THIN_ZOOM, COAST_TIER_MIN_ZOOM, LAKE_TIER_MIN_ZOOM, RIVER_LABEL_MIN_ZOOM, RIVER_TIER_MIN_ZOOM, visibleTierCount } from './detail';
import { coastTierSegments, coastTierSegmentsLonLat, riverTierSegments, riverTierSegmentsLonLat, type CoastTiers } from './geometry';
import { cityLabelEligible, minPopForDot, visiblePlaces, webZoom } from './places';
import { visibleLakes, visibleSeas } from './seas';
import type { GlobeView } from './globe-view';
import type { Theme } from './theme';
import { EDGE_LON, LON0, MAP_OUTLINE, edgeBetween, lonDelta, project, projectLambda, wrapLon, type FlatView } from './view';

/** Everything the vector overlay needs besides the game state. */
export interface MapOverlay {
  /** Armed or dragged tool: draws a range preview at `target`. */
  tool: ToolDefinition | null;
  target: GeoPoint | null;
  /** True while a tool is being dragged from the palette. */
  dragging: boolean;
  hover: GeoPoint | null;
  selectedCityId: string | null;
  selectedStormId: number | null;
  /** Alias of `labels.recordedPaths`: the recorded paths draw only when both are on. */
  showRecordedPaths: boolean;
  /** Label layers to show; omitted keys default to true. */
  labels?: Partial<MapLabels>;
  rightInset: number;
  /** First-visit tutorial: a pulsing ring and 'Drop here' label at this spot. */
  tutorialTarget?: GeoPoint | null;
}

/** Which label layers the overlay draws. */
export interface MapLabels {
  /** City and place labels (dots stay; the selected city keeps its label). */
  cities: boolean;
  /** Isobar pressure labels (the lines stay). */
  isobars: boolean;
  /** Sea and ocean names. */
  seas: boolean;
  /** The full recorded path of every loaded historic typhoon. */
  recordedPaths: boolean;
}

export const DEFAULT_LABELS: Readonly<MapLabels> = { cities: true, isobars: true, seas: true, recordedPaths: true };

export const EMPTY_OVERLAY: MapOverlay = { tool: null, target: null, dragging: false, hover: null, selectedCityId: null, selectedStormId: null, showRecordedPaths: true, rightInset: 0 };

const TAU = Math.PI * 2;
const EFFECT_RESIZE_MS = 240;
/** Scratch projections for picking and hover tests. */
const P = new Float64Array(3);
const Q = new Float64Array(3);
/** lon/lat pairs of a graticule or reference line, refilled per line. */
const LINE = new Float64Array(2 * 181);
const lonLabel = (lon: number): string => {
  const wl = wrapLon(lon);
  return `${Math.abs(wl)}°${wl === 0 || Math.abs(wl) === 180 ? '' : wl > 0 ? 'E' : 'W'}`;
};
type Rect = [number, number, number, number];
/** Sea label font sizes in px by rank. */
const SEA_SIZE = [14, 12, 11, 10];
/** Offsets tried in turn for a sea label, in multiples of its font size: the anchor itself, then up/down and sideways. */
const SEA_NUDGES: [number, number][] = [[0, 0], [0, -1.4], [0, 1.4], [0, -2.8], [0, 2.8], [-2.5, 0], [2.5, 0], [-2.5, -1.4], [2.5, -1.4], [-2.5, 1.4], [2.5, 1.4]];

/** Screen rectangles [x0, y0, x1, y1] already claimed by labels this frame. */
class LabelOccupancy {
  private readonly rects: Rect[] = [];
  clear(): void { this.rects.length = 0; }
  add(r: Rect): void { this.rects.push(r); }
  /** A copy of the rectangles claimed so far. */
  snapshot(): Rect[] { return this.rects.slice(); }
  fits(r: Rect): boolean { return !this.rects.some(p => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1]); }
  /** Claims `r` and returns true when nothing overlaps it. */
  place(r: Rect): boolean {
    if (!this.fits(r)) return false;
    this.rects.push(r);
    return true;
  }
}

/** Glyph radius in px: grows with wind and with the storm's age, so a young depression reads small. */
interface StormSpot { x: number; y: number; a: number; labels: string[]; flip: boolean; labelX: number; ly: number }
interface IsobarLabel { text: string; x: number; y: number; angle: number }
const stormGlyphRadius = (s: Storm): number => Math.max(6, Math.min(16, 5 + s.wind * 0.14 + Math.min(4, s.ageHours / 16)));
const REFERENCE_PARALLELS = [
  { lat: 0, label: 'Equator · 0°', equator: true },
  { lat: 23.44, label: 'Tropic of Cancer · 23.4°N', equator: false },
  { lat: -23.44, label: 'Tropic of Capricorn · 23.4°S', equator: false },
] as const;

export class OverlayPainter {
  trafficCounts: TrafficCounts = { ships: 0, planes: 0, diverted: 0 };
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 1;
  private h = 1;
  /** Shoreline segment buffers by detail tier in world units (flat map) and in degrees (globe), built on first use. */
  private coast: CoastTiers | null = null;
  private coastLL: CoastTiers | null = null;
  /** Isobar segments projected to world units, keyed by the lon/lat array they came from. */
  private readonly projectedContours = new WeakMap<Float32Array, Float32Array>();
  /** Whole isobars projected to world units, split into runs at the map's edge meridian. */
  private readonly isobarRuns = new WeakMap<Isobar, number[][]>();
  /** Whole isobars as unit vectors (xyz per vertex), for the globe. */
  private readonly isobarUnits = new WeakMap<Isobar, Float32Array>();
  private readonly occ = new LabelOccupancy();
  /** Real frame time when a placed condition first appeared, independent of simulation speed. */
  private readonly effectPlacedAt = new Map<number, number>();
  private readonly effectScale = new Map<number, { from: number; to: number; startedAt: number }>();
  private effectSeed: number | undefined;
  private effectTick = 0;
  reducedMotion = false;

  constructor(readonly canvas: HTMLCanvasElement, private readonly theme: Theme) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.w = width;
    this.h = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  // ---- picking -----------------------------------------------------------------------------

  /** Nearest city marker within `radius` px, or null. */
  pickCity(view: MapCamera, px: number, py: number, radius = 22): string | null {
    let best: string | null = null;
    let bestD = radius;
    for (const c of CITIES) {
      view.projectZ(c.lon, c.lat, P);
      if (P[2] < 0.05) continue;
      const d = Math.hypot(P[0] - px, P[1] - py);
      if (d < bestD) { bestD = d; best = c.id; }
    }
    return best;
  }

  /** Nearest storm glyph within `radius` px, or null. */
  pickStorm(view: MapCamera, storms: Storm[], px: number, py: number, radius = 14): number | null {
    let best: number | null = null;
    let bestD = Infinity;
    for (const s of storms) {
      view.projectZ(s.lon, s.lat, P);
      if (P[2] < 0.05) continue;
      const d = Math.hypot(P[0] - px, P[1] - py);
      // The pick area covers the whole glyph, tails included.
      if (d < Math.max(radius, stormGlyphRadius(s) * 1.5) && d < bestD) { bestD = d; best = s.id; }
    }
    return best;
  }

  // ---- drawing -----------------------------------------------------------------------------

  draw(view: MapCamera, state: GameState | null, overlays: MapOverlays, overlay: MapOverlay, contours: Contours | null, now: number, _field: FieldData | null = null, clockNow = now, traffic: readonly TrafficMarker[] = [], thunderstorms: readonly Thunderstorm[] = state?.thunderstorms ?? []): void {
    const { ctx, w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    const tm = this.reducedMotion ? 0 : now;
    const labels = { ...DEFAULT_LABELS, ...overlay.labels };
    this.occ.clear();

    // Bottom to top: reference lines, coast, cities and places, sea names, isobars, tracks, effects, history, target preview, storms, outline.
    this.graticule(view);
    this.referenceParallels(view);
    this.coastline(view);
    if (state?.weatherHazards?.length) drawWeatherHazards(ctx, view, state.weatherHazards, this.theme.font, this.theme.paper);
    // Pass 1: reference-parallel, storm and isobar labels claim their rectangles first, without drawing, so cities and places yield to them.
    const parallelLabels = this.referenceParallelLabelLayout(view, overlay.rightInset);
    const spots = state ? state.storms.map(s => this.stormLayout(view, s, s.id === overlay.selectedStormId)) : [];
    const isobarLabels = overlays.pressure && labels.isobars && contours ? this.isobarLabelLayout(view, contours, overlay.rightInset) : [];
    this.graticuleLabels(view, overlay.rightInset);
    const reserved = this.occ.snapshot();
    // Pass 2: cities, then seas (which yield to cities), then places (which yield to seas).
    this.cities(view, state, overlays.population, overlay.selectedCityId, reserved, labels.cities);
    if (labels.seas) { this.seaLabels(view); this.riverLabels(view); }
    this.places(view, labels.cities);
    // Pass 3: everything that draws over the cities.
    this.drawReferenceParallelLabels(parallelLabels);
    if (overlays.pressure && contours) { this.isobars(view, contours); this.drawIsobarLabels(isobarLabels); }
    this.trafficCounts = drawTraffic(ctx, view, traffic, overlays);
    if (!state || state.seed !== this.effectSeed || state.tick < this.effectTick) {
      this.effectPlacedAt.clear();
      this.effectScale.clear();
    }
    this.effectSeed = state?.seed;
    this.effectTick = state?.tick ?? 0;
    if (state) {
      const ids = new Set(state.effects.map(e => e.id));
      for (const id of this.effectPlacedAt.keys()) if (!ids.has(id)) {
        this.effectPlacedAt.delete(id);
        this.effectScale.delete(id);
      }
      if (overlay.showRecordedPaths && labels.recordedPaths) for (const s of state.storms) this.recordedPath(view, s);
      for (const s of state.storms) { this.forecast(view, s); this.track(view, s, s.id === overlay.selectedStormId); }
      for (const e of state.effects) {
        let hovered = false;
        if (overlay.hover !== null) {
          view.projectZ(e.lon, e.lat, P);
          view.projectZ(overlay.hover.lon, overlay.hover.lat, Q);
          hovered = P[2] > 0 && Math.hypot(P[0] - Q[0], P[1] - Q[1]) <= 22;
        }
        const placedAt = this.effectPlacedAt.get(e.id) ?? clockNow;
        this.effectPlacedAt.set(e.id, placedAt);
        const scale = this.markerScale(e.id, clockNow - placedAt >= 1000 && !hovered ? 0.75 : 1, clockNow);
        this.effect(view, e, hovered && !overlay.tool, scale);
      }
      for (const c of state.candidates) this.candidate(view, c.lon, c.lat, c.progressHours, tm);
    }
    const record = state?.stormArchive.find(s => s.id === overlay.selectedStormId);
    if (record) { this.track(view, record, true); this.history(view, record, overlay.rightInset); }
    if (overlay.tool) {
      if (overlay.target) this.targetPreview(view, overlay, tm);
    }
    if (overlay.tutorialTarget) this.tutorialMarker(view, overlay.tutorialTarget, tm);
    // Live systems stay above placed icons and the armed/dragged tool preview.
    if (state) {
      for (const storm of thunderstorms) this.thunderstorm(view, storm);
      state.storms.forEach((s, i) => this.storm(view, s, s.id === overlay.selectedStormId, tm, spots[i]));
    }
    if (isGlobe(view)) this.limb(view); else this.outline(view);
  }

  /** Ordinary graticule: meridians are curves (sampled every 2° of latitude); parallels are straight in Equal Earth. */
  private graticule(view: MapCamera): void {
    const { ctx, theme } = this;
    const step = view.scale >= 12 ? 10 : 30;
    ctx.save();
    ctx.strokeStyle = theme.grid;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (isGlobe(view)) {
      for (let lon = -180; lon < 180; lon += step) {
        for (let k = 0; k <= 90; k++) { LINE[2 * k] = lon; LINE[2 * k + 1] = -90 + 2 * k; }
        geoPolylineLL(view, ctx, LINE, 91);
      }
      for (let lat = -90 + step; lat < 90; lat += step) {
        if (lat === 0) continue; // the equator has its own stronger line
        for (let k = 0; k <= 180; k++) { LINE[2 * k] = -180 + 2 * k; LINE[2 * k + 1] = lat; }
        geoPolylineLL(view, ctx, LINE, 181);
      }
    } else {
      const flat = view as FlatView;
      for (const lon of this.meridians(step)) {
        for (let lat = -90; lat <= 90; lat += 2) {
          const [x, y] = flat.lonLatToPx(lon, lat);
          if (lat === -90) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
      }
      for (let lat = -90 + step; lat < 90; lat += step) {
        if (lat === 0) continue; // the equator has its own stronger line
        const [x0, y] = flat.worldToPx(...projectLambda(-180, lat));
        if (y < 0 || y > this.h) continue;
        ctx.moveTo(x0, y);
        ctx.lineTo(flat.worldToPx(...projectLambda(180, lat))[0], y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Meridians (multiples of `step` degrees) strictly inside the map; the edge meridian is the outline. */
  private meridians(step: number): number[] {
    const out: number[] = [];
    for (let lon = Math.ceil(EDGE_LON / step) * step; lon < EDGE_LON + 360; lon += step) {
      if (Math.abs(wrapLon(lon - LON0)) < 179.999) out.push(lon);
    }
    return out;
  }

  /** Geographic reference lines stay distinct from the ordinary 10°/30° grid. */
  private referenceParallels(view: MapCamera): void {
    const { ctx, theme } = this;
    ctx.save();
    for (const reference of REFERENCE_PARALLELS) {
      ctx.setLineDash(reference.equator ? [] : [10, 7]);
      ctx.beginPath();
      if (isGlobe(view)) {
        for (let k = 0; k <= 180; k++) { LINE[2 * k] = -180 + 2 * k; LINE[2 * k + 1] = reference.lat; }
        geoPolylineLL(view, ctx, LINE, 181);
      } else {
        const flat = view as FlatView;
        const [left, y] = flat.worldToPx(...projectLambda(-180, reference.lat));
        if (y < -3 || y > this.h + 3) continue;
        ctx.moveTo(left, y); ctx.lineTo(flat.worldToPx(...projectLambda(180, reference.lat))[0], y);
      }
      // A dark under-stroke keeps both lines legible over bright weather fields.
      ctx.strokeStyle = theme.paper; ctx.globalAlpha = 0.8; ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = reference.equator ? theme.equator : theme.tropics;
      ctx.globalAlpha = 0.95; ctx.lineWidth = reference.equator ? 2.4 : 1.8;
      ctx.stroke();
    }
    ctx.restore();
  }

  private referenceParallelLabelLayout(view: MapCamera, rightInset: number): { lx: number; y: number; width: number; label: string; colour: string; equator: boolean }[] {
    const { ctx, theme } = this;
    const items: { lx: number; y: number; width: number; label: string; colour: string; equator: boolean }[] = [];
    ctx.save();
    for (const reference of REFERENCE_PARALLELS) {
      ctx.font = `${reference.equator ? 700 : 600} 8px ${theme.font}`;
      const label = translate(reference.label);
      const width = ctx.measureText(label).width + 10;
      let lx: number;
      let y: number;
      if (isGlobe(view)) {
        // The leftmost sample of the parallel that is well inside the disc, the viewport and the clear area.
        lx = Infinity; y = 0;
        for (let lon = -180; lon <= 180; lon += 2) {
          view.projectZ(lon, reference.lat, P);
          if (P[2] > 0.2 && P[0] >= 12 && P[0] < lx && P[0] + width <= this.w - rightInset && P[1] >= 10 && P[1] <= this.h - 10) { lx = P[0]; y = P[1]; }
        }
        if (lx === Infinity) continue;
      } else {
        const [left, fy] = (view as FlatView).worldToPx(...projectLambda(-180, reference.lat));
        if (fy < 10 || fy > this.h - 10) continue;
        lx = Math.max(12, left + 8);
        if (width + lx + 12 > this.w - rightInset) continue;
        y = fy;
      }
      this.occ.add([lx, y - 8, lx + width, y + 8]);
      items.push({ lx, y, width, label, colour: reference.equator ? theme.equator : theme.tropics, equator: !!reference.equator });
    }
    ctx.restore();
    return items;
  }

  private drawReferenceParallelLabels(items: { lx: number; y: number; width: number; label: string; colour: string; equator: boolean }[]): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.textAlign = 'left'; ctx.setLineDash([]);
    for (const { lx, y, width, label, colour, equator } of items) {
      ctx.font = `${equator ? 700 : 600} 8px ${theme.font}`;
      ctx.fillStyle = theme.paper; ctx.globalAlpha = 0.95;
      ctx.fillRect(lx, y - 8, width, 16);
      ctx.strokeStyle = colour; ctx.lineWidth = 1; ctx.globalAlpha = 0.65;
      ctx.strokeRect(lx, y - 8, width, 16);
      ctx.fillStyle = colour; ctx.globalAlpha = 1;
      ctx.fillText(label, lx + 5, y + 3);
    }
    ctx.restore();
  }

  /** Graticule labels: a longitude label sits just above the reference parallel, centred on its meridian; a latitude label sits just right of the reference meridian, centred on its parallel. The reference lines are the parallel and meridian nearest the view centre on the globe, the bottom and left edges on the flat map. Each label claims its rectangle, so at a crossing the latitude label yields to the longitude one. */
  private graticuleLabels(view: MapCamera, rightInset: number): void {
    const { ctx, theme, w, h } = this;
    const step = view.scale >= 12 ? 10 : 30;
    const GAP = 4;
    const EDGE = 12;
    const right = w - Math.max(0, rightInset) - EDGE;
    const latText = (lat: number): string => `${Math.abs(lat)}°${lat === 0 ? '' : lat > 0 ? 'N' : 'S'}`;
    ctx.save();
    ctx.font = `500 11px ${theme.mono}`;
    ctx.fillStyle = theme.muted;
    /** Claims the label's rectangle (baseline at `base`, 12 px tall) and draws it; false when it leaves the safe area or collides. */
    const put = (text: string, x: number, base: number, centred: boolean): boolean => {
      const tw = ctx.measureText(translate(text)).width + 6;
      const x0 = centred ? x - tw / 2 : x;
      const rect: Rect = [x0, base - 12, x0 + tw, base];
      if (rect[0] < EDGE || rect[2] > right || rect[1] < EDGE || rect[3] > h - EDGE || !this.occ.place(rect)) return false;
      ctx.textAlign = centred ? 'center' : 'left';
      this.halo(text, x, base);
      return true;
    };
    if (isGlobe(view)) {
      const row = Math.max(-90 + step, Math.min(90 - step, Math.round(view.lat0 / step) * step));
      for (let lon = -180; lon < 180; lon += step) {
        view.projectZ(lon, row, P);
        if (P[2] < 0.25) continue;
        put(lonLabel(lon), P[0], P[1] - GAP, true);
      }
      const col = Math.round(view.lon0 / step) * step;
      for (let lat = -90 + step; lat < 90; lat += step) {
        view.projectZ(col, lat, P);
        const x = P[0]; const y = P[1];
        if (P[2] < 0.25) continue;
        if (REFERENCE_PARALLELS.some(p => Math.abs(view.projectZ(col, p.lat, Q)[1] - y) < 20)) continue;
        put(latText(lat), x + GAP, y + 4, false);
      }
      ctx.restore();
      return;
    }
    const flat = view as FlatView;
    for (const lon of this.meridians(step)) {
      for (let lat = -90; lat <= 90; lat += 2) {
        const [x, y] = flat.lonLatToPx(lon, lat);
        if (x < 0 || x > w || y > h - EDGE - GAP) continue;
        put(lonLabel(lon), x, y - GAP, true);
        break;
      }
    }
    for (let lat = -90 + step; lat < 90; lat += step) {
      if (REFERENCE_PARALLELS.some(p => Math.abs(flat.lonLatToPx(0, p.lat)[1] - flat.lonLatToPx(0, lat)[1]) < 20)) continue;
      const [x, y] = flat.worldToPx(...projectLambda(-180, lat));
      if (y < 0 || y > h) continue;
      const lx = Math.max(EDGE, x + GAP);
      // Beside the bottom-left corner the first label would sit on a longitude label: lift it clear.
      if (!put(latText(lat), lx, y + 4, false) && y > h - 48) put(latText(lat), lx, y + 4 - 14, false);
    }
    ctx.restore();
  }

  private halo(text: string, x: number, y: number, fill = this.ctx.fillStyle as string, alpha = 1): void {
    text = translate(text);
    const { ctx, theme } = this;
    ctx.lineWidth = 3;
    ctx.strokeStyle = theme.paper;
    ctx.globalAlpha = 0.85 * alpha;
    ctx.strokeText(text, x, y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = fill;
    ctx.fillText(text, x, y);
  }

  /** Adds world-unit segments [x0,y0,x1,y1,…] to the current path in screen space, skipping those off screen. */
  private flatSegments(view: FlatView, c: Float32Array): void {
    const { ctx, w, h } = this;
    const s = view.scale;
    const ox = w / 2 - view.cx * s;
    const oy = h / 2 + view.cy * s;
    for (let i = 0; i < c.length; i += 4) {
      const x0 = c[i] * s + ox; const y0 = oy - c[i + 1] * s;
      const x1 = c[i + 2] * s + ox; const y1 = oy - c[i + 3] * s;
      if ((x0 < -4 && x1 < -4) || (x0 > w + 4 && x1 > w + 4) || (y0 < -4 && y1 < -4) || (y0 > h + 4 && y1 > h + 4)) continue;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
    }
  }

  /** Strokes segment buffers (world units on the flat map, lon/lat degrees on the globe) as one path. */
  private strokeSegments(view: MapCamera, buffers: Float32Array[]): void {
    this.ctx.beginPath();
    if (isGlobe(view)) for (const c of buffers) segmentsUnit(view, this.ctx, unitCache(c));
    else for (const c of buffers) this.flatSegments(view as FlatView, c);
    this.ctx.stroke();
  }

  /** Rivers, then coasts and lake shores. Both come in detail tiers built once, so a frame only picks how many tiers to stroke. */
  private coastline(view: MapCamera): void {
    const { ctx, theme } = this;
    const zoom = webZoom(view);
    const globe = isGlobe(view);
    ctx.save();
    const nRivers = visibleTierCount(RIVER_TIER_MIN_ZOOM, zoom);
    if (nRivers > 0) {
      const tiers = globe ? riverTierSegmentsLonLat() : riverTierSegments();
      // The shoreline colour pulled 20% toward the sea colour, so rivers sit quietly under the coasts. A browser without color-mix keeps the shoreline colour.
      ctx.strokeStyle = theme.coast;
      ctx.strokeStyle = `color-mix(in srgb, ${theme.coast} 80%, ${theme.sea})`;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 0.8;
      this.strokeSegments(view, tiers.slice(0, 1));
      if (nRivers > 1) {
        ctx.lineWidth = 0.6;
        this.strokeSegments(view, tiers.slice(1, nRivers));
      }
    }
    // Far out the land fill carries the shape: a faint half-pixel coast keeps the map calm.
    const thin = zoom < COAST_THIN_ZOOM;
    ctx.strokeStyle = theme.coast;
    ctx.lineWidth = thin ? 0.5 : 1;
    ctx.globalAlpha = thin ? 0.5 : 0.9;
    const shore = globe ? (this.coastLL ??= coastTierSegmentsLonLat()) : (this.coast ??= coastTierSegments());
    this.strokeSegments(view, [...shore.land.slice(0, visibleTierCount(COAST_TIER_MIN_ZOOM, zoom)), ...shore.lakes.slice(0, visibleTierCount(LAKE_TIER_MIN_ZOOM, zoom))]);
    ctx.restore();
  }

  /** Contour segments are lon/lat; project them once per contour set. Segments that cross the map's edge meridian are dropped. */
  private projectContours(arr: Float32Array): Float32Array {
    let out = this.projectedContours.get(arr);
    if (out) return out;
    const kept: number[] = [];
    for (let i = 0; i < arr.length; i += 4) {
      if (edgeBetween(arr[i], arr[i + 2])) continue;
      kept.push(...project(arr[i], arr[i + 1]), ...project(arr[i + 2], arr[i + 3]));
    }
    out = new Float32Array(kept);
    this.projectedContours.set(arr, out);
    return out;
  }

  private isobars(view: MapCamera, c: Contours): void {
    const { ctx, theme, w, h } = this;
    const s = view.scale;
    const flat = isGlobe(view) ? null : (view as FlatView);
    const draw = (lonLat: Float32Array) => {
      ctx.beginPath();
      if (!flat) {
        segmentsUnit(view as GlobeView, ctx, unitCache(lonLat));
      } else {
        const arr = this.projectContours(lonLat);
        const ox = w / 2 - flat.cx * s;
        const oy = h / 2 + flat.cy * s;
        for (let i = 0; i < arr.length; i += 4) {
          ctx.moveTo(arr[i] * s + ox, oy - arr[i + 1] * s);
          ctx.lineTo(arr[i + 2] * s + ox, oy - arr[i + 3] * s);
        }
      }
      ctx.stroke();
    };
    ctx.save();
    // Smoothed isobars arrive as short chained segments; round caps hide the joints.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Dark casing keeps isobars legible across tinted cells.
    ctx.strokeStyle = theme.paper;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.4;
    draw(c.minor);
    ctx.lineWidth = 3.2;
    ctx.globalAlpha = 0.65;
    draw(c.major);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 0.9;
    ctx.globalAlpha = 0.32;
    draw(c.minor);
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.6;
    draw(c.major);
    ctx.restore();
  }

  /** An isobar's vertices in world units, as runs that never span the map's edge meridian. */
  private runsOf(line: Isobar): number[][] {
    let runs = this.isobarRuns.get(line);
    if (runs) return runs;
    runs = [];
    const q = line.points;
    const n = q.length / 2;
    let run: number[] = [];
    for (let k = 0; k < n + (line.closed ? 1 : 0); k++) {
      const lon = q[2 * (k % n)]; const lat = q[2 * (k % n) + 1];
      if (k > 0 && edgeBetween(q[2 * (k - 1)], lon)) { runs.push(run); run = []; }
      run.push(...project(lon, lat));
    }
    runs.push(run);
    this.isobarRuns.set(line, runs);
    return runs;
  }

  /** An isobar's vertices as unit vectors (xyz per vertex), built once per line. */
  private unitsOf(line: Isobar): Float32Array {
    let units = this.isobarUnits.get(line);
    if (units) return units;
    const q = line.points;
    const n = q.length / 2;
    units = new Float32Array(3 * n);
    for (let k = 0; k < n; k++) geoToUnit(q[2 * k], q[2 * k + 1], units, 3 * k);
    this.isobarUnits.set(line, units);
    return units;
  }

  /** One pressure label per isobar, set on the line and kept upright; yields to labels already placed. */
  /** Pass 1 for isobar labels: claims their rectangles and returns where each is drawn. */
  private isobarLabelLayout(view: MapCamera, c: Contours, rightInset: number): IsobarLabel[] {
    const out: IsobarLabel[] = [];
    if (view.scale < 2.5) return out;
    const { ctx, theme, w, h } = this;
    const s = view.scale;
    const globe = isGlobe(view) ? view : null;
    const flat = globe ? null : (view as FlatView);
    const ox = flat ? w / 2 - flat.cx * s : 0;
    const oy = flat ? h / 2 + flat.cy * s : 0;
    const margin = 24;
    const right = w - Math.max(0, rightInset) - margin;
    ctx.save();
    ctx.font = `600 11px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const line of c.lines) {
      // Visible chunks: consecutive vertices inside the safe area, with cumulative path length.
      const chunks: { p: number[]; cum: number[] }[] = [];
      let total = 0;
      let p: number[] = []; let cum: number[] = [];
      const flush = () => {
        if (cum.length > 1 && cum[cum.length - 1] >= 40) { chunks.push({ p, cum }); total += cum[cum.length - 1]; }
        p = []; cum = [];
      };
      const vertex = (x: number, y: number, visible: boolean) => {
        if (!visible || x < margin || x > right || y < margin || y > h - margin) { flush(); return; }
        cum.push(cum.length ? cum[cum.length - 1] + Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) : 0);
        p.push(x, y);
      };
      if (globe) {
        const units = this.unitsOf(line);
        const n = units.length / 3;
        for (let k = 0; k < n + (line.closed ? 1 : 0); k++) {
          const i = 3 * (k % n);
          globe.projectUnit(units[i], units[i + 1], units[i + 2], P);
          vertex(P[0], P[1], P[2] >= 0.25);
        }
        flush();
      } else {
        for (const run of this.runsOf(line)) {
          for (let i = 0; i < run.length; i += 2) vertex(run[i] * s + ox, oy - run[i + 1] * s, true);
          flush();
        }
      }
      if (total < 60) continue;
      // The point at path distance `d` within one chunk, as pixels.
      const pointAt = (ch: { p: number[]; cum: number[] }, d: number): [number, number] => {
        const end = ch.cum[ch.cum.length - 1];
        d = Math.max(0, Math.min(end, d));
        let i = 1;
        while (i < ch.cum.length - 1 && ch.cum[i] < d) i++;
        const span = ch.cum[i] - ch.cum[i - 1] || 1;
        const t = (d - ch.cum[i - 1]) / span;
        return [ch.p[2 * i - 2] + (ch.p[2 * i] - ch.p[2 * i - 2]) * t, ch.p[2 * i - 1] + (ch.p[2 * i + 1] - ch.p[2 * i - 1]) * t];
      };
      const text = String(line.level);
      const tw = ctx.measureText(text).width + 8;
      // Preferred spot at 40% of the visible length, then every ~120 px either side of it.
      const targets = [0.4 * total];
      for (let k = 1; targets.length < 8 && k * 120 <= total; k++) {
        for (const sign of [1, -1]) {
          const t = 0.4 * total + sign * k * 120;
          if (t >= 0 && t <= total && targets.length < 8) targets.push(t);
        }
      }
      for (const target of targets) {
        let d = target;
        let ch = chunks[0];
        for (const candidate of chunks) { ch = candidate; if (d <= candidate.cum[candidate.cum.length - 1]) break; d -= candidate.cum[candidate.cum.length - 1]; }
        const [x, y] = pointAt(ch, d);
        const [ax, ay] = pointAt(ch, d - 10);
        const [bx, by] = pointAt(ch, d + 10);
        let angle = Math.atan2(by - ay, bx - ax);
        if (Math.abs(angle) > Math.PI / 2) angle += Math.PI;
        const cos = Math.abs(Math.cos(angle)); const sin = Math.abs(Math.sin(angle));
        const hw = (cos * tw + sin * 14) / 2; const hh = (sin * tw + cos * 14) / 2;
        if (!this.occ.place([x - hw, y - hh, x + hw, y + hh])) continue;
        out.push({ text, x, y, angle });
        break;
      }
    }
    ctx.restore();
    return out;
  }

  private drawIsobarLabels(labels: IsobarLabel[]): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.font = `600 11px ${theme.font}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      ctx.save();
      ctx.translate(l.x, l.y);
      ctx.rotate(l.angle);
      this.halo(l.text, 0, 0, theme.ink);
      ctx.restore();
    }
    ctx.restore();
  }

  /** Thin stroke around the whole map: the curved sides and the flat poles. */
  private outline(view: MapCamera): void {
    const { ctx, theme } = this;
    const flat = view as FlatView;
    ctx.save();
    ctx.strokeStyle = theme.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    MAP_OUTLINE.forEach(([x, y], i) => {
      const [px, py] = flat.worldToPx(x, y);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  /** Thin stroke around the globe's disc. */
  private limb(view: GlobeView): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = theme.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(view.width / 2 + view.offsetX, view.height / 2, view.radius, 0, TAU);
    ctx.stroke();
    ctx.restore();
  }

  private track(view: MapCamera, s: Storm, selected: boolean): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = theme.track;
    ctx.lineWidth = selected ? 2.6 : 1.8;
    ctx.globalAlpha = selected ? 1 : 0.8;
    ctx.beginPath();
    geoPolyline(view, ctx, [...s.track, { lon: s.lon, lat: s.lat }]);
    ctx.stroke();
    ctx.restore();
  }

  /** The whole JMA best track of a loaded historic storm, dashed; the part already travelled is drawn by `track`. */
  private recordedPath(view: MapCamera, s: Storm): void {
    const typhoon = s.record ? typhoonById(s.record.typhoonId) : undefined;
    if (!typhoon || typhoon.points.length < 2) return;
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = theme.recordedPath;
    ctx.fillStyle = theme.recordedPath;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.85;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    geoPolyline(view, ctx, typhoon.points.map(p => ({ lon: wrapLon(p.lon), lat: p.lat })));
    ctx.stroke();
    ctx.setLineDash([]);
    const last = typhoon.points[typhoon.points.length - 1];
    each(view, last.lon, last.lat, 8, this.w, this.h, (ex, ey, a) => {
      ctx.globalAlpha = 0.85 * a;
      ctx.beginPath();
      ctx.arc(ex, ey, 3.5, 0, TAU);
      ctx.fill();
    });
    ctx.restore();
  }

  /** Archived systems have a static track and stage markers, never a live vortex or forecast. */
  private history(view: MapCamera, record: StormRecord, rightInset: number): void {
    const { ctx, theme } = this;
    ctx.save();
    const right = Math.max(0, this.w - rightInset);
    ctx.beginPath(); ctx.rect(0, 0, right, this.h); ctx.clip();
    const occupied: { x: number; y: number; w: number; h: number }[] = [];
    const label = (text: string, x: number, y: number, colour: string, preferred: number, alpha: number) => {
      const width = ctx.measureText(text).width;
      const lx = Math.max(4, Math.min(x + 14, right - width - 4));
      let ly = Math.max(16, Math.min(this.h - 8, y + preferred));
      for (const delta of [preferred, -preferred, -40, 40, -60, 60, -80, 80, -100, 100, -120, 120, -160, 160, -200, 200]) {
        const candidate = y + delta;
        if (candidate < 16 || candidate > this.h - 8) continue;
        if (!occupied.some(b => lx < b.x + b.w && lx + width > b.x && candidate - 12 < b.y + b.h && candidate + 3 > b.y)) {
          ly = candidate; break;
        }
      }
      occupied.push({ x: lx - 3, y: ly - 14, w: width + 6, h: 20 });
      ctx.strokeStyle = colour; ctx.lineWidth = 0.7; ctx.globalAlpha = alpha;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(lx, ly - 4); ctx.stroke();
      this.halo(text, lx, ly, colour, alpha);
    };
    const colours = ['#91b9cb', '#66c9ba', '#e3cd72', '#ffa94d', '#ff7566', '#d89bff'];
    const colourOf = (grade: number) => colours[Math.min(grade, colours.length - 1)];
    for (const [i, sample] of stageChanges(record).entries()) {
      each(view, sample.lon, sample.lat, 180, this.w, this.h, (x, y, a) => {
        ctx.fillStyle = theme.paper;
        ctx.strokeStyle = colourOf(sample.grade);
        ctx.lineWidth = 2;
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(x, y, 10, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.font = `700 11px ${theme.font}`;
        ctx.textAlign = 'center';
        this.halo(String(sample.grade), x, y + 4, colourOf(sample.grade), a);
        ctx.font = `500 11px ${theme.font}`;
        ctx.textAlign = 'left';
        const text = translate(`Grade ${sample.grade} · ${sample.stage} · ${sample.hour.toFixed(1)} h`);
        label(text, x, y, theme.ink, i % 2 ? 23 : -15, a);
      });
    }
    each(view, record.lon, record.lat, 180, this.w, this.h, (x, y, a) => {
      ctx.strokeStyle = theme.accent; ctx.lineWidth = 2; ctx.globalAlpha = a;
      ctx.beginPath(); ctx.moveTo(x - 6, y - 6); ctx.lineTo(x + 6, y + 6);
      ctx.moveTo(x - 6, y + 6); ctx.lineTo(x + 6, y - 6); ctx.stroke();
      ctx.font = `600 12px ${theme.font}`; ctx.textAlign = 'left';
      const text = translate(stormOutcome(record));
      label(text, x, y, theme.accent, 38, a);
    });
    ctx.restore();
  }

  private forecast(view: MapCamera, s: Storm): void {
    const { ctx, theme } = this;
    if (s.forecast.length === 0) return;
    const geo: GeoPoint[] = [{ lon: s.lon, lat: s.lat }, ...s.forecast];
    ctx.save();
    ctx.fillStyle = theme.track;
    ctx.globalAlpha = 0.09;
    ctx.beginPath();
    geo.forEach((p, i) => {
      groundCircle(view, ctx, p.lon, p.lat, 60 + 4.2 * i * 6, 'fill');
      const prev = geo[i - 1];
      if (i > 0 && (isGlobe(view) || !edgeBetween(prev.lon, p.lon))) {
        groundCircle(view, ctx, prev.lon + lonDelta(prev.lon, p.lon) / 2, (p.lat + prev.lat) / 2, 60 + 4.2 * (i - 0.5) * 6, 'fill');
      }
    });
    ctx.fill();
    ctx.globalAlpha = 0.85;
    ctx.strokeStyle = theme.track;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([6, 5]);
    ctx.beginPath();
    geoPolyline(view, ctx, geo);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** Reverses a size change from its current position when the pointer moves mid-animation. */
  private markerScale(id: number, target: number, now: number): number {
    const previous = this.effectScale.get(id);
    if (this.reducedMotion || !previous) {
      this.effectScale.set(id, { from: target, to: target, startedAt: now });
      return target;
    }
    const progress = Math.max(0, Math.min(1, (now - previous.startedAt) / EFFECT_RESIZE_MS));
    const eased = progress * progress * (3 - 2 * progress);
    const current = previous.from + (previous.to - previous.from) * eased;
    if (previous.to !== target) {
      this.effectScale.set(id, { from: current, to: target, startedAt: now });
      return current;
    }
    return current;
  }

  private effect(view: MapCamera, effect: Effect, hovered: boolean, scale: number): void {
    const { ctx, theme } = this;
    const { type, lon, lat, remainingHours: remaining } = effect;
    const [rx] = view.kmRadiiPx(effect.radiusKm, lat);
    const color = theme.fx[type];
    each(view, lon, lat, hovered ? rx + 32 : 32, this.w, this.h, (x, y, a) => {
      ctx.save();
      if (hovered) {
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.12 * a;
        ctx.beginPath(); groundCircle(view, ctx, lon, lat, effect.radiusKm, 'fill'); ctx.fill();
        ctx.globalAlpha = 0.9 * a;
        ctx.lineWidth = 1.5;
        ctx.setLineDash([7, 5]);
        ctx.beginPath(); groundCircle(view, ctx, lon, lat, effect.radiusKm, 'stroke'); ctx.stroke();
        ctx.setLineDash([]);
      }
      const opacity = 0.8 + (scale - 0.75) * 0.8;
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = 0.95 * opacity * a;
      this.glyph(type, 0, 0, 8, color, lat < 0);
      ctx.font = `600 10px ${theme.mono}`;
      ctx.textAlign = 'center';
      this.halo(`${Math.ceil(remaining)}h`, 0, 22, color, opacity * a);
      ctx.restore();
    });
  }

  /** Small tool glyph centred on (x, y); `size` is the half-extent. */
  glyph(type: ToolType, x: number, y: number, size: number, color: string, southern = false): void {
    const { ctx, theme } = this;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.7;
    ctx.lineCap = 'round';
    if (type === 'warm' || type === 'cool') {
      for (const dy of [0.55, 1.1]) {
        ctx.beginPath();
        for (let i = 0; i <= 8; i++) {
          const px = x - size + (i / 8) * size * 2;
          const py = y + dy * size * 0.8 + Math.sin((i / 8) * TAU * 1.5) * size * 0.28;
          if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.beginPath(); ctx.roundRect(x - size * 0.2, y - size * 1.3, size * 0.4, size * 1.45, size * 0.2); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y + size * 0.12, size * 0.37, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - size * (type === 'warm' ? 0.85 : 0.4)); ctx.lineTo(x, y + size * 0.15); ctx.stroke();
      if (type === 'warm') {
        const px = x + size * 0.75, py = y - size * 0.7, arm = size * 0.22;
        ctx.beginPath(); ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm); ctx.stroke();
      }
    } else if (type === 'warm-air' || type === 'cold-air') {
      ctx.beginPath(); ctx.arc(x, y + size * 0.65, size * 0.45, 0, TAU); ctx.stroke();
      ctx.beginPath(); ctx.roundRect(x - size * 0.22, y - size, size * 0.44, size * 1.35, size * 0.2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x, y - size * 0.45); ctx.lineTo(x, y + size * 0.65); ctx.stroke();
      if (type === 'warm-air') {
        const px = x + size * 0.75, py = y - size * 0.5, arm = size * 0.22;
        ctx.beginPath(); ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py);
        ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm); ctx.stroke();
      }
    } else if (type === 'updraft' || type === 'downdraft') {
      if (type === 'downdraft') { ctx.translate(x, y); ctx.scale(1, -1); ctx.translate(-x, -y); }
      for (const dx of [-0.8, 0, 0.8]) {
        const top = y - size * (dx === 0 ? 1.2 : 0.6);
        const sx = x + dx * size;
        ctx.beginPath(); ctx.moveTo(sx, y + size); ctx.lineTo(sx, top);
        ctx.moveTo(sx - size * 0.3, top + size * 0.35); ctx.lineTo(sx, top); ctx.lineTo(sx + size * 0.3, top + size * 0.35); ctx.stroke();
      }
    } else if (type === 'low-shear' || type === 'high-shear') {
      // Layered upper flow: level, aligned lines when calm; offset layers with opposing arrow tips when sheared.
      const strong = type === 'high-shear';
      [-1, 0, 1].forEach(row => {
        const dir = row === 0 ? 1 : row;
        const py = y + row * size * 0.8;
        const shift = strong ? row * size * 0.45 : 0;
        const tip = x + dir * size + shift;
        ctx.beginPath();
        ctx.moveTo(x - dir * size + shift, py); ctx.lineTo(tip, py);
        if (strong) { ctx.moveTo(tip - dir * size * 0.35, py - size * 0.3); ctx.lineTo(tip, py); ctx.lineTo(tip - dir * size * 0.35, py + size * 0.3); }
        ctx.stroke();
      });
    } else if (type === 'moisture' || type === 'dry') {
      ctx.beginPath();
      ctx.moveTo(x, y - size * 1.1);
      ctx.bezierCurveTo(x + size * 1.1, y + size * 0.1, x + size * 0.75, y + size * 1.05, x, y + size * 1.05);
      ctx.bezierCurveTo(x - size * 0.75, y + size * 1.05, x - size * 1.1, y + size * 0.1, x, y - size * 1.1);
      ctx.stroke();
      if (type === 'dry') { ctx.beginPath(); ctx.moveTo(x - size, y + size); ctx.lineTo(x + size, y - size); ctx.stroke(); }
    } else if (type === 'unstable-air' || type === 'stable-air') {
      if (type === 'stable-air') {
        for (const dy of [-0.75, 0, 0.75]) { ctx.beginPath(); ctx.moveTo(x - size, y + dy * size); ctx.lineTo(x + size, y + dy * size); ctx.stroke(); }
      } else {
        for (const dx of [-0.7, 0, 0.7]) {
          const sx = x + dx * size;
          ctx.beginPath(); ctx.moveTo(sx, y + size); ctx.bezierCurveTo(sx - 4, y + size * 0.4, sx + 4, y - size * 0.4, sx, y - size); ctx.stroke();
        }
      }
    } else {
      // Lows turn counter-clockwise and highs clockwise in the north; the south is reversed.
      const ccw = (type === 'low') !== southern;
      ctx.beginPath();
      ctx.arc(x, y, size * 1.15, 0, TAU);
      ctx.stroke();
      ctx.font = `700 ${Math.round(size * 1.35)}px ${theme.font}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(type === 'low' ? 'L' : 'H', x, y + 0.5);
      const a0 = -Math.PI / 2;
      const dir = ccw ? -1 : 1;
      const a1 = a0 + dir * 0.6;
      const r = size * 1.15;
      const tx = x + Math.cos(a1) * r;
      const ty = y + Math.sin(a1) * r;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx + Math.cos(a1 + dir * 2.2) * 5, ty + Math.sin(a1 + dir * 2.2) * 5);
      ctx.lineTo(tx + Math.cos(a1 - dir * 0.9 + dir * 2.2) * 5, ty + Math.sin(a1 - dir * 0.9 + dir * 2.2) * 5);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private candidate(view: MapCamera, lon: number, lat: number, hours: number, now: number): void {
    const { ctx, theme } = this;
    const [rx] = view.kmRadiiPx(280, lat);
    const ax = Math.max(rx, 8);
    each(view, lon, lat, ax + 80, this.w, this.h, (x, y, a) => {
      ctx.save();
      ctx.strokeStyle = theme.storm;
      ctx.globalAlpha = 0.85 * a;
      ctx.lineWidth = 1.4;
      ctx.setLineDash([2, 4]);
      ctx.lineDashOffset = -(now / 120) % 6;
      ctx.beginPath();
      groundCircle(view, ctx, lon, lat, 280, 'stroke', 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = theme.storm;
      ctx.beginPath(); ctx.arc(x, y, 2.5, 0, TAU); ctx.fill();
      ctx.font = `600 11px ${theme.font}`;
      ctx.textAlign = 'left';
      this.halo(`Forming · ${Math.min(99, Math.floor((hours / GENESIS_HOURS) * 100))}%`, x + ax + 5, y + 4, theme.ink, a);
      ctx.restore();
    });
  }

  private thunderstorm(view: MapCamera, storm: Thunderstorm): void {
    const { ctx, theme } = this;
    if (storm.tornadoTrack && storm.tornadoTrack.length > 1) {
      ctx.save();
      ctx.strokeStyle = theme.warn;
      ctx.globalAlpha = storm.tornado ? 0.75 : 0.4;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      let run: [number, number][] = [];
      const drawRun = () => {
        if (!run.length) return;
        ctx.moveTo(run[0][0], run[0][1]);
        for (let i = 1; i < run.length - 1; i++) {
          ctx.quadraticCurveTo(run[i][0], run[i][1], (run[i][0] + run[i + 1][0]) / 2, (run[i][1] + run[i + 1][1]) / 2);
        }
        if (run.length > 1) ctx.lineTo(run[run.length - 1][0], run[run.length - 1][1]);
        run = [];
      };
      for (const point of storm.tornadoTrack) {
        const px = view.lonLatToPx(point.lon, point.lat);
        const previous = run[run.length - 1];
        if (!px || (previous && Math.hypot(px[0] - previous[0], px[1] - previous[1]) >= this.w / 2)) drawRun();
        if (px) run.push(px);
      }
      drawRun();
      ctx.stroke();
      ctx.restore();
    }
    const [rx] = view.kmRadiiPx(storm.radiusKm, storm.lat);
    each(view, storm.lon, storm.lat, Math.max(rx, 12) + 80, this.w, this.h, (x, y, a) => {
      ctx.save();
      ctx.fillStyle = theme.warn;
      ctx.strokeStyle = theme.warn;
      ctx.globalAlpha = (0.06 + storm.intensity * 0.1) * a;
      ctx.beginPath(); groundCircle(view, ctx, storm.lon, storm.lat, storm.radiusKm, 'fill', 8); ctx.fill();
      ctx.globalAlpha = 0.75 * a;
      ctx.lineWidth = 1;
      ctx.beginPath(); groundCircle(view, ctx, storm.lon, storm.lat, storm.radiusKm, 'stroke', 8);
      ctx.setLineDash([2, 4]); ctx.stroke(); ctx.setLineDash([]);
      ctx.globalAlpha = a;
      ctx.beginPath();
      if (storm.tornado) {
        ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y - 8);
        ctx.quadraticCurveTo(x + 3, y - 1, x + 1, y + 8);
        ctx.lineTo(x - 1, y + 8); ctx.quadraticCurveTo(x - 3, y - 1, x - 8, y - 8);
      } else {
        // Steady lightning glyph: readable at small scales without flashing.
        ctx.moveTo(x + 2, y - 9); ctx.lineTo(x - 5, y + 1); ctx.lineTo(x, y + 1);
        ctx.lineTo(x - 2, y + 9); ctx.lineTo(x + 6, y - 2); ctx.lineTo(x + 1, y - 2);
      }
      ctx.closePath(); ctx.fill();
      if (view.scale >= 8) {
        ctx.font = `500 11px ${theme.font}`;
        ctx.textAlign = 'left';
        this.halo(`${translate(storm.tornado ? 'Tornado' : 'Thunderstorm')} · ${storm.gustMs.toFixed(0)} m/s`, x + 11, y + 4, theme.warn, a);
      }
      ctx.restore();
    });
  }

  /** Pass 1 for a storm: places its label beside each copy of the glyph, claims the rectangles, and returns the layout to draw later. */
  private stormLayout(view: MapCamera, s: Storm, selected: boolean): StormSpot[] {
    const { ctx, theme } = this;
    const [galeX] = view.kmRadiiPx(s.galeRadiusKm, s.lat);
    const R = stormGlyphRadius(s);
    const spots: StormSpot[] = [];
    each(view, s.lon, s.lat, Math.max(galeX, R) + 120, this.w, this.h, (x, y, a) => {
      ctx.save();
      ctx.font = `600 12px ${theme.font}`;
      const labels = [
        `${s.name ? translate(s.name) : `#${s.id}`} · ${translate(stormGradeLabel(s))}${selected ? ` · ${translate(s.stage)}` : ''}`,
        `${translate('Radius')} ${s.galeRadiusKm.toFixed(0)} km · ${translate('Moving')} ${s.movementSpeedKmh.toFixed(1)} km/h`,
      ];
      const tw = Math.max(...labels.map(label => ctx.measureText(label).width));
      ctx.restore();
      // Keep both lines inside the viewport, flipping beside the glyph when needed.
      const flip = x + R + 6 + tw > this.w - 4 && x - R - 6 - tw > 4;
      const lx = flip ? x - R - 6 : Math.min(x + R + 6, this.w - 4 - tw);
      const ly = Math.min(this.h - 24, Math.max(14, y + 4));
      const labelX = Math.max(flip ? tw + 4 : 4, lx);
      this.occ.add([x - R * 1.5, y - R * 1.5, x + R * 1.5, y + R * 1.5]);
      this.occ.add([flip ? labelX - tw : labelX, ly - 12, flip ? labelX : labelX + tw, ly + 20]);
      spots.push({ x, y, a, labels, flip, labelX, ly });
    });
    return spots;
  }

  private storm(view: MapCamera, s: Storm, selected: boolean, now: number, spots: StormSpot[] = this.stormLayout(view, s, selected)): void {
    const { ctx, theme } = this;
    const [, galeY] = view.kmRadiiPx(s.galeRadiusKm, s.lat);
    const [, rmwY] = view.kmRadiiPx(s.radiusKm, s.lat);
    const R = stormGlyphRadius(s);
    const rank = stageRank(s.wind);
    const dir = s.lat >= 0 ? 1 : -1;
    const rot = (now / 1800) % TAU;
    for (const { x, y, a, labels, flip, labelX, ly } of spots) {
      ctx.save();
      ctx.strokeStyle = theme.storm;
      if (galeY > 6) {
        ctx.globalAlpha = 0.5 * a;
        ctx.lineWidth = 1.25;
        ctx.setLineDash([5, 5]);
        ctx.beginPath(); groundCircle(view, ctx, s.lon, s.lat, s.galeRadiusKm, 'stroke'); ctx.stroke();
        ctx.setLineDash([]);
        if (rmwY > 4) { ctx.globalAlpha = 0.8 * a; ctx.beginPath(); groundCircle(view, ctx, s.lon, s.lat, s.radiusKm, 'stroke'); ctx.stroke(); }
      }
      ctx.globalAlpha = a;
      if (selected) {
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, R + 5, 0, TAU); ctx.stroke();
        ctx.strokeStyle = theme.storm;
      }
      this.cycloneSymbol(x, y, R, rank, dir, rot, a);
      ctx.font = `600 12px ${theme.font}`;
      ctx.textAlign = flip ? 'right' : 'left';
      labels.forEach((label, i) => this.halo(label, labelX, ly + i * 16, theme.ink, a));
      ctx.restore();
    }
  }

  /**
   * The cyclone symbol at (x, y): a solid ring with a hollow eye and two tails that leave it tangentially
   * on opposite sides. A depression is a thinner ring with no tails, a storm gets short tails, a typhoon full ones.
   * Drawn for the northern (counter-clockwise) sense; `dir` -1 mirrors it for the south, `rot` spins it.
   */
  private cycloneSymbol(x: number, y: number, R: number, rank: number, dir: number, rot: number, alpha = 1): void {
    const { ctx, theme } = this;
    const hole = rank < 1 ? 0.6 : 0.41;
    const f = rank < 1 ? 0 : rank < 3 ? 0.5 : 1;
    // Canvas point for polar (r in units of R, degrees counter-clockwise from +x) turned by `off` degrees.
    const P = (r: number, deg: number, off: number): [number, number] => {
      const a = (deg + off) * Math.PI / 180;
      return [R * r * Math.cos(a), -R * r * Math.sin(a)];
    };
    const ring = new Path2D();
    ring.arc(0, 0, R, 0, TAU);
    ring.moveTo(R * hole, 0);
    ring.arc(0, 0, R * hole, 0, TAU, true);
    const tails = new Path2D();
    if (f > 0) {
      for (const off of [0, 180]) {
        const S = P(1, 115, off); // the outer edge leaves the ring here, heading clockwise
        const N = P(1, 55, off); // the inner edge rejoins the ring here
        const T = P(1 + 0.6 * f, 55 - 32 * f, off);
        const lead = R * (0.4 + 0.45 * f);
        const a = (115 + off) * Math.PI / 180;
        const droop = (off * Math.PI) / 180;
        tails.moveTo(S[0], S[1]);
        tails.bezierCurveTo(
          S[0] + Math.sin(a) * lead, S[1] + Math.cos(a) * lead,
          T[0] - Math.cos(droop) * 0.5 * R * f, T[1] - Math.sin(droop) * 0.5 * R * f - 0.28 * R * f * Math.cos(droop),
          T[0], T[1]);
        tails.quadraticCurveTo((T[0] + N[0]) / 2, (T[1] + N[1]) / 2, N[0], N[1]);
        tails.closePath();
      }
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(dir, 1);
    ctx.rotate(-rot);
    ctx.lineJoin = 'round';
    // A dark outline keeps the symbol readable over bright rain and land.
    ctx.strokeStyle = theme.paper;
    ctx.globalAlpha = 0.6 * alpha;
    ctx.lineWidth = R <= 10 ? 3 : 4;
    ctx.stroke(ring);
    ctx.stroke(tails);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = theme.storm;
    ctx.fill(ring, 'evenodd');
    ctx.fill(tails);
    ctx.restore();
  }

  private cities(view: MapCamera, state: GameState | null, population: boolean, selected: string | null, reserved: Rect[] = [], showLabels = true): void {
    const { ctx, theme, w, h } = this;
    const impacts = new Map(state?.cities.map(c => [c.id, c]) ?? []);
    ctx.save();
    ctx.font = `500 12px ${theme.font}`;
    // Cities below the dot threshold are skipped unless selected or in the storm's wind. Labels are placed greedily (selected first, then largest) and skipped
    // when they would overlap one already placed, so the world view stays readable.
    const placed: Rect[] = [...reserved]; // starts with the rectangles that storm and isobar labels have claimed
    const zoom = webZoom(view);
    const dotMin = minPopForDot(zoom);
    const order = selected ? [...CITIES.filter(c => c.id === selected), ...CITIES.filter(c => c.id !== selected)] : CITIES; // CITIES is largest first
    for (const c of order) {
      each(view, c.lon, c.lat, 30, w, h, (x, y, a) => {
        const impact = impacts.get(c.id);
        const ratio = impact ? impact.damage / c.population : 0;
        const exposed = impact !== undefined && impact.exposedPopulation > 0;
        const color = ratio >= 0.05 ? theme.danger : ratio >= 0.005 ? theme.warn : exposed ? theme.accent : theme.ink;
        const labelled = c.id === selected || exposed || cityLabelEligible(c.population, zoom);
        if (!labelled && c.population < dotMin) return; // small cities in a wide view draw neither dot nor label
        const r = labelled ? (population ? 2.5 + Math.sqrt(c.population / 1e6) * 0.9 : 3) : 2.2; // unlabelled dots stay small so a thousand cities do not blot out the map
        const lossUsd = impact ? estimateCityDamage(c, impact).lossUsd : 0;
        const text = lossUsd > 0 ? `${cityLabel(c)} · ${fmtMoneyCompact(lossUsd)}` : cityLabel(c);
        const showLabel = labelled && (showLabels || c.id === selected);
        const tw = showLabel ? ctx.measureText(text).width : 0;
        ctx.fillStyle = color;
        ctx.strokeStyle = theme.paper;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = a;
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
        this.occ.add([x - r - 2, y - r - 2, x + r + 2, y + r + 2]);
        if (c.id === selected) {
          ctx.strokeStyle = theme.accent;
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, y, r + 5, 0, TAU); ctx.stroke();
        }
        if (a < 1 || !showLabel) return; // labels need z >= 0.3: near the limb only the dot is drawn
        let chosen: { x: number; right: boolean } | null = null;
        for (const cand of [{ right: false, x: x + r + 5 }, { right: true, x: x - r - 5 }]) {
          const left = cand.right ? cand.x - tw : cand.x;
          const rect: [number, number, number, number] = [left, y - 9, left + tw, y + 5];
          if (rect[0] < 2 || rect[2] > w - 2 || rect[1] < 2 || rect[3] > h - 2) continue;
          if (placed.some(p => rect[0] < p[2] && rect[2] > p[0] && rect[1] < p[3] && rect[3] > p[1])) continue;
          placed.push(rect);
          this.occ.add(rect);
          chosen = cand;
          break;
        }
        if (!chosen && c.id === selected) {
          const right = x + r + 5 + tw > w - 2;
          chosen = { right, x: right ? x - r - 5 : x + r + 5 };
          this.occ.add(right ? [chosen.x - tw, y - 9, chosen.x, y + 5] : [chosen.x, y - 9, chosen.x + tw, y + 5]);
        }
        if (chosen) {
          ctx.textAlign = chosen.right ? 'right' : 'left';
          this.halo(text, chosen.x, y + 4, c.id === selected ? theme.accent : theme.ink);
        }
      });
    }
    ctx.restore();
  }

  /** Italic, letter-spaced sea, ocean and lake names centred on open water; no halo. Each is dropped when it would overlap a label already placed. */
  private seaLabels(view: MapCamera): void {
    const { ctx, theme, w, h } = this;
    const lang = getLanguage();
    const spacing = 'letterSpacing' in ctx;
    ctx.save();
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (spacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.12em';
    const label = (lon: number, lat: number, rank: 0 | 1 | 2 | 3, name: string): void => {
      // a < 0.32 is z < 0.15: too close to the globe's limb to read.
      each(view, lon, lat, 200, w, h, (x, y, a) => {
        if (a < 0.32) return;
        ctx.font = `italic 500 ${SEA_SIZE[rank]}px ${theme.font}`;
        const text0 = rank === 0 ? name.toUpperCase() : name;
        const text = spacing ? text0 : [...text0].join('\u200A');
        const tw = ctx.measureText(text).width;
        const size = SEA_SIZE[rank];
        // Centred on the anchor; when a city or isobar label is in the way, nudge a little to find open water.
        for (const [dx, dy] of SEA_NUDGES) {
          const cx = x + dx * size;
          const cy = y + dy * size;
          const rect: Rect = [cx - tw / 2 - 2, cy - size * 0.7, cx + tw / 2 + 2, cy + size * 0.7];
          if (rect[0] < 2 || rect[2] > w - 2 || rect[1] < 2 || rect[3] > h - 2 || !this.occ.place(rect)) continue;
          ctx.globalAlpha = (rank < 2 ? 0.9 : 0.75) * a;
          ctx.fillText(text, cx, cy);
          return;
        }
      });
    };
    for (const sea of visibleSeas(view, lang)) label(sea.lon, sea.lat, sea.rank, seaName(sea, lang));
    // Lakes use the same style and yield to everything placed so far, seas included.
    for (const lake of visibleLakes(view, lang)) label(lake.lon, lake.lat, lake.rank, lakeName(lake, lang));
    ctx.restore();
  }

  /** Italic river names (scalerank <= 2) set along the river on its longest on-screen run, kept upright; one per river, each dropped when it would overlap a label already placed. */
  private riverLabels(view: MapCamera): void {
    if (webZoom(view) < RIVER_LABEL_MIN_ZOOM) return;
    const { ctx, theme, w, h } = this;
    const lang = getLanguage();
    const size = 10;
    const margin = 24;
    const spacing = 'letterSpacing' in ctx;
    ctx.save();
    ctx.font = `italic 500 ${size}px ${theme.font}`;
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (spacing) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.08em';
    for (const river of RIVERS) {
      if (river.scalerank > 2) break; // RIVERS is sorted by scalerank
      const name = riverName(river, lang);
      const text = spacing ? name : [...name].join('\u200A');
      const tw = ctx.measureText(text).width;
      // The longest run of consecutive vertices on screen (not across the map's edge meridian or the globe's limb), as pixels with cumulative length.
      let best: { p: number[]; cum: number[] } | null = null;
      for (const line of river.lines) {
        let p: number[] = []; let cum: number[] = [];
        const flush = (): void => {
          if (cum.length > 1 && (!best || cum[cum.length - 1] > best.cum[best.cum.length - 1])) best = { p, cum };
          p = []; cum = [];
        };
        for (let i = 0; i < line.length; i++) {
          view.projectZ(line[i][0], line[i][1], P);
          const x = P[0]; const y = P[1];
          if ((i > 0 && edgeBetween(line[i - 1][0], line[i][0])) || P[2] < 0.25 || x < margin || x > w - margin || y < margin || y > h - margin) flush();
          if (P[2] < 0.25 || x < margin || x > w - margin || y < margin || y > h - margin) continue;
          cum.push(cum.length ? cum[cum.length - 1] + Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) : 0);
          p.push(x, y);
        }
        flush();
      }
      const run = best as { p: number[]; cum: number[] } | null;
      if (!run) continue;
      const total = run.cum[run.cum.length - 1];
      if (total < tw + 24) continue;
      const pointAt = (d: number): [number, number] => {
        d = Math.max(0, Math.min(total, d));
        let i = 1;
        while (i < run.cum.length - 1 && run.cum[i] < d) i++;
        const t = (d - run.cum[i - 1]) / (run.cum[i] - run.cum[i - 1] || 1);
        return [run.p[2 * i - 2] + (run.p[2 * i] - run.p[2 * i - 2]) * t, run.p[2 * i - 1] + (run.p[2 * i + 1] - run.p[2 * i - 1]) * t];
      };
      // From the middle of the run outwards, 12 px at a time.
      const step = 12;
      for (let k = 0; k <= total / step; k++) {
        const d = total / 2 + (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * step;
        if (d < tw / 2 + 4 || d > total - tw / 2 - 4) continue;
        const [x, y] = pointAt(d);
        const [ax, ay] = pointAt(d - tw / 2);
        const [bx, by] = pointAt(d + tw / 2);
        let angle = Math.atan2(by - ay, bx - ax);
        if (Math.abs(angle) > Math.PI / 2) angle += Math.PI;
        // A slanted label claims a staircase of small rectangles along its baseline, not one big box that would block the diagonal's corners.
        const cos = Math.cos(angle); const sin = Math.sin(angle);
        const pieces = Math.ceil(tw / 14);
        const hw = (Math.abs(cos) * (tw / pieces) + Math.abs(sin) * size * 1.4) / 2 + 1; const hh = (Math.abs(sin) * (tw / pieces) + Math.abs(cos) * size * 1.4) / 2;
        const rects = Array.from({ length: pieces }, (_, i): Rect => {
          const along = ((i + 0.5) / pieces - 0.5) * tw;
          const cx = x + along * cos; const cy = y + along * sin;
          return [cx - hw, cy - hh, cx + hw, cy + hh];
        });
        if (!rects.every(r => this.occ.fits(r))) continue;
        for (const r of rects) this.occ.add(r);
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(angle);
        ctx.globalAlpha = 0.8;
        ctx.fillText(text, 0, 0);
        ctx.restore();
        break;
      }
    }
    ctx.restore();
  }

  /** Small dots with muted labels for the display-only places layer; a place whose label collides with an earlier one is dropped with its dot. Pinned places (Ulleungdo, Dokdo) go first so thinning never drops them. */
  private places(view: MapCamera, showLabels = true): void {
    const { ctx, theme, w, h } = this;
    const lang = getLanguage();
    ctx.save();
    ctx.font = `500 10.5px ${theme.font}`;
    ctx.textAlign = 'left';
    ctx.lineWidth = 3;
    const draw = (p: { lon: number; lat: number }, name: string): void => {
      each(view, p.lon, p.lat, 30, w, h, (x, y, a) => {
        if (a < 1) return;
        if (!showLabels) {
          ctx.globalAlpha = 0.8;
          ctx.fillStyle = theme.ink;
          ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
          return;
        }
        const tw = ctx.measureText(name).width;
        const rect: Rect = [x + 4, y - 8, x + 6 + tw, y + 4];
        if (rect[0] < 2 || rect[2] > w - 2 || rect[1] < 2 || rect[3] > h - 2) return;
        if (!this.occ.place(rect)) return;
        ctx.globalAlpha = 0.8;
        ctx.fillStyle = theme.ink;
        ctx.beginPath(); ctx.arc(x, y, 1.8, 0, TAU); ctx.fill();
        ctx.globalAlpha = 0.7;
        ctx.strokeStyle = theme.paper;
        ctx.strokeText(name, x + 5, y + 3);
        ctx.globalAlpha = 0.9;
        ctx.fillStyle = theme.muted;
        ctx.fillText(name, x + 5, y + 3);
      });
    };
    if (webZoom(view) >= PINNED_PLACE_MIN_ZOOM) for (const p of PINNED_PLACES) draw(p, pinnedPlaceName(p, lang));
    for (const p of visiblePlaces(view, lang)) draw(p, placeName(p, lang));
    ctx.restore();
  }

  /** Dashed ring (about 40 px) with a short label, so the tutorial can point at a spot on the map. */
  private tutorialMarker(view: MapCamera, at: GeoPoint, now: number): void {
    const { ctx, theme, w } = this;
    each(view, at.lon, at.lat, 60, w, this.h, (x, y, a) => {
      const r = 40 + Math.sin(now / 280) * 3;
      ctx.save();
      ctx.strokeStyle = theme.accent;
      ctx.fillStyle = theme.accent;
      ctx.globalAlpha = 0.14 * a;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.globalAlpha = a;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -(now / 90) % 14;
      ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(x, y, 3, 0, TAU); ctx.fill();
      ctx.font = `600 12px ${theme.font}`;
      const text = translate('Drop here');
      const tw = ctx.measureText(text).width + 16;
      const lx = Math.max(6, Math.min(w - tw - 6, x - tw / 2));
      const ly = y - r - 30 < 8 ? y + r + 8 : y - r - 30;
      ctx.fillStyle = theme.paper;
      ctx.globalAlpha = 0.92 * a;
      ctx.beginPath(); ctx.roundRect(lx, ly, tw, 22, 4); ctx.fill();
      ctx.globalAlpha = a;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = theme.accent;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lx + 8, ly + 11.5);
      ctx.restore();
    });
  }

  private targetPreview(view: MapCamera, o: MapOverlay, now: number): void {
    const { ctx, theme, w } = this;
    const tool = o.tool!;
    const t = o.target!;
    const [rx] = view.kmRadiiPx(tool.radiusKm, t.lat);
    const color = theme.accent;
    const showRange = o.dragging || o.hover !== null;
    each(view, t.lon, t.lat, showRange ? rx + 20 : 20, w, this.h, (x, y, a) => {
      ctx.save();
      ctx.strokeStyle = color;
      let top = y;
      let bottom = y;
      if (showRange) {
        ctx.globalAlpha = 0.12 * a;
        ctx.fillStyle = color;
        ctx.beginPath(); groundCircle(view, ctx, t.lon, t.lat, tool.radiusKm, 'fill'); ctx.fill();
        ctx.globalAlpha = a;
        ctx.lineWidth = 2;
        ctx.setLineDash([7, 5]);
        ctx.lineDashOffset = -(now / 90) % 12;
        ctx.beginPath(); [top, bottom] = groundCircle(view, ctx, t.lon, t.lat, tool.radiusKm, 'stroke'); ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = a;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + dx * 5, y + dy * 5); ctx.lineTo(x + dx * 13, y + dy * 13); }
      ctx.stroke();
      if (!showRange) { ctx.restore(); return; }
      ctx.font = `600 12px ${theme.font}`;
      const text = `${translate(tool.name)} · ${tool.radiusKm} km`;
      const tw = ctx.measureText(text).width + 16;
      let ly = y - Math.min(y - top, 400) - 30;
      if (ly < 8) ly = y + Math.min(bottom - y, 400) + 10;
      const lx = Math.max(6, Math.min(w - tw - 6, x - tw / 2));
      ctx.fillStyle = theme.paper;
      ctx.globalAlpha = 0.92 * a;
      ctx.beginPath(); ctx.roundRect(lx, ly, tw, 22, 4); ctx.fill();
      ctx.globalAlpha = a;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, lx + 8, ly + 11.5);
      ctx.restore();
    });
  }
}
