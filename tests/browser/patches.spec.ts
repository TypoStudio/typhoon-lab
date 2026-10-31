import { setSpeed } from './speed';
import { test, expect } from '@playwright/test';

test('three nearby progress indicators produce three distinct storms in live play', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(141, 16, 30));
  let placed = 0;
  for (const [tool, lon] of [['warm', 140], ['moisture', 140], ['low', 140], ['low', 141], ['low', 142]] as const) {
    const button = page.getByTestId(`tool-${tool}`);
    if (await button.getAttribute('aria-pressed') !== 'true') await button.click();
    const point = await page.evaluate(lon => (window as any).__typhoonLab.mapView.lonLatToPx(lon, 16), lon);
    const box = (await page.getByTestId('map-stage').boundingBox())!;
    await page.mouse.click(box.x + point[0], box.y + point[1]);
    placed++;
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(placed);
  }
  const lowIds = await page.evaluate(() => (window as any).__typhoonLab.state.effects.filter((e: any) => e.type === 'low').map((e: any) => e.id));
  expect(lowIds).toHaveLength(3);
  await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-storms').click();
  await setSpeed(page, 600);
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('patch-list').locator('li')).toHaveCount(3, { timeout: 40_000 });
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.candidates.every((c: any) => c.progressHours > 0))).toBe(true);
  await setSpeed(page, 14400);
  await expect(page.getByTestId('storm-row')).toHaveCount(3, { timeout: 20_000 });
  await page.getByTestId('play-toggle').click();
  const result = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { storms: s.storms.map((st: any) => st.id), candidates: s.candidates.length,
      lows: s.effects.filter((e: any) => e.type === 'low').length,
      formations: s.news.filter((n: any) => n.kind === 'formation').length };
  });
  expect(new Set(result.storms).size).toBe(3);
  expect(result).toMatchObject({ candidates: 0, lows: 0, formations: 3 });
  await expect(page.getByTestId('patch-list').locator('li')).toHaveCount(0);
});
