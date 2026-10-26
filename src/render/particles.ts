import { BOUNDS, GRID_STEP } from '../simulation/engine';
import { MIN_COS } from '../simulation/geo';
import type { GeoBounds } from './camera';
import { sampleGrid, type FieldData } from './fields';
import { KM_PER_DEG_LAT, KM_PER_DEG_LON, wrapLon } from './view';

/** On-screen speed in px/s per m/s of wind, independent of zoom. Purely visual: never feeds the score. */
const PX_PER_MS = 2.4;
export const TRAIL_SECONDS = 0.6;
/** Renderers extend a streak that would be shorter than this (px) so slow particles stay visible. */
export const MIN_TRAIL_PX = 3;
const MAX_PX_PER_S = 500;
const KM_RATIO = KM_PER_DEG_LAT / KM_PER_DEG_LON;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** Tries at finding a visible spot when seeding. */
const SEED_TRIES = 4;
/** A particle's visibility is re-checked every this many updates. */
const VISIBLE_EVERY = 10;
/** Share of respawns placed inside a blizzard cell (when any exist), and their life relative to normal. */
const BLIZZARD_SEED_SHARE = 0.12;
const BLIZZARD_LIFE_SCALE = 0.8;
const WORLD: GeoBounds = { west: -180, east: 180, south: -90, north: 90 };

/**
 * CPU particle field in geographic coordinates (degrees). Each particle advects through the
 * bilinearly interpolated state.grid wind, so what is drawn matches the simulated wind. Renderers
 * project the head and the tail (tailLonLat) every frame through the camera, so streaks follow the
 * flow under any projection. `visible` (globe: the near side) and `edge` (flat map: the edge
 * meridian) are optional hooks that respawn particles. `frozen` keeps them still (reduced motion)
 * and only reseeds when asked.
 */
export class ParticleSystem {
  count = 0;
  /** Degrees, lon in [-180, 180). */
  lon = new Float32Array(0);
  lat = new Float32Array(0);
  age = new Float32Array(0);
  life = new Float32Array(0);
  /** Degrees per second of real time at the current scale, written by update() for drawing. */
  vLon = new Float32Array(0);
  vLat = new Float32Array(0);
  speed = new Float32Array(0);
  /** Local humidity (0..1), sampled with velocity rather than inferred from storm strength. */
  humidity = new Float32Array(0);
  /** Local rainfall in mm/h (0..60); thickens the streak. */
  rain = new Float32Array(0);
  /** Local snowfall in mm/h (0..60); tints the streak toward the snow colour. */
  snow = new Float32Array(0);
  /** Local blizzard coverage (0..1, soft at the edges); whitens and stretches the streak. */
  blizzard = new Float32Array(0);
  frozen = false;
  private bounds: GeoBounds = WORLD;
  private tick = 0;
  private rng = 0x9e3779b9;
  /** Indices of blizzard cells in the current field, rebuilt every update(). */
  private blizzardCells: number[] = [];
  private blizzardCols = 0;

  private rand(): number {
    // xorshift32: cheap and independent of Math.random so visuals are repeatable per session start.
    let s = this.rng;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.rng = s >>> 0;
    return this.rng / 4294967296;
  }

  resize(count: number): void {
    const old = this.count;
    if (count === old) return;
    const grow = (a: Float32Array): Float32Array<ArrayBuffer> => { const n = new Float32Array(count); n.set(a.subarray(0, Math.min(old, count))); return n; };
    this.lon = grow(this.lon); this.lat = grow(this.lat); this.age = grow(this.age); this.life = grow(this.life);
    this.vLon = grow(this.vLon); this.vLat = grow(this.vLat); this.speed = grow(this.speed);
    this.humidity = grow(this.humidity);
    this.rain = grow(this.rain);
    this.snow = grow(this.snow);
    this.blizzard = grow(this.blizzard);
    this.count = count;
    for (let i = old; i < count; i++) this.seed(i, this.bounds, true);
  }

  /** Places particle i uniformly by area inside `b`, preferring spots where `visible` holds. */
  private seed(i: number, b: GeoBounds, randomAge: boolean, visible?: (lon: number, lat: number) => boolean): void {
    const span = Math.min(360, b.east - b.west);
    const sinS = Math.sin(Math.max(-90, b.south) * D2R);
    const sinN = Math.sin(Math.min(90, b.north) * D2R);
    let lon = 0; let lat = 0;
    let short = false;
    if (this.blizzardCells.length > 0 && this.rand() < BLIZZARD_SEED_SHARE) {
      const k = this.blizzardCells[Math.floor(this.rand() * this.blizzardCells.length)];
      const bLon = wrapLon(BOUNDS.west + ((k % this.blizzardCols) + this.rand()) * GRID_STEP);
      const bLat = BOUNDS.south + (Math.floor(k / this.blizzardCols) + this.rand()) * GRID_STEP;
      if (!visible || visible(bLon, bLat)) { lon = bLon; lat = bLat; short = true; }
    }
    for (let tries = 0; !short && tries < SEED_TRIES; tries++) {
      lon = wrapLon(b.west + this.rand() * span);
      lat = Math.asin(sinS + this.rand() * (sinN - sinS)) * R2D;
      if (!visible || visible(lon, lat)) break;
    }
    this.lon[i] = lon;
    this.lat[i] = lat;
    this.life[i] = (2.2 + this.rand() * 3.2) * (short ? BLIZZARD_LIFE_SCALE : 1);
    this.age[i] = randomAge ? this.rand() * this.life[i] : 0;
  }

  /** Scatter every particle across `b`. */
  reseed(b: GeoBounds, visible?: (lon: number, lat: number) => boolean): void {
    this.bounds = b;
    for (let i = 0; i < this.count; i++) this.seed(i, b, true, visible);
  }

  private inBounds(b: GeoBounds, lon: number, lat: number): boolean {
    if (lat < b.south || lat > b.north) return false;
    const span = b.east - b.west;
    return span >= 360 || ((((lon - b.west) % 360) + 360) % 360) <= span;
  }

  /**
   * `b` is the visible geographic bounds (view.visibleBounds()). `scale` is the camera's px per
   * degree of latitude; it keeps the on-screen particle speed constant while zooming. `visible`
   * respawns particles that left the visible area (checked every few updates), and `edge(lon0,
   * lon1)` respawns particles whose step crosses a map edge (flat map only).
   */
  update(
    dt: number, field: FieldData | null, b: GeoBounds, scale = 1,
    visible?: (lon: number, lat: number) => boolean, edge?: (lon0: number, lon1: number) => boolean,
  ): void {
    const n = this.count;
    this.bounds = b;
    if (!field) { this.speed.fill(0); this.humidity.fill(0); this.rain.fill(0); this.snow.fill(0); this.blizzard.fill(0); return; }
    const move = this.frozen ? 0 : dt;
    this.blizzardCells.length = 0;
    this.blizzardCols = field.cols;
    for (let k = 0; k < field.blizzard.length; k++) if (field.blizzard[k]) this.blizzardCells.push(k);
    // Degrees of latitude per second per m/s of wind, and the combined-speed cap, both scaled by
    // the zoom so the on-screen speed is constant.
    const k = PX_PER_MS / Math.max(1e-6, scale);
    const cap = MAX_PX_PER_S / Math.max(1e-6, scale);
    const tick = ++this.tick;
    for (let i = 0; i < n; i++) {
      if (!this.frozen) {
        this.age[i] += dt;
        if (this.age[i] >= this.life[i] || Math.abs(this.lat[i]) > 90
          || (visible && ((tick + i) % VISIBLE_EVERY === 0 || !this.inBounds(b, this.lon[i], this.lat[i])) && !visible(this.lon[i], this.lat[i]))) {
          this.seed(i, b, false, visible);
        }
      }
      const lon = this.lon[i];
      const lat = this.lat[i];
      const u = sampleGrid(field, field.u, lon, lat);
      const v = sampleGrid(field, field.v, lon, lat);
      this.humidity[i] = Math.min(1, Math.max(0, sampleGrid(field, field.humidity, lon, lat)));
      this.rain[i] = Math.min(60, Math.max(0, sampleGrid(field, field.rain, lon, lat)));
      this.snow[i] = Math.min(60, Math.max(0, sampleGrid(field, field.snow, lon, lat)));
      this.blizzard[i] = Math.min(1, Math.max(0, sampleGrid(field, field.blizzardF, lon, lat)));
      const ground = Math.hypot(u, v) * k;
      const shrink = ground > cap ? cap / ground : 1;
      const cos = Math.max(MIN_COS, Math.cos(lat * D2R));
      const vLon = (u * k * shrink * KM_RATIO) / cos;
      const vLat = v * k * shrink;
      this.vLon[i] = vLon;
      this.vLat[i] = vLat;
      this.speed[i] = Math.hypot(u, v);
      const nlon = lon + vLon * move;
      const nlat = lat + vLat * move;
      if ((edge && edge(lon, nlon)) || Math.abs(nlat) > 90) { this.seed(i, b, false, visible); continue; }
      this.lon[i] = wrapLon(nlon);
      this.lat[i] = nlat;
    }
  }

  /** Streak tail of particle i: out[0] = lon, out[1] = lat of head - v * TRAIL_SECONDS (lon not wrapped). */
  tailLonLat(i: number, out: Float64Array): void {
    const trail = TRAIL_SECONDS * (1 + 1.0 * this.blizzard[i]); // blowing snow: up to 2x longer
    out[0] = this.lon[i] - this.vLon[i] * trail;
    out[1] = this.lat[i] - this.vLat[i] * trail;
  }

  /** Alpha 0..1 over the particle's life: quick fade in, slow fade out. */
  fade(i: number): number {
    if (this.frozen) return 0.8;
    const t = this.age[i] / this.life[i];
    return Math.min(1, t * 6) * (1 - t * t);
  }

  /** 0..1 rain intensity (saturates at 30 mm/h) used for streak thickness. */
  rainFactor(i: number): number {
    return Math.min(1, this.rain[i] / 30);
  }

  /** 0..1 snowfall intensity (saturates at 20 mm/h) used to tint the streak toward snow. */
  snowFactor(i: number): number {
    return Math.min(1, this.snow[i] / 20);
  }

  /** 0..1 blizzard coverage at the particle. */
  blizzardFactor(i: number): number {
    return this.blizzard[i];
  }
}
