import { HUMIDITY_BUCKETS, humidityBucket, type BaseRenderer } from './base';
import { LAKE_TIER_MIN_ZOOM, visibleTierCount } from './detail';
import { projectedLakeTiers, projectedLand, type ProjectedPolygon } from './geometry';
import type { MapCamera } from './camera';
import { webZoom } from './places';
import { MIN_TRAIL_PX, type ParticleSystem } from './particles';
import type { Theme } from './theme';
import { LON0, MAP_OUTLINE, edgeBetween, projectLambda, type FlatView } from './view';

const SPEED_BUCKETS = 4;
/** Each field row is drawn as this many column chunks (10° of longitude each), every chunk into its own projected quad. */
const FIELD_CHUNKS = 36;
/** Streak widths are batched into this many rain tiers: 1.1 px dry up to 3.3 px at 30 mm/h and above. */
const RAIN_WIDTH_STEPS = 4;

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
  private fieldCtx: CanvasRenderingContext2D | null = null;
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

  private fieldCols = 0;

  setFieldImage(rgba: Uint8Array, cols: number, rows: number): void {
    if (!this.fieldCanvas || this.fieldCanvas.width !== cols || this.fieldCanvas.height !== rows) {
      this.fieldCanvas = document.createElement('canvas');
      this.fieldCanvas.width = cols;
      this.fieldCanvas.height = rows;
      this.fieldCtx = this.fieldCanvas.getContext('2d');
    }
    this.fieldCols = cols;
    if (!this.fieldCtx) return;
    // Flip vertically: image row 0 is the south edge.
    const out = new Uint8ClampedArray(cols * rows * 4);
    for (let j = 0; j < rows; j++) out.set(rgba.subarray(j * cols * 4, (j + 1) * cols * 4), (rows - 1 - j) * cols * 4);
    this.fieldCtx.putImageData(new ImageData(out, cols, rows), 0, 0);
  }

  private landPath(): Path2D {
    return (this.land ??= polygonsPath(projectedLand()));
  }

  private lakePaths(): Path2D[] {
    return (this.lakes ??= projectedLakeTiers().map(polygonsPath));
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

    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (view.width / 2 - view.cx * s), dpr * (view.height / 2 + view.cy * s));
    ctx.fillStyle = theme.land;
    ctx.fill(this.landPath(), 'evenodd');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (this.fieldCanvas && this.fieldCols > 0) {
      ctx.imageSmoothingEnabled = true;
      ctx.save();
      ctx.clip(outline);
      // The field is equirectangular (2° rows, columns from -180°) but the map is Equal Earth: each
      // source row is drawn as 36 column chunks, every chunk into the bounding box of its projected
      // quad (rows are thin, so the trapezoid error is invisible). Source chunks start at
      // LON0 - 180, so they follow the central-meridian shift. Edges are snapped to device pixels
      // and shared by neighbouring chunks and rows, so there are no seams.
      const rows = this.fieldCanvas.height;
      const rowDeg = 180 / rows;
      const chunkCols = this.fieldCols / FIELD_CHUNKS;
      const snap = (v: number) => Math.round(v * dpr) / dpr;
      const edges = new Float64Array(FIELD_CHUNKS + 1);
      for (let r = 0; r < rows; r++) {
        // Canvas row 0 is the north edge (see setFieldImage).
        const latTop = 90 - r * rowDeg;
        const latBottom = latTop - rowDeg;
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
          const sx = ((((LON0 - 180 + (360 * c) / FIELD_CHUNKS + 180) / 360) % 1) + 1) % 1 * this.fieldCols;
          ctx.drawImage(this.fieldCanvas, sx, r, chunkCols, 1, x0, pyTop, x1 - x0, pyBottom - pyTop);
        }
      }
      ctx.restore();
    }

    // Lakes go over the field: their cells are land to the simulation and carry its population tint, which would turn the water olive.
    ctx.setTransform(dpr * s, 0, 0, -dpr * s, dpr * (view.width / 2 - view.cx * s), dpr * (view.height / 2 + view.cy * s));
    ctx.fillStyle = theme.sea;
    const lakes = this.lakePaths();
    for (let t = visibleTierCount(LAKE_TIER_MIN_ZOOM, webZoom(view)) - 1; t >= 0; t--) ctx.fill(lakes[t], 'evenodd');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (particleAlpha <= 0) return;
    // Particles in screen space.
    ctx.lineCap = 'round';
    const n = particles.count;
    const bucketCount = humidity ? HUMIDITY_BUCKETS : SPEED_BUCKETS;
    const buckets: number[][] = Array.from({ length: bucketCount }, () => []);
    const snowy: number[] = [];
    const blizzard: number[] = [];
    for (let i = 0; i < n; i++) {
      if (particles.blizzardFactor(i) >= 0.5) { blizzard.push(i); continue; }
      if (particles.snowFactor(i) > 0) { snowy.push(i); continue; }
      const b = humidity ? humidityBucket(particles.humidity[i])
        : Math.min(SPEED_BUCKETS - 1, Math.floor((particles.speed[i] / 35) * SPEED_BUCKETS));
      buckets[b].push(i);
    }
    const color = new Uint8Array(3);
    const head = new Float64Array(3);
    const tail = new Float64Array(3);
    const tailGeo = new Float64Array(2);
    const addStreak = (i: number): void => {
      if (particles.fade(i) < 0.12) return;
      view.projectZ(particles.lon[i], particles.lat[i], head);
      const px = head[0]; const py = head[1];
      if (px < -8 || px > this.cssW + 8 || py < -8 || py > this.cssH + 8) return;
      particles.tailLonLat(i, tailGeo);
      // A tail across the map's edge meridian would be drawn across the whole map.
      if (edgeBetween(particles.lon[i], tailGeo[0])) return;
      view.projectZ(tailGeo[0], tailGeo[1], tail);
      let qx = tail[0]; let qy = tail[1];
      const len = Math.hypot(px - qx, py - qy);
      if (len < MIN_TRAIL_PX) {
        // Extend short streaks along their on-screen direction (or west-to-east when still).
        const dx = len > 1e-9 ? (px - qx) / len : 1;
        const dy = len > 1e-9 ? (py - qy) / len : 0;
        qx = px - dx * MIN_TRAIL_PX; qy = py - dy * MIN_TRAIL_PX;
      }
      ctx.moveTo(qx, qy);
      ctx.lineTo(px, py);
    };
    const strokeTiers = (list: number[]): void => {
      for (let w = 0; w < RAIN_WIDTH_STEPS; w++) {
        ctx.lineWidth = 1.1 + 2.2 * (w / (RAIN_WIDTH_STEPS - 1));
        ctx.beginPath();
        for (const i of list) {
          if (Math.round(particles.rainFactor(i) * (RAIN_WIDTH_STEPS - 1)) === w) addStreak(i);
        }
        ctx.stroke();
      }
    };
    for (let b = 0; b < bucketCount; b++) {
      if (humidity) {
        theme.ramps.humidity.at(b / (HUMIDITY_BUCKETS - 1), color, 0);
        ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
      } else ctx.strokeStyle = b >= SPEED_BUCKETS - 2 ? theme.ink : theme.wind;
      ctx.globalAlpha = particleAlpha * (humidity ? 0.8 : 0.28 + 0.14 * b);
      strokeTiers(buckets[b]);
    }
    // Snowfall: streaks in the snow colour, thickness by the same rain tiers.
    theme.ramps.snow.at(5, color, 0);
    ctx.strokeStyle = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    ctx.globalAlpha = particleAlpha * 0.8;
    strokeTiers(snowy);
    // Blizzard: long, thin, softly white lines.
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = particleAlpha * 0.6;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const i of blizzard) addStreak(i);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  isLost(): boolean { return false; }
  dispose(): void { /* nothing to release */ }
}
