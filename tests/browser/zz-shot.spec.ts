import { test, expect } from '@playwright/test';
test('legend shot', async ({ page }) => {
  page.on('pageerror', e => console.log('PAGEERR', e.message, e.stack));
  page.on('console', m => { if (m.type()==='error') console.log('CONSOLE', m.text()); });
  await page.goto('/?lang=en&seed=20261022&help=0&start=2026-08-01&renderer=canvas&map=flat');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  for (const o of ['pressure', 'temperature', 'population']) {
    await page.getByTestId(`layer-${o}`).click();
    await expect(page.getByTestId(`layer-${o}`)).toHaveAttribute('aria-pressed', 'true');
  }
  console.log('OVERLAYS', await page.getByTestId('map-stage').getAttribute('data-overlays'), await page.getByTestId('sidebar').isVisible());
  const px = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 26));
  const box = (await page.getByTestId('map-stage').boundingBox())!;
  await page.mouse.move(box.x + px[0] - 3, box.y + px[1]);
  await page.mouse.move(box.x + px[0], box.y + px[1]);
  await expect(page.getByTestId('legend-pressure')).toContainText('hPa');
  await page.mouse.move(box.x + px[0] + 300, box.y + px[1] + 300);
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/typhoon-bench/legend-values.png', clip: { x: 0, y: 0, width: 420, height: 620 } });
});
