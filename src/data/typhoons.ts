import data from './generated/typhoons.json';
import type { HistoricAgency, HistoricTyphoon, HistoricTyphoonData } from '../types';

const DATA = data as HistoricTyphoonData;
/** JMA best-track source details; the licence requires attribution. */
export const TYPHOON_SOURCE = DATA.source;
/** Every best-track file the storms come from (JMA, NOAA NHC HURDAT2, NOAA IBTrACS). */
export const TYPHOON_SOURCES = DATA.sources;
/** Display name of the agency a storm's track comes from. */
export const AGENCY_NAMES: Record<HistoricAgency, string> = { JMA: 'JMA RSMC Tokyo', NHC: 'NOAA NHC HURDAT2', IBTrACS: 'NOAA IBTrACS' };
export const TYPHOONS: HistoricTyphoon[] = DATA.typhoons;

export function typhoonById(id: unknown): HistoricTyphoon | undefined {
  return TYPHOONS.find(t => t.id === id);
}
