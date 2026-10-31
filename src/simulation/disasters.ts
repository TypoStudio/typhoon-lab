import { WEATHER_HAZARDS, isWeatherHazardKind } from '../data/weather-hazards';
import type { DisasterKind, DisasterRecord, EnvironmentCell, GameState, GeoPoint } from '../types';
import { distanceKm } from './geo';
import { estimateStormDamage } from './damage-news';

export function disasterName(kind: DisasterKind): string {
  return isWeatherHazardKind(kind) ? WEATHER_HAZARDS[kind].name : ({ blizzard: 'Blizzard', tornado: 'Tornado', thunderstorm: 'Thunderstorm' })[kind];
}

export function disasterDamage(record: Pick<DisasterRecord, 'damageScore' | 'transportLossUsd' | 'kind'>) {
  const report = estimateStormDamage(record.damageScore);
  report.lossUsd += record.transportLossUsd;
  if (record.kind === 'dust' || record.kind === 'drought') { report.deaths = 0; report.missing = 0; }
  return report;
}

/** Observe current sources once per fixed step. Ended records keep their final location and readings. */
export function syncDisasters(state: GameState, sample: (point: GeoPoint) => EnvironmentCell): void {
  const records = state.disasters ??= [];
  const byId = new Map(records.map(record => [record.id, record]));
  const seen = new Set<string>();
  const observe = (id: string, kind: DisasterKind, point: GeoPoint, age: number, radiusKm: number, intensity: number, wind?: number, cell = sample(point)) => {
    seen.add(id);
    let record = byId.get(id);
    const speed = wind ?? Math.hypot(cell.u, cell.v);
    if (!record) {
      record = { id, kind, lon: point.lon, lat: point.lat, startedHour: state.hours - age, updatedHour: state.hours,
        ageHours: age, radiusKm, intensity, movementSpeedKmh: 0, wind: speed, peakWind: speed,
        pressure: cell.pressure, airTemperature: cell.airTemperature, humidity: cell.humidity, rain: cell.rain, snowCm: cell.snowCm,
        damageScore: 0, transportLossUsd: 0, history: [] };
      records.push(record); byId.set(id, record);
    }
    const elapsed = state.hours - record.updatedHour;
    record.movementSpeedKmh = elapsed > 0 ? distanceKm(record.lon, record.lat, point.lon, point.lat) / elapsed : 0;
    Object.assign(record, point, { ageHours: age, radiusKm, intensity, updatedHour: state.hours, wind: speed,
      peakWind: Math.max(record.peakWind, speed), pressure: cell.pressure, airTemperature: cell.airTemperature,
      humidity: cell.humidity, rain: cell.rain, snowCm: cell.snowCm });
  };
  for (const hazard of state.weatherHazards ?? []) {
    observe(`weather-${hazard.id}`, hazard.kind, { lon: hazard.lon, lat: hazard.lat }, hazard.ageHours, hazard.radiusKm, hazard.intensity);
  }
  for (const storm of state.thunderstorms) {
    observe(`thunderstorm-${storm.id}`, 'thunderstorm', { lon: storm.lon, lat: storm.lat }, storm.ageHours, storm.radiusKm, storm.intensity, storm.tornado ? 8 + 30 * storm.intensity : storm.gustMs);
    if (storm.tornado) observe(`tornado-${storm.id}`, 'tornado', { lon: storm.lon, lat: storm.lat }, storm.ageHours - (storm.tornadoStartAgeHours ?? storm.ageHours), 8, storm.intensity, storm.gustMs);
  }
  // The simulation's blizzard episode includes the lingering snow load until it melts.
  const winter = records.find(record => record.kind === 'blizzard' && record.endedHour === undefined);
  const snowy = state.grid.filter(cell => cell.blizzard || (winter && cell.snowCm >= 20));
  if (snowy.length) {
    const lat = snowy.reduce((sum, cell) => sum + cell.lat, 0) / snowy.length;
    const lon = Math.atan2(snowy.reduce((sum, c) => sum + Math.sin(c.lon * Math.PI / 180), 0), snowy.reduce((sum, c) => sum + Math.cos(c.lon * Math.PI / 180), 0)) * 180 / Math.PI;
    const centre = { lon, lat };
    const strongest = snowy.reduce((best, cell) => cell.snowCm > best.snowCm ? cell : best);
    const wind = Math.max(...snowy.map(cell => Math.hypot(cell.u, cell.v)));
    const radius = Math.max(100, ...snowy.map(cell => distanceKm(lon, lat, cell.lon, cell.lat) + 100));
    observe(winter?.id ?? `blizzard-${state.tick}`, 'blizzard', centre, winter ? state.hours - winter.startedHour : 0, radius, Math.min(1, strongest.snowCm / 100), wind, strongest);
  }
  for (const record of records) if (record.endedHour === undefined && !seen.has(record.id)) {
    record.endedHour = state.hours;
    record.ageHours = state.hours - record.startedHour;
    record.intensity = 0;
  }
}

/** Hourly history plus first/final observations, after this step's land and vehicle damage. */
export function recordDisasterHistory(state: GameState): void {
  for (const record of state.disasters ?? []) {
    if (record.endedHour !== undefined && record.endedHour !== state.hours) continue;
    const last = record.history.at(-1);
    if (last && Math.floor(last.hour) === Math.floor(state.hours) && record.endedHour === undefined) continue;
    const { wind, pressure, airTemperature, humidity, rain, snowCm, damageScore } = record;
    record.history.push({ hour: state.hours, wind, pressure, airTemperature, humidity, rain, snowCm, damageScore });
  }
}
