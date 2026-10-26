import { test, expect } from '@playwright/test';

test('the footer privacy link opens the policy in a popup and /privacy.html stays a full page', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const url = page.url();
  await page.getByTestId('sidebar').locator('a[data-privacy-link]').click();
  const dialog = page.getByTestId('privacy-dialog');
  await expect(dialog).toBeVisible();
  expect(page.url()).toBe(url);
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('개인정보처리방침');
  await expect(dialog.getByTestId('privacy-full')).toHaveAttribute('href', /\?lang=ko$/);
  await expect(dialog.getByTestId('privacy-full')).toHaveAttribute('target', '_blank');
  await expect(dialog.locator('script, .langs')).toHaveCount(0);
  await page.getByTestId('language-select').evaluate((el: HTMLSelectElement) => { el.value = 'ja'; el.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(dialog.getByRole('heading', { level: 1 })).toHaveText('プライバシーポリシー');
  await expect(dialog.getByTestId('privacy-full')).toHaveAttribute('href', /\?lang=ja$/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.getByTestId('language-select').selectOption('ko');

  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tab-data').click();
  await page.getByTestId('help-panel-data').locator('a[data-privacy-link]').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('privacy-close').click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('help-dialog')).toBeVisible();

  const res = await page.request.get('/privacy.html');
  expect(res.status()).toBe(200);
  expect((await res.text()).match(/<section lang="/g)).toHaveLength(5);
});
