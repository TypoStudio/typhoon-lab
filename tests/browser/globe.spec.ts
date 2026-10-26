import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page, url = '/?lang=en') {
  await page.goto(`${url}${url.includes('?') ? '&' : '?'}help=0&start=2026-08-01`);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
}
const stage = (page: Page) => page.getByTestId('map-stage');
const centre = (page: Page) => page.evaluate(() => (window as any).__typhoonLab.mapView.centerLonLat() as [number, number]);
async function openSidebar(page: Page) {
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
}

test('the globe is the default map and can be switched off, persistently', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await expect(stage(page)).toHaveAttribute('data-map', 'globe');
  expect(await page.evaluate(() => (window as any).__typhoonLab.mapMode)).toBe('globe');
  await openSidebar(page);
  const toggle = page.getByTestId('globe-toggle');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await toggle.click();
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
  // The query string beats the stored choice and is not stored itself.
  await page.goto('/?lang=en&map=globe&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(stage(page)).toHaveAttribute('data-map', 'globe');
  await page.goto('/?lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
  expect(errors).toEqual([]);
});

test('?map=flat starts on the flat map', async ({ page }) => {
  await ready(page, '/?lang=en&map=flat');
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
});

test('the canvas renderer is flat only and says so', async ({ page }) => {
  await page.goto('/?lang=en&renderer=canvas&map=globe&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
  await openSidebar(page);
  await expect(page.getByTestId('globe-toggle')).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByTestId('renderer-note')).toContainText('Globe view needs WebGL; showing the flat map.');
  await page.getByTestId('globe-toggle').click({ force: true });
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
});

test('dragging rotates the globe, reset returns home, the far side is hidden', async ({ page }) => {
  await ready(page);
  const home = await centre(page);
  expect(home[0]).toBeCloseTo(115, 3);
  expect(home[1]).toBeCloseTo(10, 3);
  await page.mouse.move(700, 450);
  await page.mouse.down();
  await page.mouse.move(500, 450, { steps: 5 });
  await page.mouse.up();
  const moved = await centre(page);
  // Dragging left brings the content from the east to the middle.
  expect(moved[0]).toBeGreaterThan(home[0] + 5);
  await page.getByTestId('view-reset').click();
  const back = await centre(page);
  expect(back[0]).toBeCloseTo(home[0], 6);
  expect(back[1]).toBeCloseTo(home[1], 6);
  const hidden = await page.evaluate(() => {
    const v = (window as any).__typhoonLab.mapView;
    const [lon, lat] = v.centerLonLat();
    return { antipode: v.lonLatToPx(lon + 180, -lat), near: v.lonLatToPx(lon, lat) };
  });
  expect(hidden.antipode).toBeNull();
  expect(hidden.near).not.toBeNull();
});

test('a condition dropped on the globe lands where it was released', async ({ page }) => {
  await ready(page);
  await page.getByTestId('play-toggle').click();
  const button = (await page.getByTestId('tool-warm').boundingBox())!;
  const destination = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16) as [number, number]);
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination[0], destination[1], { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  const effect = await page.evaluate(() => (window as any).__typhoonLab.state.effects[0] as { lon: number; lat: number });
  expect(Math.abs(effect.lon - 140)).toBeLessThan(0.5);
  expect(Math.abs(effect.lat - 16)).toBeLessThan(0.5);
});

test('switching modes keeps the view centre when the camera is not at home', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(150, 20));
  await openSidebar(page);
  await page.getByTestId('globe-toggle').click();
  await expect(stage(page)).toHaveAttribute('data-map', 'flat');
  const [lon, lat] = await centre(page);
  expect(lon).toBeCloseTo(150, 3);
  expect(lat).toBeCloseTo(20, 3);
});

for (const [width, height] of [[1440, 900], [390, 844]]) {
  test(`the globe renders at ${width}px without errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height });
    await ready(page);
    await expect(stage(page)).toHaveAttribute('data-map', 'globe');
    await page.waitForTimeout(500);
    const png = await page.screenshot();
    expect(png.length).toBeGreaterThan(5000);
    expect(errors).toEqual([]);
  });
}
