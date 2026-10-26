import { LAKES, LAKE_MIN_ZOOM, type Lake } from '../data/lakes';
import { SEAS, SEA_MIN_ZOOM, type Sea } from '../data/seas';
import type { Language } from '../i18n';
import type { MapCamera } from './camera';
import { webZoom } from './places';

export const seaEligible = (s: Sea, zoom: number): boolean => zoom >= SEA_MIN_ZOOM[s.rank];

/** Screen margin in px: a label wider than this around its anchor can still reach into the viewport. */
const MARGIN_PX = 200;

let cache: { view: MapCamera; version: number; lang: Language; list: Sea[] } | null = null;

/** Eligible seas near the viewport, oceans first (SEAS is already ordered by rank). Rebuilt only when the view version or language changes. */
export function visibleSeas(view: MapCamera, lang: Language): Sea[] {
  if (cache && cache.view === view && cache.version === view.version && cache.lang === lang) return cache.list;
  const zoom = webZoom(view);
  const { west, east, south, north } = view.visibleBounds();
  const pad = MARGIN_PX / view.scale;
  const all = east - west >= 360 - 2 * pad;
  const inLon = (lon: number): boolean => [lon - 360, lon, lon + 360].some(l => l >= west - pad && l <= east + pad);
  const list = SEAS.filter(s => seaEligible(s, zoom) && s.lat >= south - pad && s.lat <= north + pad && (all || inLon(s.lon)));
  cache = { view, version: view.version, lang, list };
  return list;
}

export const lakeEligible = (l: Lake, zoom: number): boolean => zoom >= LAKE_MIN_ZOOM[l.rank];

let lakeCache: { view: MapCamera; version: number; lang: Language; list: Lake[] } | null = null;

/** Eligible named lakes near the viewport, largest first (LAKES is sorted by area). Same eligibility and caching as `visibleSeas`. */
export function visibleLakes(view: MapCamera, lang: Language): Lake[] {
  if (lakeCache && lakeCache.view === view && lakeCache.version === view.version && lakeCache.lang === lang) return lakeCache.list;
  const zoom = webZoom(view);
  const { west, east, south, north } = view.visibleBounds();
  const pad = MARGIN_PX / view.scale;
  const all = east - west >= 360 - 2 * pad;
  const inLon = (lon: number): boolean => [lon - 360, lon, lon + 360].some(l => l >= west - pad && l <= east + pad);
  const list = LAKES.filter(l => lakeEligible(l, zoom) && l.lat >= south - pad && l.lat <= north + pad && (all || inLon(l.lon)));
  lakeCache = { view, version: view.version, lang, list };
  return list;
}
