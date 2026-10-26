import type { Language, LocalNames } from '../i18n';
import type { LandPolygon } from '../types';

// Small islands the Natural Earth files leave out or draw too coarsely to see, kept here by hand.
// `pinned` islands stay in the coast layer from web zoom 4.5 instead of 6 (see `coastTier`).

const hexagon = (lon: number, lat: number, radiusDeg: number): LandPolygon['outer'] =>
  Array.from({ length: 6 }, (_, k) => {
    const a = (Math.PI / 3) * k;
    return [Number((lon + radiusDeg * Math.cos(a)).toFixed(5)), Number((lat + radiusDeg * Math.sin(a)).toFixed(5))] as [number, number];
  });

/**
 * Dongdo, the eastern island of Dokdo (about 0.002° across): Natural Earth 10m minor islands has only the western island,
 * which prepare-map.mjs adds from that file. Manual addition, listed in DATA_SOURCES.md.
 */
export const MANUAL_ISLANDS: LandPolygon[] = [{ outer: hexagon(131.8695, 37.241, 0.001), pinned: true }];

/** A named spot that is always labelled from `PINNED_PLACE_MIN_ZOOM`, whatever its population or polygon size. */
export interface PinnedPlace {
  name: string;
  nameKo: string;
  names: LocalNames;
  lon: number;
  lat: number;
}

export const PINNED_PLACE_MIN_ZOOM = 4.5;

export const PINNED_PLACES: PinnedPlace[] = [
  { name: 'Ulleungdo', nameKo: '울릉도', names: { ja: '鬱陵島', 'zh-CN': '郁陵岛', 'zh-TW': '鬱陵島' }, lon: 130.87, lat: 37.5 },
  { name: 'Dokdo', nameKo: '독도', names: { ja: '独島', 'zh-CN': '独岛', 'zh-TW': '獨島' }, lon: 131.8667, lat: 37.2417 },
];

export const pinnedPlaceName = (p: PinnedPlace, lang: Language): string => (lang === 'en' ? p.name : (lang === 'ko' ? p.nameKo : p.names[lang]) || p.name);
