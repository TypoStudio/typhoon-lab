import { expect, test } from '@playwright/test';
import { setSpeed } from './speed';
import { TIME_SPEEDS } from '../../src/time';

const tick = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__typhoonLab.state?.tick as number);

test('+4h while paused advances 4 hours and stays paused', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const skip = page.getByTestId('skip-4h');
  await expect(skip).toHaveText('+4h');
  await expect(skip).toHaveAccessibleName('Skip ahead 4 hours');
  await expect(skip).toBeEnabled();
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  await page.waitForTimeout(600);
  const before = await tick(page);
  await skip.dblclick();
  await expect.poll(() => tick(page)).toBe(before + 16);
  await page.waitForTimeout(700);
  expect(await tick(page)).toBe(before + 16);
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  expect(await page.evaluate(() => (window as any).__typhoonLab.playing)).toBe(false);
});

test('+4h is disabled at the fast climate speed, with a reason', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const skip = page.getByTestId('skip-4h');
  await expect(skip).toBeEnabled();
  await setSpeed(page, TIME_SPEEDS.at(-1)!);
  await expect(skip).toBeDisabled();
  await expect(skip).toHaveAttribute('data-tip', /7d\/s/);
  await setSpeed(page, TIME_SPEEDS[0]);
  await expect(skip).toBeEnabled();
});
