import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobeView } from '../src/render/globe-view';
import { MAP_Y1, MapView, project } from '../src/render/view';
import { initialiseLocation, SOUTHEAST_ASIA, LOCAL_REGION_SPAN, LOCATION_TIMEOUT_MS } from '../src/ui/initial-location';

const [HOME_X, HOME_Y] = project(SOUTHEAST_ASIA.lon, SOUTHEAST_ASIA.lat);
const SEOUL = project(126.98, 37.57);
const position = (longitude: number, latitude: number) => ({ coords: { longitude, latitude } }) as GeolocationPosition;
function fixture() {
  const view = new MapView(); view.resize(1440, 900);
  const target = new EventTarget(); const status = vi.fn();
  let success!: PositionCallback, error!: PositionErrorCallback;
  const provider = { getCurrentPosition: vi.fn((ok: PositionCallback, fail?: PositionErrorCallback | null) => { success = ok; error = fail!; }) };
  const dispose = initialiseLocation(view, target, status, provider);
  return { view, target, status, provider, dispose, success: (lon: number, lat: number) => success(position(lon, lat)), fail: () => error({ code: 1 } as GeolocationPositionError) };
}
afterEach(() => vi.useRealTimers());

describe('initial regional camera', () => {
  it('shows a zoomed Southeast Asia view before an unanswered location request completes', () => {
    vi.useFakeTimers(); const f = fixture();
    expect(f.view.cx).toBe(HOME_X); expect(f.view.cy).toBeCloseTo(HOME_Y, 9);
    expect(f.view.scale).toBe(900 / SOUTHEAST_ASIA.span);
    expect(f.view.zoom).toBeGreaterThan(1);
    expect(f.status).toHaveBeenLastCalledWith('locating');
    vi.advanceTimersByTime(LOCATION_TIMEOUT_MS);
    expect(f.status).toHaveBeenLastCalledWith('fallback');
    f.success(126.98, 37.57); // late callback cannot jump the camera after timeout
    expect(f.view.cx).toBe(HOME_X);
  });
  it('uses successful browser coordinates and returns to that area with reset', () => {
    const f = fixture(); f.success(126.98, 37.57);
    expect(f.status).toHaveBeenLastCalledWith('located');
    expect(f.view.cx).toBeCloseTo(SEOUL[0], 6); expect(f.view.cy).toBeCloseTo(SEOUL[1], 6);
    expect(f.view.scale).toBe(900 / LOCAL_REGION_SPAN);
    f.view.panPx(200, 100); f.view.reset();
    expect(f.view.cx).toBeCloseTo(SEOUL[0], 6); expect(f.view.cy).toBeCloseTo(SEOUL[1], 6);
    f.view.resize(375, 812);
    expect(f.view.scale).toBe(375 / LOCAL_REGION_SPAN);
    // The tall phone viewport cannot show beyond the pole edge, so the camera stops against it.
    expect(f.view.cx).toBeCloseTo(SEOUL[0], 6); expect(f.view.cy).toBeCloseTo(Math.min(SEOUL[1], MAP_Y1 - 812 / f.view.scale / 2), 6);
    expect(f.provider.getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), {
      enableHighAccuracy: false, maximumAge: 300_000, timeout: LOCATION_TIMEOUT_MS,
    });
  });
  it('keeps the fallback for denied, absent, throwing and invalid location providers', () => {
    const denied = fixture(); denied.fail();
    expect(denied.status).toHaveBeenLastCalledWith('fallback');
    for (const coords of [[NaN, 10], [115, Infinity], [181, 10], [115, 91]]) {
      const f = fixture(); f.success(coords[0], coords[1]);
      expect(f.status).toHaveBeenLastCalledWith('fallback');
      expect(f.view.cx).toBe(HOME_X);
    }
    for (const provider of [null, { getCurrentPosition() { throw new Error('blocked'); } }]) {
      const view = new MapView(); view.resize(1440, 900); const status = vi.fn();
      initialiseLocation(view, new EventTarget(), status, provider);
      expect(status).toHaveBeenLastCalledWith('fallback');
      expect(view.cx).toBe(HOME_X); expect(view.zoom).toBeGreaterThan(1);
    }
  });
  it('does not move the camera after pointer, wheel or keyboard interaction, or after disposal', () => {
    for (const event of ['pointerdown', 'wheel', 'keydown']) {
      const f = fixture(); f.target.dispatchEvent(new Event(event)); f.view.panPx(80, 40);
      const before = { cx: f.view.cx, cy: f.view.cy, scale: f.view.scale };
      f.success(-74, 40.7);
      expect(f.status).toHaveBeenLastCalledWith('kept');
      expect({ cx: f.view.cx, cy: f.view.cy, scale: f.view.scale }).toEqual(before);
    }
    vi.useFakeTimers(); const f = fixture(); f.dispose(); f.success(126.98, 37.57);
    vi.advanceTimersByTime(LOCATION_TIMEOUT_MS);
    expect(f.status).toHaveBeenCalledTimes(1);
    expect(f.view.cx).toBe(HOME_X);
  });
  it('keeps the fallback region on phone resize while allowing zoom out to the whole world', () => {
    const view = new MapView(); view.resize(1440, 900);
    initialiseLocation(view, new EventTarget(), () => {}, null);
    view.resize(375, 812);
    expect(view.cx).toBe(HOME_X); expect(view.cy).toBeCloseTo(Math.min(HOME_Y, MAP_Y1 - 812 / view.scale / 2), 9);
    expect(view.zoom).toBeGreaterThan(1);
    view.zoomAt(0.001, 187, 406);
    expect(view.scale).toBe(view.fitScale);
    view.reset(); expect(view.zoom).toBeGreaterThan(1);
  });
});

describe('initial globe camera', () => {
  it('opens on the home point with the same degrees-per-viewport scale as the flat map', () => {
    const view = new GlobeView(); view.resize(1440, 900);
    initialiseLocation(view, new EventTarget(), () => {}, null);
    const [lon, lat] = view.centerLonLat();
    expect(lon).toBeCloseTo(SOUTHEAST_ASIA.lon, 6); expect(lat).toBeCloseTo(SOUTHEAST_ASIA.lat, 6);
    expect(view.scale).toBeCloseTo(900 / SOUTHEAST_ASIA.span, 9);
    expect(view.zoom).toBeGreaterThan(1);
    view.dragPx(700, 450, 500, 450); view.reset();
    expect(view.centerLonLat()[0]).toBeCloseTo(SOUTHEAST_ASIA.lon, 6);
  });
});
