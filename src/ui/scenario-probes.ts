import { MAX_PINS, type MeasureId } from './measure';

/** One starter probe a loaded climate scenario puts in the Measure tab. `label` is an English place name (translated for display); basin charts have none. */
export interface ScenarioProbe { item: MeasureId; lon: number; lat: number; label?: string }

/**
 * Same set for both scenarios: the three basin charts, then the places that show an El Niño or La Niña (the Niño 3.4 chart carries the Observed line).
 * Nine pins in all (the sea-temperature and thermocline charts share two of them), so three of the twelve stay free for the player.
 */
export const SCENARIO_PROBES: readonly ScenarioProbe[] = [
  { item: 'measure-nino34', lon: 0, lat: 0 },
  { item: 'measure-soi-wwv', lon: 0, lat: 0 },
  { item: 'measure-sea-temperature', lon: -170, lat: 0, label: 'Central Pacific' },
  { item: 'measure-sea-temperature', lon: -110, lat: 0, label: 'East Pacific' },
  { item: 'measure-sea-temperature', lon: 150, lat: 0, label: 'Warm pool' },
  { item: 'measure-thermocline', lon: -110, lat: 0, label: 'East Pacific' },
  { item: 'measure-thermocline', lon: 150, lat: 0, label: 'Warm pool' },
  { item: 'measure-pressure', lon: 130.9, lat: -12.4, label: 'Darwin' },
  { item: 'measure-pressure', lon: -149.6, lat: -17.5, label: 'Tahiti' },
  { item: 'measure-humidity', lon: 115, lat: 0, label: 'Indonesia' },
  { item: 'measure-humidity', lon: -81, lat: -5, label: 'Coastal Peru' },
  { item: 'measure-formation', lon: 150, lat: 15, label: 'Western North Pacific' },
  { item: 'measure-formation', lon: 170, lat: 15, label: 'Central North Pacific' },
];
export const SCENARIO_PROBE_PINS = new Set(SCENARIO_PROBES.filter(p => p.label).map(p => `${p.lon},${p.lat}`)).size;
if (SCENARIO_PROBE_PINS > MAX_PINS) throw new Error('The scenario probe set needs more pins than the Measure tab allows.');
