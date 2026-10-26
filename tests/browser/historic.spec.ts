import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const ALL_TOOLS = ['warm', 'moisture', 'low', 'low-shear', 'warm-air', 'updraft', 'cool', 'dry', 'high', 'cold-air', 'downdraft', 'high-shear'];

test('loading a past typhoon adds its recorded storm, keeps the palette and shows the date line', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?renderer=canvas&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('historic-hud')).toBeHidden();
  await expect(page.getByTestId('historic-select').locator('option')).not.toHaveCount(0);
  await expect(page.getByTestId('historic-select').locator('option[value="maemi-2003"]')).toHaveText('Maemi (2003) · Western North Pacific');
  await page.getByTestId('historic-select').selectOption('maemi-2003');
  // Choosing does not load anything; only the button does.
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.historic)).toEqual([]);
  await page.getByTestId('historic-load').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.historic.map((h: any) => h.typhoonId))).toEqual(['maemi-2003']);
  await expect(page.getByTestId('status')).toContainText('Maemi (2003) loaded. Its path is recorded; conditions change its strength.');
  await expect(page.getByTestId('historic-hud')).toBeVisible();
  await expect(page.getByTestId('historic-hud').locator('p')).toHaveCount(1);
  await expect(page.getByTestId('historic-hud')).toContainText(/^Maemi \(2003\) · 2003-09-0[45] \d\d:\d\d UTC · (NCEP\/NCAR R1 \+ ERSST v5|base climate)$/);
  await expect(page.getByTestId('weather-palette')).toBeVisible();
  for (const tool of ALL_TOOLS) await expect(page.getByTestId(`tool-${tool}`)).toBeVisible();
  await expect(page.getByTestId('storm-list')).toContainText('Maemi');

  await page.getByTestId('storm-row').click();
  const effect = page.locator('[data-metric="windDelta"]');
  await expect(effect).toBeVisible();
  await expect(page.getByTestId('storm-detail')).toContainText('Maemi');

  await page.getByTestId('speed-12').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.hours), { timeout: 30_000 }).toBeGreaterThanOrEqual(24);
  await expect(page.getByTestId('historic-hud')).toContainText(/2003-09-(0[5-9]|1\d)/);
});

test('Korean labels follow the language and the toast names the typhoon in Korean', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('historic-select').locator('option[value="maemi-2003"]')).toHaveText('매미 (2003) · 서북태평양');
  await page.getByTestId('historic-select').selectOption('maemi-2003');
  await page.getByTestId('historic-load').click();
  await expect(page.getByTestId('status')).toContainText('매미 (2003) 태풍을 불러왔습니다. 경로는 기록을 따르며 조건은 세기만 바꿉니다.');
  await expect(page.getByTestId('historic-hud')).toContainText('매미 (2003)');
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('historic-select').locator('option[value="maemi-2003"]')).toHaveText('Maemi (2003) · Western North Pacific');
  await expect(page.getByTestId('historic-hud')).toContainText('Maemi (2003)');
});

test('the recorded path toggle flips, redraws and is remembered', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const toggle = page.getByTestId('recorded-path-toggle');
  await expect(toggle).toHaveRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveText('On');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('Off');
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveText('On');
});

test('a loaded typhoon survives a replay export and import', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?renderer=canvas&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('historic-select').selectOption('maemi-2003');
  await page.getByTestId('historic-load').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.historic.length)).toBe(1);
  await page.getByTestId('speed-12').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.hours), { timeout: 30_000 }).toBeGreaterThanOrEqual(12);
  await page.getByTestId('play-toggle').click();
  await page.getByTestId('tab-replay').click();
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('export-replay').click();
  const file = await readFile((await (await downloaded).path())!, 'utf8');
  const replay = JSON.parse(file);
  expect(replay.formatVersion).toBe(6);
  expect(replay).not.toHaveProperty('mode');
  expect(replay.actions).toEqual([expect.objectContaining({ type: 'historic', typhoonId: 'maemi-2003' })]);
  const snapshot = () => page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { tick: s.tick, historic: s.historic, storms: s.storms, actions: s.actions };
  });
  const before = await snapshot();
  await page.getByTestId('reset').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.historic.length)).toBe(0);
  await expect(page.getByTestId('historic-hud')).toBeHidden();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'historic.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.getByTestId('replay-message')).toContainText(String(replay.untilTick));
  expect(await snapshot()).toEqual(before);
  await expect(page.getByTestId('historic-hud')).toContainText('Maemi (2003)');
});
