import { BOUNDS, GRID_COLS, GRID_ROWS, GRID_STEP, isLand } from '../simulation/engine';
import { DEFAULT_MAP_OVERLAYS, type GameState, type MapOverlays } from '../types';
import { windAnimationMultiplier } from '../time';
import type { BaseRenderer } from './base';
import { CanvasBase } from './canvas2d';
import { buildContours, buildFieldData, buildCombinedImage, buildSurfaceImages, FIELD_IMAGE_COLS, FIELD_IMAGE_ROWS, sampleGrid, sampleWind, type Contours, type FieldData } from './fields';
import { attachStormWind } from './storm-wind';
import { DEFAULT_LABELS, EMPTY_OVERLAY, OverlayPainter, type MapLabels, type MapOverlay } from './overlay';
import { ParticleSystem } from './particles';
import { loadTheme, type Theme } from './theme';
import type { MapCamera, MapMode } from './camera';
import { GlobeView } from './globe-view';
import { FlatView, edgeBetween, wrapLon } from './view';
import { ThreeBase } from './webgl';
import { TrafficAnimation } from './traffic';
import { ThunderstormAnimation } from './thunderstorm-animation';
import { AnimationClock } from './animation-clock';
import { WindParticleBudget, type WindBudgetAdjustment } from './wind-budget';

export interface RenderStats {
  kind: 'webgl' | 'canvas';
  fps: number;
  particles: number;
  /** True when the particle budget was lowered because frames were slow. */
  reduced: boolean;
  lost: boolean;
  firstWindReduction: WindBudgetAdjustment | null;
  lastWindAdjustment: WindBudgetAdjustment | null;
}

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
  private readonly traffic = new TrafficAnimation();
  private readonly thunderstorms = new ThunderstormAnimation();
  private readonly animationClock = new AnimationClock();
  private windSpeedMultiplier = 1;
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
  private seaImage: Uint8Array | null = null;
  private landImage: Uint8Array | null = null;
  private contours: Contours | null = null;
  private contoursDirty = true;
  private dpr = 1;
  private lastFrame = 0;
  private fpsShown = 0;
  private fpsAt = 0;
  private reduced = false;
  private maxParticles: number;
  private readonly windBudget: WindParticleBudget;
  private lostFlag = false;
  private viewVersion = -1;
  private interacting = false;
  private lastAnimationFrame = 0;
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
    this.maxParticles = Math.round((this.kind === 'webgl' ? (coarse ? 6000 : 14000) : (coarse ? 1500 : 3500)) * 2 / 3 * 1.3);
    this.windBudget = new WindParticleBudget(this.maxParticles);
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
    this.traffic.update(state, this.animationClock.read(performance.now()));
    this.thunderstorms.update(state, this.animationClock.read(performance.now()));
    this.field = buildFieldData(state.grid);
    if (this.field) attachStormWind(this.field, state);
    this.contoursDirty = true;
    this.pushImage();
  }

  /** Wind keeps illustrating the current field when model time is paused. */
  setSimulationClock(hours: number, speed: number, playing: boolean): void {
    this.windSpeedMultiplier = windAnimationMultiplier(speed);
    this.traffic.setClock(hours, speed, playing, this.animationClock.read(performance.now()));
    this.thunderstorms.setClock(hours, speed, playing, this.animationClock.read(performance.now()));
  }

  setOverlays(overlays: MapOverlays): void {
    const tintChanged = this.overlays.temperature !== overlays.temperature || this.overlays.population !== overlays.population
      || this.overlays.rain !== overlays.rain;
    this.overlays = { ...overlays };
    if (tintChanged) this.pushImage();
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
    const wind = new Float64Array(2);
    sampleWind(f, wl, lat, wind);
    return {
      land: isLand(wl, lat),
      wind: Math.hypot(wind[0], wind[1]),
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
    this.animationClock.setPaused(on, on ? this.lastFrame || performance.now() : performance.now());
    if (!on && this.reducedMotion.matches) this.reseedAfterGesture = true;
  }

  pickStorm(px: number, py: number): number | null { return this.state ? this.overlayPainter.pickStorm(this.view, this.state.storms, px, py) : null; }

  pickCity(px: number, py: number): string | null { return this.overlayPainter.pickCity(this.view, px, py); }

  /** Visible moving vehicle under a map tap, using the same interpolated position as the icon. */
  pickTraffic(px: number, py: number): string | null {
    let best: string | null = null;
    let bestDistance = 18;
    const projected = new Float64Array(3);
    for (const marker of this.traffic.frame(this.animationClock.read(performance.now()), this.reducedMotion.matches)) {
      if (!this.overlays[marker.kind]) continue;
      this.view.projectZ(marker.lon, marker.lat, projected);
      if (projected[2] < 0.22) continue;
      const distance = Math.hypot(projected[0] - px, projected[1] - py);
      if (distance < bestDistance) { best = marker.id; bestDistance = distance; }
    }
    return best;
  }

  trafficPoint(id: string): [number, number] | null {
    const marker = this.traffic.frame(this.animationClock.read(performance.now()), this.reducedMotion.matches).find(item => item.id === id);
    if (!marker || !this.overlays[marker.kind]) return null;
    const projected = this.view.projectZ(marker.lon, marker.lat);
    return projected[2] > 0.22 && projected[0] >= 0 && projected[0] <= this.view.width
      && projected[1] >= 0 && projected[1] <= this.view.height ? [projected[0], projected[1]] : null;
  }

  private pushImage(): void {
    if (!this.field) return;
    const cols = FIELD_IMAGE_COLS, rows = FIELD_IMAGE_ROWS;
    if (!this.image || this.image.length !== cols * rows * 4) this.image = new Uint8Array(cols * rows * 4);
    this.seaImage ??= new Uint8Array(cols * rows * 4);
    this.landImage ??= new Uint8Array(cols * rows * 4);
    buildSurfaceImages(this.field, this.overlays, this.theme, this.seaImage, this.landImage);
    this.base.setSurfaceImages(this.seaImage, this.landImage, cols, rows);
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
    return { kind: this.kind, fps: this.fpsShown, particles: this.particles.count, reduced: this.reduced,
      lost: this.lostFlag || this.base.isLost(), firstWindReduction: this.windBudget.firstReduction,
      lastWindAdjustment: this.windBudget.lastAdjustment };
  }

  frame(now: number): void {
    // Advance wind by animation time; a suspended tab resumes without a long visual jump.
    const frameMs = this.lastFrame ? now - this.lastFrame : 16;
    const animationNow = this.animationClock.read(now);
    const dt = frameMs > SUSPENSION_MS ? 0 : Math.min(0.1, Math.max(0, (this.lastAnimationFrame ? animationNow - this.lastAnimationFrame : 0) / 1000));
    this.lastAnimationFrame = animationNow;
    this.lastFrame = now;
    this.trackPerformance(frameMs);

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
        this.particles.update(dt, this.field, view.visibleBounds(), view.scale, this.visibleTest(), view.kind === 'flat' ? edgeBetween : undefined, this.windSpeedMultiplier);

      }
    }

    this.stage.dataset.overlays = (Object.keys(this.overlays) as (keyof MapOverlays)[]).filter(key => this.overlays[key]).join(' ');
    const showWind = !!this.field && this.overlays.wind;
    this.stage.dataset.wind = showWind ? 'visible' : 'hidden';
    this.stage.dataset.humidity = this.overlays.humidity ? 'wind' : 'off';
    this.base.draw(view, this.particles, showWind ? 1 : 0, this.theme, this.overlays.humidity);
    this.overlayPainter.draw(view, this.state, this.overlays, this.drawOverlay, this.currentContours(), animationNow, this.field, animationNow, this.traffic.frame(animationNow, this.reducedMotion.matches), this.thunderstorms.frame(animationNow, this.reducedMotion.matches));
    const traffic = this.overlayPainter.trafficCounts;
    this.stage.dataset.trafficShips = String(traffic.ships);
    this.stage.dataset.trafficPlanes = String(traffic.planes);
    this.stage.dataset.trafficDiverted = String(traffic.diverted);
    this.stage.dataset.weatherHazards = String(this.state?.weatherHazards?.length ?? 0);
  }

  /**
   * Reduce wind below about 35 fps and gradually restore it above about 45 fps.
   * Camera gestures, reduced motion and hidden wind keep the current budget unchanged.
   */
  private trackPerformance(frameMs: number): void {
    const active = !this.interacting && !!this.field && this.overlays.wind
      && !this.reducedMotion.matches && !this.base.isLost();
    const count = this.windBudget.sample(frameMs, active);
    const clock = performance.now();
    if (clock - this.fpsAt > 500) {
      this.fpsAt = clock;
      this.fpsShown = this.windBudget.fps;
    }
    if (count !== this.particles.count) this.particles.resize(count);
    this.reduced = count < this.maxParticles;
  }

  dispose(): void {
    this.observer.disconnect();
    this.base.dispose();
    this.baseCanvas.remove();
    this.overlayCanvas.remove();
  }
}
