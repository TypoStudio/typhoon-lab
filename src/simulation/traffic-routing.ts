import { isLand } from '../data/world';
import type { TrafficKind } from '../data/traffic';
import { clamp, distanceKm, moveKm, wrapLon } from './geo';
import type { GeoPoint, Storm } from '../types';

export interface TrafficHazard extends GeoPoint { radiusKm: number }
const RAD = Math.PI / 180;
const EARTH_KM = 6371;
const STEP = 2, COLS = 180, SOUTH = -60, ROWS = 66;
const oceanNodes = new Int8Array(COLS * ROWS);
const oceanEdges = new Map<number, boolean>();

/** Spherical distance/interpolation keep long flights and dateline routes on the short arc. */
export function trafficDistance(a: GeoPoint, b: GeoPoint): number {
  const lat = (b.lat - a.lat) * RAD, lon = wrapLon(b.lon - a.lon) * RAD;
  const h = Math.sin(lat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(lon / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}
export function trafficPoint(a: GeoPoint, b: GeoPoint, t: number): GeoPoint {
  const angle = trafficDistance(a, b) / EARTH_KM;
  if (angle < 1e-9) return { lon: a.lon, lat: a.lat };
  const sin = Math.sin(angle), u = Math.sin((1 - t) * angle) / sin, v = Math.sin(t * angle) / sin;
  const x = u * Math.cos(a.lat * RAD) * Math.cos(a.lon * RAD) + v * Math.cos(b.lat * RAD) * Math.cos(b.lon * RAD);
  const y = u * Math.cos(a.lat * RAD) * Math.sin(a.lon * RAD) + v * Math.cos(b.lat * RAD) * Math.sin(b.lon * RAD);
  const z = u * Math.sin(a.lat * RAD) + v * Math.sin(b.lat * RAD);
  return { lon: wrapLon(Math.atan2(y, x) / RAD), lat: Math.atan2(z, Math.hypot(x, y)) / RAD };
}

export function trafficHazards(storms: readonly Storm[], kind: TrafficKind): TrafficHazard[] {
  return storms.flatMap(s => {
    // Even a young depression is avoided. A short forecast buffer anticipates its movement.
    const radiusKm = Math.max(120, s.galeRadiusKm) + (kind === 'planes' ? 180 : 120);
    return [s, ...s.forecast.slice(0, kind === 'ships' ? 2 : 1)].map(p => ({ lon: p.lon, lat: p.lat, radiusKm }));
  });
}

export const inTrafficHazard = (p: GeoPoint, h: TrafficHazard): boolean => distanceKm(p.lon, p.lat, h.lon, h.lat) < h.radiusKm;

/** A storm can form underneath traffic: leave its wind area before holding for a closed destination. */
export function trafficEscapeRoute(start: GeoPoint, kind: TrafficKind, hazards: readonly TrafficHazard[]): GeoPoint[] | null {
  const covering = hazards.filter(h => inTrafficHazard(start, h));
  if (!covering.length) return null;
  const radius = Math.max(...covering.map(h => h.radiusKm + distanceKm(start.lon, start.lat, h.lon, h.lat))) + 80;
  let best: GeoPoint | null = null, length = Infinity;
  for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12;
    const point = moveKm(start.lon, start.lat, Math.cos(angle) * radius, Math.sin(angle) * radius);
    if (hazards.some(h => inTrafficHazard(point, h)) || !trafficSegmentClear(start, point, kind, hazards, true)) continue;
    const d = trafficDistance(start, point);
    if (d < length) { best = point; length = d; }
  }
  return best ? [{ lon: start.lon, lat: start.lat }, best] : null;
}

/** Every traversed segment is sampled, so a coastal shortcut cannot cut across an island. */
export function trafficSegmentClear(a: GeoPoint, b: GeoPoint, kind: TrafficKind, hazards: readonly TrafficHazard[], escaping = false): boolean {
  const count = Math.max(1, Math.ceil(trafficDistance(a, b) / (kind === 'ships' ? 4 : 30)));
  const initial = hazards.map(h => distanceKm(a.lon, a.lat, h.lon, h.lat));
  for (let i = 0; i <= count; i++) {
    const p = trafficPoint(a, b, i / count);
    if (kind === 'ships' && isLand(p.lon, p.lat)) return false;
    for (let k = 0; k < hazards.length; k++) {
      const h = hazards[k], d = distanceKm(p.lon, p.lat, h.lon, h.lat);
      if (d < h.radiusKm && !(escaping && initial[k] < h.radiusKm && d >= initial[k] - 0.01)) return false;
    }
  }
  return true;
}

const nodePoint = (id: number): GeoPoint => ({ lon: (id % COLS) * STEP - 180, lat: SOUTH + Math.floor(id / COLS) * STEP });
const nodeId = (x: number, y: number): number => y * COLS + ((x % COLS) + COLS) % COLS;
function waterNode(id: number): boolean {
  if (!oceanNodes[id]) { const p = nodePoint(id); oceanNodes[id] = isLand(p.lon, p.lat) ? -1 : 1; }
  return oceanNodes[id] > 0;
}
function waterEdge(a: number, b: number): boolean {
  const key = Math.min(a, b) * COLS * ROWS + Math.max(a, b);
  let clear = oceanEdges.get(key);
  if (clear === undefined) { clear = trafficSegmentClear(nodePoint(a), nodePoint(b), 'ships', []); oceanEdges.set(key, clear); }
  return clear;
}

/** Small binary heap: routing never scans the whole frontier to choose its next node. */
class Frontier {
  private items: { id: number; score: number }[] = [];
  push(id: number, score: number): void {
    const item = { id, score }; let k = this.items.length;
    this.items.push(item);
    while (k > 0) {
      const parent = (k - 1) >> 1;
      if (this.items[parent].score <= score) break;
      this.items[k] = this.items[parent]; k = parent;
    }
    this.items[k] = item;
  }
  pop(): number | undefined {
    if (!this.items.length) return undefined;
    const first = this.items[0], last = this.items.pop()!;
    if (this.items.length) {
      let k = 0;
      while (k * 2 + 1 < this.items.length) {
        let child = k * 2 + 1;
        if (child + 1 < this.items.length && this.items[child + 1].score < this.items[child].score) child++;
        if (this.items[child].score >= last.score) break;
        this.items[k] = this.items[child]; k = child;
      }
      this.items[k] = last;
    }
    return first.id;
  }
}

function endpointNodes(p: GeoPoint, kind: TrafficKind, hazards: readonly TrafficHazard[], escaping: boolean): number[] {
  const x = Math.round((wrapLon(p.lon) + 180) / STEP), y = Math.round((p.lat - SOUTH) / STEP);
  const nodes: number[] = [];
  // Several connections avoid trapping an offshore port behind the coarse grid's nearest cell.
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    if (y + dy < 0 || y + dy >= ROWS) continue;
    const id = nodeId(x + dx, y + dy), n = nodePoint(id);
    if (kind === 'ships' && !waterNode(id)) continue;
    if (hazards.some(h => inTrafficHazard(n, h))) continue;
    if (trafficSegmentClear(p, n, kind, hazards, escaping)) nodes.push(id);
  }
  return nodes.sort((a, b) => trafficDistance(p, nodePoint(a)) - trafficDistance(p, nodePoint(b))).slice(0, 6);
}

/** A* on a wrapped globe; null means hold rather than enter land or a storm. */
export function planTrafficRoute(start: GeoPoint, end: GeoPoint, kind: TrafficKind, hazards: readonly TrafficHazard[] = []): GeoPoint[] | null {
  start = { lon: start.lon, lat: start.lat }; end = { lon: end.lon, lat: end.lat };
  if (kind === 'planes' && hazards.length === 0) return [start, end];
  if (hazards.some(h => inTrafficHazard(end, h))) return null;
  if (trafficSegmentClear(start, end, kind, hazards, true)) return [start, end];
  const starts = endpointNodes(start, kind, hazards, true), ends = new Set(endpointNodes(end, kind, hazards, false));
  if (!starts.length || !ends.size) return null;
  const frontier = new Frontier(), costs = new Float64Array(COLS * ROWS).fill(Infinity);
  const parent = new Int32Array(COLS * ROWS).fill(-1), closed = new Uint8Array(COLS * ROWS);
  for (const id of starts) {
    costs[id] = trafficDistance(start, nodePoint(id));
    frontier.push(id, costs[id] + trafficDistance(nodePoint(id), end));
  }
  let found: number | undefined;
  for (let n = 0; n < COLS * ROWS; n++) {
    const id = frontier.pop(); if (id === undefined) break;
    if (closed[id]) { n--; continue; }
    if (ends.has(id)) { found = id; break; }
    closed[id] = 1;
    const p = nodePoint(id), x = id % COLS, y = Math.floor(id / COLS);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dy) || y + dy < 0 || y + dy >= ROWS) continue;
      const next = nodeId(x + dx, y + dy);
      if (closed[next] || (kind === 'ships' && (!waterNode(next) || !waterEdge(id, next)))) continue;
      const q = nodePoint(next);
      if (hazards.length && !trafficSegmentClear(p, q, 'planes', hazards)) continue;
      const cost = costs[id] + trafficDistance(p, q);
      if (cost >= costs[next]) continue;
      costs[next] = cost; parent[next] = id;
      frontier.push(next, cost + trafficDistance(q, end));
    }
  }
  if (found === undefined) return null;
  const raw: GeoPoint[] = [end];
  for (let id = found; id !== -1; id = parent[id]) raw.push(nodePoint(id));
  raw.push(start); raw.reverse();
  // Greedy line-of-sight smoothing removes the grid's staircase without crossing obstacles.
  const route = [start];
  for (let i = 0; i < raw.length - 1;) {
    let next = raw.length - 1;
    while (next > i + 1 && !trafficSegmentClear(raw[i], raw[next], kind, hazards, i === 0)) next--;
    route.push(raw[next]); i = next;
  }
  return route;
}
