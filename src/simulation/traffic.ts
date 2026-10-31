import { TRAFFIC_DEPARTURES, TRAFFIC_ROUTES, type TrafficRoute } from '../data/traffic';
import preparedSeaRoutes from '../data/generated/traffic-routes.json';
import { hash01 } from './geo';
import { inTrafficHazard, planTrafficRoute, trafficDistance, trafficEscapeRoute, trafficHazards, trafficPoint, trafficSegmentClear, type TrafficHazard } from './traffic-routing';
import type { GameState, GeoPoint, NewsItem, PlacementResult, TrafficDispatch, TrafficKind, TrafficSimulation, TrafficVehicle, TransportReport } from '../types';

/** Representative cruising speeds in km/h (airliners and container ships). */
export const TRAFFIC_SPEED = { planes: 850, ships: 30 } as const;
const TRAFFIC_COUNTS = { planes: 10, ships: 16 } as const;
export const TRAFFIC_WIND_LIMIT = { planes: 35, ships: 28 } as const;
export const TRAFFIC_LOSS_USD = { planes: 120_000_000, ships: 75_000_000 } as const;
export interface TrafficWind { speed: number; stormId?: number; disasterId?: string }
type TrafficWorld = Pick<GameState, 'seed' | 'hours' | 'tick' | 'storms' | 'traffic' | 'news' | 'disasters'>;
const MAX_NEWS = 60;
const baselineRoutes = new Map<string, GeoPoint[]>();
const servicesById = new Map(TRAFFIC_ROUTES.map(route => [route.id.toUpperCase(), route]));
// Spread the selected services across the network instead of filling only its first region.
const activeServices = new Set((['planes', 'ships'] as const).flatMap(kind => {
  const routes = TRAFFIC_ROUTES.filter(route => route.kind === kind);
  const count = Math.min(TRAFFIC_COUNTS[kind], routes.length);
  return Array.from({ length: count }, (_, i) => routes[Math.floor(i * routes.length / count)].id);
}));
const departuresById = new Map(TRAFFIC_DEPARTURES.map(departure => [departure.id, departure]));
const vehicleIds = new Set([...activeServices].map(id => id.toUpperCase()));
export const MAX_TRAFFIC_DISPATCHES = 5000;

/** Abstract airports at the city hubs used by our illustrative air network. */
export const TRAFFIC_AIRPORTS: { name: string; point: GeoPoint }[] = [...new Map(
  TRAFFIC_ROUTES.filter(r => r.kind === 'planes').flatMap(r => [[r.from, r.start], [r.to, r.end]] as [string, GeoPoint][]),
)].map(([name, point]) => ({ name, point }));

function baseline(service: TrafficRoute): GeoPoint[] | null {
  let route = baselineRoutes.get(service.id);
  if (!route) {
    const prepared = (preparedSeaRoutes as Record<string, GeoPoint[]>)[service.id];
    route = prepared ?? planTrafficRoute(service.start, service.end, service.kind) ?? undefined;
    if (route) baselineRoutes.set(service.id, route);
  }
  return route ?? null;
}
export function trafficPathLength(route: readonly GeoPoint[]): number {
  return route.slice(1).reduce((sum, p, i) => sum + trafficDistance(route[i], p), 0);
}
export function alongTrafficPath(route: readonly GeoPoint[], distance: number): { point: GeoPoint; next: number } {
  for (let i = 1; i < route.length; i++) {
    const length = trafficDistance(route[i - 1], route[i]);
    if (distance <= length) return { point: trafficPoint(route[i - 1], route[i], length ? distance / length : 1), next: i };
    distance -= length;
  }
  return { point: route[route.length - 1], next: route.length - 1 };
}

export function createTraffic(seed: number): TrafficSimulation {
  const vehicles: TrafficVehicle[] = [];
  for (const [i, service] of TRAFFIC_ROUTES.entries()) {
    if (!activeServices.has(service.id)) continue;
    const path = baseline(service); if (!path) continue;
    const reverse = hash01(seed, 8100, i) > 0.5, route = reverse ? path.slice().reverse() : path.slice();
    const travelled = hash01(seed, 8000, i) * trafficPathLength(route);
    const { point, next } = alongTrafficPath(route, travelled);
    const homeName = reverse ? service.to : service.from, destinationName = reverse ? service.from : service.to;
    vehicles.push({
      id: service.id.toUpperCase(), serviceId: service.id, kind: service.kind, ...point, home: route[0], homeName,
      destination: route[route.length - 1], destinationName, scheduledDestination: route[route.length - 1], scheduledName: destinationName,
      route: [point, ...route.slice(next)], next: 1, toward: route[next],
      diverted: false, holding: false, grounded: false, status: 'travelling',
      waitHours: 0, retryAt: 0, exposureHours: 0, motion: [{ ...point, hour: 0 }],
      departedAtHour: -travelled / TRAFFIC_SPEED[service.kind],
    });
  }
  return { vehicles, lossUsd: 0, crashes: 0, sinkings: 0, dispatches: [] };
}

/** Record actual dispatches, so viewing another region also replays deterministically. */
export function applyTrafficDispatch(state: TrafficWorld, dispatch: TrafficDispatch): PlacementResult {
  const jobs = dispatch.assignments.map(assignment => ({
    vehicle: state.traffic.vehicles.find(v => v.id === assignment.vehicleId),
    departure: departuresById.get(assignment.departureId),
  }));
  if (jobs.some(({ vehicle, departure }) => !vehicle || !departure || vehicle.kind !== departure.kind
    || vehicle.status === 'crashed' || vehicle.status === 'sunk')) return { ok: false, reason: 'Invalid traffic dispatch.' };
  const inactive = (dispatch.inactive ?? []).map(id => state.traffic.vehicles.find(v => v.id === id));
  if (inactive.some(v => !v || v.status === 'crashed' || v.status === 'sunk')) return { ok: false, reason: 'Invalid traffic dispatch.' };
  for (const { vehicle: v, departure: d } of jobs) {
    if (!v || !d) return { ok: false, reason: 'Invalid traffic dispatch.' };
    const path = baseline(servicesById.get(d.serviceId.toUpperCase())!);
    if (!path) return { ok: false, reason: 'Traffic route is unavailable.' };
    const route = d.reverse ? path.slice().reverse() : path.slice();
    const start = { lon: d.start.lon, lat: d.start.lat }, end = { lon: d.end.lon, lat: d.end.lat };
    Object.assign(v, {
      ...start, serviceId: d.serviceId, home: { ...start }, homeName: d.from,
      destination: { ...start }, destinationName: d.from, scheduledDestination: end, scheduledName: d.to,
      route, next: 1, toward: route[1], diverted: false, holding: true, grounded: v.kind === 'planes', status: 'parked',
      waitHours: hash01(state.seed, 8500 + state.tick, state.traffic.vehicles.indexOf(v)) * (v.kind === 'planes' ? 1 : 3),
      retryAt: state.hours, exposureHours: 0, motion: [{ ...start, hour: state.hours }],
      departedAtHour: undefined,
    });
  }
  for (const vehicle of inactive) vehicle!.status = 'inactive';
  state.traffic.dispatches.push(structuredClone(dispatch));
  return { ok: true };
}

/** One active vehicle per visible hub, with the fleet counts as ceilings and no duplicate services. */
export function focusTraffic(state: TrafficWorld, departureIds: unknown, visibleIds: unknown): PlacementResult {
  if (!Array.isArray(departureIds) || departureIds.length > TRAFFIC_DEPARTURES.length
    || departureIds.some(id => typeof id !== 'string' || !departuresById.has(id))
    || !Array.isArray(visibleIds) || visibleIds.length > vehicleIds.size || visibleIds.some(id => typeof id !== 'string' || !vehicleIds.has(id))) {
    return { ok: false, reason: 'Invalid traffic view.' };
  }
  const visible = new Set(visibleIds);
  const assignments: TrafficDispatch['assignments'] = [];
  const inactive = new Set<string>();
  for (const kind of ['planes', 'ships'] as const) {
    const hazards = trafficHazards(state.storms, kind);
    const departures = [...new Set<string>(departureIds)].map(id => departuresById.get(id)!)
      .filter(d => d.kind === kind && !hazards.some(h => inTrafficHazard(d.start, h) || inTrafficHazard(d.end, h)));
    const fleet = state.traffic.vehicles.filter(v => v.kind === kind && v.status !== 'crashed' && v.status !== 'sunk');
    const capacity = Math.min(TRAFFIC_COUNTS[kind], new Set(departures.map(d => d.from)).size);
    // Complete safety-critical journeys before putting those vehicles back in reserve.
    const critical = (v: TrafficVehicle) => v.status !== 'inactive'
      && (v.diverted || v.exposureHours > 0 || hazards.some(h => inTrafficHazard(v, h)));
    const kept = new Set(fleet.filter(critical).map(v => v.id));
    const origin = (v: TrafficVehicle) => v.status === 'parked' ? v.destinationName : v.homeName;
    const origins = new Set(fleet.filter(v => kept.has(v.id)).map(origin));
    const services = new Set(fleet.filter(v => kept.has(v.id)).map(v => v.serviceId));
    const visibleFleet = fleet.filter(v => v.status !== 'inactive' && visible.has(v.id) && !kept.has(v.id))
      .sort((a, b) => Number(b.status === 'travelling') - Number(a.status === 'travelling'));
    for (const vehicle of visibleFleet) {
      if (kept.size >= capacity || origins.has(origin(vehicle)) || services.has(vehicle.serviceId)) continue;
      kept.add(vehicle.id); origins.add(origin(vehicle)); services.add(vehicle.serviceId);
    }
    const available = fleet.filter(v => !kept.has(v.id) && (v.status === 'inactive' || !visible.has(v.id)));
    const offset = Math.floor(hash01(state.seed, 8600 + state.tick, kind === 'planes' ? 0 : 1) * departures.length);
    for (let i = 0; i < departures.length && kept.size < capacity && available.length; i++) {
      const departure = departures[(i + offset) % departures.length];
      if (origins.has(departure.from) || services.has(departure.serviceId)) continue;
      const vehicle = available.shift()!;
      assignments.push({ vehicleId: vehicle.id, departureId: departure.id });
      kept.add(vehicle.id); origins.add(departure.from); services.add(departure.serviceId);
    }
    for (const vehicle of fleet) {
      if (vehicle.status !== 'inactive' && !kept.has(vehicle.id)) inactive.add(vehicle.id);
    }
  }
  return assignments.length || inactive.size ? applyTrafficDispatch(state, {
    tick: state.tick, assignments, ...(inactive.size ? { inactive: [...inactive] } : {}),
  }) : { ok: true };
}

export function validateTrafficDispatches(value: unknown, untilTick: number): { ok: true; dispatches: TrafficDispatch[] } | { ok: false; reason: string } {
  const invalid = { ok: false as const, reason: 'Invalid replay traffic dispatches.' };
  if (!Array.isArray(value) || value.length > MAX_TRAFFIC_DISPATCHES) return invalid;
  const dispatches: TrafficDispatch[] = [];
  let previousTick = 0;
  for (const event of value) {
    if (!event || !Number.isInteger(event.tick) || event.tick < previousTick || event.tick > untilTick
      || !Array.isArray(event.assignments) || event.assignments.length > vehicleIds.size) return invalid;
    const inactive: unknown = event.inactive === undefined ? [] : event.inactive;
    if (!Array.isArray(inactive) || inactive.length > vehicleIds.size || !event.assignments.length && !inactive.length) return invalid;
    const seen = new Set<string>();
    const assignments: TrafficDispatch['assignments'] = [];
    for (const a of event.assignments) {
      const departure = a && departuresById.get(a.departureId);
      const vehicle = a && servicesById.get(a.vehicleId);
      if (!departure || !vehicle || !vehicleIds.has(a.vehicleId) || seen.has(a.vehicleId) || departure.kind !== vehicle.kind) return invalid;
      seen.add(a.vehicleId); assignments.push({ vehicleId: a.vehicleId, departureId: a.departureId });
    }
    for (const id of inactive) {
      if (typeof id !== 'string' || !vehicleIds.has(id) || seen.has(id)) return invalid;
      seen.add(id);
    }
    previousTick = event.tick;
    dispatches.push({ tick: event.tick, assignments, ...(inactive.length ? { inactive: [...inactive] } : {}) });
  }
  return { ok: true, dispatches };
}

function report(state: TrafficWorld, v: TrafficVehicle, event: TransportReport['event'], windMs = 0, lossUsd = 0): void {
  const subject = v.kind === 'planes' ? 'Flight' : 'Ship';
  const title = event === 'crash' ? `Flight ${v.id} crashes in strong winds`
    : event === 'sinking' ? `Ship ${v.id} sinks in strong winds`
    : event === 'diversion' ? `Flight ${v.id} diverts to ${v.destinationName}`
    : `Flight ${v.id} lands at ${v.destinationName}`;
  state.news.push({
    id: `transport-${v.id}-${event}-${state.tick}`, hour: state.hours, kind: 'transport', title,
    text: `${subject} route: ${v.homeName} → ${v.destinationName}.`,
    transport: { vehicleId: v.id, kind: v.kind, event, from: v.homeName, to: v.destinationName, windMs, lossUsd },
  });
  if (state.news.length > MAX_NEWS) state.news.splice(0, state.news.length - MAX_NEWS);
}

function setRoute(v: TrafficVehicle, route: GeoPoint[]): void {
  v.route = route; v.next = 1; v.holding = false; v.toward = route[1] ?? v.toward;
}

/** Reuse prepared ocean legs at ports instead of repeating a global search on every departure. */
function knownPortRoute(v: TrafficVehicle, destination: GeoPoint, hazards: readonly TrafficHazard[]): GeoPoint[] | null {
  if (v.kind !== 'ships') return null;
  const service = servicesById.get(v.serviceId.toUpperCase()), path = service && baseline(service);
  if (!path) return null;
  const forward = trafficDistance(v, path[0]) < 1 && trafficDistance(destination, path[path.length - 1]) < 1;
  const reverse = trafficDistance(v, path[path.length - 1]) < 1 && trafficDistance(destination, path[0]) < 1;
  if (!forward && !reverse) return null;
  const route = forward ? path.slice() : path.slice().reverse();
  if (hazards.length && route.slice(1).some((p, i) => !trafficSegmentClear(route[i], p, 'planes', hazards))) return null;
  return route;
}

/** Nearest reachable safe airport first; return to the origin is a valid diversion. */
function divertFlight(state: TrafficWorld, v: TrafficVehicle, hazards: readonly TrafficHazard[]): boolean {
  const candidates = TRAFFIC_AIRPORTS.filter(a => !hazards.some(h => inTrafficHazard(a.point, h)))
    .sort((a, b) => trafficDistance(v, a.point) - trafficDistance(v, b.point));
  for (const airport of candidates) {
    const route = planTrafficRoute(v, airport.point, 'planes', hazards);
    if (!route) continue;
    const changed = trafficDistance(v.destination, airport.point) > 1;
    v.destination = { ...airport.point }; v.destinationName = airport.name; v.diverted = true;
    setRoute(v, route);
    if (changed) report(state, v, 'diversion');
    return true;
  }
  // There is no safe airport: make an emergency approach rather than hover in midair.
  const nearest = [...TRAFFIC_AIRPORTS].sort((a, b) => trafficDistance(v, a.point) - trafficDistance(v, b.point))[0];
  if (!nearest) return false;
  const changed = trafficDistance(v.destination, nearest.point) > 1;
  v.destination = { ...nearest.point }; v.destinationName = nearest.name; v.diverted = true;
  setRoute(v, [{ lon: v.lon, lat: v.lat }, v.destination]);
  if (changed) report(state, v, 'diversion');
  return true;
}

function replan(state: TrafficWorld, v: TrafficVehicle, hazards: readonly TrafficHazard[]): void {
  v.retryAt = state.hours + (v.kind === 'ships' ? 1 : 0.5);
  const route = planTrafficRoute(v, v.destination, v.kind, hazards);
  if (route) { setRoute(v, route); v.diverted ||= hazards.length > 0; return; }
  if (v.kind === 'planes') { divertFlight(state, v, hazards); return; }
  const escape = trafficEscapeRoute(v, 'ships', hazards);
  v.diverted = hazards.length > 0;
  if (escape) setRoute(v, escape); else v.holding = true;
}

function applyExposure(state: TrafficWorld, v: TrafficVehicle, wind: TrafficWind, dt: number): boolean {
  if (v.kind === 'planes' && v.grounded) return false;
  const excess = wind.speed - TRAFFIC_WIND_LIMIT[v.kind];
  // Sustained exposure is dangerous; brief gusts can be survived and recovered from.
  v.exposureHours = excess >= 0 ? v.exposureHours + dt * (1 + excess / 10) : Math.max(0, v.exposureHours - dt * 2);
  if (v.exposureHours < (v.kind === 'planes' ? 0.35 : 0.6)) return false;
  v.status = v.kind === 'planes' ? 'crashed' : 'sunk'; v.holding = false;
  const loss = TRAFFIC_LOSS_USD[v.kind];
  state.traffic.lossUsd += loss;
  if (v.kind === 'planes') state.traffic.crashes++; else state.traffic.sinkings++;
  const source = state.storms.find(s => s.id === wind.stormId);
  if (source) source.transportLossUsd = (source.transportLossUsd ?? 0) + loss;
  const disaster = state.disasters?.find(record => record.id === wind.disasterId);
  if (!source && disaster) disaster.transportLossUsd += loss;
  report(state, v, v.kind === 'planes' ? 'crash' : 'sinking', wind.speed, loss);
  return true;
}

function arrive(state: TrafficWorld, v: TrafficVehicle): void {
  if (trafficDistance(v, v.destination) > 1) { v.holding = true; return; }
  v.status = 'parked'; v.grounded = v.kind === 'planes'; v.holding = true;
  v.waitHours = v.kind === 'planes' ? 2 : 6;
  if (v.kind === 'planes' && v.diverted) report(state, v, 'landing');
}

function depart(state: TrafficWorld, v: TrafficVehicle, hazards: readonly TrafficHazard[], windAt: (point: GeoPoint) => TrafficWind, atHour: number): boolean {
  if (hazards.some(h => inTrafficHazard(v, h)) || windAt(v).speed >= TRAFFIC_WIND_LIMIT[v.kind]) return false;
  const continuing = trafficDistance(v, v.scheduledDestination) > 1;
  const destination = continuing ? v.scheduledDestination : v.home;
  const name = continuing ? v.scheduledName : v.homeName;
  if (hazards.some(h => inTrafficHazard(destination, h))) return false;
  const route = knownPortRoute(v, destination, hazards) ?? planTrafficRoute(v, destination, v.kind, hazards);
  if (!route) return false;
  v.home = { lon: v.lon, lat: v.lat }; v.homeName = v.destinationName;
  v.destination = { ...destination }; v.destinationName = name;
  v.scheduledDestination = { ...destination }; v.scheduledName = name;
  v.grounded = false; v.status = 'travelling'; v.diverted = false; v.exposureHours = 0;
  v.departedAtHour = atHour;
  setRoute(v, route);
  return true;
}

/** Called only by the fixed-step worker simulation. Rendering and layer toggles cannot create accidents. */
export function stepTraffic(state: TrafficWorld, dt: number, windAt: (point: GeoPoint) => TrafficWind): void {
  const hazards = { planes: trafficHazards(state.storms, 'planes'), ships: trafficHazards(state.storms, 'ships') };
  for (const v of state.traffic.vehicles) {
    if (v.status === 'inactive' || v.status === 'crashed' || v.status === 'sunk') continue;
    // Keep enough model-time trail for the largest worker batch at x12 (64 fixed steps = 16h),
    // so a delayed render can still interpolate every leg instead of teleporting.
    while (v.motion.length > 1 && v.motion[1].hour < state.hours - 16) v.motion.shift();
    const initial = { lon: v.lon, lat: v.lat, hour: state.hours - dt };
    if (Math.abs(v.motion[v.motion.length - 1].hour - initial.hour) < 1e-8) v.motion[v.motion.length - 1] = initial;
    else v.motion.push(initial);
    const danger = hazards[v.kind];
    if (v.status === 'parked') {
      if (v.kind === 'ships' && applyExposure(state, v, windAt(v), dt)) continue;
      v.waitHours = Math.max(0, v.waitHours - dt);
      if (v.waitHours > 0 || !depart(state, v, danger, windAt, state.hours - dt)) continue;
    }
    const target = v.route[v.next];
    const lookahead = TRAFFIC_SPEED[v.kind] * (v.kind === 'planes' ? 6 : 24) + 300;
    const preview = danger.length > 0 && target && trafficPoint(v, target, Math.min(1, lookahead / Math.max(1, trafficDistance(v, target))));
    const airportClosed = v.kind === 'planes' && danger.some(h => inTrafficHazard(v.destination, h));
    const blocked = airportClosed || (danger.length > 0 && preview && !trafficSegmentClear(v, preview, 'planes', danger, true));
    if ((blocked || v.holding) && state.hours >= v.retryAt) replan(state, v, danger);
    if (v.holding && v.kind === 'ships') { applyExposure(state, v, windAt(v), dt); continue; }
    // Short substeps check wind along the entire traversed leg, including storm crossings.
    let remaining = dt;
    for (let step = 0; remaining > 1e-8 && step < 128; step++) {
      const wind = windAt(v);
      const caution = v.exposureHours > 0 || wind.speed >= TRAFFIC_WIND_LIMIT[v.kind] - 5
        || danger.some(h => trafficDistance(v, h) < h.radiusKm + TRAFFIC_SPEED[v.kind] * remaining);
      const next = v.route[v.next];
      if (!next) { arrive(state, v); break; }
      const length = trafficDistance(v, next);
      if (length < 1e-8) { v.next++; continue; }
      // Reaching a waypoint uses only the time that leg actually takes. Keep the remainder
      // of this model step so aircraft do not slow down at short route segments.
      const duration = Math.min(remaining, caution ? 0.05 : remaining, length / TRAFFIC_SPEED[v.kind]);
      if (applyExposure(state, v, wind, duration)) break;
      const distance = TRAFFIC_SPEED[v.kind] * duration;
      const end = distance >= length - 1e-8 ? next : trafficPoint(v, next, distance / length);
      if (v.kind === 'ships' && !trafficSegmentClear(v, end, 'ships', danger, true)) {
        replan(state, v, danger); remaining -= duration; continue;
      }
      v.lon = end.lon; v.lat = end.lat; v.motion.push({ lon: v.lon, lat: v.lat, hour: state.hours - remaining + duration });
      if (distance >= length - 1e-8) v.next++;
      remaining -= duration;
    }
    if (v.status === 'travelling' && !v.route[v.next]) arrive(state, v);
    v.toward = v.route[v.next] ?? v.toward;
    if (v.motion[v.motion.length - 1].hour < state.hours - 1e-8) v.motion.push({ lon: v.lon, lat: v.lat, hour: state.hours });
  }
}
