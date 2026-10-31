import { test, expect } from '@playwright/test';

test('damage bulletins follow city impacts, survive replay, and localize without overflow', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const fixture = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const state = createGame();
    for (const type of ['warm', 'moisture', 'low']) placeTool(state, type, 130, 18);
    for (let tick = 0; tick < 800; tick++) stepGame(state);
    return { replay: buildReplay(state), reports: state.news.filter((n: any) => n.damage) };
  });
  expect(fixture.reports.length).toBeGreaterThan(0);
  expect(new Set(fixture.reports.map((n: any) => n.id)).size).toBe(fixture.reports.length);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'damage.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture.replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String(fixture.replay.untilTick));
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.news.filter((n: any) => n.damage))).toEqual(fixture.reports);
  await page.getByTestId('tab-news').click();
  await expect(page.getByTestId('news-damage')).toHaveCount(fixture.reports.length);
  const newest = fixture.reports.at(-1);
  const card = page.locator('.news').filter({ hasText: newest.title });
  await expect(card).toContainText(newest.text);
  await expect(card).toContainText(`${newest.damage.displaced.toLocaleString('en-US')} people`);
  await expect(card).toContainText(`USD ${newest.damage.lossUsd.toLocaleString('en-US')}`);
  await expect(card).toContainText('Missing (estimated)');
  await expect(card).toContainText('Damaged homes');
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.getByTestId('news-damage').first()).toContainText('이재민');
  await expect(page.getByTestId('news-damage').first()).toContainText('실종자 추정');
  await expect(page.getByTestId('news-damage').first()).toContainText('피해주택');
  await expect(page.getByTestId('news-damage').first()).toContainText(/\d+(?:조|억)?(?: \d+억)? ?원/);
  await expect(page.getByTestId('news-list')).toContainText('주거 지역에서 침수 피해가 발생했습니다');
  await page.setViewportSize({ width: 375, height: 812 });
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  expect(await page.getByTestId('news-damage').evaluateAll(nodes => nodes.every(node => {
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth && node.scrollWidth <= node.clientWidth + 1;
  }))).toBe(true);

  await page.getByTestId('language-select').selectOption('en');
  const allNews = await page.evaluate(() => (window as any).__typhoonLab.state.news.map((n: any) => ({ cityId: n.cityId, title: n.title })));
  await page.getByTestId('tab-environment').click();
  const listedCities = await page.locator('#panel-environment [data-city]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.city));
  const cityId = listedCities.find(id => allNews.some((n: any) => n.cityId === id));
  expect(cityId).toBeTruthy();
  await page.getByTestId(`city-${cityId}`).click();
  await page.getByTestId('tab-news').click();
  await expect(page.locator('.news__title')).toHaveText(allNews.filter((n: any) => n.cityId === cityId).slice(-60).reverse().map((n: any) => n.title));

  await page.getByTestId('tab-environment').click();
  await page.getByTestId(`city-${cityId}`).click();
  await page.getByTestId('tab-news').click();
  await expect(page.locator('.news__title')).toHaveText(allNews.slice(-60).reverse().map((n: any) => n.title));
});
