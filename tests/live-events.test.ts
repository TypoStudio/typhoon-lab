import { expect, it } from 'vitest';
import { parseGdacsEvents } from '../src/data/live-events';
import { createGame, pressureDeficit, seedLiveEvents } from '../src/simulation/engine';
import type { LiveEvent } from '../src/types';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const feature = (props: object, coordinates: unknown = [140, 15], type = 'Point') => ({ type: 'Feature', geometry: { type, coordinates }, properties: props });
const FIXTURE = { type: 'FeatureCollection', features: [
  feature({ eventtype: 'TC', eventname: 'MURASU-26', alertlevel: 'Red', iscurrent: 'true', todate: '2026-11-21T00:00:00', country: 'India',
    severitydata: { severity: 157.4, severityunit: 'km/h' }, url: { report: 'https://www.gdacs.org/report.aspx?eventid=1&episodeid=2&eventtype=TC' } }),
  feature({ eventtype: 'DR', eventname: 'Central America-2026', alertlevel: 'Orange', iscurrent: 'false', todate: '2026-11-20T00:00:00' }, [-95.1, 18.3]),
  feature({ eventtype: 'FL', name: 'Flood in India', eventname: '', alertlevel: 'Green', iscurrent: 'false', todate: '2026-11-20T12:00:00' }, [78.6, 11.3]),
  feature({ eventtype: 'TC', eventname: 'OLD-26', alertlevel: 'Red', iscurrent: 'false', todate: '2026-11-01T00:00:00' }),
  feature({ eventtype: 'EQ', eventname: 'QUAKE', alertlevel: 'Red', iscurrent: 'true', todate: '2026-11-21T00:00:00' }),
  feature({ eventtype: 'TC', eventname: 'POLY', alertlevel: 'Red', iscurrent: 'true', todate: '2026-11-21T00:00:00' }, [[[0, 0]]], 'Polygon'),
  feature({ eventtype: 'DR', eventname: 'Drought 6 days ago', alertlevel: 'Green', iscurrent: 'false', todate: '2026-11-15T00:00:00' }, [-100, 25]),
  feature({ eventtype: 'FL', eventname: 'Flood 6 days ago', alertlevel: 'Green', iscurrent: 'false', todate: '2026-11-15T00:00:00' }, [78.6, 11.3]),
] };

it('parses current GDACS events and drops stale, unknown or non-point ones', () => {
  const events = parseGdacsEvents(FIXTURE, NOW);
  expect(events.map(e => [e.kind, e.name, e.alert])).toEqual([['cyclone', 'MURASU-26', 'red'], ['drought', 'Central America-2026', 'orange'], ['flood', 'Flood in India', 'green'], ['drought', 'Drought 6 days ago', 'green']]);
  expect(events[0]).toMatchObject({ lon: 140, lat: 15, windKmh: 157.4, country: 'India', url: expect.stringContaining('gdacs.org/report') });
  expect(parseGdacsEvents({ nope: 1 }, NOW)).toEqual([]);
});

it('seeds a free-running storm with estimated pressure, plus downpour and drought hazards', () => {
  const state = createGame(1, 200);
  const events: LiveEvent[] = [
    { kind: 'cyclone', name: 'MURASU-26', lon: 140, lat: 15, alert: 'red', windKmh: 180 },
    { kind: 'cyclone', name: 'ON-LAND', lon: 100, lat: 40, alert: 'red', windKmh: 100 },
    { kind: 'flood', name: 'Flood in India', lon: 78.6, lat: 11.3, alert: 'orange' },
    { kind: 'drought', name: 'Drought in Mexico', lon: -100, lat: 25, alert: 'green' },
  ];
  expect(seedLiveEvents(state, events)).toBe(3);
  const [storm] = state.storms;
  expect(state.storms).toHaveLength(1);
  expect(storm).toMatchObject({ name: 'MURASU-26' });
  expect(storm.record).toBeUndefined();
  expect(storm.wind).toBeCloseTo(50, 5);
  expect(storm.pressure).toBeCloseTo(1010 - pressureDeficit(50), 5);
  expect(state.historic).toHaveLength(0);
  expect(state.actions).toHaveLength(0);
  expect(state.weatherHazards.map(h => h.kind)).toEqual(['downpour', 'drought']);
  expect(state.news.some(n => n.id === 'welcome')).toBe(false);
  expect(state.news.filter(n => n.title.startsWith('Live: '))).toHaveLength(3);
  expect(state.liveEventsSource).toBe(3);
});
