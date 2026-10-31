import { CITIES } from './world';
import type { GeoPoint } from '../types';
import type { TrafficKind } from '../types';

export type { TrafficKind } from '../types';
export interface TrafficRoute { id: string; kind: TrafficKind; from: string; to: string; start: GeoPoint; end: GeoPoint }

// Illustrative services between major cities, not live flight or vessel data.
const AIR_LINKS = [
  ['Seoul', 'Tokyo'], ['Seoul', 'Beijing'], ['Seoul', 'Shanghai'], ['Seoul', 'Taipei'],
  ['Seoul', 'Manila'], ['Seoul', 'Bangkok'], ['Seoul', 'Singapore'], ['Busan', 'Tokyo'],
  ['Tokyo', 'Shanghai'], ['Tokyo', 'Taipei'], ['Tokyo', 'Manila'], ['Tokyo', 'Honolulu'],
  ['Shanghai', 'Hong Kong'], ['Shanghai', 'Beijing'], ['Taipei', 'Hong Kong'],
  ['Hong Kong', 'Manila'], ['Hong Kong', 'Singapore'], ['Manila', 'Singapore'],
  ['Bangkok', 'Singapore'], ['Singapore', 'Jakarta'], ['Singapore', 'Sydney'],
  ['Sydney', 'Auckland'], ['Tokyo', 'Los Angeles'], ['Los Angeles', 'New York'],
  ['New York', 'London'], ['London', 'Paris'], ['London', 'Dubai'],
  ['Dubai', 'Mumbai'], ['Mumbai', 'Singapore'], ['London', 'Cape Town'],
  ['Miami', 'New York'], ['New York', 'São Paulo'],
] as const;

// Offshore approaches to port cities. Sea navigation joins these through ocean-only edges.
export const TRAFFIC_PORTS: Record<string, GeoPoint> = {
  Busan: { lon: 129.2, lat: 34.9 }, Tokyo: { lon: 139.9, lat: 34.8 },
  Shanghai: { lon: 122.3, lat: 30.7 }, Taipei: { lon: 121.9, lat: 25.3 },
  'Hong Kong': { lon: 114.3, lat: 22.05 }, Manila: { lon: 120.5, lat: 14.2 },
  Singapore: { lon: 104.5, lat: 1.5 }, Mumbai: { lon: 72.5, lat: 18.8 },
  Colombo: { lon: 79.5, lat: 6.7 },
  Rotterdam: { lon: 3.7, lat: 52.2 }, 'New York': { lon: -73.5, lat: 40.2 },
  Miami: { lon: -79.7, lat: 25.5 }, 'Los Angeles': { lon: -118.5, lat: 33.5 },
  Honolulu: { lon: -158, lat: 20.9 }, Sydney: { lon: 151.5, lat: -34 },
  Auckland: { lon: 175.2, lat: -36.5 }, 'Cape Town': { lon: 18, lat: -34.4 },
  Santos: { lon: -46.1, lat: -24.3 },
};
const SEA_LINKS = [
  ['Busan', 'Tokyo'], ['Busan', 'Shanghai'], ['Busan', 'Taipei'],
  ['Shanghai', 'Taipei'], ['Shanghai', 'Hong Kong'], ['Taipei', 'Manila'],
  ['Hong Kong', 'Manila'], ['Hong Kong', 'Singapore'], ['Manila', 'Singapore'],
  ['Singapore', 'Colombo'], ['Colombo', 'Mumbai'],
  ['Singapore', 'Sydney'], ['Sydney', 'Auckland'], ['Tokyo', 'Honolulu'],
  ['Honolulu', 'Los Angeles'], ['New York', 'Rotterdam'], ['New York', 'Miami'],
  ['Miami', 'Santos'], ['Rotterdam', 'Cape Town'], ['Cape Town', 'Colombo'],
] as const;

export const TRAFFIC_ROUTES: TrafficRoute[] = [
  ...AIR_LINKS.flatMap(([from, to], i): TrafficRoute[] => {
    const start = CITIES.find(c => c.name === from), end = CITIES.find(c => c.name === to);
    return start && end ? [{ id: `air-${i}`, kind: 'planes', from, to, start, end }] : [];
  }),
  ...SEA_LINKS.map(([from, to], i): TrafficRoute => ({
    id: `sea-${i}`, kind: 'ships', from, to, start: TRAFFIC_PORTS[from], end: TRAFFIC_PORTS[to],
  })),
];

/** Both directions are departure options; the UI projects these origins onto either camera. */
export const TRAFFIC_DEPARTURES = TRAFFIC_ROUTES.flatMap(service => [false, true].map(reverse => ({
  id: `${service.id}:${reverse ? 1 : 0}`, serviceId: service.id, kind: service.kind, reverse,
  start: reverse ? service.end : service.start, end: reverse ? service.start : service.end,
  from: reverse ? service.to : service.from, to: reverse ? service.from : service.to,
})));
