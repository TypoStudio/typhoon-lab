import type { Language, LocalNames } from '../i18n';
import generated from './generated/places.json';

// Display-only labels from Natural Earth v5.1.2 populated places (public domain), written by
// scripts/prepare-map.mjs. Impact cities stay the 71 in world.ts; places never take damage or get clicked.
export interface Place {
  name: string;
  nameKo: string | null;
  /** Natural Earth ja / zh-CN / zh-TW names, only the ones the source has. */
  names?: LocalNames;
  lon: number;
  lat: number;
  popMax: number;
  scalerank: number;
  /** Natural Earth label zoom on a web map (about 256 px world at zoom 0). */
  minZoom: number;
}

type Row = [name: string, nameKo: string | null, lon: number, lat: number, popMax: number, scalerank: number, minZoom: number, names?: LocalNames];

/** Largest first. */
export const PLACES: Place[] = (generated as Row[])
  .map(([name, nameKo, lon, lat, popMax, scalerank, minZoom, names]) => ({ name, nameKo, lon, lat, popMax, scalerank, minZoom, names }))
  .sort((a, b) => b.popMax - a.popMax);

export const placeName = (p: Place, lang: Language): string => (lang === 'en' ? p.name : (lang === 'ko' ? p.nameKo : p.names?.[lang]) || p.name);
