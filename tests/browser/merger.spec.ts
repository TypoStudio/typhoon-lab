import { test, expect } from '@playwright/test';

test('independent young storms later merge, keep selection, and explain the event in both languages', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const meta = await page.evaluate(() => {
    const { scenarioId, version, seed } = (window as any).__typhoonLab.state;
    return { scenarioId, version, seed };
  });
  const replay = { ...meta, format: 'typhoon-lab-replay', formatVersion: 6, startDayOfYear: 213, untilTick: 120,
    actions: ['warm', 'moisture', 'low', 'low'].map(type => ({ tick: 0, type, lon: 140, lat: 16 })) };
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'young.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText('틱 120');
  await page.getByTestId('tab-storms').click();
  await expect(page.getByTestId('storm-row')).toHaveCount(2);
  // Determine which of the two selected candidates will be absorbed, then follow the real worker.
  const event = await page.evaluate(async () => {
    const path = '/src/simulation/engine.ts';
    const { stepGame } = await import(path);
    const state = structuredClone((window as any).__typhoonLab.state);
    for (let i = 0; i < 100 && !state.news.some((n: any) => n.kind === 'merger'); i++) stepGame(state);
    return state.news.find((n: any) => n.kind === 'merger');
  });
  expect(event).toBeTruthy();
  await page.locator(`[data-storm-id="${event.absorbedId}"]`).click();
  await expect(page.getByTestId('storm-detail')).toBeVisible();
  await page.getByTestId('speed-4').click();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('storm-row')).toHaveCount(1, { timeout: 15_000 });
  await page.getByTestId('play-toggle').click();
  await expect(page.locator(`[data-storm-id="${event.mergedIntoId}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('storm-detail')).toBeVisible();
  await expect(page.getByTestId('storm-detail')).toContainText(`태풍 #${event.mergedIntoId}`);
  await page.getByTestId('tab-news').click();
  const news = page.locator('.news--merger');
  await expect(news).toHaveCount(1);
  await expect(news).toContainText(`폭풍 #${event.absorbedId}이 #${event.mergedIntoId}로 병합`);
  await expect(news).toContainText('진행률은 유지됩니다');
  await page.getByTestId('language-select').selectOption('en');
  await expect(news).toContainText(`Storm #${event.absorbedId} merges into #${event.mergedIntoId}`);
  await expect(news).toContainText('Merger');
  // The post-merger worker state also has an exact replay, including the explicit merger record.
  expect(await page.evaluate(async () => {
    const path = '/src/simulation/engine.ts';
    const { replayGame } = await import(path);
    const state = (window as any).__typhoonLab.state;
    const result = replayGame(state.seed, state.actions, state.tick);
    return result.ok && JSON.stringify(result.state) === JSON.stringify(state);
  })).toBe(true);
  await page.getByTestId('tab-storms').click();
  const archived = page.getByTestId('storm-history-row');
  await expect(archived).toHaveCount(1);
  await archived.click();
  await expect(archived).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('storm-detail')).toContainText(`Merged into storm #${event.mergedIntoId}`);
  const tick = await page.evaluate(() => (window as any).__typhoonLab.state.tick);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.tick)).toBeGreaterThan(tick + 4);
  await page.getByTestId('play-toggle').click();
  await expect(archived).toHaveAttribute('aria-pressed', 'true');
});
