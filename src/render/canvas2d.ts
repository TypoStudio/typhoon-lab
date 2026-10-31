import { HUMIDITY_BUCKETS, humidityBucket, type BaseRenderer } from './base';
import { LAKE_TIER_MIN_ZOOM, visibleTierCount } from './detail';
import { projectedLakeTiers, projectedLand, type ProjectedPolygon } from './geometry';
import type { MapCamera } from './camera';
import { webZoom } from './places';
import { WIND_STREAK_SEGMENTS, type ParticleSystem } from './particles';
import type { Theme } from './theme';
import { LON0, MAP_OUTLINE, projectLambda, type FlatView } from './view';

const SPEED_BUCKETS = 4;
/** Each field row is drawn as this many column chunks (10° of longitude each), every chunk into its own projected quad. */
const FIELD_CHUNKS = 36;
/** Streak widths are batched into this many rain tiers: 1.1 px dry up to 3.3 px at 30 mm/h and above. */
const RAIN_WIDTH_STEPS = 4;
const SNOW_TINT_STEPS = 8;

function polygonsPath(polygons: ProjectedPolygon[]): Path2D {
  const path = new Path2D();
  for (const p of polygons) {
    for (const r of [p.outer, ...p.holes]) {
      for (let i = 0; i < r.length; i += 2) {
        if (i === 0) path.moveTo(r[0], r[1]); else path.lineTo(r[i], r[i + 1]);
      }
      path.closePath();
    }
  }
  return path;
}

/** Canvas 2D fallback with the same layers as the WebGL base (fewer particles, no GPU). */
export class CanvasBase implements BaseRenderer {
  readonly kind = 'canvas' as const;
  private readonly ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private fieldCanvas: HTMLCanvasElement | null = null;
  private hasPrecipitation = false;
  private seaCanvas: HTMLCanvasElement | null = null;
  private landCanvas: HTMLCanvasElement | null = null;
  private land: Path2D | null = null;
  /** One path per lake area tier (`LAKE_TIER_MIN_ZOOM`). */
  private lakes: Path2D[] | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    this.ctx = ctx;
  }

  resize(width: number, height: number, dpr: number): void {
    this.dpr = dpr;
    this.cssW = width;
    this.cssH = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
  }

  private uploadImage(rgba: Uint8Array, cols: number, rows: number, canvas: HTMLCanvasElement | null): HTMLCanvasElement {
    canvas ??= document.createElement('canvas');
    if (canvas.width !== cols || canvas.height !== rows) { canvas.width = cols; canvas.height = rows; }
    const context = canvas.getContext('2d');
    if (context) {
      // Image row 0 is the south edge; Canvas row 0 is north.
      const out = new Uint8ClampedArray(cols * rows * 4);
      for (let j = 0; j < rows; j++) out.set(rgba.subarray(j * cols * 4, (j + 1) * cols * 4), (rows - 1 - j) * cols * 4);
      context.putImageData(new ImageData(out, cols, rows), 0, 0);
    }
    return canvas;
  }

  setFieldImage(rgba: Uint8Array, cols: number, rows: number): void {
    this.hasPrecipitation = rgba.some((value, index) => index % 4 === 3 && value > 0);
    this.fieldCanvas = this.uploadImage(rgba, cols, rows, this.fieldCanvas);
  }

  setSurfaceImages(sea: Uint8Array, land: Uint8Array, cols: number, rows: number): void {
    this.seaCanvas = this.uploadImage(sea, cols, rows, this.seaCanvas);
    this.landCanvas = this.uploadImage(land, cols, rows, this.landCanvas);
  }

  private landPath(): Path2D {
    return (this.land ??= polygonsPath(projectedLand()));
  }

  private lakePaths(): Path2D[] {
    return (this.lakes ??= projectedLakeTiers().map(polygonsPath));
  }

  /** Paint geographic surface pixels within the caller's current land/sea clip. */
  private drawRaster(view: FlatView, image: HTMLCanvasElement): void {
    const { ctx, dpr } = this;
    // The field is equirectangular (1° pixels, columns from -180°) but the map is Equal Earth: each
    // source row is drawn as 36 column chunks, every chunk into the bounding box of its projected
    // quad (rows are thin, so the trapezoid error is invisible). Source chunks start at
    // LON0 - 180, so they follow the central-meridian shift. Edges are snapped to device pixels
    // and shared by neighbouring chunks and rows, so there are no seams.
    const rows = image.height;
    const rowDeg = 180 / rows;
    const chunkCols = image.width / FIELD_CHUNKS;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const edges = new Float64Array(FIELD_CHUNKS + 1);
    // Draw two texture rows per quad to keep the fallback's draw-call count low.
    for (let r = 0; r < rows; r += 2) {
      // Canvas row 0 is the north edge (see setFieldImage).
      const latTop = 90 - r * rowDeg;
      const latBottom = latTop - 2 * rowDeg;
      const pyTop = snap(view.worldToPx(0, projectLambda(0, latTop)[1])[1]);
      const pyBottom = snap(view.worldToPx(0, projectLambda(0, latBottom)[1])[1]);
      if (pyBottom < 0 || pyTop > this.cssH || pyBottom <= pyTop) continue;
      // Chunk boundary x: the outer of the row's top and bottom edges, so neighbours overlap rather than leave gaps.
      for (let c = 0; c <= FIELD_CHUNKS; c++) {
        const lambda = -180 + (360 * c) / FIELD_CHUNKS;
        const xa = projectLambda(lambda, latTop)[0];
        const xb = projectLambda(lambda, latBottom)[0];
        edges[c] = view.worldToPx(c === 0 ? Math.min(xa, xb) : c === FIELD_CHUNKS ? Math.max(xa, xb) : (xa + xb) / 2, 0)[0];
      }
      for (let c = 0; c < FIELD_CHUNKS; c++) {
        const x0 = snap(edges[c]);
        const x1 = snap(edges[c + 1]);
        if (x1 <= x0 || x1 < 0 || x0 > this.cssW) continue;
        const sx = ((((LON0 - 180 + (360 * c) / FIELD_CHUNKS + 180) / 360) % 1) + 1) % 1 * image.width;
        ctx.drawImage(image, sx, r, chunkCols, 2, x0, pyTop, x1 - x0, pyBottom - pyTop);
      }
    }
  }

  draw(camera: MapCamera, particles: ParticleSystem, particleAlpha: number, theme: Theme, humidity = false): void {
    if (camera.kind !== 'flat') return;
    const view = camera as FlatView;
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = theme.paper;
    ctx.fillRect(0, 0, this.cssW, this.cssH);
    const s = view.scale;

    // Sea: the filled map outline.
    const outline = new Path2D();
    MAP_OUTLINE.forEach(([x, y], i) => {
      const [px, py] = view.worldToPx(x, y);
      if (i === 0) outline.moveTo(px, py); else outline.lineTo(px, py);
    });
    outline.closePath();
    ctx.fillStyle = theme.sea;
    ctx.fill(outline);
    if (this.seaCanvas) {
      ctx.save();
      ctx.clip(outline);
      this.drawRaster(view, this.seaCanvas);
      ctx.restore();
    }

    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (view.width / 2 - view.cx * s), dpr * (view.height / 2 + view.cy * s));
    ctx.fillStyle = theme.land;
    ctx.fill(this.landPath(), 'evenodd');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (this.landCanvas) {
      ctx.save();
      ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (view.width / 2 - view.cx * s), dpr * (view.height / 2 + view.cy * s));
      ctx.clip(this.landPath(), 'evenodd');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawRaster(view, this.landCanvas);
      ctx.restore();
    }

    if (this.fieldCanvas && this.hasPrecipitation) {
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.clip(outline);
      this.drawRaster(view, this.fieldCanvas);
      ctx.restore();
    }

    // Lakes keep their sea colour above the field raster.
    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (view.width / 2 - view.cx * s), dpr * (view.height / 2 + view.cy * s));
    ctx.fillStyle = theme.sea;
    const lakes = this.lakePaths();
    for (let t = visibleTierCount(LAKE_TIER_MIN_ZOOM, webZoom(view)) - 1; t >= 0; t--) ctx.fill(lakes[t], 'evenodd');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (particleAlpha <= 0) return;
    // Particles in screen space.
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const n = particles.count;
    const bucketCount = humidity ? HUMIDITY_BUCKETS : SPEED_BUCKETS;
    const buckets: number[][] = Array.from({ length: bucketCount * (SNOW_TINT_STEPS + 1) }, () => []);
    for (let i = 0; i < n; i++) {
      const b = humidity ? humidityBucket(particles.humidity[i])
        : Math.min(SPEED_BUCKETS - 1, Math.floor((particles.speed[i] / 35) * SPEED_BUCKETS));
      const tint = 1 - (1 - 0.7 * particles.snowFactor(i)) * (1 - 0.85 * particles.blizzardFactor(i));
      buckets[b * (SNOW_TINT_STEPS + 1) + Math.round(tint * SNOW_TINT_STEPS)].push(i);
    }
    const color = new Uint8Array(3);
    const head = new Float64Array(3);
    const streak = new Float64Array((WIND_STREAK_SEGMENTS + 1) * 2);
    const addStreak = (i: number): void => {
      if (particles.fade(i) < 0.12) return;
      view.projectZ(particles.lon[i], particles.lat[i], head);
      const px = head[0]; const py = head[1];
      if (px < -8 || px > this.cssW + 8 || py < -8 || py > this.cssH + 8) return;
      const count = particles.traceStreak(i, view, streak);
      if (count < 2) return;
      ctx.moveTo(streak[(count - 1) * 2], streak[(count - 1) * 2 + 1]);
      for (let j = count - 2; j >= 0; j--) ctx.lineTo(streak[j * 2], streak[j * 2 + 1]);
    };
    const strokeTiers = (list: number[]): void => {
      for (let w = 0; w < RAIN_WIDTH_STEPS; w++) {
        ctx.lineWidth = 1.1 + 2.2 * (w / (RAIN_WIDTH_STEPS - 1));
        ctx.beginPath();
        for (const i of list) {
          const blizzard = particles.blizzardFactor(i);
          const width = particles.rainFactor(i) * (1 - blizzard) + 0.36 * blizzard;
          if (Math.round(width * (RAIN_WIDTH_STEPS - 1)) === w) addStreak(i);
        }
        ctx.stroke();
      }
    };
    const snowColor = new Uint8Array(3);
    theme.ramps.snow.at(5, snowColor, 0);
    for (let b = 0; b < bucketCount; b++) {
      if (humidity) theme.ramps.humidity.at(b / (HUMIDITY_BUCKETS - 1), color, 0);
      const baseColor = humidity ? `rgb(${color[0]}, ${color[1]}, ${color[2]})`
        : b >= SPEED_BUCKETS - 2 ? theme.ink : theme.wind;
      for (let snow = 0; snow <= SNOW_TINT_STEPS; snow++) {
        const list = buckets[b * (SNOW_TINT_STEPS + 1) + snow];
        if (!list.length) continue;
        const tint = snow / SNOW_TINT_STEPS;
        ctx.strokeStyle = baseColor;
        if (snow) {
          const channels = humidity ? color : b >= SPEED_BUCKETS - 2 ? theme.rgb.ink : theme.rgb.wind;
          const mixed = [0, 1, 2].map(i => Math.round(channels[i] + (snowColor[i] - channels[i]) * tint));
          ctx.strokeStyle = `rgb(${mixed.join(',')})`;
        }
        const alpha = humidity ? 0.8 : 0.28 + 0.14 * b;
        ctx.globalAlpha = particleAlpha * (alpha + (0.65 - alpha) * tint);
        strokeTiers(list);
      }
    }
    ctx.globalAlpha = 1;
  }

  isLost(): boolean { return false; }
  dispose(): void { /* nothing to release */ }
}
