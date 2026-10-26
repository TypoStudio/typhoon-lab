import { test, expect } from '@playwright/test';

test('Formation tab arms the typhoon probe, which opens the recipe popover and places it', async ({ page }) => {
  await page.goto('/?lang=en&help=0&start=2026-08-01&map=flat&seed=20261022');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const stage = page.getByTestId('map-stage');
  const box = (await stage.boundingBox())!;
  const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // A plain click never opens the popover.
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('spot-popover')).toBeHidden();
  await page.getByTestId('palette-tab-formation').click();
  await expect(page.getByTestId('palette-tab-formation')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('tool-genesis-typhoon').click();
  await expect(page.getByTestId('tool-genesis-typhoon')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => { const v = (window as any).__typhoonLab.mapView; v.centerOn(140, 16); });
  await page.mouse.click(at.x, at.y);
  await expect(page.getByTestId('spot-popover')).toBeVisible();
  await expect(page.getByTestId('spot-score')).toContainText('Formation score');
  await expect(page.getByTestId('spot-recipe')).toContainText('Low pressure');
  await page.getByTestId('spot-place').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBeGreaterThan(0);
  // Placing the recipe closes the popover but leaves the probe armed; Escape then puts it away.
  await expect(page.getByTestId('spot-popover')).toBeHidden();
  await expect(page.getByTestId('tool-genesis-typhoon')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-genesis-typhoon')).toHaveAttribute('aria-pressed', 'false');
});

test('Q arms the typhoon formation probe and shows the Formation tab; typing in a field is ignored', async ({ page }) => {
  await page.goto('/?lang=en&help=0&start=2026-08-01&map=flat&seed=20261022');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const tool = page.getByTestId('tool-genesis-typhoon');
  await expect(tool).toHaveAttribute('aria-keyshortcuts', 'Q');
  await expect(tool.locator('.tool__key')).toHaveText('Q');
  await expect(page.getByTestId('palette-tab-conditions')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('q');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('palette-tab-formation')).toHaveAttribute('aria-selected', 'true');
  // The number keys mirror it: they bring back the Conditions tab and replace the armed tool.
  await page.keyboard.press('1');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('palette-tab-conditions')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tool-warm')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('q');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('q');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  // Letters typed into a field never arm a tool.
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-environment').click();
  await page.getByTestId('place-lon').focus();
  await page.keyboard.press('q');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('place-lon')).toBeFocused();
});
