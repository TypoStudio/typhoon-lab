import { test, expect, type Page } from '@playwright/test';

async function importReplay(page: Page, replay: object) {
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String((replay as any).untilTick), { timeout: 60_000 });
  await page.getByTestId('tab-storms').click();
}
async function observeLabels(page: Page) {
  // Observe drawing commands only. No canvas pixels, images, traces with screenshots, or captures.
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const clear = proto.clearRect, fill = proto.fillText;
    proto.clearRect = function(...args) {
      if (this.canvas.classList.contains('map-canvas--overlay')) { (window as any).__mapLabels = []; (window as any).__mapLabelBoxes = []; }
      return clear.apply(this, args);
    };
    proto.fillText = function(...args) {
      if (this.canvas.classList.contains('map-canvas--overlay')) {
        ((window as any).__mapLabels ??= []).push(args[0]);
        if (/^Grade \d+ ·/.test(args[0])) ((window as any).__mapLabelBoxes ??= []).push({ x: args[1], y: args[2] - 12, w: this.measureText(args[0]).width, h: 15 });
      }
      return fill.apply(this, args);
    };
  });
}

test('ended records show complete routes and weakening stages, survive replay, and render in Korean', async ({ page }) => {
  await observeLabels(page);
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const fixture = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low']) placeTool(s, tool, 140, 16);
    for (let i = 0; i < 1600 && !s.stormArchive.length; i++) stepGame(s);
    return { replay: buildReplay(s), record: s.stormArchive[0] };
  });
  expect(fixture.record).toBeTruthy();
  await importReplay(page, fixture.replay);
  await expect(page.getByTestId('storm-row')).toHaveCount(0);
  const row = page.getByTestId('storm-history-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Dissipated');
  // Active and ended storms are separate, counted sections; ended rows carry an outcome chip and no accent bar or cyclone icon.
  await expect(page.getByTestId('storm-active-title')).toHaveText('Active disasters · 0');
  await expect(page.getByTestId('storm-ended-title')).toHaveText('Ended disasters · 1');
  await expect(row.locator('.storm-row__chip')).toHaveText('Dissipated');
  await expect(row.locator('.storm-row__chip')).toBeVisible();
  await expect(row.locator('.storm-row__icon')).toBeHidden();
  expect(await row.evaluate(b => getComputedStyle(b, '::before').content)).toBe('none');
  await expect(page.getByTestId('storm-history-more')).toBeHidden();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  const detail = page.getByTestId('storm-detail');
  await expect(detail.locator('[data-metric="outcome"]')).toHaveText('Dissipated');
  await expect(detail.locator('[data-metric="centerWind"]')).toHaveCount(0);
  const changes = fixture.record.history.filter((sample: any, i: number, samples: any[]) => !i || sample.stage !== samples[i - 1].stage);
  await expect(page.getByTestId('storm-stages').locator('li')).toHaveCount(changes.length);
  await expect.poll(() => page.evaluate(() => (window as any).__mapLabels.includes('Dissipated'))).toBe(true);
  for (const change of changes) {
    await expect.poll(() => page.evaluate(text => (window as any).__mapLabels.includes(text),
      `Grade ${change.grade} · ${change.stage} · ${change.hour.toFixed(1)} h`)).toBe(true);
  }
  expect(await page.evaluate(() => {
    const boxes = (window as any).__mapLabelBoxes;
    const right = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect().left;
    return boxes.length > 0 && boxes.every((a: any, i: number) => a.x >= 0 && a.x + a.w < right && a.y >= 0 && a.y + a.h <= innerHeight
      && boxes.every((b: any, j: number) => i === j || a.x >= b.x + b.w || a.x + a.w <= b.x || a.y >= b.y + b.h || a.y + a.h <= b.y));
  })).toBe(true);
  // The entire historical path is fitted into the map area left of the sidebar.
  expect(await page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    const right = document.querySelector('[data-testid="sidebar"]')!.getBoundingClientRect().left;
    return lab.state.stormArchive[0].track.every((p: any) => {
      const [x, y] = lab.mapView.lonLatToPx(p.lon, p.lat);
      return x >= 0 && x < right && y >= 0 && y < innerHeight;
    });
  })).toBe(true);
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.getByTestId('storm-active-title')).toHaveText('진행 중인 재난 · 0');
  await expect(page.getByTestId('storm-ended-title')).toHaveText('종료된 재난 · 1');
  await expect(page.getByTestId('storm-stages')).toContainText('등급');
  await expect(detail.locator('[data-metric="outcome"]')).toHaveText('소멸');
  await expect.poll(() => page.evaluate(() => (window as any).__mapLabels.includes('소멸'))).toBe(true);
  // Future worker snapshots must preserve the selected ended record and its map markers.
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.tick)).toBeGreaterThan(fixture.replay.untilTick + 2);
  await page.getByTestId('play-toggle').click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.stormArchive[0])).toEqual(fixture.record);
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(row).toHaveCount(0);
  await importReplay(page, fixture.replay);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.stormArchive[0])).toEqual(fixture.record);
  await page.setViewportSize({ width: 375, height: 812 });
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('storm-history-row').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__mapLabels.includes('소멸'))).toBe(true);
});

test('live map labels show storm identifiers, grades, radius and movement speed', async ({ page }) => {
  await observeLabels(page);
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const meta = await page.evaluate(() => {
    const { seed, scenarioId, version } = (window as any).__typhoonLab.state;
    return { seed, scenarioId, version };
  });
  await importReplay(page, { ...meta, format: 'typhoon-lab-replay', formatVersion: 6, startDayOfYear: 213, untilTick: 180,
    actions: ['warm', 'moisture', 'low'].map(type => ({ tick: 0, type, lon: 140, lat: 16 })) });
  const expected = await page.evaluate(async () => {
    const path = '/src/storm-info.ts'; const { stormGradeLabel } = await import(path);
    const storm = (window as any).__typhoonLab.state.storms[0];
    return { grade: stormGradeLabel(storm), title: `#${storm.id} · ${stormGradeLabel(storm)}`,
      details: `Radius ${storm.galeRadiusKm.toFixed(0)} km · Moving ${storm.movementSpeedKmh.toFixed(1)} km/h` };
  });
  for (const label of [expected.title, expected.details]) {
    await expect.poll(() => page.evaluate(text => (window as any).__mapLabels.includes(text), label)).toBe(true);
  }
  await page.getByTestId('storm-row').click();
  await expect(page.getByTestId('storm-detail').locator('[data-metric="stage"]')).toContainText(expected.grade);
  await page.getByTestId('language-select').selectOption('ko');
  await expect.poll(() => page.evaluate(() => (window as any).__mapLabels.some((text: string) => /^#\d+ · \d+등급/.test(text)))).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as any).__mapLabels.some((text: string) => /^반경 \d+ km · 이동 [\d.]+ km\/h$/.test(text)))).toBe(true);
});

test('more than eight ended storms collapse behind a Show all link', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const replay = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const s = createGame();
    // Ten separate spots, each grown into its own storm and left to dissipate.
    for (let i = 0; i < 10; i++) for (const tool of ['warm', 'moisture', 'low']) placeTool(s, tool, 120 + i * 6, 14);
    for (let i = 0; i < 6000 && s.stormArchive.length < 9; i++) stepGame(s);
    return buildReplay(s);
  });
  await importReplay(page, replay);
  const rows = page.getByTestId('storm-history-row');
  const total = await rows.count();
  expect(total).toBeGreaterThan(8);
  await expect(page.getByTestId('storm-ended-title')).toHaveText(`Ended disasters · ${total}`);
  await expect(rows.filter({ visible: true })).toHaveCount(8);
  const more = page.getByTestId('storm-history-more');
  await expect(more).toHaveText(`Show all (${total})`);
  await more.click();
  await expect(rows.filter({ visible: true })).toHaveCount(total);
  await expect(more).toBeHidden();
});
