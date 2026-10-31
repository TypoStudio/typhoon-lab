import { expect, test, type Page } from '@playwright/test';

async function importDisasters(page: Page, kinds: string[], ticks: number) {
  const replay = await page.evaluate(async ({ kinds, ticks }) => {
    const enginePath = '/src/simulation/engine.ts', storagePath = '/src/ui/storage.ts';
    const { createGame, placeFormation, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const state = createGame(17, 213);
    for (const kind of kinds) {
      const result = placeFormation(state, kind, 127, 37);
      if (!result.ok) throw new Error(result.reason);
    }
    for (let i = 0; i < ticks; i++) stepGame(state);
    return buildReplay(state);
  }, { kinds, ticks });
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'disasters.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String(ticks));
  await page.getByTestId('tab-storms').click();
}

test('all seven current disasters have selectable Korean status, observations and damage', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&map=flat&weather=base&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await importDisasters(page, ['heatwave', 'drought', 'downpour', 'coldwave', 'hail', 'dust', 'gust'], 29);
  await expect(page.getByTestId('tab-storms')).toHaveText('재난');
  for (const name of ['폭염', '가뭄', '집중호우', '한파', '우박', '황사', '돌풍']) {
    const row = page.getByTestId('disaster-row').filter({ hasText: name }).first();
    await expect(row).toContainText('기압');
    await expect(row).toContainText('추정 피해액');
    await row.click();
    await expect(page.getByTestId('disaster-detail')).toBeVisible();
    await expect(page.getByTestId('disaster-detail')).toContainText(name);
    await expect(page.getByTestId('disaster-detail')).toContainText('피해주택');
    await expect(page.getByTestId('disaster-history').locator('li')).not.toHaveCount(0);
  }
  await page.getByTestId('tab-rank').click();
  await page.getByTestId('rank-metric-lifetimeHours').click();
  await expect(page.getByTestId('storm-rank')).toContainText('폭염');
  await expect(page.getByTestId('rank-metric-floodedHomes')).toHaveText('피해주택');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId('tab-storms').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('ended disasters keep their detail and ranking across replay, reload and selection', async ({ page }) => {
  await page.goto('/?renderer=canvas&map=flat&weather=base&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await importDisasters(page, ['gust'], 37);
  const row = page.getByTestId('disaster-history-row').filter({ hasText: '돌풍' });
  await expect(row).toHaveCount(1);
  await row.click();
  await expect(page.getByTestId('disaster-detail').locator('[data-metric="disasterStatus"]')).toHaveText('종료');
  await page.getByTestId('tab-rank').click();
  await expect(page.getByTestId('storm-rank')).toContainText('돌풍');
  await page.getByTestId('storm-rank').locator('[data-disaster-id]').click();
  await expect(page.getByTestId('disaster-detail')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-rank').click();
  await expect(page.getByTestId('storm-rank')).toContainText('돌풍');
  await expect(page.getByTestId('storm-rank')).not.toContainText('undefined');
});
