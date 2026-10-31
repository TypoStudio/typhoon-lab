import { setSpeed } from './speed';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const ALL_TOOLS = ['warm', 'moisture', 'low', 'low-shear', 'warm-air', 'updraft', 'unstable-air'];

test('natural formation toggle starts waves, shows the wave line and stops when switched off', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&seed=20261022&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const toggle = page.getByTestId('genesis-toggle');
  await expect(toggle).toHaveRole('switch');
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('Off');
  await expect(page.getByTestId('genesis-wave')).toBeHidden();
  await expect(page.locator('[data-mode], [data-testid^="mode-"]')).toHaveCount(0);
  const stateOf = () => page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { hours: s.hours, genesis: s.genesis, effects: s.effects.length, storms: s.storms.length, actions: s.actions };
  });
  expect(await stateOf()).toMatchObject({ effects: 0, storms: 0, genesis: { enabled: false, waves: 0 } });

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(toggle).toHaveText('On');
  await expect.poll(async () => (await stateOf()).genesis.waves).toBe(1);
  expect(await stateOf()).toMatchObject({ effects: 5, actions: [{ type: 'genesis', on: true }] });
  await expect(page.getByTestId('genesis-wave')).toContainText(/^Natural formation · wave 1 · next conditions in \d+ h$/);
  await page.getByTestId('tab-news').click();
  await expect(page.getByTestId('news-list')).toContainText('Natural formation wave 1: conditions gathering');
  for (const tool of ALL_TOOLS) await expect(page.getByTestId(`tool-${tool}`)).toBeVisible();

  await setSpeed(page, 14400);
  await expect.poll(async () => (await stateOf()).genesis.waves, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('news-list')).toContainText('Natural formation wave 2: conditions gathering');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(toggle).toHaveText('Off');
  await expect(page.getByTestId('genesis-wave')).toBeHidden();
  const off = await stateOf();
  expect(off.genesis.enabled).toBe(false);
  await expect.poll(async () => (await stateOf()).hours, { timeout: 30_000 }).toBeGreaterThanOrEqual(off.hours + 120);
  expect((await stateOf()).genesis.waves).toBe(off.genesis.waves);
});

test('natural formation survives replay export and import after loading a fresh world', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const snapshot = () => page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { seed: s.seed, tick: s.tick, genesis: s.genesis, effects: s.effects, candidates: s.candidates, storms: s.storms, cities: s.cities, score: s.score };
  });
  const first = await snapshot();
  await page.getByTestId('genesis-toggle').click();
  await setSpeed(page, 14400);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.hours), { timeout: 30_000 }).toBeGreaterThanOrEqual(30);
  await page.getByTestId('play-toggle').click();
  await page.getByTestId('tab-replay').click();
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('export-replay').click();
  const file = await readFile((await (await downloaded).path())!, 'utf8');
  const replay = JSON.parse(file);
  expect(replay.formatVersion).toBe(6);
  expect(replay).not.toHaveProperty('mode');
  expect(replay).not.toHaveProperty('typhoonId');
  expect(replay.actions[0]).toMatchObject({ type: 'genesis', on: true });
  const before = await snapshot();
  expect(before.genesis.enabled).toBe(true);

  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect.poll(async () => (await snapshot()).seed).not.toBe(first.seed);
  expect((await snapshot()).genesis).toEqual({ enabled: false, waves: 0, nextSpawnTick: 0 });
  await expect(page.getByTestId('genesis-toggle')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('speed-value')).toHaveText('x1');
  await expect(page.getByTestId('speed-reset')).toHaveAttribute('data-tip', 'Return only the speed to x1.');

  await page.getByTestId('import-replay-input').setInputFiles({ name: 'genesis.json', mimeType: 'application/json', buffer: Buffer.from(file) });
  await expect(page.getByTestId('replay-message')).toContainText(String(replay.untilTick));
  expect(await snapshot()).toEqual(before);
  await expect(page.getByTestId('genesis-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('genesis-wave')).toBeVisible();
});

test('world controls fit narrow and desktop viewports without captures', async ({ page }) => {
  await page.goto('/?renderer=canvas&seed=20261022&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('genesis-toggle').click();
  await expect(page.getByTestId('genesis-toggle')).toHaveText('켜짐');
  await expect(page.getByTestId('genesis-wave')).toContainText('태풍 자연 발생');
  for (const width of [320, 375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
    for (const type of ALL_TOOLS) {
      const b = page.getByTestId(`tool-${type}`);
      await expect(b).toBeVisible();
      const r = (await b.boundingBox())!;
      // Below 48rem the palette is one sideways-scrolling row, so cells past the edge are reached by scrolling.
      if (width >= 768) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.width).toBeLessThanOrEqual(width);
      }
      expect(r.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    // Phones collapse the legend into a chip; the damage line sits under whichever of the two is showing.
    const legend = (await page.getByTestId(width < 768 ? 'legend-toggle' : 'legend').boundingBox())!;
    const hud = (await page.getByTestId('damage-hud').boundingBox())!;
    expect(hud.y).toBeGreaterThanOrEqual(legend.y + legend.height);
    if (width < 768) {
      const strip = (await page.locator('.clockbar').boundingBox())!;
      expect(strip.height).toBeLessThanOrEqual(2.25 * 15 + 0.5);
      expect(strip.x).toBe(0);
      expect(strip.width).toBe(width);
      // The wave line is ellipsized to one line, never wrapped.
      expect(hud.height).toBeLessThanOrEqual(2 * 1.5 * 0.75 * 15 + 8);
      const clock = (await page.locator('.clockbar').boundingBox())!;
      const palette = (await page.getByTestId('weather-palette').boundingBox())!;
      expect(clock.y + clock.height).toBeLessThanOrEqual(palette.y);
    }
    await page.getByTestId('sidebar-toggle').click();
    if (width < 768) await page.getByTestId('tab-settings').click();
    const sidebar = (await page.getByTestId('sidebar').boundingBox())!;
    expect(sidebar.x + sidebar.width).toBeLessThanOrEqual(width + 1);
    for (const id of ['genesis-toggle', 'historic-select', 'historic-load', 'recorded-path-toggle', 'climate-reset']) {
      await expect(page.getByTestId(id)).toBeVisible();
      const r = (await page.getByTestId(id).boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(sidebar.x);
      expect(r.x + r.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
    }
  }
});
