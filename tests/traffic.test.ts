import { describe, expect, it } from 'vitest';
import { isLand } from '../src/data/world';
import { TRAFFIC_DEPARTURES, TRAFFIC_PORTS, TRAFFIC_ROUTES } from '../src/data/traffic';
import preparedSeaRoutes from '../src/data/generated/traffic-routes.json';
import { distanceKm } from '../src/simulation/geo';
import { TrafficAnimation, trafficIconScale } from '../src/render/traffic';
import { AnimationClock } from '../src/render/animation-clock';
import { TRAFFIC_AIRPORTS, TRAFFIC_LOSS_USD, TRAFFIC_SPEED, createTraffic, focusTraffic, stepTraffic, validateTrafficDispatches, type TrafficWind } from '../src/simulation/traffic';
import { buildReplay, parseReplay } from '../src/ui/storage';
import { stormTotalLossUsd } from '../src/simulation/damage-news';
import { transportAccidentFixture } from './fixtures/traffic';
import { createGame, placeTool, replayGame, stepGame } from '../src/simulation/engine';
import { planTrafficRoute, trafficDistance, trafficEscapeRoute, trafficPoint, trafficSegmentClear, type TrafficHazard } from '../src/simulation/traffic-routing';
import type { GeoPoint, NewsItem, Storm } from '../src/types';

const storm = (point: GeoPoint): Storm => ({ id: 1, ...point, wind: 45, galeRadiusKm: 350, forecast: [] }) as unknown as Storm;
const routeLength = (route: GeoPoint[]) => route.slice(1).reduce((sum, p, i) => sum + trafficDistance(route[i], p), 0);
function samples(route: GeoPoint[]): GeoPoint[] {
  return route.flatMap((p, i) => {
    if (i === 0) return [p];
    const n = Math.ceil(trafficDistance(route[i - 1], p) / 8);
    return Array.from({ length: n }, (_, k) => trafficPoint(route[i - 1], p, (k + 1) / n));
  });
}

describe('traffic routing', () => {
  it('takes the short arc across the date line', () => {
    const a = { lon: 179, lat: 15 }, b = { lon: -179, lat: 15 };
    expect(trafficDistance(a, b)).toBeLessThan(220);
    expect(Math.abs(trafficPoint(a, b, 0.5).lon)).toBeCloseTo(180, 5);
  });

  it('keeps offshore port approaches out of land', () => {
    for (const [name, point] of Object.entries(TRAFFIC_PORTS)) expect(isLand(point.lon, point.lat), name).toBe(false);
    expect(TRAFFIC_ROUTES.filter(r => r.kind === 'planes').length).toBeGreaterThanOrEqual(25);
  });

  for (const kind of ['ships', 'planes'] as const) {
    it(`routes ${kind} around a storm rather than through its wind area`, () => {
      const start = { lon: -160, lat: 15 }, end = { lon: -140, lat: 15 };
      const hazard: TrafficHazard = { lon: -150, lat: 15, radiusKm: 500 };
      const route = planTrafficRoute(start, end, kind, [hazard]);
      expect(route).not.toBeNull();
      expect(routeLength(route!)).toBeGreaterThan(trafficDistance(start, end) * 1.05);
      for (const p of samples(route!)) {
        expect(distanceKm(p.lon, p.lat, hazard.lon, hazard.lat)).toBeGreaterThanOrEqual(hazard.radiusKm - 1);
        if (kind === 'ships') expect(isLand(p.lon, p.lat)).toBe(false);
      }
    });
  }

  it('sails around Luzon instead of crossing it', () => {
    const start = { lon: 118, lat: 16 }, end = { lon: 124, lat: 16 };
    expect(trafficSegmentClear(start, end, 'ships', [])).toBe(false);
    const route = planTrafficRoute(start, end, 'ships');
    expect(route).not.toBeNull();
    expect(route!.length).toBeGreaterThan(2);
    expect(samples(route!).every(p => !isLand(p.lon, p.lat))).toBe(true);
  });

  it('ships have prepared sea-only routes matching every port service', () => {
    const prepared = preparedSeaRoutes as Record<string, GeoPoint[]>;
    for (const route of TRAFFIC_ROUTES.filter(r => r.kind === 'ships')) {
      const path = prepared[route.id];
      expect(path, route.id).toBeDefined();
      expect(path[0]).toEqual(route.start);
      expect(path[path.length - 1]).toEqual(route.end);
      expect(samples(path).every(p => !isLand(p.lon, p.lat)), route.id).toBe(true);
    }
  });

  it('waits when the destination is covered, and allows an outward escape from a newly formed storm', () => {
    const start = { lon: -160, lat: 15 }, end = { lon: -140, lat: 15 };
    expect(planTrafficRoute(start, end, 'planes', [{ ...end, radiusKm: 500 }])).toBeNull();
    const route = planTrafficRoute(start, end, 'planes', [{ ...start, radiusKm: 500 }]);
    expect(route).not.toBeNull();
    const distances = samples(route!).map(p => trafficDistance(start, p));
    expect(distances.every((d, i) => i === 0 || d >= distances[i - 1])).toBe(true);
  });

  it('avoids overlapping storms', () => {
    const hazards = [{ lon: -152, lat: 15, radiusKm: 450 }, { lon: -147, lat: 18, radiusKm: 450 }];
    const route = planTrafficRoute({ lon: -160, lat: 15 }, { lon: -140, lat: 15 }, 'planes', hazards);
    expect(route).not.toBeNull();
    for (const p of samples(route!)) for (const h of hazards) expect(distanceKm(p.lon, p.lat, h.lon, h.lat)).toBeGreaterThanOrEqual(h.radiusKm - 1);
  });

  it('escapes a storm before waiting instead of stopping inside it', () => {
    const start = { lon: -150, lat: 15 }, hazard = { ...start, radiusKm: 500 };
    const route = trafficEscapeRoute(start, 'ships', [hazard]);
    expect(route).not.toBeNull();
    const end = route![route!.length - 1];
    expect(distanceKm(end.lon, end.lat, hazard.lon, hazard.lat)).toBeGreaterThan(hazard.radiusKm);
    expect(samples(route!).every(p => !isLand(p.lon, p.lat))).toBe(true);
  });
});

function world(seed = 42) {
  return { seed, hours: 0, tick: 0, storms: [] as Storm[], traffic: createTraffic(seed), news: [] as NewsItem[] };
}
function tick(state: ReturnType<typeof world>, windAt: (p: GeoPoint) => TrafficWind = () => ({ speed: 0 }), dt = 0.25) {
  state.hours += dt; state.tick++;
  stepTraffic(state, dt, windAt);
}

describe('simulated traffic', () => {
  const localDepartures = TRAFFIC_DEPARTURES.filter(d => d.kind === 'planes' ? d.from === 'Seoul' : d.from === 'Busan');

  it('scales active traffic to unique visible hubs and preserves retained visible journeys', () => {
    const state = world();
    const visible = [state.traffic.vehicles.find(v => v.kind === 'planes')!, state.traffic.vehicles.find(v => v.kind === 'ships')!];
    const before = structuredClone(visible);
    expect(focusTraffic(state, localDepartures.map(d => d.id), visible.map(v => v.id)).ok).toBe(true);
    expect(visible).toEqual(before);
    expect(state.traffic.vehicles.filter(v => v.kind === 'planes')).toHaveLength(10);
    expect(state.traffic.vehicles.filter(v => v.kind === 'ships')).toHaveLength(16);
    expect(state.traffic.vehicles.filter(v => v.status !== 'inactive')).toHaveLength(2);
    expect(state.traffic.dispatches[0].assignments).toHaveLength(0);
    expect(state.traffic.dispatches[0].inactive).toHaveLength(24);
    // Once the retained journeys leave the view, reuse their slots for actual local departures.
    focusTraffic(state, localDepartures.map(d => d.id), []);
    const assigned = state.traffic.dispatches[1].assignments;
    expect(assigned).toHaveLength(2);
    const reserve = state.traffic.vehicles.filter(v => v.status === 'inactive');
    const reserveBefore = structuredClone(reserve);
    for (const assignment of assigned) {
      const vehicle = state.traffic.vehicles.find(v => v.id === assignment.vehicleId)!;
      const departure = localDepartures.find(d => d.id === assignment.departureId)!;
      expect(trafficDistance(vehicle, departure.start)).toBeLessThan(0.01);
      expect(vehicle.status).toBe('parked');
      expect(vehicle.homeName).toBe(departure.from);
      expect(vehicle.scheduledName).toBe(departure.to);
      if (vehicle.kind === 'ships') expect(isLand(vehicle.lon, vehicle.lat)).toBe(false);
    }
    for (let i = 0; i < 16; i++) tick(state);
    expect(reserve).toEqual(reserveBefore);
    const animation = new TrafficAnimation(); animation.update(state, 1000);
    expect(animation.frame(1250)).toHaveLength(2);
    for (const assignment of assigned) {
      const vehicle = state.traffic.vehicles.find(v => v.id === assignment.vehicleId)!;
      const departure = localDepartures.find(d => d.id === assignment.departureId)!;
      expect(vehicle.status).toBe('travelling');
      expect(trafficDistance(vehicle, departure.start)).toBeGreaterThan(0);
      // An airliner can finish a short route and start its return during four model hours.
    }
    const dispatchCount = state.traffic.dispatches.length;
    const localIds = [...new Set([...visible.map(v => v.id), ...assigned.map(a => a.vehicleId)])];
    focusTraffic(state, localDepartures.map(d => d.id), localIds);
    expect(state.traffic.dispatches).toHaveLength(dispatchCount);
  });

  it('does not fill multiple routes from one port, and reduces traffic to zero without visible hubs', () => {
    const state = world();
    focusTraffic(state, localDepartures.map(d => d.id), []);
    const active = () => state.traffic.vehicles.filter(v => v.status !== 'inactive');
    expect(active().filter(v => v.kind === 'planes')).toHaveLength(1);
    expect(active().filter(v => v.kind === 'ships')).toHaveLength(1);
    const local = active().map(v => v.id);
    for (let i = 0; i < 12; i++) {
      tick(state);
      focusTraffic(state, localDepartures.map(d => d.id), local);
      expect(active()).toHaveLength(2);
    }
    focusTraffic(state, [], local);
    expect(active()).toHaveLength(0);
    expect(state.traffic.dispatches.at(-1)?.assignments).toEqual([]);
    expect(state.traffic.dispatches.at(-1)?.inactive).toHaveLength(2);
    const still = structuredClone(state.traffic.vehicles);
    tick(state, () => ({ speed: 90 }));
    expect(state.traffic.vehicles).toEqual(still);
    expect(state.traffic.lossUsd).toBe(0);
    focusTraffic(state, TRAFFIC_DEPARTURES.map(d => d.id), []);
    expect(active().filter(v => v.kind === 'planes')).toHaveLength(10);
    expect(active().filter(v => v.kind === 'ships')).toHaveLength(16);
    expect(new Set(active().map(v => v.serviceId)).size).toBe(active().length);
    for (const kind of ['planes', 'ships']) {
      const origins = active().filter(v => v.kind === kind).map(v => v.homeName);
      expect(new Set(origins).size).toBe(origins.length);
    }
  });

  it('does not resurrect accidents, interrupt diversions, rescue wind-exposed vehicles or dispatch through storms', () => {
    const state = world();
    const [crashed, diverted, exposed] = state.traffic.vehicles.filter(v => v.kind === 'planes');
    const sunk = state.traffic.vehicles.find(v => v.kind === 'ships')!;
    crashed.status = 'crashed'; sunk.status = 'sunk'; diverted.diverted = true; exposed.exposureHours = 0.2;
    const protectedVehicles = [crashed, sunk, diverted, exposed];
    const before = structuredClone(protectedVehicles);
    focusTraffic(state, localDepartures.map(d => d.id), []);
    expect(protectedVehicles).toEqual(before);
    const blocked = world();
    blocked.storms = [{ ...storm({ lon: 130, lat: 35 }), galeRadiusKm: 30_000 }];
    const original = structuredClone(blocked);
    focusTraffic(blocked, localDepartures.map(d => d.id), []);
    expect(blocked).toEqual(original);
    expect(focusTraffic(blocked, ['unknown'], []).ok).toBe(false);
  });

  it('exports, validates and replays traffic dispatches across camera changes exactly', () => {
    const state = createGame(42);
    focusTraffic(state, localDepartures.map(d => d.id), []);
    for (let i = 0; i < 16; i++) stepGame(state);
    const western = TRAFFIC_DEPARTURES.filter(d => ['London', 'New York', 'Rotterdam'].includes(d.from));
    focusTraffic(state, western.map(d => d.id), []);
    for (let i = 0; i < 16; i++) stepGame(state);
    focusTraffic(state, [], []);
    const parsed = parseReplay(JSON.stringify(buildReplay(state)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const replay = replayGame(state.seed, parsed.replay.actions, state.tick, state.initialStartDayOfYear, parsed.replay.trafficDispatches);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.state).toEqual(state);
    const dispatches = state.traffic.dispatches;
    expect(validateTrafficDispatches(dispatches, state.tick).ok).toBe(true);
    expect(validateTrafficDispatches([{ ...dispatches[0], tick: -1 }], state.tick).ok).toBe(false);
    expect(validateTrafficDispatches([{ ...dispatches[0], tick: state.tick + 1 }], state.tick).ok).toBe(false);
    expect(validateTrafficDispatches([{ tick: 0, assignments: [{ vehicleId: 'AIR-0', departureId: 'sea-0:0' }] }], state.tick).ok).toBe(false);
    expect(validateTrafficDispatches([{ tick: 0, assignments: [dispatches[0].assignments[0], dispatches[0].assignments[0]] }], state.tick).ok).toBe(false);
    expect(validateTrafficDispatches([...dispatches].reverse(), state.tick).ok).toBe(false);
    const slot = dispatches[0].assignments[0].vehicleId;
    expect(validateTrafficDispatches([{ tick: 0, assignments: [], inactive: [slot] }], state.tick).ok).toBe(true);
    expect(validateTrafficDispatches([{ tick: 0, assignments: [], inactive: [slot, slot] }], state.tick).ok).toBe(false);
    expect(validateTrafficDispatches([{ tick: 0, assignments: [dispatches[0].assignments[0]], inactive: [slot] }], state.tick).ok).toBe(false);
  });

  it('uses the real storm wind field and includes accident losses in its storm total', () => {
    const state = transportAccidentFixture();
    expect(state.traffic.crashes).toBe(1); expect(state.traffic.sinkings).toBe(1);
    expect(state.traffic.lossUsd).toBe(195_000_000);
    expect(state.storms[0].transportLossUsd).toBe(195_000_000);
    expect(state.news.filter(n => n.transport?.lossUsd)).toHaveLength(2);
  });

  it('reconstructs transport positions, losses and reports from replay actions exactly', () => {
    const state = createGame(42);
    for (const tool of ['warm', 'moisture', 'low'] as const) placeTool(state, tool, 140, 16);
    for (let i = 0; i < 100; i++) stepGame(state);
    const replay = replayGame(state.seed, state.actions, state.tick, state.initialStartDayOfYear);
    expect(replay.ok).toBe(true);
    if (replay.ok) { expect(replay.state.traffic).toEqual(state.traffic); expect(replay.state.news).toEqual(state.news); }
  });
  it('runs 10 planes and 16 ships at cruising, bounded speeds', () => {
    const state = world();
    expect(state.traffic.vehicles.filter(v => v.kind === 'planes')).toHaveLength(10);
    expect(state.traffic.vehicles.filter(v => v.kind === 'ships')).toHaveLength(16);
    const initial = state.traffic.vehicles.map(v => ({ lon: v.lon, lat: v.lat }));
    tick(state);
    state.traffic.vehicles.forEach((v, i) => {
      expect(trafficDistance(initial[i], v)).toBeLessThanOrEqual(TRAFFIC_SPEED[v.kind] * 0.25 + 0.01);
      expect(trafficDistance(initial[i], v)).toBeGreaterThan(0);
    });
    expect(createTraffic(42)).toEqual(createTraffic(42));
  });

  it('gets smaller when zooming out and caps close-up sizes', () => {
    for (const kind of ['planes', 'ships'] as const) {
      expect(trafficIconScale(3, kind)).toBeLessThan(trafficIconScale(15, kind));
      expect(trafficIconScale(15, kind)).toBeLessThan(trafficIconScale(60, kind));
      expect(trafficIconScale(999, kind)).toBeLessThanOrEqual(0.85);
      expect(trafficIconScale(0.01, kind)).toBeGreaterThan(0);
    }
  });

  it('diverts an airborne flight to the nearest reachable safe airport instead of stopping', () => {
    const state = world();
    const plane = state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 1500)!;
    const original = { ...plane.destination }, before = { lon: plane.lon, lat: plane.lat };
    state.traffic.vehicles = [plane]; state.storms = [storm(original)];
    const hazards = [{ ...original, radiusKm: 530 }];
    const nearest = [...TRAFFIC_AIRPORTS].filter(a => distanceKm(a.point.lon, a.point.lat, original.lon, original.lat) >= 530)
      .sort((a, b) => trafficDistance(plane, a.point) - trafficDistance(plane, b.point))
      .find(a => planTrafficRoute(plane, a.point, 'planes', hazards));
    tick(state);
    expect(plane.holding).toBe(false); expect(plane.grounded).toBe(false);
    expect(plane.diverted).toBe(true);
    expect(plane.destinationName).toBe(nearest!.name);
    expect(trafficDistance(before, plane)).toBeGreaterThan(0);
    expect(state.news.some(n => n.transport?.event === 'diversion')).toBe(true);
  });

  it('lands and disappears from the air overlay at an alternate airport', () => {
    const state = world(), plane = state.traffic.vehicles.find(v => v.kind === 'planes')!;
    const airport = TRAFFIC_AIRPORTS.find(a => a.name === 'Seoul')!;
    const near = trafficPoint(airport.point, { lon: airport.point.lon + 1, lat: airport.point.lat }, 0.01);
    Object.assign(plane, near, { destination: airport.point, destinationName: airport.name, route: [near, airport.point], next: 1, diverted: true });
    state.traffic.vehicles = [plane];
    tick(state);
    expect(plane.status).toBe('parked'); expect(plane.grounded).toBe(true);
    expect(trafficDistance(plane, airport.point)).toBeLessThan(0.01);
    const animation = new TrafficAnimation(); animation.update(state, 250);
    expect(animation.frame(500)).toEqual([]);
    expect(state.news.some(n => n.transport?.event === 'landing')).toBe(true);
  });

  it('keeps making an emergency approach when every airport is unsafe', () => {
    const state = world(), plane = state.traffic.vehicles.find(v => v.kind === 'planes')!;
    state.traffic.vehicles = [plane];
    state.storms = [{ ...storm(plane), galeRadiusKm: 30_000 }];
    const at = { lon: plane.lon, lat: plane.lat };
    tick(state);
    expect(['travelling', 'parked']).toContain(plane.status);
    expect(trafficDistance(at, plane)).toBeGreaterThan(0);
    expect(TRAFFIC_AIRPORTS.some(a => a.name === plane.destinationName)).toBe(true);
  });

  it('crashes/sinks after unavoidable sustained strong winds and charges each accident once', () => {
    const state = world();
    state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes')!, state.traffic.vehicles.find(v => v.kind === 'ships')!];
    state.storms = [storm({ lon: -120, lat: 0 })];
    tick(state, () => ({ speed: 85, stormId: 1 }));
    expect(state.traffic.vehicles.map(v => v.status)).toEqual(['crashed', 'sunk']);
    expect(state.traffic.crashes).toBe(1); expect(state.traffic.sinkings).toBe(1);
    expect(state.traffic.lossUsd).toBe(TRAFFIC_LOSS_USD.planes + TRAFFIC_LOSS_USD.ships);
    expect(state.storms[0].transportLossUsd).toBe(state.traffic.lossUsd);
    expect(stormTotalLossUsd({ damageScore: 0, transportLossUsd: state.traffic.lossUsd })).toBe(state.traffic.lossUsd);
    const news = state.news.filter(n => n.transport?.lossUsd);
    expect(news).toHaveLength(2);
    expect(news.reduce((sum, n) => sum + n.transport!.lossUsd, 0)).toBe(state.traffic.lossUsd);
    tick(state, () => ({ speed: 85, stormId: 1 }));
    expect(state.traffic.lossUsd).toBe(195_000_000);
    expect(state.news.filter(n => n.transport?.lossUsd)).toHaveLength(2);
    const animation = new TrafficAnimation(); animation.update(state, 500);
    expect(animation.frame(750)).toHaveLength(0);
  });

  it('survives a brief gust and cannot create accidents just by rendering', () => {
    const state = world(); state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes')!];
    tick(state, () => ({ speed: 40 }), 0.05);
    expect(state.traffic.crashes).toBe(0);
    tick(state);
    expect(state.traffic.vehicles[0].exposureHours).toBe(0);
    const before = structuredClone(state);
    const animation = new TrafficAnimation(); animation.update(state, 0);
    for (let now = 0; now < 10000; now += 16) animation.frame(now);
    expect(state).toEqual(before);
  });

  it('keeps ships and interpolated markers on water', () => {
    const state = world(), animation = new TrafficAnimation();
    for (let hour = 0; hour < 12; hour += 0.25) {
      tick(state); animation.update(state, hour * 1000);
      for (const v of animation.frame(hour * 1000 + 125)) if (v.kind === 'ships') expect(isLand(v.lon, v.lat), v.id).toBe(false);
    }
  });

  it('interpolates the whole worker batch instead of jumping to its last fixed step', () => {
    const state = world(), animation = new TrafficAnimation();
    const plane = state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!;
    state.traffic.vehicles = [plane];
    const start = { lon: plane.lon, lat: plane.lat };
    animation.update(state, 0);
    for (let i = 0; i < 12; i++) tick(state);
    animation.update(state, 250);
    expect(trafficDistance(start, animation.frame(375)[0])).toBeCloseTo(1275, 0);
    expect(trafficDistance(start, animation.frame(500)[0])).toBeGreaterThan(2000);
    for (let i = 0; i < 100; i++) tick(state);
    expect(plane.motion.length).toBeLessThan(100);
  });

  it('keeps a plane at its visible position when a new snapshot arrives mid-flight', () => {
    const state = world(), animation = new TrafficAnimation();
    state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!];
    animation.update(state, 0);
    for (let i = 0; i < 4; i++) tick(state);
    animation.update(state, 250);
    const before = { ...animation.frame(375)[0] };
    for (let i = 0; i < 4; i++) tick(state);
    animation.update(state, 375);
    const after = animation.frame(375)[0];
    expect(trafficDistance(before, after)).toBeLessThan(0.01);
    expect(trafficDistance(before, animation.frame(438)[0])).toBeGreaterThan(1);
  });

  it('spreads a 600x plane step across the full 1.5-second snapshot interval', () => {
    const state = world(), animation = new TrafficAnimation();
    const plane = state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!;
    state.traffic.vehicles = [plane];
    const start = { lon: plane.lon, lat: plane.lat };
    animation.update(state, 0);
    tick(state);
    animation.update(state, 1500);
    const early = trafficDistance(start, animation.frame(1800)[0]);
    const middle = trafficDistance(start, animation.frame(2250)[0]);
    const end = trafficDistance(start, animation.frame(3000)[0]);
    expect(early).toBeCloseTo(42.5, 0);
    expect(middle).toBeCloseTo(106.25, 0);
    expect(end).toBeCloseTo(212.5, 0);
  });

  it('moves aircraft and ships at real cruising speed between worker steps, then freezes on pause', () => {
    const state = world(), animation = new TrafficAnimation();
    const plane = state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!;
    const ship = state.traffic.vehicles.find(v => v.kind === 'ships' && trafficDistance(v, v.destination) > 100)!;
    state.traffic.vehicles = [plane, ship];
    const starts = state.traffic.vehicles.map(v => ({ lon: v.lon, lat: v.lat }));
    animation.update(state, 0);
    animation.setClock(0, 1, true, 0);
    const moving = animation.frame(60_000).map(marker => ({ ...marker }));
    expect(trafficDistance(starts[0], moving[0])).toBeCloseTo(850 / 60, 1);
    expect(trafficDistance(starts[1], moving[1])).toBeCloseTo(30 / 60, 1);
    animation.setClock(1 / 60, 1, false, 60_000);
    expect(animation.frame(120_000)).toEqual(moving);
  });

  it('does not rewind fractional travel when a reply repeats the same clock checkpoint', () => {
    const state = world(), animation = new TrafficAnimation();
    state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!];
    animation.update(state, 0); animation.setClock(0, 600, true, 0);
    const before = { ...animation.frame(300)[0] };
    animation.setClock(0, 600, true, 300);
    expect(trafficDistance(before, animation.frame(300)[0])).toBeLessThan(0.001);
    expect(trafficDistance(before, animation.frame(400)[0])).toBeGreaterThan(1);
  });

  it('uses actual batched movement at high speed and never goes backwards on clock or state updates', () => {
    const state = world(), animation = new TrafficAnimation();
    const plane = state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 5000)!;
    state.traffic.vehicles = [plane];
    const start = { lon: plane.lon, lat: plane.lat };
    animation.update(state, 0); animation.setClock(0, 14400, true, 0);
    let previousDistance = 0;
    for (let batch = 1; batch <= 4; batch++) {
      const now = batch * 250;
      const before = { ...animation.frame(now)[0] };
      for (let i = 0; i < 4; i++) tick(state);
      animation.setClock(state.hours, 14400, true, now);
      animation.update(state, now);
      expect(trafficDistance(before, animation.frame(now)[0])).toBeLessThan(0.01);
      for (let elapsed = 0; elapsed <= 240; elapsed += 20) {
        const at = now + elapsed, marker = { ...animation.frame(at)[0] };
        const distance = trafficDistance(start, marker);
        expect(distance).toBeGreaterThanOrEqual(previousDistance - 0.01);
        previousDistance = distance;
        animation.setClock(state.hours, 14400, true, at);
        expect(trafficDistance(marker, animation.frame(at)[0])).toBeLessThan(0.01);
      }
    }
    expect(previousDistance).toBeGreaterThan(3000);
  });

  it('freezes buffered high-speed travel on pause and resumes from the visible position', () => {
    const state = world(), animation = new TrafficAnimation();
    state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!];
    animation.update(state, 0); animation.setClock(0, 14400, true, 0);
    for (let i = 0; i < 4; i++) tick(state);
    animation.setClock(state.hours, 14400, true, 250); animation.update(state, 250);
    const before = structuredClone(animation.frame(375));
    animation.setClock(state.hours, 14400, false, 375);
    expect(animation.frame(1375)).toEqual(before);
    animation.setClock(state.hours, 14400, true, 1375);
    expect(animation.frame(1375)).toEqual(before);
    expect(trafficDistance(before[0], animation.frame(1400)[0])).toBeGreaterThan(1);
  });

  it('switches to high-speed history without backing up an already predicted aircraft', () => {
    const state = world(), animation = new TrafficAnimation();
    state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes' && trafficDistance(v, v.destination) > 2500)!];
    animation.update(state, 0); animation.setClock(0, 600, true, 0);
    const before = { ...animation.frame(300)[0] };
    animation.setClock(0, 14400, true, 300);
    expect(trafficDistance(before, animation.frame(300)[0])).toBeLessThan(0.01);
    for (let i = 0; i < 4; i++) tick(state);
    animation.setClock(state.hours, 14400, true, 550); animation.update(state, 550);
    expect(trafficDistance(before, animation.frame(550)[0])).toBeLessThan(0.01);
    expect(trafficDistance(before, animation.frame(600)[0])).toBeGreaterThan(1);
  });

  it('continues an unfinished interpolation from the same position after a long map gesture', () => {
    const state = world(), animation = new TrafficAnimation(), clock = new AnimationClock();
    animation.update(state, clock.read(0));
    tick(state);
    animation.update(state, clock.read(250));
    const before = structuredClone(animation.frame(clock.read(375)));
    clock.setPaused(true, 375);
    expect(animation.frame(clock.read(10_375))).toEqual(before);
    clock.setPaused(false, 10_375);
    expect(animation.frame(clock.read(10_375))).toEqual(before);
    expect(trafficDistance(before[0], animation.frame(clock.read(10_391))[0])).toBeLessThan(TRAFFIC_SPEED.planes * 0.016 + 0.01);
  });
});
