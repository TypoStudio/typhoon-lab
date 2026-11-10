import { CLIMATE_SCENARIOS } from '../simulation/climate-scenarios';
import { TYPHOONS } from '../data/typhoons';
import type { GameState } from '../types';
import { CYCLONE_PATH } from './shell';

/** One tile of the Experience palette tab: a climate scenario or a recorded typhoon. */
export type ExperienceItem =
  | { key: string; kind: 'scenario'; id: string }
  | { key: string; kind: 'typhoon'; id: string };

/** The two climate scenarios first, then the recorded typhoons from the oldest year to the newest (same year: list order). */
export const EXPERIENCE_ITEMS: readonly ExperienceItem[] = [
  ...CLIMATE_SCENARIOS.map(s => ({ key: `scenario:${s.id}`, kind: 'scenario' as const, id: s.id })),
  ...TYPHOONS.map((h, i) => ({ h, i })).sort((a, b) => a.h.year - b.h.year || a.i - b.i)
    .map(({ h }) => ({ key: `typhoon:${h.id}`, kind: 'typhoon' as const, id: h.id })),
];

/** English source text of a typhoon tile's tooltip (translated by the tooltip): basin, peak pressure and, when recorded, peak wind. */
export function typhoonTipSource(h: { basin: string; peakPressure: number; peakWindMs: number | null }): string {
  return [h.basin, `Peak pressure ${h.peakPressure} hPa`, ...(h.peakWindMs === null ? [] : [`Peak wind ${Math.round(h.peakWindMs)} m/s`])].join(' · ');
}

/** Keys of the tiles that are live in this world: the loaded scenario, and every recorded typhoon whose storm is still active. */
export function activeExperienceKeys(state: Pick<GameState, 'climateScenario' | 'storms'>): Set<string> {
  const keys = new Set<string>();
  if (state.climateScenario) keys.add(`scenario:${state.climateScenario.id}`);
  for (const s of state.storms) if (s.record) keys.add(`typhoon:${s.record.typhoonId}`);
  return keys;
}

const SVG = (body: string) => `<svg class="tool__icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
export const TYPHOON_ICON = SVG(`<path d="${CYCLONE_PATH}" fill="currentColor" fill-rule="evenodd" stroke="none"/>`);
const WAVES = '<path d="M3 17c2-1.5 3.5 1.5 6 0s3.5 1.5 6 0 3.5 1.5 6 0"/><path d="M3 21c2-1.5 3.5 1.5 6 0s3.5 1.5 6 0 3.5 1.5 6 0"/>';
/** Scenario icons: sea waves with a sun for El Niño (warm water spreads east), with a falling drop and arrow for La Niña (cold water rises). */
export const SCENARIO_ICON: Record<string, string> = {
  'nino-1997': SVG(`${WAVES}<circle cx="12" cy="7" r="2.6"/><path d="M12 1.5v1.2M5.5 7h1.2M17.3 7h1.2M7.4 2.9l.9.9M16.6 2.9l-.9.9"/>`),
  'nina-2010': SVG(`${WAVES}<path d="M12 2c-2 2.6-3.4 4.1-3.4 6a3.4 3.4 0 0 0 6.8 0c0-1.9-1.4-3.4-3.4-6Z"/>`),
};
