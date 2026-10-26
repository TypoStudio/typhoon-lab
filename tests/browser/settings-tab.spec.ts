import { test, expect } from '@playwright/test';

test('settings sit behind the first tab on phones', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/?help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-settings')).toBeVisible();
  await expect(page.getByTestId('tab-storms')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-settings')).toBeHidden();
  await expect(page.getByTestId('season-summer')).toBeHidden();
  await page.getByTestId('tab-settings').click();
  await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-settings')).toBeVisible();
  await expect(page.getByTestId('season-summer')).toBeVisible();
  await expect(page.getByTestId('layer-wind')).toBeVisible();
  await expect(page.getByTestId('storm-row').first()).toBeHidden();
  // Arrow keys wrap through all six tabs on phones.
  await page.getByTestId('tab-settings').press('ArrowLeft');
  await expect(page.getByTestId('tab-replay')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('tab-replay').press('ArrowRight');
  await expect(page.getByTestId('tab-settings')).toHaveAttribute('aria-selected', 'true');
  // Growing past 48rem drops the phone-only tab and shows the settings above the tabs.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByTestId('tab-storms')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tab-settings')).toBeHidden();
  await expect(page.locator('#panel-settings')).toBeVisible();
});

test('settings stay above the tabs on desktop', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-settings')).toBeHidden();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await expect(page.getByTestId('season-summer')).toBeVisible();
  await page.getByTestId('tab-news').click();
  await expect(page.locator('#panel-settings')).toBeVisible();
  await page.getByTestId('tab-news').press('Home');
  await expect(page.getByTestId('tab-storms')).toHaveAttribute('aria-selected', 'true');
  await page.getByTestId('tab-storms').press('ArrowLeft');
  await expect(page.getByTestId('tab-replay')).toHaveAttribute('aria-selected', 'true');
});
