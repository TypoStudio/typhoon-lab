import { MIN_COS } from '../simulation/geo';
import type { GeoBounds, MapCamera } from './camera';
import { samplePrecipitation } from './precipitation';
import { sampleGrid, sampleWind, type FieldData } from './fields';
import { edgeBetween, KM_PER_DEG_LAT, KM_PER_DEG_LON, wrapLon } from './view';

/** Base wind streak length in screen pixels. */
export const WIND_STREAK_PX = 27;
export const WIND_STREAK_SEGMENTS = 8;
/** Limit each chord's change in direction so small, zoomed-out vortices stay smooth. */
const MIN_TRACE_DIRECTION_DOT = Math.cos(Math.PI / 24);
/** Projected probe points give direction; all strokes retain the same screen length. */
export function setWindStreakTail(headX: number, headY: number, probeX: number, probeY: number, out: Float64Array): void {
  const dx = headX - probeX, dy = headY - probeY, length = Math.hypot(dx, dy);
  out[0] = headX - (length > 1e-9 ? dx / length : 1) * WIND_STREAK_PX;
  out[1] = headY - (length > 1e-9 ? dy / length : 0) * WIND_STREAK_PX;
}
/** Original display speed, in pixels per second for each m/s of model wind. */
const PX_PER_MS = 2.4;
const MAX_PX_PER_S = 500;
/** Base visual rotation cap (radians/s); simulation wind and streak length remain unchanged. */
const MAX_ANGULAR_SPEED = 0.6;
const KM_RATIO = KM_PER_DEG_LAT / KM_PER_DEG_LON;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
/** Tries at finding a visible spot when seeding. */
const SEED_TRIES = 4;
/** A particle's visibility is re-checked every this many updates. */
const VISIBLE_EVERY = 10;
const WORLD: GeoBounds = { west: -180, east: 180, south: -90, north: 90 };

/**
 * CPU particle field in geographic coordinates (degrees). Each particle advects through the
 * bilinearly interpolated state.grid wind, with the original zoom-independent display speed. Renderers
 * project the head and the tail (tailLonLat) every frame through the camera, so streaks follow the
 * flow under any projection. `visible` (globe: the near side) and `edge` (flat map: the edge
 * meridian) are optional hooks that respawn particles. `frozen` keeps them still (reduced motion)
 * and only reseeds when asked.
 */
export class ParticleSystem {
  count = 0;
  /** Degrees, lon in [-180, 180). */
  lon = new Float64Array(0);
  lat = new Float64Array(0);
  age = new Float32Array(0);
  life = new Float32Array(0);
  /** Degrees per real second at the current camera scale, used to draw streaks. */
  vLon = new Float32Array(0);
  vLat = new Float32Array(0);
  speed = new Float32Array(0);
  /** Local humidity (0..1), sampled with velocity rather than inferred from storm strength. */
  humidity = new Float32Array(0);
  /** Local rainfall in mm/h (0..60); thickens the streak. */
  rain = new Float32Array(0);
  /** Local snowfall in mm/h (0..60); tints the streak toward the snow colour. */
  snow = new Float32Array(0);
  /** Local blizzard coverage (0..1, soft at the edges); whitens the streak. */
  blizzard = new Float32Array(0);
  frozen = false;
  paused = false;
  private bounds: GeoBounds = WORLD;
  private tick = 0;
  private rng = 0x9e3779b9;
  private seedField: FieldData | null = null;
  private readonly traceProjection = new Float64Array(3);
  private readonly sampledWind = new Float64Array(2);
  private readonly sampledVelocity = new Float64Array(2);
  private readonly traceStartDirection = new Float64Array(2);
  private readonly traceMidDirection = new Float64Array(2);
  private readonly traceEndDirection = new Float64Array(2);

  private velocityAt(field: FieldData, lon: number, lat: number, k: number, cap: number): number {
    sampleWind(field, lon, lat, this.sampledWind);
    const u = this.sampledWind[0], v = this.sampledWind[1];
    const speed = Math.hypot(u, v);
    const radius = field.windAnimationRadiusKm?.(lon, lat) ?? Infinity;
    const limit = Math.min(cap, MAX_ANGULAR_SPEED * radius / KM_PER_DEG_LAT);
    const ground = speed * k;
    const shrink = ground > limit ? limit / ground : 1;
    this.sampledVelocity[0] = u * k * shrink * KM_RATIO / Math.max(MIN_COS, Math.cos(lat * D2R));
    this.sampledVelocity[1] = v * k * shrink;
    return speed;
  }

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
    const growPosition = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const next = new Float64Array(count); next.set(a.subarray(0, Math.min(old, count))); return next;
    };
    this.lon = growPosition(this.lon); this.lat = growPosition(this.lat); this.age = grow(this.age); this.life = grow(this.life);
    this.vLon = grow(this.vLon); this.vLat = grow(this.vLat); this.speed = grow(this.speed);
    this.humidity = grow(this.humidity);
    this.rain = grow(this.rain);
    this.snow = grow(this.snow);
    this.blizzard = grow(this.blizzard);
    this.count = count;
    for (let i = old; i < count; i++) this.seed(i, this.bounds, true);
  }

  /** Uniform area sampling, independent of wind strength and weather systems. */
  private seed(i: number, b: GeoBounds, randomAge: boolean, visible?: (lon: number, lat: number) => boolean): void {
    const span = Math.min(360, b.east - b.west);
    const sinS = Math.sin(Math.max(-90, b.south) * D2R);
    const sinN = Math.sin(Math.min(90, b.north) * D2R);
    let lon = 0, lat = 0;
    for (let tries = 0; tries < SEED_TRIES; tries++) {
      lon = wrapLon(b.west + this.rand() * span);
      lat = Math.asin(sinS + this.rand() * (sinN - sinS)) * R2D;
      if (!visible || visible(lon, lat)) break;
    }
    this.lon[i] = lon;
    this.lat[i] = lat;
    // Choose lifetime at birth so changing wind cannot abruptly jump the fade.
    // Strong wind lasts up to twice as long, without changing spawn density or count.
    const field = this.seedField;
    if (field) sampleWind(field, lon, lat, this.sampledWind);
    const windSpeed = field ? Math.hypot(this.sampledWind[0], this.sampledWind[1]) : 0;
    this.life[i] = (2.2 + this.rand() * 3.2) * (1 + Math.min(1, windSpeed / 25));
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
   * degree; the original display speed stays consistent while zooming. `visible`
   * respawns particles that left the visible area (checked every few updates), and `edge(lon0,
   * lon1)` respawns particles whose step crosses a map edge (flat map only).
   */
  update(
    dt: number, field: FieldData | null, b: GeoBounds, scale = 1,
    visible?: (lon: number, lat: number) => boolean, edge?: (lon0: number, lon1: number) => boolean,
    movementMultiplier = 1,
  ): void {
    const n = this.count;
    this.bounds = b;
    if (!field) { this.speed.fill(0); this.humidity.fill(0); this.rain.fill(0); this.snow.fill(0); this.blizzard.fill(0); return; }
    this.seedField = field;
    const move = this.frozen || this.paused ? 0 : dt * movementMultiplier;
    const k = PX_PER_MS / Math.max(1e-6, scale);
    const cap = MAX_PX_PER_S / Math.max(1e-6, scale);
    const tick = ++this.tick;
    const weather = { rain: 0, snow: 0, snowFraction: 0, blizzard: 0 };
    for (let i = 0; i < n; i++) {
      if (!this.frozen && !this.paused) {
        this.age[i] += dt;
        if (this.age[i] >= this.life[i] || Math.abs(this.lat[i]) > 90
          || (visible && ((tick + i) % VISIBLE_EVERY === 0 || !this.inBounds(b, this.lon[i], this.lat[i])) && !visible(this.lon[i], this.lat[i]))) {
          this.seed(i, b, false, visible);
        }
      }
      const lon = this.lon[i];
      const lat = this.lat[i];
      const windSpeed = this.velocityAt(field, lon, lat, k, cap);
      let vLon = this.sampledVelocity[0], vLat = this.sampledVelocity[1];
      this.humidity[i] = Math.min(1, Math.max(0, sampleGrid(field, field.humidity, lon, lat)));
      samplePrecipitation(field, lon, lat, weather, windSpeed);
      this.rain[i] = weather.rain;
      this.snow[i] = weather.snow;
      this.blizzard[i] = weather.blizzard;
      if (move && field.windAnimationRadiusKm) {
        // Midpoint integration follows tight curves instead of taking a long tangent step.
        const midLat = Math.max(-90, Math.min(90, lat + vLat * move * 0.5));
        this.velocityAt(field, wrapLon(lon + vLon * move * 0.5), midLat, k, cap);
        vLon = this.sampledVelocity[0]; vLat = this.sampledVelocity[1];
      }
      this.vLon[i] = vLon; this.vLat[i] = vLat; this.speed[i] = windSpeed;
      const nlon = lon + vLon * move, nlat = lat + vLat * move;
      if ((edge && edge(lon, nlon)) || Math.abs(nlat) > 90) { this.seed(i, b, false, visible); continue; }
      this.lon[i] = wrapLon(nlon); this.lat[i] = nlat;
    }
  }

  /** A short geographic direction probe; renderers set the actual fixed screen length. */
  tailLonLat(i: number, out: Float64Array): void {
    const magnitude = Math.hypot(this.vLon[i], this.vLat[i]);
    const step = magnitude > 1e-12 ? 0.001 / magnitude : 0;
    out[0] = this.lon[i] - this.vLon[i] * step;
    out[1] = this.lat[i] - this.vLat[i] * step;
  }

  /** Screen-space backwards direction, sampled at the actual geographic position. */
  private traceDirection(i: number, view: MapCamera, lon: number, lat: number, x: number, y: number, out: Float64Array): boolean {
    const field = this.seedField;
    if (field) sampleWind(field, lon, lat, this.sampledWind);
    const u = field ? this.sampledWind[0] : this.vLon[i];
    const v = field ? this.sampledWind[1] : this.vLat[i];
    const dx = field ? u * KM_RATIO / Math.max(MIN_COS, Math.cos(lat * D2R)) : u;
    const magnitude = Math.hypot(dx, v);
    if (magnitude < 1e-12) return false;
    const probeLon = wrapLon(lon - dx / magnitude * 0.001);
    const probeLat = Math.max(-90, Math.min(90, lat - v / magnitude * 0.001));
    if (view.kind === 'flat' && edgeBetween(lon, probeLon)) return false;
    const projected = view.projectZ(probeLon, probeLat, this.traceProjection);
    if (projected[2] <= 0) return false;
    const vx = projected[0] - x, vy = projected[1] - y;
    const length = Math.hypot(vx, vy);
    if (length < 1e-9) return false;
    out[0] = vx / length; out[1] = vy / length;
    return true;
  }

  /** Midpoint integration with adaptive spacing avoids angular tails in tight projected flows. */
  traceStreak(i: number, view: MapCamera, out: Float64Array): number {
    const projected = this.traceProjection;
    let lon = this.lon[i], lat = this.lat[i];
    const field = this.seedField;
    const visibility = field?.windVisibilityAt?.(lon, lat) ?? 1;
    // Calm air should not draw a full-length streak merely because direction is normalised.
    const streakLength = WIND_STREAK_PX * Math.min(5, this.speed[i] / 5) * visibility;
    if (streakLength < 1 || visibility < 0.02) return 0;
    view.projectZ(lon, lat, projected);
    if (projected[2] <= 0) return 0;
    let x = projected[0], y = projected[1];
    out[0] = x; out[1] = y;
    let count = 1;
    const segmentLength = streakLength / WIND_STREAK_SEGMENTS;
    let stepLength = segmentLength;
    const start = this.traceStartDirection, middle = this.traceMidDirection, end = this.traceEndDirection;
    if (!this.traceDirection(i, view, lon, lat, x, y, start)) return count;
    for (let step = 0; step < WIND_STREAK_SEGMENTS; step++) {
      let accepted = false;
      for (let attempt = 0; attempt < 8; attempt++, stepLength *= 0.5) {
        const midX = x + start[0] * stepLength * 0.5, midY = y + start[1] * stepLength * 0.5;
        const mid = view.pxToLonLat(midX, midY);
        if (!mid || (view.kind === 'flat' && edgeBetween(lon, mid[0]))) continue;
        if ((field?.windVisibilityAt?.(mid[0], mid[1]) ?? 1) < 0.02) continue;
        if (!this.traceDirection(i, view, mid[0], mid[1], midX, midY, middle)) continue;
        const midDot = start[0] * middle[0] + start[1] * middle[1];
        if (midDot < MIN_TRACE_DIRECTION_DOT) continue;
        const nextX = x + middle[0] * stepLength, nextY = y + middle[1] * stepLength;
        const next = view.pxToLonLat(nextX, nextY);
        if (!next || (view.kind === 'flat' && edgeBetween(lon, next[0]))) continue;
        // Do not cross a calm eye or a sharp change in the underlying field.
        if ((field?.windVisibilityAt?.(next[0], next[1]) ?? 1) < 0.02) continue;
        if (midDot > 0.99999) {
          // Nearly straight background wind needs no extra end-point wind sample.
          const ex = 2 * middle[0] - start[0], ey = 2 * middle[1] - start[1];
          const norm = Math.hypot(ex, ey);
          end[0] = ex / norm; end[1] = ey / norm;
        } else if (!this.traceDirection(i, view, next[0], next[1], nextX, nextY, end)) continue;
        if (middle[0] * end[0] + middle[1] * end[1] < MIN_TRACE_DIRECTION_DOT) continue;
        x = nextX; y = nextY; lon = next[0]; lat = next[1];
        out[count * 2] = x; out[count * 2 + 1] = y;
        count++;
        start.set(end);
        stepLength = Math.min(segmentLength, stepLength * 1.15);
        accepted = true;
        break;
      }
      if (!accepted) break;
    }
    return count;
  }

  /** Alpha 0..1 over the particle's life: quick fade in, slow fade out. */
  fade(i: number): number {
    const visibility = this.seedField?.windVisibilityAt?.(this.lon[i], this.lat[i]) ?? 1;
    if (this.frozen) return 0.8 * visibility;
    const t = this.age[i] / this.life[i];
    return Math.min(1, t * 6) * (1 - t * t) * visibility;
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
