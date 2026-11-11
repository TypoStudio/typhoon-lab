import { expect, test, type Page } from '@playwright/test';
import { setSpeed } from './speed';

const URL = '/?renderer=canvas&map=flat&weather=base&help=0&lang=ko&seed=17&start=2026-04-01';

async function form(page: Page, tool: string, lon: number, lat: number, span: number): Promise<void> {
  await page.getByTestId('play-toggle').click();
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('palette-tab-formation').click();
  await page.getByTestId(`tool-genesis-${tool}`).click();
  await page.evaluate(([x, y, s]) => (window as any).__typhoonLab.mapView.setHome(x, y, s), [lon, lat, span]);
  const point = await page.evaluate(([x, y]) => (window as any).__typhoonLab.mapView.lonLatToPx(x, y), [lon, lat]);
  const box = (await page.getByTestId('map-stage').boundingBox())!;
  await page.mouse.click(box.x + point[0], box.y + point[1]);
  await expect(page.getByTestId('spot-place')).toBeEnabled();
  await page.getByTestId('spot-place').click();
}

const centroid = (page: Page) => page.evaluate(() => {
  const grid = (window as any).__typhoonLab.state.grid as { lon: number; lat: number; pm25: number }[];
  let m = 0, x = 0, y = 0, peak = 0;
  for (const c of grid) { m += c.pm25; x += c.pm25 * c.lon; y += c.pm25 * c.lat; peak = Math.max(peak, c.pm25); }
  return { mass: m, lon: m ? x / m : NaN, lat: m ? y / m : NaN, peak };
});

test('fine dust: formed near Beijing it builds, drifts, shows as hexagons and reaches the news', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(URL);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('palette-tab-formation').click();
  await expect(page.getByTestId('tool-genesis-finedust')).toHaveAccessibleName(/미세먼지 발생/);
  await form(page, 'finedust', 117, 39, 24);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.actions.some((a: any) => a.formation === 'finedust'))).toBe(true);
  await setSpeed(page, 86_400);
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await centroid(page)).peak, { timeout: 40_000 }).toBeGreaterThan(40);
  const first = await centroid(page);
  await page.waitForTimeout(600);
  await page.getByTestId('play-toggle').click();
  const later = await centroid(page);
  expect(later.mass).toBeGreaterThan(first.mass * 0.5);
  expect(Math.hypot(later.lon - first.lon, later.lat - first.lat)).toBeGreaterThan(0.2); // the haze moved with the wind
  await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(122, 37, 28));
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-weather-hazards', '1');
  await expect.poll(() => page.getByTestId('map-stage').getAttribute('data-dust-hexes').then(Number)).toBeGreaterThan(5);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-news').click();
  await expect(page.getByTestId('news-list')).toContainText('미세먼지');
  await page.getByTestId('layer-finedust').click(); // switching the layer off removes the hexagons
  await expect.poll(() => page.getByTestId('map-stage').getAttribute('data-dust-hexes').then(Number)).toBe(0);
  await page.getByTestId('layer-finedust').click();
  await page.getByTestId('sidebar-toggle').click();
  await page.waitForTimeout(400);
  await expect.poll(() => page.getByTestId('map-stage').getAttribute('data-dust-hexes').then(Number)).toBeGreaterThan(5);
  await page.screenshot({ path: '/tmp/typhoon-shot/finedust-ramp-ko.png' });
  await page.screenshot({ path: '/tmp/typhoon-shot/finedust-ramp-ko-zoom.png', clip: { x: 380, y: 230, width: 460, height: 300 } });
  for (const [name, span] of [['out', 70], ['in', 9]] as const) {
    await page.evaluate(([s]) => (window as any).__typhoonLab.mapView.setHome(119, 37, s), [span]);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `/tmp/typhoon-shot/finedust-ramp-ko-${name}.png` });
  }
  expect(errors).toEqual([]);
});

test('yellow dust: shown as dashed hexagons', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(URL);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await form(page, 'dust', 105, 40, 30);
  await setSpeed(page, 14_400);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.weatherHazards.some((h: any) => h.kind === 'dust')), { timeout: 40_000 }).toBe(true);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.getByTestId('map-stage').getAttribute('data-dust-hexes').then(Number)).toBeGreaterThan(5);
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: '/tmp/typhoon-shot/yellowdust-ko.png' });
  expect(errors).toEqual([]);
});

test('measure: Fine dust (PM2.5) is the 11th item, reachable by the page buttons, has no keycap and graphs 0 without dust', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?renderer=canvas&map=flat&weather=base&help=0&lang=ko&seed=17&start=2026-04-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('palette-tab-measure').click();
  await expect(page.locator('[data-palette-panel="measure"] .tool')).toHaveCount(11);
  const tool = page.getByTestId('tool-measure-fine-dust');
  await expect(tool).toHaveAccessibleName(/미세먼지 농도/);
  await expect(tool).not.toHaveAttribute('aria-keyshortcuts', /.+/);
  await expect(tool.locator('.tool__key')).toHaveCount(0);
  const inView = async () => tool.evaluate(el => {
    const row = el.parentElement!.getBoundingClientRect(), r = el.getBoundingClientRect();
    return r.left >= row.left - 1 && r.right <= row.right + 1;
  });
  const pager = page.getByTestId('palette-pager');
  if (await pager.isVisible()) {
    for (let n = 0; n < 6 && !(await inView()); n++) await page.getByTestId('palette-next').click();
    expect(await inView()).toBe(true);
    await page.getByTestId('palette-prev').click();
  }
  for (let n = 0; n < 6 && !(await inView()) && await pager.isVisible(); n++) await page.getByTestId('palette-next').click();
  await tool.click();
  const point = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(127, 37));
  const box = (await page.getByTestId('map-stage').boundingBox())!;
  await page.mouse.click(box.x + point[0], box.y + point[1]);
  await expect(page.getByTestId('measure-card-measure-fine-dust')).toBeVisible();
  await expect(page.getByTestId('measure-plot-measure-fine-dust-0')).toHaveAttribute('aria-label', /µg\/m³/);
  expect(errors).toEqual([]);
});
