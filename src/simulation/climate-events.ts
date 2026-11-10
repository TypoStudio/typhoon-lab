import { WEATHER_HAZARDS } from '../data/weather-hazards';
import type { EnvironmentCell, GameState, GeoPoint, WeatherHazardKind } from '../types';
import type { AnomalyPoint } from './climate-coupling';
import { hash01 } from './geo';

/**
 * Events of a loaded climate scenario that make it more than a chart (all of it inactive in any other world):
 *
 *  1. Climate-driven disasters. Once per model day, at weather speeds only (the fast path does not run the weather), every region of
 *     `CLIMATE_REGIONS` tests the model's own state: the smoothed Nino 3.4 of the ENSO layer must be on the region's side of zero, and the layer's local
 *     anomaly at the region's probe point (relative humidity, which carries the model's rain anomaly in the tropics and the observed-statistics
 *     teleconnection elsewhere; air temperature; or sea-surface temperature) must pass a threshold. Above it, a hazard of an existing kind starts there
 *     with a probability that grows with the anomaly. With the anomaly removed nothing fires. The disaster then goes through the ordinary hazard,
 *     disaster-record, damage and news systems.
 *  2. A record of well-documented real events on their dates (`HISTORIC_RECORD`), as news only: no damage, no model result, shown at every speed.
 */

type Driver = 'nino' | 'nina';
interface ClimateRegion {
  driver: Driver;
  kind: Extract<WeatherHazardKind, 'downpour' | 'drought' | 'heatwave'>;
  /** English place phrase for the news title. */
  place: string;
  /** Where the hazard starts. */
  lon: number; lat: number;
  /** First and last month (1-12) of the season it can start in; the window wraps over the new year when first > last. */
  from: number; to: number;
  /** The layer's anomaly that decides, and where it is read. */
  field: 'hum' | 'air' | 'sst';
  probe: GeoPoint;
  /** The anomaly (in the direction of the event) where the daily probability starts to grow, and where it reaches its maximum. */
  lo: number; hi: number;
}

/**
 * Kinds: "heavy rain" is the existing downpour, "drought" the drought and "heat" the heatwave. Thresholds are in the units of the layer's own fields
 * (relative humidity as a fraction, degC); they sit just under the strongest anomaly the model gives each place in a strong event (see VALIDATION.md).
 * Places and seasons follow the standard ENSO teleconnection literature (e.g. Ropelewski and Halpert 1987; NOAA CPC ENSO impacts).
 */
export const CLIMATE_REGIONS: readonly ClimateRegion[] = [
  // El Nino side
  { driver: 'nino', kind: 'downpour', place: 'coastal Peru and Ecuador', lon: -80.5, lat: -4.5, from: 12, to: 4, field: 'sst', probe: { lon: -86, lat: -4 }, lo: 0.8, hi: 2.0 },
  { driver: 'nino', kind: 'drought', place: 'Indonesia', lon: 111, lat: -2, from: 8, to: 11, field: 'hum', probe: { lon: 111, lat: -2 }, lo: 0.004, hi: 0.015 },
  { driver: 'nino', kind: 'heatwave', place: 'Indonesia', lon: 104, lat: -2.5, from: 9, to: 12, field: 'air', probe: { lon: 104, lat: -2.5 }, lo: 0.15, hi: 0.5 },
  { driver: 'nino', kind: 'drought', place: 'northern Australia', lon: 133, lat: -13, from: 9, to: 12, field: 'hum', probe: { lon: 133, lat: -12 }, lo: 0.02, hi: 0.07 },
  { driver: 'nino', kind: 'heatwave', place: 'northern Australia', lon: 130, lat: -17, from: 10, to: 12, field: 'air', probe: { lon: 127, lat: -18 }, lo: 0.2, hi: 0.7 },
  { driver: 'nino', kind: 'drought', place: 'eastern Australia', lon: 147, lat: -30, from: 8, to: 11, field: 'hum', probe: { lon: 146, lat: -30 }, lo: 0.012, hi: 0.04 },
  { driver: 'nino', kind: 'drought', place: 'India', lon: 80, lat: 24, from: 6, to: 9, field: 'hum', probe: { lon: 84, lat: 27 }, lo: 0.005, hi: 0.02 },
  { driver: 'nino', kind: 'drought', place: 'southern Africa', lon: 26, lat: -24, from: 12, to: 3, field: 'hum', probe: { lon: 28, lat: -26 }, lo: 0.02, hi: 0.07 },
  { driver: 'nino', kind: 'downpour', place: 'East Africa', lon: 38, lat: 3, from: 10, to: 12, field: 'hum', probe: { lon: 38, lat: 4 }, lo: 0.01, hi: 0.04 },
  { driver: 'nino', kind: 'downpour', place: 'the southern United States', lon: -97, lat: 33, from: 12, to: 3, field: 'hum', probe: { lon: -100, lat: 36 }, lo: 0.02, hi: 0.07 },
  // La Nina side
  { driver: 'nina', kind: 'downpour', place: 'eastern Australia', lon: 148, lat: -23, from: 12, to: 3, field: 'hum', probe: { lon: 144, lat: -20 }, lo: 0.006, hi: 0.018 },
  { driver: 'nina', kind: 'downpour', place: 'Indonesia', lon: 101, lat: -2, from: 12, to: 3, field: 'hum', probe: { lon: 101, lat: -2 }, lo: 0.001, hi: 0.004 },
  { driver: 'nina', kind: 'drought', place: 'the Horn of Africa', lon: 42, lat: 4, from: 10, to: 12, field: 'hum', probe: { lon: 38, lat: 6 }, lo: 0.008, hi: 0.025 },
  { driver: 'nina', kind: 'drought', place: 'the southwestern United States', lon: -108, lat: 34, from: 12, to: 3, field: 'hum', probe: { lon: -106, lat: 36 }, lo: 0.015, hi: 0.045 },
  { driver: 'nina', kind: 'downpour', place: 'South Asia', lon: 85, lat: 25, from: 7, to: 9, field: 'hum', probe: { lon: 83, lat: 28 }, lo: 0.002, hi: 0.009 },
  { driver: 'nina', kind: 'downpour', place: 'Colombia', lon: -74.5, lat: 5, from: 9, to: 12, field: 'hum', probe: { lon: -78, lat: 8 }, lo: 0.002, hi: 0.008 },
];

/** News that outlives routine items when the feed is full: climate-driven events and the record of real events. */
const isLastingNews = (id: string): boolean => id.startsWith('climate-event-') || id.startsWith('climate-record-');
/** Cuts a news feed to `max` items: the oldest routine items go first, then the oldest of any kind. A feed with no lasting items loses exactly its oldest items. */
export function trimNews(news: { id: string }[], max: number): void {
  while (news.length > max) {
    const k = news.findIndex(n => !isLastingNews(n.id));
    news.splice(k < 0 ? 0 : k, 1);
  }
}

/** Smoothed Nino 3.4 (degC) the layer must have on the region's side of zero. */
export const CLIMATE_NINO_MIN = 0.7;
/** Daily start probability at full anomaly. */
const P_MAX = 0.04;
/** Model days a region rests after one of its events. */
export const CLIMATE_COOLDOWN_DAYS = 35;
/** Climate-driven hazards that may run at once on the whole map. */
export const CLIMATE_MAX_ACTIVE = 4;
/** A climate-driven event outlasts the recipe it is modelled on (heat and drought build over days, a flood takes more than half a day). */
const DURATION_FACTOR: Record<ClimateRegion['kind'], number> = { downpour: 3, drought: 2, heatwave: 2 };
const KIND_PHRASE: Record<ClimateRegion['kind'], string> = { downpour: 'heavy rain', drought: 'drought', heatwave: 'heat' };
const KIND_EFFECT: Record<ClimateRegion['kind'], string> = {
  downpour: 'It can cause flash flooding and close roads.', drought: 'Water shortages can damage crops.', heatwave: 'Extreme heat strains health services and electricity supplies.',
};
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
/** Month (1-12) of a day of the year (1 = 1 January, fractional, to 365.25). */
export function monthOf(doy: number): number {
  let m = 11;
  while (m > 0 && doy < MONTH_START[m] + 1) m--;
  return m + 1;
}
const inWindow = (m: number, from: number, to: number): boolean => (from <= to ? m >= from && m <= to : m >= from || m <= to);

export interface ClimateEventHost {
  /** The layer's smoothed Nino 3.4, or null without a layer. */
  nino: number | null;
  /** The layer's anomalies at a point. */
  probe: (lon: number, lat: number) => AnomalyPoint | null;
  /** The weather cell at a point (for the hazard's drift direction). */
  sample: (point: GeoPoint) => EnvironmentCell;
  /** Whole model days since the world began, and the calendar's day of the year. */
  day: number;
  doy: number;
}

/**
 * The once-a-day check. Returns the number of events started. Cost without a scenario: none (the engine does not call this). With one, a few
 * comparisons per region and one bilinear read for a region that is in season with the right Nino sign.
 */
export function stepClimateEvents(state: GameState, host: ClimateEventHost, emit: (news: { id: string; title: string; text: string; phenomenon: WeatherHazardKind; lon: number; lat: number }) => void): number {
  const info = state.climateScenario;
  if (!info || host.nino === null) return 0;
  const hazards = state.weatherHazards ??= [];
  let active = 0;
  for (const h of hazards) if (h.climate) active++;
  const month = monthOf(host.doy);
  const n = CLIMATE_REGIONS.length;
  let started = 0;
  info.eventLast.length = n;
  for (let q = 0; q < n && active < CLIMATE_MAX_ACTIVE; q++) {
    const i = (q + host.day) % n; // the order rotates by day, so the cap does not always favour the same regions
    const r = CLIMATE_REGIONS[i];
    if ((r.driver === 'nino' ? host.nino : -host.nino) < CLIMATE_NINO_MIN || !inWindow(month, r.from, r.to)) continue;
    const last = info.eventLast[i];
    if (last != null && host.day - last < CLIMATE_COOLDOWN_DAYS) continue;
    const a = host.probe(r.probe.lon, r.probe.lat);
    if (!a) continue;
    const value = r.kind === 'drought' ? -a[r.field] : a[r.field];
    const p = P_MAX * Math.min(1, Math.max(0, (value - r.lo) / (r.hi - r.lo)));
    if (p <= 0 || hash01(state.seed ^ (info.loads * 7919), host.day, 31000 + i) >= p) continue;
    const def = WEATHER_HAZARDS[r.kind], wind = host.sample(r);
    const id = info.loads * 1_000_000 + ++info.eventSeq;
    hazards.push({ id, kind: r.kind, lon: r.lon, lat: r.lat, radiusKm: def.radiusKm, ageHours: 0, durationHours: def.durationHours * DURATION_FACTOR[r.kind],
      intensity: 1, directionRad: Math.atan2(wind.v, wind.u), climate: true });
    info.eventLast[i] = host.day;
    active++; started++;
    const driver = r.driver === 'nino' ? 'El Niño' : 'La Niña';
    emit({ id: `climate-event-${id}`, phenomenon: r.kind, lon: r.lon, lat: r.lat,
      title: `${driver}: ${KIND_PHRASE[r.kind]} in ${r.place}`, text: `The model's ${driver} drives this ${KIND_PHRASE[r.kind]}. ${KIND_EFFECT[r.kind]}` });
  }
  return started;
}

interface HistoricEvent {
  scenario: string;
  year: number; month: number; day: number;
  name: string;
  lon: number; lat: number;
}

/**
 * Real events of the two scenarios, posted as news on their dates. Month-level dates (the day is the middle or a well-known day of the month
 * or period named); no figures are quoted. They are a record, not a model result, and cause no damage. Sources: NOAA National Hurricane Center
 * and Japan Meteorological Agency (Pauline 1997, Paka 1997), WMO annual statements on the state of the climate for 1997-98 and 2010-11, UN OCHA /
 * ReliefWeb situation reports (floods in East Africa, Pakistan, Colombia, Thailand; Somalia famine declared 20 July 2011), Australian Bureau of
 * Meteorology (Queensland 2010-11), Texas state climatologist (drought 2011), Chinese government and WMO reports (Yangtze 1998), ASEAN
 * haze reports (Indonesia 1997).
 */
export const HISTORIC_RECORD: readonly HistoricEvent[] = [
  { scenario: 'nino-1997', year: 1997, month: 9, day: 15, name: 'Indonesian forest fires and haze', lon: 113, lat: -2 },
  { scenario: 'nino-1997', year: 1997, month: 10, day: 9, name: 'Hurricane Pauline strikes Mexico', lon: -99, lat: 16.5 },
  { scenario: 'nino-1997', year: 1997, month: 11, day: 15, name: 'East African floods', lon: 40, lat: 1 },
  { scenario: 'nino-1997', year: 1997, month: 12, day: 16, name: 'Typhoon Paka hits Guam', lon: 144.8, lat: 13.5 },
  { scenario: 'nino-1997', year: 1998, month: 2, day: 1, name: 'Floods in Peru and Ecuador', lon: -80, lat: -5 },
  { scenario: 'nino-1997', year: 1998, month: 8, day: 1, name: 'Yangtze floods in China', lon: 114, lat: 30.5 },
  { scenario: 'nina-2010', year: 2010, month: 7, day: 29, name: 'Floods in Pakistan', lon: 70.5, lat: 29.5 },
  { scenario: 'nina-2010', year: 2010, month: 11, day: 15, name: 'Floods in Colombia', lon: -74.5, lat: 5 },
  { scenario: 'nina-2010', year: 2010, month: 12, day: 28, name: 'Floods in Queensland, Australia', lon: 150, lat: -24 },
  { scenario: 'nina-2010', year: 2011, month: 6, day: 15, name: 'Severe drought in Texas', lon: -99, lat: 31.5 },
  { scenario: 'nina-2010', year: 2011, month: 7, day: 20, name: 'Drought in the Horn of Africa and famine in Somalia', lon: 45.5, lat: 3 },
  { scenario: 'nina-2010', year: 2011, month: 10, day: 15, name: 'Floods in Thailand', lon: 100.5, lat: 14.5 },
];

export const HISTORIC_RECORD_TEXT = 'A record of the real event on this date. It is not a result of the model and it causes no damage here.';

/** A date as one number that grows with time: the calendar year and the day of the year (1..366). */
export const dateSerial = (year: number, doy: number): number => year * 400 + Math.floor(doy);
const serialOf = (e: HistoricEvent): number => dateSerial(e.year, MONTH_START[e.month - 1] + e.day);
/** Posts the record's events dated after the last post up to `serial` (the world's date now), then moves the mark. Returns how many were posted. */
export function postHistoricRecord(info: NonNullable<GameState['climateScenario']>, serial: number, emit: (news: { id: string; title: string; text: string; lon: number; lat: number; serial: number }) => void): number {
  let posted = 0;
  if (serial <= info.recordSerial) return 0;
  for (const e of HISTORIC_RECORD) {
    if (e.scenario !== info.id) continue;
    const at = serialOf(e);
    if (at <= info.recordSerial || at > serial) continue;
    emit({ id: `climate-record-${info.loads}-${at}`, title: `Historical record: ${e.name}`, text: HISTORIC_RECORD_TEXT, lon: e.lon, lat: e.lat, serial: at });
    posted++;
  }
  info.recordSerial = serial;
  return posted;
}
