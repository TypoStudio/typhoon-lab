import { expect, test, type Page } from '@playwright/test';
import { setSpeed } from './speed';

const LAB = '/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01&map=flat';

async function ready(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(LAB);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  return errors;
}
const px = (page: Page, lon: number, lat: number) => page.evaluate(([x, y]) => (window as any).__typhoonLab.mapView.lonLatToPx(x, y) as [number, number], [lon, lat]);
const card = (page: Page, item: string) => page.getByTestId(`measure-card-measure-${item}`);
const probes = (page: Page) => page.evaluate(() => (window as any).__typhoonLab.probes as { pins: { n: number; lon: number; lat: number }[]; charts: string[] });

async function dragDrop(page: Page, tool: string, lon: number, lat: number) {
  const rect = (await page.getByTestId(`tool-measure-${tool}`).boundingBox())!;
  const [x, y] = await px(page, lon, lat);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 4 });
  await expect(page.locator('.drag-ghost')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
}
async function keyClick(page: Page, key: string, lon: number, lat: number) {
  await page.keyboard.press(key);
  const [x, y] = await px(page, lon, lat);
  await page.mouse.click(x, y);
}

test('measure tab: drop by drag and by key, compare points, basin indices, reject, remove', async ({ page }) => {
  test.setTimeout(240_000);
  const errors = await ready(page);
  await page.getByTestId('palette-tab-measure').click();
  await expect(page.getByTestId('tool-measure-sea-temperature')).toBeVisible();
  await expect(page.getByTestId('tool-measure-sea-temperature')).toHaveAttribute('aria-keyshortcuts', 'Z');
  await expect(page.locator('[data-palette-panel="measure"] .tool__key')).toHaveText(['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/']);

  // Drag: the sidebar opens on the Measure tab and the chart appears with one line.
  await dragDrop(page, 'sea-temperature', 140, 16);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-measure')).toHaveAttribute('aria-selected', 'true');
  await expect(card(page, 'sea-temperature')).toBeVisible();
  await expect(card(page, 'sea-temperature').locator('.measure-line')).toHaveCount(1);
  await expect(page.getByTestId('measure-plot-measure-sea-temperature-0')).toHaveAttribute('aria-label', /#1.*°C/);
  expect((await probes(page)).pins).toHaveLength(1);
  // One pin: only the header locate button; the per-line one appears with a second pin.
  await expect(page.getByTestId('measure-locate-measure-sea-temperature')).toBeVisible();
  await expect(page.getByTestId('measure-line-locate-measure-sea-temperature-1')).toHaveCount(0);
  await expect(page.getByTestId('map-stage')).not.toHaveAttribute('data-armed', /measure/);

  // The model keeps running and the line gains points.
  await setSpeed(page, 7200);
  await expect.poll(async () => Number(await card(page, 'sea-temperature').getAttribute('data-points')), { timeout: 60_000 }).toBeGreaterThan(3);

  // Select, then click: another chart, and a second point on the same chart.
  await keyClick(page, 'x', 125, 8);
  await expect(page.getByTestId('tool-measure-air-temperature')).toHaveAttribute('aria-pressed', 'true');
  await expect(card(page, 'air-temperature')).toBeVisible();
  await page.keyboard.press('z');
  const [zx, zy] = await px(page, 150, 2);
  await page.mouse.click(zx, zy);
  await expect(card(page, 'sea-temperature').locator('.measure-line')).toHaveCount(2);
  await expect(page.locator('[data-testid^="measure-line-locate-measure-sea-temperature-"]')).toHaveCount(2);
  await expect(page.getByTestId('measure-line-locate-measure-air-temperature-2')).toHaveCount(0);
  expect((await probes(page)).pins.map(p => p.n)).toEqual([1, 2, 3]);

  // The same item at the same place does not duplicate.
  const [dx, dy] = await px(page, 150.05, 2.05);
  await page.mouse.click(dx, dy);
  await expect(page.getByTestId('status')).toContainText('already measured');
  await expect(card(page, 'sea-temperature').locator('.measure-line')).toHaveCount(2);

  // Humidity and rainfall: two stacked plots in one card.
  await keyClick(page, 'b', 140, 16);
  await expect(card(page, 'humidity').locator('canvas')).toHaveCount(2);

  // Basin indices need no pin and are added once.
  const pinsBefore = (await probes(page)).pins.length;
  await keyClick(page, '.', 110, 25);
  await expect(card(page, 'nino34')).toBeVisible();
  const [nx, ny] = await px(page, 100, 22); // the tool stays armed after a drop
  await page.mouse.click(nx, ny);
  await expect(page.getByTestId('status')).toContainText('already graphed');
  await expect(page.locator('[data-testid="measure-card-measure-nino34"]')).toHaveCount(1);
  await expect(card(page, 'nino34')).toContainText('No ENSO climate layer');
  await keyClick(page, '/', 105, 24);
  await expect(card(page, 'soi-wwv').locator('canvas')).toHaveCount(2);
  expect((await probes(page)).pins).toHaveLength(pinsBefore);

  // Thermocline: refused outside the equatorial Pacific strip, accepted inside.
  await keyClick(page, ',', 100, 20);
  await expect(page.getByTestId('status')).toContainText('equatorial Pacific');
  await expect(card(page, 'thermocline')).toHaveCount(0);
  const [tx, ty] = await px(page, 130, 0);
  await page.mouse.click(tx, ty);
  await expect(card(page, 'thermocline')).toBeVisible();
  await expect(card(page, 'thermocline').locator('canvas')).toHaveCount(2);

  // Shortcuts are not read while typing, and Formation moved from Z to ;.
  await page.evaluate(() => { const i = document.createElement('input'); i.id = 'typing'; document.body.append(i); i.focus(); });
  await page.keyboard.press('v');
  await expect(page.getByTestId('tool-measure-wind')).toHaveAttribute('aria-pressed', 'false');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press(';');
  await expect(page.locator('[data-palette-panel="formation"] .tool.is-armed')).toHaveCount(1);
  await expect(page.getByTestId('tool-measure-sea-temperature')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');

  // Removing a chart removes the pins no other chart uses.
  await card(page, 'air-temperature').getByRole('button', { name: /Remove/ }).click();
  await expect(card(page, 'air-temperature')).toHaveCount(0);
  expect((await probes(page)).pins.map(p => p.n)).toEqual([1, 3, 4]); // pin 2 was only the air temperature
  await page.getByTestId('measure-clear').click();
  await expect(page.locator('.measure-card')).toHaveCount(0);
  expect(await probes(page)).toEqual({ pins: [], charts: [] });
  expect(errors).toEqual([]);
});

test('measure tab: pins stay out of the replay, and loading a replay clears the probes', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await ready(page);
  await page.getByTestId('palette-tab-measure').click();
  await dragDrop(page, 'wind', 140, 16);
  await expect(card(page, 'wind')).toBeVisible();
  await page.getByTestId('tab-replay').click();
  await expect(page.getByTestId('replay-message')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByTestId('export-replay').click();
  const text = await (await import('node:fs/promises')).readFile((await (await download).path())!, 'utf8');
  expect(text).not.toMatch(/measure/i);
  await page.locator('summary', { hasText: 'Paste replay JSON' }).click();
  await page.getByTestId('import-replay-text').fill(text);
  await page.getByTestId('import-replay-paste').click();
  await expect.poll(async () => (await probes(page)).charts.length, { timeout: 30_000 }).toBe(0);
  expect(errors).toEqual([]);
});
