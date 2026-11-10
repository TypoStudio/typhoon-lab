import { expect, test } from '@playwright/test';
import { TIME_SPEEDS, timeSpeedLabel } from '../../src/time';

test('speed buttons and Tab cycle through the time settings', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const value = page.getByTestId('speed-value');
  const prev = page.getByTestId('speed-prev');
  const next = page.getByTestId('speed-next');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[1]));
  await expect(prev).toBeEnabled();
  await prev.click();
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[0]));
  await prev.click();
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS.at(-1)!));
  await expect(next).toBeEnabled();
  await next.click();
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[0]));
  for (let i = 1; i <= TIME_SPEEDS.length; i++) {
    await page.keyboard.press('Tab');
    await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[i % TIME_SPEEDS.length]));
  }
  for (let i = TIME_SPEEDS.length - 1; i >= 0; i--) {
    await page.keyboard.press('Shift+Tab');
    await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[i]));
  }
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'speed-shortcut-input-test';
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.press('Tab');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[0]));
  await page.locator('#speed-shortcut-input-test').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[0]));
});

test('number keys 1 through 9 set the time speeds and 0 does nothing', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const value = page.getByTestId('speed-value');
  await page.keyboard.press('3');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[2]));
  await page.keyboard.press('2');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[1]));
  await page.keyboard.press('1');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[0]));
  await page.keyboard.press('6');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[5]));
  await page.keyboard.press('4');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[3]));
  await page.keyboard.press('8');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[7]));
  await page.keyboard.press('7');
  await expect(value).toHaveText('1d');
  await page.keyboard.press('9');
  await expect(value).toHaveText('14d');
  await page.keyboard.press('0');
  await expect(value).toHaveText('14d');
  await page.keyboard.press('4');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[3]));
});

test('shortcuts still work after a range slider keeps focus, and the slider keeps its own keys', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const value = page.getByTestId('speed-value');
  const slider = page.getByTestId('climate-enso');
  if (!(await slider.isVisible())) await page.getByTestId('tab-settings').click();
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  const moved = Number(await slider.inputValue());
  expect(moved).not.toBe(0);
  await page.keyboard.press('ArrowRight');
  expect(Number(await slider.inputValue())).toBeGreaterThan(moved);
  await page.keyboard.press('3');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[2]));
  await page.keyboard.press('-');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[1]));
  await page.keyboard.press('=');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[2]));
  await page.keyboard.press('`');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[1]));
  await page.keyboard.press('Tab');
  await expect(value).toHaveText(timeSpeedLabel(TIME_SPEEDS[2]));
  await page.keyboard.press('q');
  await expect(page.getByTestId('tool-warm')).toHaveAttribute('aria-pressed', 'true');
  await slider.focus();
  const playing = await page.getByTestId('play-toggle').textContent();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play-toggle')).not.toHaveText(playing ?? '');
});
