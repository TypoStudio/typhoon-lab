import { BOUNDS, GRID_COLS, GRID_ROWS, GRID_STEP, isLand } from '../simulation/engine';
import { DEFAULT_MAP_OVERLAYS, type GameState, type MapOverlays } from '../types';
import type { BaseRenderer } from './base';
import { CanvasBase } from './canvas2d';
import { buildContours, buildFieldData, buildCombinedImage, sampleGrid, type Contours, type FieldData } from './fields';
import { DEFAULT_LABELS, EMPTY_OVERLAY, OverlayPainter, type MapLabels, type MapOverlay } from './overlay';
import { ParticleSystem } from './particles';
import { loadTheme, type Theme } from './theme';
import type { MapCamera, MapMode } from './camera';
import { GlobeView } from './globe-view';
import { FlatView, edgeBetween, wrapLon } from './view';
import { ThreeBase } from './webgl';

export interface RenderStats {
  kind: 'webgl' | 'canvas';
  fps: number;
  particles: number;
  /** True when the particle budget was lowered because frames were slow. */
  reduced: boolean;
  lost: boolean;
}

const MIN_PARTICLES = 1200;
/** Frames slower than this count toward lowering the particle budget. */
const SLOW_FRAME_MS = 34;
/** Real time spent slow before the budget drops one step. */
const SLOW_BUDGET_MS = 2500;
/** Longer gaps are tab suspension or debugger pauses, not rendering cost. */
const SUSPENSION_MS = 2000;

/**
 * Map facade used by the UI. A base layer (Three.js WebGL2, or Canvas 2D when WebGL is not
 * available) draws sea, land, the data layer and wind streaks; a transparent Canvas 2D overlay on
 * top draws coastline, labels, tracks, forecasts, effects, storms and the placement preview.
 */
export class MapRenderer {
  private readonly flat = new FlatView();
  private readonly globe = new GlobeView();
  private current: MapCamera = this.globe;
  readonly theme: Theme;
  readonly kind: 'webgl' | 'canvas';
  /** Why WebGL was not used, or null. */
  readonly fallbackReason: string | null;
  readonly baseCanvas: HTMLCanvasElement;
  readonly overlayCanvas: HTMLCanvasElement;
  onLostChange: ((lost: boolean) => void) | null = null;

  private base: BaseRenderer;
  private readonly overlayPainter: OverlayPainter;
  private readonly particles = new ParticleSystem();
  private readonly observer: ResizeObserver;
  private readonly reducedMotion: MediaQueryList;
  private state: GameState | null = null;
  private overlays: MapOverlays = { ...DEFAULT_MAP_OVERLAYS };
  private overlay: MapOverlay = EMPTY_OVERLAY;
  private labels: Partial<MapLabels> = {};
  /** `overlay` with the renderer's label flags merged in; rebuilt only when either changes. */
  private drawOverlay: MapOverlay = EMPTY_OVERLAY;
  private field: FieldData | null = null;
  private image: Uint8Array | null = null;
  private contours: Contours | null = null;
  private contoursDirty = true;
  private dpr = 1;
  private lastFrame = 0;
  private ema = 16;
  private slowMs = 0;
  private fpsShown = 0;
  private fpsAt = 0;
  private reduced = false;
  private maxParticles: number;
  private lostFlag = false;
  private viewVersion = -1;
  private interacting = false;
  private frozenNow = 0;
  private lastNow = 0;
  private reseedAfterGesture = false;
  private modeVersion = 0;
  private lastModeVersion = -1;

  constructor(private readonly stage: HTMLElement, options: { forceCanvas?: boolean } = {}) {
    this.theme = loadTheme();
    let canvas = this.makeCanvas('map-canvas map-canvas--base');
    stage.prepend(canvas);
    let base: BaseRenderer | null = null;
    let reason: string | null = null;
    if (options.forceCanvas) reason = 'Canvas renderer requested.';
    else {
      try {
        base = new ThreeBase(canvas, this.theme);
      } catch (error) {
        reason = error instanceof Error ? error.message : 'WebGL is not available.';
        // A canvas that failed to create a WebGL context may be unusable for 2D; use a fresh one.
        const fresh = this.makeCanvas('map-canvas map-canvas--base');
        stage.replaceChild(fresh, canvas);
        canvas = fresh;
      }
    }
    base ??= new CanvasBase(canvas);
    this.base = base;
    this.kind = base.kind;
    this.fallbackReason = base.kind === 'canvas' ? reason ?? 'WebGL is not available.' : null;
    this.baseCanvas = canvas;
    this.overlayCanvas = this.makeCanvas('map-canvas map-canvas--overlay');
    stage.insertBefore(this.overlayCanvas, canvas.nextSibling);
    this.overlayPainter = new OverlayPainter(this.overlayCanvas, this.theme);

    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.overlayPainter.reducedMotion = this.reducedMotion.matches;
    const coarse = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 700;
    this.maxParticles = this.kind === 'webgl' ? (coarse ? 6000 : 14000) : (coarse ? 1500 : 3500);
    this.particles.resize(this.maxParticles);

    canvas.addEventListener('webglcontextlost', () => { this.lostFlag = true; this.onLostChange?.(true); });
    canvas.addEventListener('webglcontextrestored', () => { this.lostFlag = false; this.pushImage(); this.onLostChange?.(false); });

    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(stage);
    this.resize();
    this.stage.dataset.map = this.mode;
  }

  /** Active camera. Do not hold on to it: it changes when the map mode changes. */
  get view(): MapCamera { return this.current; }

  get mode(): MapMode { return this.current.kind; }

  /** Switches between the globe and the flat map, carrying the camera over. The canvas renderer is flat only. */
  setMode(mode: MapMode): void {
    const next = this.kind === 'canvas' || mode === 'flat' ? this.flat : this.globe;
    const prev = this.current;
    if (next === prev) return;
    if (prev.isAtHome) next.reset();
    else {
      next.centerOn(...prev.centerLonLat());
      next.zoomAt(prev.scale / next.scale, next.width / 2, next.height / 2);
    }
    this.current = next;
    this.modeVersion++;
    this.stage.dataset.map = next.kind;
    this.reseed();
  }

  /** Home view for both cameras, so switching modes keeps the same starting point. */
  setHome(lon: number, lat: number, span: number): void {
    this.flat.setHome(lon, lat, span);
    this.globe.setHome(lon, lat, span);
  }

  private visibleTest(): ((lon: number, lat: number) => boolean) | undefined {
    const v = this.current;
    return v.kind === 'globe' ? (lon, lat) => v.projectZ(lon, lat)[2] > 0 : undefined;
  }

  private reseed(): void {
    this.particles.reseed(this.current.visibleBounds(), this.visibleTest());
  }

  private makeCanvas(className: string): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.className = className;
    c.setAttribute('aria-hidden', 'true');
    return c;
  }

  resize(): void {
    const w = Math.max(1, Math.round(this.overlayCanvas.clientWidth || this.stage.clientWidth));
    const h = Math.max(1, Math.round(this.overlayCanvas.clientHeight || this.stage.clientHeight));
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.flat.resize(w, h);
    this.globe.resize(w, h);
    this.base.resize(w, h, this.dpr);
    this.overlayPainter.resize(w, h, this.dpr);
    this.reseed();
  }

  setState(state: GameState): void {
    // Rebuild for every new worker state object: tick and counts alone cannot tell two snapshots apart.
    if (state === this.state) return;
    this.state = state;
    this.field = buildFieldData(state.grid);
    this.contoursDirty = true;
    this.pushImage();
  }

  setOverlays(overlays: MapOverlays): void {
    const rasterChanged = this.overlays.temperature !== overlays.temperature || this.overlays.population !== overlays.population;
    this.overlays = { ...overlays };
    if (rasterChanged) this.pushImage();
  }

  setOverlay(overlay: MapOverlay): void { this.overlay = overlay; this.mergeOverlay(); }

  /** Shows or hides label layers; keys not given keep their value. Takes effect on the next frame. */
  setLabels(labels: Partial<MapLabels>): void { this.labels = { ...this.labels, ...labels }; this.mergeOverlay(); }

  /** Legacy name for `setLabels({ recordedPaths })`. */
  setShowRecordedPaths(on: boolean): void { this.setLabels({ recordedPaths: on }); }

  get currentLabels(): Readonly<MapLabels> { return { ...DEFAULT_LABELS, ...this.labels }; }

  private mergeOverlay(): void { this.drawOverlay = { ...this.overlay, labels: { ...this.overlay.labels, ...this.labels } }; }

  get currentOverlays(): Readonly<MapOverlays> { return { ...this.overlays }; }

  /** Interpolated grid values at a point, for the coordinate readout. Null before the first state. */
  sampleAt(lon: number, lat: number): { land: boolean; wind: number; pressure: number; temperature: number; airTemperature: number; updraft: number; humidity: number; rain: number; snow: number; snowCm: number; blizzard: boolean; population: number } | null {
    const f = this.field;
    if (!f || lat < BOUNDS.south || lat > BOUNDS.north) return null;
    const wl = wrapLon(lon);
    const i = Math.min(GRID_COLS - 1, Math.max(0, Math.floor((wl - BOUNDS.west) / GRID_STEP)));
    const j = Math.min(GRID_ROWS - 1, Math.max(0, Math.floor((lat - BOUNDS.south) / GRID_STEP)));
    return {
      land: isLand(wl, lat),
      wind: Math.hypot(sampleGrid(f, f.u, wl, lat), sampleGrid(f, f.v, wl, lat)),
      pressure: sampleGrid(f, f.pressure, wl, lat),
      temperature: sampleGrid(f, f.temperature, wl, lat),
      airTemperature: sampleGrid(f, f.airTemperature, wl, lat),
      updraft: sampleGrid(f, f.updraft, wl, lat),
      humidity: sampleGrid(f, f.humidity, wl, lat),
      rain: sampleGrid(f, f.rain, wl, lat),
      snow: sampleGrid(f, f.snow, wl, lat),
      snowCm: sampleGrid(f, f.snowCm, wl, lat),
      blizzard: f.blizzard[j * f.cols + i] === 1,
      population: f.population[j * f.cols + i],
    };
  }

  /** Tick of the state currently drawn (stays put while a gesture freezes the weather). */
  get renderedTick(): number { return this.state?.tick ?? -1; }
  get isInteracting(): boolean { return this.interacting; }

  /**
   * Freezes the weather picture while the camera is being moved (pan, pinch, wheel): no new state,
   * no particle motion, no animation clock. The camera itself keeps redrawing.
   */
  setInteracting(on: boolean): void {
    if (on === this.interacting) return;
    this.interacting = on;
    if (on) this.frozenNow = this.lastNow;
    else {
      if (this.reducedMotion.matches) this.reseedAfterGesture = true;
    }
  }

  pickStorm(px: number, py: number): number | null { return this.state ? this.overlayPainter.pickStorm(this.view, this.state.storms, px, py) : null; }

  pickCity(px: number, py: number): string | null { return this.overlayPainter.pickCity(this.view, px, py); }

  private pushImage(): void {
    if (!this.field) return;
    const { cols, rows } = this.field;
    if (!this.image || this.image.length !== cols * rows * 4) this.image = new Uint8Array(cols * rows * 4);
    buildCombinedImage(this.field, this.overlays, this.theme, this.image);
    this.base.setFieldImage(this.image, cols, rows);
  }

  private currentContours(): Contours | null {
    if (!this.overlays.pressure || !this.field) return null;
    if (this.contoursDirty || !this.contours) {
      this.contours = buildContours(this.field);
      this.contoursDirty = false;
    }
    return this.contours;
  }

  stats(): RenderStats {
    return { kind: this.kind, fps: this.fpsShown, particles: this.particles.count, reduced: this.reduced, lost: this.lostFlag || this.base.isLost() };
  }

  frame(now: number): void {
    // Real frame time drives the performance budget; the advection step is capped separately.
    const frameMs = this.lastFrame ? now - this.lastFrame : 16;
    const dt = Math.min(0.1, Math.max(0, frameMs / 1000));
    this.lastFrame = now;
    this.lastNow = now;
    if (!this.interacting) this.trackPerformance(frameMs);

    this.overlayPainter.reducedMotion = this.reducedMotion.matches;
    this.particles.frozen = this.reducedMotion.matches;
    const view = this.current;
    if (!this.interacting) {
      const changed = this.viewVersion !== view.version || this.lastModeVersion !== this.modeVersion;
      if (this.particles.frozen && (changed || this.reseedAfterGesture)) this.reseed();
      this.reseedAfterGesture = false;
      this.viewVersion = view.version;
      this.lastModeVersion = this.modeVersion;
      if (this.overlays.wind) {
        this.particles.update(dt, this.field, view.visibleBounds(), view.scale, this.visibleTest(), view.kind === 'flat' ? edgeBetween : undefined);
      }
    }

    this.stage.dataset.overlays = (Object.keys(this.overlays) as (keyof MapOverlays)[]).filter(key => this.overlays[key]).join(' ');
    const showWind = !!this.field && this.overlays.wind;
    this.stage.dataset.wind = showWind ? 'visible' : 'hidden';
    this.stage.dataset.humidity = this.overlays.humidity ? 'wind' : 'off';
    this.base.draw(view, this.particles, showWind ? 1 : 0, this.theme, this.overlays.humidity);
    this.overlayPainter.draw(view, this.state, this.overlays, this.drawOverlay, this.currentContours(), this.interacting ? this.frozenNow : now, this.field);
  }

  /**
   * Lowers the particle budget when frames stay slow, within a few seconds even at a few fps:
   * slow time accumulates in real milliseconds, so one 1 s frame counts as 1 s, not as one frame.
   * No frame-rate target is promised.
   */
  private trackPerformance(frameMs: number): void {
    if (frameMs <= 0 || frameMs > SUSPENSION_MS) return;
    this.ema += (frameMs - this.ema) * (frameMs > this.ema ? 0.3 : 0.08);
    const clock = performance.now();
    if (clock - this.fpsAt > 500) {
      this.fpsAt = clock;
      this.fpsShown = Math.round(1000 / Math.max(1, this.ema));
    }
    if (frameMs > SLOW_FRAME_MS) this.slowMs += frameMs;
    else this.slowMs = Math.max(0, this.slowMs - frameMs * 2);
    if (this.slowMs > SLOW_BUDGET_MS && this.particles.count > MIN_PARTICLES) {
      this.particles.resize(Math.max(MIN_PARTICLES, Math.floor(this.particles.count * 0.7)));
      this.reduced = true;
      this.slowMs = 0;
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.base.dispose();
    this.baseCanvas.remove();
    this.overlayCanvas.remove();
  }
}
