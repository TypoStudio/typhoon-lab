import type { ToolType, WeatherHazardKind } from '../types';

interface HazardDefinition {
  name: string; radiusKm: number; durationHours: number; buildupHours: number; damage: number; pressureHpa: number;
  anchor: ToolType; landOnly: boolean; moves: boolean; color: string; iconPath: string; impact: string;
}

/** Display and gameplay constants; all seven phenomena use the same recipe/replay pipeline. */
export const WEATHER_HAZARDS = {
  heatwave: { name: 'Heatwave', radiusKm: 450, durationHours: 72, buildupHours: 12, damage: 0.025, pressureHpa: 12,
    anchor: 'warm-air', landOnly: false, moves: false, color: '#f4a259',
    iconPath: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
    impact: 'Extreme heat strains health services and electricity supplies.' },
  drought: { name: 'Drought', radiusKm: 550, durationHours: 120, buildupHours: 24, damage: 0.02, pressureHpa: 10,
    anchor: 'dry', landOnly: true, moves: false, color: '#c8a06a',
    iconPath: 'M2 18h20M3 22l5-4-2-4 5-4M8 22l5-4-2-4 5-4M15 22l4-4M17 2c2 3 3 4 3 6a3 3 0 0 1-6 0c0-2 1-3 3-6',
    impact: 'Water shortages damage crops and restrict water supplies.' },
  downpour: { name: 'Downpour', radiusKm: 250, durationHours: 12, buildupHours: 2, damage: 0.06, pressureHpa: -10,
    anchor: 'updraft', landOnly: false, moves: true, color: '#7cbbea',
    iconPath: 'M6 13a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9H6M7 16l-2 5M13 16l-2 5M19 16l-2 5',
    impact: 'Intense rain causes flash flooding and closes roads.' },
  coldwave: { name: 'Cold wave', radiusKm: 450, durationHours: 72, buildupHours: 8, damage: 0.03, pressureHpa: 16,
    anchor: 'cold-air', landOnly: false, moves: false, color: '#9dd5f2',
    iconPath: 'M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 3l3 3 3-3M9 21l3-3 3 3M3 10l4-1-1-4M21 14l-4 1 1 4',
    impact: 'Severe cold freezes pipes, damages crops and disrupts transport.' },
  hail: { name: 'Hail', radiusKm: 180, durationHours: 3, buildupHours: 0.5, damage: 0.035, pressureHpa: -6,
    anchor: 'updraft', landOnly: false, moves: true, color: '#d2e6ef',
    iconPath: 'M6 12a4 4 0 0 1 0-8 6 6 0 0 1 11-1 4.5 4.5 0 0 1 1 9H6M5 16l2 2-2 2-2-2ZM13 16l2 2-2 2-2-2ZM20 16l2 2-2 2-2-2Z',
    impact: 'Hail damages roofs, vehicles and crops.' },
  dust: { name: 'Yellow dust', radiusKm: 450, durationHours: 24, buildupHours: 3, damage: 0.008, pressureHpa: -8,
    anchor: 'dry', landOnly: true, moves: true, color: '#d5bc7d',
    iconPath: 'M2 7h13a3 3 0 1 0-3-3M2 12h17a3 3 0 1 1-3 3M3 18h7M3 3h.1M19 20h.1M14 21h.1M21 7h.1',
    impact: 'Blowing dust reduces visibility and disrupts outdoor work and transport.' },
  gust: { name: 'Wind gust', radiusKm: 220, durationHours: 2, buildupHours: 0.25, damage: 0.045, pressureHpa: 6,
    anchor: 'downdraft', landOnly: false, moves: true, color: '#b5dddb',
    iconPath: 'M2 5h13a3 3 0 1 0-3-3M2 11h17a3 3 0 1 1-3 3M3 18h8M16 17v6M13 20l3 3 3-3',
    impact: 'Sudden strong gusts bring down trees and damage buildings.' },
} as const satisfies Record<WeatherHazardKind, HazardDefinition>;

export const WEATHER_HAZARD_KINDS = Object.keys(WEATHER_HAZARDS) as WeatherHazardKind[];
export function isWeatherHazardKind(value: unknown): value is WeatherHazardKind {
  return typeof value === 'string' && Object.hasOwn(WEATHER_HAZARDS, value);
}
