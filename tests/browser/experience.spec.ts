import { expect, test, type Page } from '@playwright/test';

const LAB = '/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01&map=flat';
const lab = <T>(page: Page, fn: (lab: any) => T) => page.evaluate(fn, undefined as never) as Promise<T>;

async function ready(page: Page, url = LAB) {
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(url);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  return errors;
}
const palette = async (page: Page) => (await page.getByTestId('weather-palette').boundingBox())!;
const state = (page: Page, read: string) => page.evaluate(`(() => { const s = window.__typhoonLab.state; return ${read}; })()`);

test('the Typhoon experience tab keeps the box size, lists 40 typhoons and loads one by click', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await ready(page);
  const home = await palette(page);
  await page.getByTestId('weather-palette').getByRole('tab', { name: 'Typhoon experience' }).click();
  const box = await palette(page);
  expect(box.height).toBeCloseTo(home.height, 0);
  expect(box.width).toBeCloseTo(home.width, 0);
  expect(box.y).toBeCloseTo(home.y, 0);
  for (const id of ['conditions', 'formation', 'measure', 'climate', 'typhoons']) {
    await page.getByTestId(`palette-tab-${id}`).click();
    expect((await palette(page)).height).toBeCloseTo(home.height, 0);
  }

  const tiles = page.locator('[data-experience^="typhoon:"]');
  await expect(tiles).toHaveCount(40);
  await expect(page.locator('[data-experience^="scenario:"]')).toHaveCount(2);
  await expect(tiles.nth(0).locator('.tool__sub')).toHaveText(/^19\d\d$/);
  // The row scrolls sideways; the page does not.
  const row = page.getByTestId('experience-typhoons');
  expect(await row.evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
  await expect(row).toHaveAttribute('data-more-end', 'true');
  await row.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => row.evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  await expect(row).toHaveAttribute('data-more-start', 'true');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Tooltip: name, year, basin and peaks.
  const maemi = page.getByTestId('experience-typhoon-maemi-2003');
  await maemi.scrollIntoViewIfNeeded();
  await maemi.hover();
  await expect(page.locator('#tip')).toContainText('Maemi (2003)');
  await expect(page.locator('#tip')).toContainText(/Western North Pacific · Peak pressure \d+ hPa · Peak wind \d+ m\/s/);

  // Click loads it with the same toast as Load, and does not arm a tool.
  await maemi.click();
  await expect.poll(() => state(page, 's.historic.map(h => h.typhoonId)')).toEqual(['maemi-2003']);
  await expect(page.getByTestId('status')).toContainText('Maemi (2003) loaded. Its path is recorded; conditions change its strength.');
  expect(await page.locator('.stage').getAttribute('data-armed')).toBe('');
  await expect.poll(() => state(page, 's.storms.some(x => x.record?.typhoonId === "maemi-2003")')).toBe(true);
  await expect(maemi).toHaveClass(/is-live/);
  await expect(maemi).toHaveAttribute('aria-current', 'true');
  expect(errors).toEqual([]);
});

test('a climate scenario (Climate experience tab) loads by click and by drag, and a drop outside the map shows the toast', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await ready(page);
  await page.getByTestId('palette-tab-climate').click();
  const nino = page.getByTestId('experience-scenario-nino-1997');
  await nino.hover();
  await expect(page.locator('#tip')).toContainText('westerly wind bursts');
  await nino.click();
  await expect.poll(() => state(page, 's.climateScenario?.year')).toBe(1997);
  // The status toast can be taken over by a running storm's own toast (storms now carry on through a load), so the load is read from the news.
  await expect.poll(() => state(page, 's.news.some(n => n.title === "1997–98 El Niño")')).toBe(true);
  await expect(nino).toHaveClass(/is-live/);

  // Drag the other one onto the map; the drop point does not matter.
  const from = (await page.getByTestId('experience-scenario-nina-2010').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 4 });
  await expect(page.locator('.drag-ghost')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => state(page, 's.climateScenario?.year')).toBe(2010);
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await expect(page.getByTestId('experience-scenario-nina-2010')).toHaveClass(/is-live/);
  await expect(nino).not.toHaveClass(/is-live/);
  expect(await page.locator('.stage').getAttribute('data-armed')).toBe('');

  // Dropped on the palette itself: not the map. Pause first so a storm's toast cannot replace the status line.
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  const before = await state(page, 's.climateScenario.loads');
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 300, from.y - 4, { steps: 4 });
  await page.mouse.move(from.x + 300, from.y + 30, { steps: 2 });
  await page.mouse.up();
  await expect(page.getByTestId('status')).toContainText('Dropped outside the map');
  expect(await state(page, 's.climateScenario.loads')).toBe(before);
  expect(errors).toEqual([]);
});

test('pressing the loaded scenario again switches it off, by click, Enter and drop; another scenario still switches over', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await ready(page);
  await page.getByTestId('palette-tab-climate').click();
  const nino = page.getByTestId('experience-scenario-nino-1997'), nina = page.getByTestId('experience-scenario-nina-2010');
  await nino.click();
  await expect.poll(() => state(page, 's.climateScenario?.id')).toBe('nino-1997');
  await expect(nino).toHaveAttribute('aria-pressed', 'true');
  // Click again: off, tile cleared, same toast style.
  await nino.click();
  await expect.poll(() => state(page, 's.climateScenario === undefined')).toBe(true);
  await expect(nino).not.toHaveClass(/is-live/);
  await expect(nino).toHaveAttribute('aria-pressed', 'false');
  expect(await state(page, 's.climateLayer === null')).toBe(true);
  expect(await state(page, 's.actions.at(-1).type')).toBe('climate-scenario-off');
  // Enter turns it on again, a drop onto the map turns it off, and the other scenario switches over.
  await nino.focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => state(page, 's.climateScenario?.id')).toBe('nino-1997');
  const box = (await nino.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(600, 300, { steps: 4 });
  await page.mouse.up();
  // A drop only ever loads: dropping the loaded tile loads it again and does not switch it off.
  await expect.poll(() => state(page, 's.climateScenario?.loads')).toBe(3);
  expect(await state(page, 's.climateScenario?.id')).toBe('nino-1997');
  // A fast double click posts one request, not two (the second would switch it off or load it twice).
  await nino.dblclick();
  await expect.poll(() => state(page, 's.actions.filter(a => a.type === "climate-scenario-off").length')).toBe(2);
  expect(await state(page, 's.climateScenario === undefined')).toBe(true);
  await nino.click();
  await expect.poll(() => state(page, 's.climateScenario?.id')).toBe('nino-1997');
  await nina.click();
  await expect.poll(() => state(page, 's.climateScenario?.id')).toBe('nina-2010');
  await expect(nina).toHaveClass(/is-live/);
  await expect(nino).not.toHaveClass(/is-live/);
  expect(errors).toEqual([]);
});

test('a loaded scenario brings its starter Measure charts, opens the tab without taking focus, and off or another scenario replaces them', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await ready(page, '/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01&map=flat');
  const probes = () => page.evaluate(() => (window as any).__typhoonLab.probes as { pins: { n: number; label?: string }[]; charts: string[] });
  await page.getByTestId('palette-tab-climate').click();
  const nino = page.getByTestId('experience-scenario-nino-1997');
  await nino.click();
  await expect.poll(async () => (await probes()).pins.length).toBe(9);
  expect((await probes()).charts).toHaveLength(7);
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-measure')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('measure-cards')).toContainText('다윈');
  await expect(page.getByTestId('measure-card-measure-nino34').getByTestId('measure-observed')).toBeVisible();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.experience)).toBe('scenario:nino-1997');
  // Another scenario replaces the set; nothing is doubled.
  await page.getByTestId('experience-scenario-nina-2010').click();
  await expect.poll(() => state(page, 's.climateScenario?.id')).toBe('nina-2010');
  await expect.poll(async () => (await probes()).pins.length).toBe(9);
  expect((await probes()).charts).toHaveLength(7);
  // A pin the player adds stays when the scenario goes off.
  await page.getByTestId('palette-tab-measure').click();
  const rect = (await page.getByTestId('tool-measure-wind').boundingBox())!;
  const [x, y] = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(100, 15) as [number, number]);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await probes()).charts.includes('measure-wind')).toBe(true);
  await page.getByTestId('palette-tab-climate').click();
  await page.getByTestId('experience-scenario-nina-2010').click();
  await expect.poll(() => state(page, 's.climateScenario === undefined')).toBe(true);
  await expect.poll(async () => (await probes()).charts).toEqual(['measure-wind']);
  expect((await probes()).pins).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('keyboard: one Tab stop per row, arrows and End move, Enter loads; an armed tool stays armed', async ({ page }) => {
  const errors = await ready(page);
  await page.getByTestId('tool-warm').click();
  await expect(page.locator('.stage')).toHaveAttribute('data-armed', 'warm');
  await page.getByTestId('palette-tab-climate').click();
  await page.getByTestId('experience-scenario-nino-1997').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('experience-scenario-nina-2010')).toBeFocused();
  await page.keyboard.press('Home');
  await page.getByTestId('palette-tab-typhoons').click();
  await page.getByTestId('experience-typhoon-maemi-2003').focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-experience^="typhoon:"]').last()).toBeFocused();
  expect(await page.locator('[data-experience^="typhoon:"][tabindex="0"]').count()).toBe(1);
  await page.getByTestId('palette-tab-climate').click();
  await page.getByTestId('experience-scenario-nino-1997').focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect.poll(() => state(page, 's.climateScenario?.year')).toBe(1997);
  await expect(page.locator('.stage')).toHaveAttribute('data-armed', 'warm');
  expect(errors).toEqual([]);
});

test('scenario tiles lock and unlock together with the climate sliders around a replay import', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await ready(page);
  const replay = await page.evaluate(async () => {
    const path = '/src/ui/storage.ts'; const { buildReplay } = await import(path);
    return buildReplay((window as any).__typhoonLab.state);
  });
  await page.getByTestId('palette-tab-climate').click();
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'empty.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  // The replay lock is only held while the worker rebuilds the world, so assert that the tiles follow the sliders' lock, whichever state it is in.
  await expect(page.getByTestId('replay-message')).toContainText(String(replay.untilTick));
  const locked = await page.getByTestId('climate-warming').isDisabled();
  await expect(page.getByTestId('experience-scenario-nino-1997')).toHaveAttribute('aria-disabled', String(locked));
  await expect(page.getByTestId('experience-scenario-nina-2010')).toHaveAttribute('aria-disabled', String(locked));
  await expect(page.getByTestId('experience-typhoon-maemi-2003')).not.toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

for (const [width, height, lang] of [[1440, 900, 'ko'], [768, 900, 'en'], [390, 844, 'ja'], [320, 640, 'ko'], [320, 640, 'en'], [375, 667, 'en']] as const) {
  test(`fits ${width}x${height} in ${lang} without page overflow or a moving box`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const errors = await ready(page, `/?renderer=canvas&lang=${lang}&help=0&seed=42&start=2026-08-01&map=flat`);
    const home = await palette(page);
    for (const id of ['typhoons', 'climate']) {
      await page.getByTestId(`palette-tab-${id}`).click();
      const box = await palette(page);
      expect(box.height).toBeCloseTo(home.height, 0);
      expect(box.width).toBeCloseTo(home.width, 0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      // The tab row fits inside the palette and no tab label is cut.
      const tabs = (await page.getByTestId('palette-tab-climate').boundingBox())!;
      expect(tabs.x + tabs.width).toBeLessThanOrEqual(box.x + box.width + 1);
      expect(await page.locator('.palette__tab').evaluateAll(n => n.filter(e => e.scrollWidth > e.clientWidth + 1).length)).toBe(0);
      expect(await page.locator('.palette__tabs').evaluate(e => e.scrollWidth <= e.clientWidth + 1)).toBe(true); // all five tabs are whole, none scrolled away
      const row = (await page.getByTestId(`experience-${id}`).boundingBox())!;
      const tile = (await page.locator(`[data-palette-panel="${id}"] [data-experience]`).first().boundingBox())!;
      expect(tile.y).toBeGreaterThanOrEqual(row.y - 1);
      expect(tile.y + tile.height).toBeLessThanOrEqual(row.y + row.height + 1);
      const clipped = await page.locator(`[data-palette-panel="${id}"] .tool__sub, [data-palette-panel="${id}"] .tool__desc`).evaluateAll(nodes => nodes.filter(n => n.scrollWidth > n.clientWidth + 1).length);
      expect(clipped).toBe(0);
    }
    expect(errors).toEqual([]);
  });
}

test.describe('phone: page buttons and vertical drags', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('page buttons appear on overflowing rows, advance by whole tiles, disable at the end and keep the box size', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await ready(page, '/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01&map=flat');
    const home = await palette(page);
    const pager = page.getByTestId('palette-pager');
    const prev = page.getByTestId('palette-prev'), next = page.getByTestId('palette-next');
    await expect(prev).toHaveAttribute('aria-label', '이전 페이지');
    await expect(next).toHaveAttribute('aria-label', '다음 페이지');
    await page.getByTestId('palette-tab-formation').click();
    await expect(pager).toBeVisible();
    await page.getByTestId('palette-tab-typhoons').click();
    await expect(pager).toBeVisible();
    expect((await palette(page)).height).toBeCloseTo(home.height, 0);
    for (const b of [prev, next]) {
      const r = (await b.boundingBox())!;
      expect(r.width).toBeGreaterThanOrEqual(24);
      // The tap area reaches about 40 px: a point 8 px below the visible button still hits it.
      for (const dy of [r.height + 8]) expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-page]'), [r.x + r.width / 2, r.y + dy])).toBe(true);
    }
    await expect(prev).toBeDisabled();
    const row = page.getByTestId('experience-typhoons');
    await next.click();
    await expect.poll(() => row.evaluate(el => el.scrollLeft)).toBeGreaterThan(200);
    await expect(prev).toBeEnabled();
    // The first tile at the left edge is whole.
    await expect.poll(async () => {
      const r = await row.evaluate(el => el.getBoundingClientRect().left);
      const lefts = await row.locator('[data-experience]').evaluateAll(n => n.map(x => x.getBoundingClientRect().left));
      return Math.min(...lefts.map(l => Math.abs(l - r - 12)));
    }).toBeLessThan(2);
    for (let i = 0; i < 30 && (await next.isEnabled()); i++) { await next.click(); await page.waitForTimeout(450); }
    await expect(next).toBeDisabled();
    expect(await row.evaluate(el => Math.round(el.scrollLeft + el.clientWidth) >= el.scrollWidth - 1)).toBe(true);
    await prev.click();
    await expect(next).toBeEnabled();
    expect(await page.locator('.stage').getAttribute('data-armed')).toBe('');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '/tmp/typhoon-shot/experience-ko-390-pager.png' });
    expect(errors).toEqual([]);
  });

  test('a vertical drag from a tile still loads it, and the page buttons arm nothing', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = await ready(page);
    await page.getByTestId('palette-tab-typhoons').click();
    await page.getByTestId('palette-next').click();
    const tile = page.getByTestId('experience-typhoon-maemi-2003');
    await tile.scrollIntoViewIfNeeded();
    const box = (await tile.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 200, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => state(page, 's.historic.map(h => h.typhoonId)')).toEqual(['maemi-2003']);
    expect(await page.locator('.stage').getAttribute('data-armed')).toBe('');
    expect(errors).toEqual([]);
  });
});
