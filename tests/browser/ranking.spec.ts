import { test, expect } from '@playwright/test';

test('ended storms enter a persistent multi-metric ranking that survives reload and can be cleared', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => localStorage.removeItem('typhoon-lab-rankings'));
  const fixture = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const rankingPath = '/src/ui/rankings.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const { entryFromStorm } = await import(rankingPath);
    const s = createGame();
    for (const tool of ['warm', 'moisture', 'low']) placeTool(s, tool, 140, 16);
    for (let i = 0; i < 1600 && !s.stormArchive.length; i++) stepGame(s);
    return { replay: buildReplay(s), entry: entryFromStorm(s.seed, s.stormArchive[0], s.hours, s.actions, '') };
  });
  expect(fixture.entry.endReason).not.toBe('active');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'rank.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture.replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String(fixture.replay.untilTick));
  await page.getByTestId('tab-rank').click();

  const rank = page.getByTestId('storm-rank');
  const values: Record<string, string> = {
    lossUsd: `USD ${fixture.entry.lossUsd.toLocaleString('en-US')}`,
    displaced: `${fixture.entry.displaced.toLocaleString('en-US')} people`,
    floodedHomes: `${fixture.entry.floodedHomes.toLocaleString('en-US')} homes`,
    grade: `Grade ${fixture.entry.grade}`,
    lifetimeHours: `${fixture.entry.lifetimeHours.toFixed(1)} h`,
  };
  await expect(page.getByTestId('rank-metric-lossUsd')).toHaveAttribute('aria-checked', 'true');
  for (const [metric, text] of Object.entries(values)) {
    await page.getByTestId(`rank-metric-${metric}`).click();
    await expect(page.getByTestId(`rank-metric-${metric}`)).toHaveAttribute('aria-checked', 'true');
    await expect(rank.getByTestId('rank-value').first()).toHaveText(text);
  }
  await expect(rank.locator('li').first()).toContainText(fixture.entry.name);
  const storedText = () => page.evaluate(() => localStorage.getItem('typhoon-lab-rankings') ?? '[]');
  const stored = JSON.parse(await storedText());
  expect(stored.map((e: any) => ({ ...e, recordedAt: '' }))).toEqual([fixture.entry]);
  // Re-importing the same replay is idempotent: identical stored JSON, including the first recorded time.
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'rank.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture.replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String(fixture.replay.untilTick));
  await page.getByTestId('tab-rank').click();
  await expect(rank.locator('li')).toHaveCount(1);
  expect(JSON.parse(await storedText())).toEqual(stored);
  // A current-world record selects its storm like the history list does.
  await rank.locator('button[data-storm-id]').first().click();
  await expect(rank.locator('button[data-storm-id]').first()).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tab-storms').click();
  await expect(page.getByTestId('storm-detail')).toBeVisible();
  await page.getByTestId('tab-rank').click();

  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-rank').click();
  await expect(rank.locator('li')).toHaveCount(1);
  await expect(rank.getByTestId('rank-value')).toHaveText(values.lossUsd);
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.getByTestId('rank-metric-lifetimeHours')).toHaveText('생존 시간');
  await page.getByTestId('rank-metric-lifetimeHours').click();
  await expect(rank.getByTestId('rank-value')).toHaveText(`${fixture.entry.lifetimeHours.toFixed(1)}시간`);
  page.once('dialog', dialog => dialog.accept());
  await page.getByTestId('rank-clear').click();
  await expect(rank.locator('li')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('typhoon-lab-rankings'))).toBe('[]');
  await expect(page.getByTestId('rank-clear')).toBeHidden();
});
