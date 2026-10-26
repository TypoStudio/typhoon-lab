import { test, expect } from '@playwright/test';

test('three nearby progress indicators produce three distinct storms in live play', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&seed=20261022&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-environment').click();
  for (const [tool, lon] of [['warm', 140], ['moisture', 140], ['low', 140], ['low', 141], ['low', 142]] as const) {
    await page.getByTestId('place-tool').selectOption(tool);
    await page.getByTestId('place-lon').fill(String(lon));
    await page.getByTestId('place-lat').fill('16');
    await page.getByTestId('place-confirm').click();
  }
  const lowIds = await page.evaluate(() => (window as any).__typhoonLab.state.effects.filter((e: any) => e.type === 'low').map((e: any) => e.id));
  expect(lowIds).toHaveLength(3);
  await page.getByTestId('tab-storms').click();
  await page.getByTestId('speed-4').click();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('patch-list').locator('li')).toHaveCount(3);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.candidates.every((c: any) => c.progressHours > 0))).toBe(true);
  await page.getByTestId('speed-12').click();
  await expect(page.getByTestId('storm-row')).toHaveCount(3, { timeout: 20_000 });
  await page.getByTestId('play-toggle').click();
  const result = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { storms: s.storms.map((st: any) => st.id), candidates: s.candidates.length,
      lows: s.effects.filter((e: any) => e.type === 'low').length,
      formations: s.news.filter((n: any) => n.kind === 'formation').length };
  });
  expect(result.storms.sort()).toEqual(lowIds.sort());
  expect(result).toMatchObject({ candidates: 0, lows: 0, formations: 3 });
  await expect(page.getByTestId('patch-list').locator('li')).toHaveCount(0);
});
