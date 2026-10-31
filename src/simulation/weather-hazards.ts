import { isWeatherHazardKind, WEATHER_HAZARDS } from '../data/weather-hazards';
import type { EnvironmentCell, GameState, GeoPoint, NewsItem, WeatherHazard } from '../types';
import { distanceKm, moveKm, smoothstep } from './geo';

type Emit = (news: Omit<NewsItem, 'hour'>) => void;

/** Gameplay pressure patterns: ridges for heat/drought/cold, troughs for rain/hail/dust,
 * and a pressure surge for a downdraft gust. These describe the accompanying weather system,
 * rather than a universal pressure response to temperature or precipitation alone. */
export function hazardPressureSystem(hazard: WeatherHazard): { lon: number; lat: number; amp: number; sigmaKm: number } {
  const definition = WEATHER_HAZARDS[hazard.kind];
  const buildup = 0.25 + 0.75 * smoothstep(0, Math.min(6, definition.buildupHours), hazard.ageHours);
  return { lon: hazard.lon, lat: hazard.lat, amp: definition.pressureHpa * hazard.intensity * buildup, sigmaKm: hazard.radiusKm * 0.75 };
}

export function hazardInfluence(hazard: WeatherHazard, point: GeoPoint): number {
  return hazard.intensity * (1 - smoothstep(0.2, 1, distanceKm(hazard.lon, hazard.lat, point.lon, point.lat) / hazard.radiusKm));
}

export function hazardWind(hazard: WeatherHazard, point: GeoPoint): { u: number; v: number } {
  const speed = ({ dust: 18, gust: 40, hail: 12, downpour: 8 } as Partial<Record<WeatherHazard['kind'], number>>)[hazard.kind] ?? 0;
  const strength = speed * hazardInfluence(hazard, point);
  return { u: Math.cos(hazard.directionRad) * strength, v: Math.sin(hazard.directionRad) * strength };
}

/** Apply the phenomenon to the same physical cells sampled by the map, vehicles and damage. */
export function applyHazardField(hazard: WeatherHazard, cell: EnvironmentCell): void {
  const weight = hazardInfluence(hazard, cell);
  if (weight <= 0) return;
  const wind = hazardWind(hazard, cell);
  cell.u += wind.u; cell.v += wind.v;
  switch (hazard.kind) {
    case 'heatwave': cell.airTemperature += Math.max(0, 42 - cell.airTemperature) * weight; break;
    case 'coldwave': cell.airTemperature -= Math.max(0, cell.airTemperature + 18) * weight; break;
    case 'drought': cell.humidity *= 1 - 0.9 * weight; cell.rain *= 1 - weight; break;
    case 'dust': cell.humidity *= 1 - 0.8 * weight; cell.rain *= 1 - weight; break;
    case 'downpour': cell.rain = Math.max(cell.rain, 60 * weight); break;
    case 'hail': cell.rain = Math.max(cell.rain, 35 * weight); break;
  }
}

export function hazardDamageRatio(hazard: WeatherHazard, point: GeoPoint): number {
  const definition = WEATHER_HAZARDS[hazard.kind];
  return definition.damage * smoothstep(0, definition.buildupHours, hazard.ageHours) * hazardInfluence(hazard, point);
}

/** Tagged recipe tools mature into one event. No new random source or replay action is needed. */
export function stepWeatherHazards(state: GameState, dt: number, sample: (point: GeoPoint) => EnvironmentCell, emit: Emit): void {
  state.weatherHazards ??= [];
  state.weatherHazards = state.weatherHazards.filter(hazard => {
    hazard.ageHours += dt;
    const definition = WEATHER_HAZARDS[hazard.kind];
    if (hazard.ageHours >= hazard.durationHours) {
      emit({ id: `weather-end-${hazard.id}`, kind: 'weather', phenomenon: hazard.kind,
        title: `${definition.name} subsides`, text: `${definition.name} conditions have eased.` });
      return false;
    }
    hazard.intensity = 1 - smoothstep(0.8 * hazard.durationHours, hazard.durationHours, hazard.ageHours);
    if (definition.moves) {
      const wind = sample(hazard);
      // Bound advection so an event's own gust cannot accelerate its transport without limit.
      const speed = Math.hypot(wind.u, wind.v), factor = speed > 20 ? 20 / speed : 1;
      Object.assign(hazard, moveKm(hazard.lon, hazard.lat, wind.u * factor * 3.6 * dt * 0.35, wind.v * factor * 3.6 * dt * 0.35));
    }
    return true;
  });
  for (const effect of state.effects) {
    if (!isWeatherHazardKind(effect.formation) || effect.triggered || effect.ageHours < 6) continue;
    const kind = effect.formation, definition = WEATHER_HAZARDS[kind];
    if (effect.type !== definition.anchor) continue;
    const wind = sample(effect);
    state.weatherHazards.push({ id: effect.id, kind, lon: effect.lon, lat: effect.lat, radiusKm: definition.radiusKm,
      ageHours: 0, durationHours: definition.durationHours, intensity: 1, directionRad: Math.atan2(wind.v, wind.u) });
    for (const same of state.effects) if (same.formation === kind && same.lon === effect.lon && same.lat === effect.lat) same.triggered = true;
    emit({ id: `weather-start-${effect.id}`, kind: 'weather', phenomenon: kind, title: `${definition.name} develops`,
      text: `${definition.name} near ${effect.lon.toFixed(1)}°, ${effect.lat.toFixed(1)}°. ${definition.impact}` });
  }
}
