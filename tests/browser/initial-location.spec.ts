import { test, expect, type Page } from '@playwright/test';

const camera = (page: Page) => page.evaluate(() => {
  const v = (window as any).__typhoonLab.mapView;
  const [lon, lat] = v.pxToLonLat(v.width / 2, v.height / 2);
  return { lon, lat, zoom: v.zoom, scale: v.scale };
});
async function ready(page: Page) {
  await page.goto('/?renderer=canvas&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
}

test('browser location opens the local region and view reset returns there', async ({ page, context }) => {
  await context.setGeolocation({ longitude: 126.98, latitude: 37.57 });
  await context.grantPermissions(['geolocation']);
  await ready(page);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-location', 'located');
  const initial = await camera(page);
  expect(initial.lon).toBeCloseTo(126.98); expect(initial.lat).toBeCloseTo(37.57);
  expect(initial.zoom).toBeGreaterThan(1);
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.mouse.move(730, 430, { steps: 3 }); await page.mouse.up();
  expect((await camera(page)).lon).not.toBeCloseTo(initial.lon);
  await page.getByTestId('view-reset').click();
  expect(await camera(page)).toEqual(initial);
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(async () => (await camera(page)).scale).toBeCloseTo(375 / 36);
  expect((await camera(page)).lon).toBeCloseTo(126.98);
  // The tall phone viewport stops against the pole edge, so the centre sits a little south of the home point.
  expect((await camera(page)).lat).toBeGreaterThan(30);
  expect((await camera(page)).lat).toBeLessThanOrEqual(37.57);
});

for (const failure of ['denied', 'unavailable']) {
  test(`${failure} location opens a zoomed Southeast Asia fallback on desktop and phone`, async ({ page }) => {
    await page.addInitScript(mode => Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: mode === 'unavailable' ? undefined : { getCurrentPosition: (_ok: unknown, fail: (error: object) => void) => fail({ code: 1, message: 'Denied' }) },
    }), failure);
    await ready(page);
    await expect(page.getByTestId('map-stage')).toHaveAttribute('data-location', 'fallback');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(async () => (await camera(page)).scale).toBeCloseTo(Math.min(width, 900) / 60);
      const view = await camera(page);
      expect(view.lon).toBeCloseTo(115, 6); expect(width === 1440 ? view.lat : 10).toBeCloseTo(10, 6); expect(view.zoom).toBeGreaterThan(1);
    }
  });
}

async function deferredLocation(page: Page) {
  await page.addInitScript(() => Object.defineProperty(navigator, 'geolocation', {
    configurable: true, value: { getCurrentPosition: (ok: unknown) => { (window as any).__locationSuccess = ok; } },
  }));
}

test('unanswered location requests time out and late callbacks cannot move the fallback', async ({ page }) => {
  await page.clock.install();
  await deferredLocation(page);
  await ready(page);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-location', 'locating');
  const fallback = await camera(page);
  expect(fallback.lon).toBeCloseTo(115, 6); expect(fallback.zoom).toBeGreaterThan(1);
  await page.clock.fastForward(8500);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-location', 'fallback');
  await page.evaluate(() => (window as any).__locationSuccess({ coords: { longitude: -74, latitude: 40.7 } }));
  expect(await camera(page)).toEqual(fallback);
});

test('a location result arriving during a map gesture does not jump the camera', async ({ page }) => {
  await deferredLocation(page);
  await ready(page);
  await page.mouse.move(600, 400); await page.mouse.down();
  await page.mouse.move(710, 440, { steps: 3 });
  const moved = await camera(page);
  await page.evaluate(() => (window as any).__locationSuccess({ coords: { longitude: -74, latitude: 40.7 } }));
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-location', 'kept');
  expect(await camera(page)).toEqual(moved);
  await page.mouse.up();
});
