import { expect, test } from '@playwright/test';
import { setSpeed } from './speed';

for (const [renderer, kind, label] of [['canvas', 'heatwave', '폭염'], ['webgl', 'gust', '돌풍']] as const) {
  test(`${renderer}: places a Korean weather recipe and renders its active event`, async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width: 900, height: 700 });
    await page.goto(`/?renderer=${renderer}&map=flat&weather=base&help=0&lang=ko&seed=17&start=2026-08-01`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('map-stage')).toHaveAttribute('data-renderer', renderer);
    await page.getByTestId('play-toggle').click();
    // Exercise independent weather rendering without software-WebGL wind ribbons dominating the test.
    if (renderer === 'webgl') {
      if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
      await page.getByTestId('layer-wind').click();
    }
    if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('palette-tab-formation').click();
    for (const [type, name] of [['heatwave', '폭염'], ['drought', '가뭄'], ['downpour', '집중호우'], ['coldwave', '한파'], ['hail', '우박'], ['dust', '황사'], ['gust', '돌풍']]) {
      await expect(page.getByTestId(`tool-genesis-${type}`)).toHaveAccessibleName(new RegExp(name));
    }
    await page.getByTestId(`tool-genesis-${kind}`).click();
    await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(127, 37, 20));
    const point = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(127, 37));
    const box = (await page.getByTestId('map-stage').boundingBox())!;
    await page.mouse.click(box.x + point[0], box.y + point[1]);
    await expect(page.getByTestId('spot-note')).toContainText('6시간');
    await expect(page.getByTestId('spot-place')).toBeEnabled();
    await page.getByTestId('spot-place').click();
    await expect.poll(() => page.evaluate(kind => (window as any).__typhoonLab.state.actions.some((action: any) => action.formation === kind), kind)).toBe(true);
    await setSpeed(page, renderer === 'webgl' ? 1200 : 4800);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.evaluate(kind => (window as any).__typhoonLab.state.weatherHazards.some((event: any) => event.kind === kind), kind), { timeout: 40_000 }).toBe(true);
    await page.getByTestId('play-toggle').click();
    await expect(page.getByTestId('map-stage')).toHaveAttribute('data-weather-hazards', '1');
    if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('tab-news').click();
    await expect(page.getByTestId('news-list')).toContainText(label);
    expect(errors).toEqual([]);
  });
}

test('all weather tools stay reachable on a phone without overflowing the page', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/?renderer=canvas&map=flat&weather=base&help=0&lang=ko&seed=17&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('palette-tab-formation').click();
  await page.getByTestId('tool-genesis-gust').click();
  await expect(page.getByTestId('tool-genesis-gust')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
