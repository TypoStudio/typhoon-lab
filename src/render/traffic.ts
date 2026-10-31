import type { GameState, GeoPoint, MapOverlays, TrafficKind, TrafficVehicle } from '../types';
import type { MapCamera } from './camera';
import { each } from './geo-draw';
import { clamp } from '../simulation/geo';
import { trafficDistance, trafficPoint } from '../simulation/traffic-routing';
import { TRAFFIC_SPEED } from '../simulation/traffic';
import { PLANE_PATH } from './transport-symbol';

export interface TrafficMarker extends GeoPoint {
  id: string; kind: TrafficKind; toward: GeoPoint; diverted: boolean; holding: boolean; grounded?: boolean;
}

/** Above this speed a worker update can cover whole 15-minute steps; use recorded paths. */
const MAX_PREDICTION_SPEED = 3600;

/** Smooths worker snapshots; movement, diversions and accidents belong to the simulation. */
export class TrafficAnimation {
  private vehicles: TrafficVehicle[] = [];
  private markers: TrafficMarker[] = [];
  private hours = -1;
  private fromHours = 0;
  private updatedAt = 0;
  private duration = 250;
  private seed: number | undefined;
  private pausedAt: number | null = null;
  private clock: { hours: number; speed: number; playing: boolean; at: number } | null = null;

  /** The worker's fractional model time keeps vehicles moving between 15-minute world steps. */
  setClock(hours: number, speed: number, playing: boolean, now = performance.now()): void {
    const previousHour = this.renderHour(now);
    if (this.clock && this.hours >= 0 && hours >= this.hours) {
      // Placements/traffic-view replies can repeat a checkpoint while its predicted
      // fractional movement is already visible. Re-anchoring must not rewind it.
      if (speed <= MAX_PREDICTION_SPEED) hours = Math.max(hours, previousHour);
      if (this.clock.speed <= MAX_PREDICTION_SPEED && speed > MAX_PREDICTION_SPEED) {
        this.fromHours = previousHour; this.updatedAt = now;
      }
    }
    if (!playing && this.pausedAt === null) this.pausedAt = now;
    else if (playing && this.pausedAt !== null) {
      this.updatedAt += now - this.pausedAt;
      this.pausedAt = null;
    }
    this.clock = { hours, speed, playing, at: now };
  }

  private displayHour(now: number): number {
    const alpha = clamp(((this.pausedAt ?? now) - this.updatedAt) / this.duration, 0, 1);
    return Math.max(this.fromHours, this.fromHours + (this.hours - this.fromHours) * alpha);
  }

  private renderHour(now: number): number {
    if (this.clock && this.clock.speed <= MAX_PREDICTION_SPEED) {
      return clamp(this.clock.hours + (this.clock.playing ? Math.max(0, now - this.clock.at) * this.clock.speed / 3_600_000 : 0), this.hours, this.hours + 0.25);
    }
    return this.displayHour(now);
  }

  update(state: Pick<GameState, 'hours' | 'traffic'> & Partial<Pick<GameState, 'seed'>>, now = performance.now()): void {
    const reset = this.hours < 0 || state.seed !== this.seed || state.hours < this.hours || state.hours - this.hours > 16;
    if (reset || state.hours !== this.hours) {
      // Start at the position already on screen. A new snapshot can arrive before the previous
      // interpolation finishes at high speed; restarting at its old tick makes planes hop.
      this.fromHours = reset ? state.hours : this.renderHour(now);
      // At slower settings, fixed model steps can arrive seconds apart. A 300 ms cap made each plane
      // move briefly and then sit still until the next snapshot.
      this.duration = this.hours >= 0 ? clamp(now - this.updatedAt || 250, 16, 2000) : 250;
      this.updatedAt = now; this.hours = state.hours;
      if (reset && this.clock) this.clock = { ...this.clock, hours: state.hours, at: now };
    }
    this.seed = state.seed;
    this.vehicles = state.traffic.vehicles.filter(v => v.status !== 'inactive' && v.status !== 'crashed' && v.status !== 'sunk' && !v.grounded);
    this.markers = this.vehicles.map(v => ({ id: v.id, kind: v.kind, lon: v.lon, lat: v.lat, toward: v.toward, diverted: v.diverted, holding: v.holding }));
  }

  frame(now: number, reducedMotion = false): readonly TrafficMarker[] {
    const hour = reducedMotion ? this.hours : this.renderHour(now);
    this.vehicles.forEach((v, i) => {
      const marker = this.markers[i];
      if (hour > this.hours && !reducedMotion) {
        let distance = v.status === 'travelling' && !v.holding ? TRAFFIC_SPEED[v.kind] * (hour - this.hours) : 0;
        let point: GeoPoint = v;
        let next = v.next;
        while (distance > 0 && next < v.route.length) {
          const target = v.route[next];
          const leg = trafficDistance(point, target);
          if (leg < 1e-8) { point = target; next++; continue; }
          if (distance < leg) { point = trafficPoint(point, target, distance / leg); distance = 0; break; }
          point = target; distance -= leg; next++;
        }
        marker.lon = point.lon; marker.lat = point.lat;
        marker.toward = v.route[next] ?? v.toward;
        return;
      }
      let next = v.motion.findIndex(p => p.hour >= hour);
      if (next < 0) next = v.motion.length - 1;
      const b = v.motion[next], a = v.motion[Math.max(0, next - 1)];
      const point = trafficPoint(a, b, b.hour > a.hour ? clamp((hour - a.hour) / (b.hour - a.hour), 0, 1) : 1);
      marker.lon = point.lon; marker.lat = point.lat;
      marker.toward = b;
      if (trafficDistance(marker, marker.toward) < 0.1) marker.toward = v.toward;
    });
    return this.markers;
  }
}

/** Geographic zoom controls glyph size: zooming out no longer leaves large fixed-size vehicles. */
export function trafficIconScale(scale: number, kind: TrafficKind): number {
  return clamp(scale / 30, 0.18, 0.85) * (kind === 'ships' ? 0.9 : 1);
}

let planeShape: Path2D | null = null, shipShape: Path2D | null = null;
export interface TrafficCounts { ships: number; planes: number; diverted: number }

/** Screen-size silhouettes follow the projected route direction on both the flat map and globe. */
export function drawTraffic(ctx: CanvasRenderingContext2D, view: MapCamera, markers: readonly TrafficMarker[], overlays: Pick<MapOverlays, 'ships' | 'planes'>): TrafficCounts {
  const counts: TrafficCounts = { ships: 0, planes: 0, diverted: 0 };
  if (!overlays.ships && !overlays.planes) return counts;
  planeShape ??= new Path2D(PLANE_PATH);
  shipShape ??= new Path2D('M0-9 Q4-7 4.5-2 L4.5 7 Q0 10-4.5 7 L-4.5-2 Q-4-7 0-9Z');
  const ahead = new Float64Array(3);
  // Paint sea traffic first, so aircraft remain above ships at crossings.
  for (const kind of ['ships', 'planes'] as const) {
    if (!overlays[kind]) continue;
    for (const marker of markers) {
      if (marker.kind !== kind || marker.grounded) continue;
      const direction = trafficPoint(marker, marker.toward, Math.min(1, 8 / Math.max(8, trafficDistance(marker, marker.toward))));
      view.projectZ(direction.lon, direction.lat, ahead);
      each(view, marker.lon, marker.lat, 18, view.width, view.height, (x, y, alpha) => {
        if (alpha < 0.6) return;
        counts[marker.kind]++; if (marker.diverted) counts.diverted++;
        const dx = ahead[0] - x, dy = ahead[1] - y;
        const angle = Math.abs(dx) < view.width / 2 && Math.hypot(dx, dy) > 0.01 ? Math.atan2(dy, dx) + Math.PI / 2 : 0;
        ctx.save(); ctx.translate(x, y); ctx.rotate(angle);
        const scale = trafficIconScale(view.scale, marker.kind);
        ctx.scale(scale, scale); ctx.globalAlpha = alpha * (marker.holding ? 0.55 : 1);
        const color = marker.diverted ? '#ffad66' : marker.kind === 'planes' ? '#ffdc4a' : '#69e0e5';
        // A short wake makes the heading legible without filling the map with complete routes.
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.globalAlpha *= 0.45;
        ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(0, 22); ctx.stroke();
        ctx.globalAlpha = alpha * (marker.holding ? 0.55 : 1);
        const shape = marker.kind === 'planes' ? planeShape! : shipShape!;
        ctx.strokeStyle = '#17272c'; ctx.lineWidth = 2.8; ctx.stroke(shape);
        ctx.fillStyle = color; ctx.fill(shape);
        if (marker.kind === 'ships') {
          ctx.fillStyle = '#173f4c'; ctx.fillRect(-2, -3, 4, 6);
          ctx.fillStyle = '#efffff'; ctx.fillRect(-1.8, 3.5, 3.6, 1.5);
        }
        ctx.restore();
      });
    }
  }
  return counts;
}
