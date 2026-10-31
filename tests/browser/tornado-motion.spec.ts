import { expect, test } from '@playwright/test';

test('draws a tornado with its curved simulated track without errors', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).__tornadoWorker = this;
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42&map=flat&weather=base&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  const tick = await page.evaluate(async () => {
    const overlayPath = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/render/overlay.ts')?.name;
    if (!overlayPath) throw new Error('Overlay module was not loaded');
    const { OverlayPainter } = await import(overlayPath);
    const original = OverlayPainter.prototype.thunderstorm;
    OverlayPainter.prototype.thunderstorm = function (view: unknown, storm: { tornado?: boolean; tornadoTrack?: unknown[] }) {
      if (storm.tornado) (window as any).__tornadoDrawn = storm.tornadoTrack!.length >= 60;
      return original.call(this, view, storm);
    };
    const state = structuredClone((window as any).__typhoonLab.state);
    state.tick++; state.hours = state.tick * 0.25;
    const motionPath = '/src/simulation/tornado-motion.ts';
    const { moveTornado } = await import(motionPath);
    const storm = { id: 1, lon: 129, lat: 19, intensity: 0.8, radiusKm: 30, gustMs: 60,
      cloudTopC: -60, ageHours: 0, durationHours: 8, tornado: true, tornadoStartAgeHours: 0,
      tornadoTrack: [{ lon: 129, lat: 19 }] };
    for (let i = 0; i < 16; i++) {
      moveTornado(storm, state.seed, 0.25, () => ({ u: 20, v: 0, shear: 20 }));
      storm.ageHours += 0.25;
    }
    state.thunderstorms = [storm];
    (window as any).__typhoonLab.mapView.centerOn(storm.lon, storm.lat);
    (window as any).__tornadoWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state, clockHours: state.hours } }));
    return state.tick;
  });
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-rendered-tick', String(tick));
  await expect.poll(() => page.evaluate(() => (window as any).__tornadoDrawn === true)).toBe(true);
  expect(errors).toEqual([]);
});
