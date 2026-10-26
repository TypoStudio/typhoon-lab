import { PLACES, type Place } from '../data/places';
import type { Language } from '../i18n';
import { geoToUnit, type MapCamera } from './camera';

/** Web-map zoom equivalent of a view: px per degree -> a 256 px tile world at zoom 0. */
export const webZoom = (view: MapCamera): number => Math.log2((view.scale * 360) / 256);

/** Web-zoom anchors of a population threshold that is interpolated in log-population and clamped outside the table. */
type Anchors = readonly (readonly [zoom: number, pop: number])[];
const thresholdAt = (anchors: Anchors, zoom: number): number => {
  if (zoom <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    const [z0, p0] = anchors[i - 1];
    const [z1, p1] = anchors[i];
    if (zoom <= z1) return Math.exp(Math.log(p0) + ((Math.log(p1) - Math.log(p0)) * (zoom - z0)) / (z1 - z0));
  }
  return anchors[anchors.length - 1][1];
};

/** Smallest population that earns a label at a web zoom: 8 M at world zoom, 2 M at the home view, 500 k at country zoom, 150 k at city zoom. */
const LABEL_ANCHORS: Anchors = [[2.7, 8_000_000], [4.4, 3_000_000], [6, 1_500_000], [7.5, 250_000]];
export const minPopForLabel = (zoom: number): number => thresholdAt(LABEL_ANCHORS, zoom);

/** Smallest population that earns an unlabelled dot: a little below the label threshold, so mid-size cities show as dots first. */
const DOT_ANCHORS: Anchors = [[2.7, 3_000_000], [4.4, 1_000_000], [6, 300_000], [7.5, 100_000]];
export const minPopForDot = (zoom: number): number => thresholdAt(DOT_ANCHORS, zoom);

/** Places are all towns under 500 k, so they read the label threshold this many zoom levels ahead; otherwise they would only appear past country zoom. */
export const PLACE_ZOOM_LEAD = 1.1;
export const MAX_DRAWN = 600;

export const placeEligible = (p: Place, zoom: number): boolean => p.popMax >= minPopForLabel(zoom + PLACE_ZOOM_LEAD);

/** Impact cities are labelled once they reach the label threshold; callers also label the selected city and any city in the storm's wind. */
export const cityLabelEligible = (population: number, zoom: number): boolean => population >= minPopForLabel(zoom);

/** Unit vectors (xyz per place, in PLACES order) for the globe's far-side test. */
const UNITS = new Float32Array(PLACES.length * 3);
PLACES.forEach((p, i) => geoToUnit(p.lon, p.lat, UNITS, 3 * i));

let cache: { view: MapCamera; version: number; lang: Language; list: Place[] } | null = null;

/** Eligible places inside the viewport, largest first, at most MAX_DRAWN. Rebuilt only when the view version or language changes. */
export function visiblePlaces(view: MapCamera, lang: Language): Place[] {
  if (cache && cache.view === view && cache.version === view.version && cache.lang === lang) return cache.list;
  const zoom = webZoom(view);
  const { west, east, south, north } = view.visibleBounds();
  const all = east - west >= 360;
  const m = view.kind === 'globe' ? view.rotation() : null;
  const list: Place[] = [];
  for (let i = 0; i < PLACES.length && list.length < MAX_DRAWN; i++) {
    const p = PLACES[i];
    if (!placeEligible(p, zoom) || p.lat < south || p.lat > north) continue;
    if (!all && !(p.lon >= west && p.lon <= east) && !(p.lon + 360 >= west && p.lon + 360 <= east) && !(p.lon - 360 >= west && p.lon - 360 <= east)) continue;
    if (m && m[6] * UNITS[3 * i] + m[7] * UNITS[3 * i + 1] + m[8] * UNITS[3 * i + 2] <= 0.1) continue;
    list.push(p);
  }
  cache = { view, version: view.version, lang, list };
  return list;
}
