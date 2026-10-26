import type { MapCamera } from '../render/camera';

/** Spans are degrees (Equal Earth world units on the flat map) across the shorter viewport side. */
export const SOUTHEAST_ASIA = { lon: 115, lat: 10, span: 60 } as const;
export const LOCAL_REGION_SPAN = 36;
export const LOCATION_TIMEOUT_MS = 8000;
export type LocationStatus = 'locating' | 'located' | 'fallback' | 'kept';
type LocationProvider = Pick<Geolocation, 'getCurrentPosition'>;

/** Use browser location only; no IP lookup, external service or saved location is needed.
 * Show a useful regional fallback immediately, and never move the camera underneath an
 * interaction. The explicit deadline also covers unanswered browser permission prompts.
 */
export function initialiseLocation(view: Pick<MapCamera, 'setHome'>, interactionTarget: EventTarget, onStatus: (status: LocationStatus) => void,
  provider?: LocationProvider | null): () => void {
  view.setHome(SOUTHEAST_ASIA.lon, SOUTHEAST_ASIA.lat, SOUTHEAST_ASIA.span);
  let active = true;
  let interacted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const touch = () => { interacted = true; };
  const events = ['pointerdown', 'wheel', 'keydown'];
  for (const event of events) interactionTarget.addEventListener(event, touch, true);
  const dispose = () => {
    active = false;
    clearTimeout(timer);
    for (const event of events) interactionTarget.removeEventListener(event, touch, true);
  };
  const finish = (status: LocationStatus) => { dispose(); onStatus(status); };
  const failure = () => { if (active) finish('fallback'); };
  onStatus('locating');
  timer = setTimeout(failure, LOCATION_TIMEOUT_MS);
  try {
    const location = provider === undefined ? navigator.geolocation : provider;
    if (!location) { failure(); return dispose; }
    location.getCurrentPosition(position => {
      if (!active) return;
      const { longitude: lon, latitude: lat } = position.coords;
      if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
        failure(); return;
      }
      if (interacted) { finish('kept'); return; }
      view.setHome(lon, lat, LOCAL_REGION_SPAN);
      finish('located');
    }, failure, { enableHighAccuracy: false, maximumAge: 300_000, timeout: LOCATION_TIMEOUT_MS });
  } catch { failure(); } // blocked API, insecure origin or provider failure
  return dispose;
}
