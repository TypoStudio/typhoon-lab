import { test, expect } from '@playwright/test';
import { setSpeed } from './speed';

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

test('A arms the typhoon formation probe and shows the Formation tab; typing in a field is ignored', async ({ page }) => {
  await page.goto('/?lang=en&help=0&start=2026-08-01&map=flat&seed=20261022');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const tool = page.getByTestId('tool-genesis-typhoon');
  await expect(tool).toHaveAttribute('aria-keyshortcuts', 'A');
  await expect(tool.locator('.tool__key')).toHaveText('A');
  await expect(page.getByTestId('palette-tab-conditions')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('a');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('palette-tab-formation')).toHaveAttribute('aria-selected', 'true');
  // The condition keys mirror it: they bring back the Conditions tab and replace the armed tool.
  await page.keyboard.press('q');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('palette-tab-conditions')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tool-warm')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('a');
  await expect(tool).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('a');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  // Letters typed into a field never arm a tool.
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.locator('.replay__paste summary').click();
  await page.getByTestId('import-replay-text').focus();
  await page.keyboard.press('a');
  await expect(tool).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('import-replay-text')).toBeFocused();
});

test('S and D open blizzard and tornado formation recipes on the map', async ({ page }) => {
  await page.goto('/?lang=en&help=0&start=2026-08-01&map=flat&seed=20261022');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const box = (await page.getByTestId('map-stage').boundingBox())!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  await page.keyboard.press('s');
  await expect(page.getByTestId('tool-genesis-blizzard')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(-30, 62));
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByTestId('spot-score')).toContainText('Blizzard cells nearby');
  await expect(page.getByTestId('spot-recipe')).toContainText('Low pressure');

  await page.keyboard.press('d');
  await expect(page.getByTestId('tool-genesis-tornado')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(127, 37.5));
  await page.mouse.click(centre.x, centre.y);
  await expect(page.getByTestId('spot-score')).toContainText('Tornado potential');
  await expect(page.getByTestId('spot-recipe')).toContainText('Unstable air');
});

test('a hot inland blizzard recipe remains enabled, uses uncapped tools, and forms in the worker', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01&map=flat&seed=42');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  await page.evaluate(() => (window as any).__typhoonLab.mapView.setHome(127.79, 36.23, 10));
  await page.keyboard.press('s');
  const stage = page.getByTestId('map-stage'), box = (await stage.boundingBox())!;
  const at = await page.evaluate(() => {
    const [x, y] = (window as any).__typhoonLab.mapView.projectZ(127.79, 36.23);
    return { x, y };
  });
  await page.mouse.click(box.x + at.x, box.y + at.y);
  await expect(page.getByTestId('spot-popover')).toBeVisible();
  await expect(page.getByTestId('spot-place')).toBeEnabled();
  await expect(page.getByTestId('spot-note')).not.toContainText('더 차가운 공기');
  await page.getByTestId('spot-place').click();
  await expect(page.getByTestId('spot-popover')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.actions.filter((a: any) => a.formation === 'blizzard' && a.type === 'cold-air').length)).toBeGreaterThan(2);
  // Advance the real worker at the highest supported speed; no injected UI state.
  await setSpeed(page, 14_400);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.blizzardCells), { timeout: 20_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
