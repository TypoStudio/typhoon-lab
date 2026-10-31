import { setSpeed } from './speed';
import { test, expect, type Page } from '@playwright/test';
import { MAX_TIME_SPEED, timeSpeedLabel } from '../../src/time';

// No help=0: this is the first-visit flow. Each test starts with empty storage.
const URL = '/?renderer=canvas&map=flat&lang=en&seed=20261022&start=2026-08-01';

async function point(page: Page, lon: number, lat: number) {
  return page.evaluate(([lon, lat]) => {
    const [x, y] = (window as any).__typhoonLab.mapView.lonLatToPx(lon, lat);
    const rect = document.querySelector('[data-testid="map-stage"]')!.getBoundingClientRect();
    return { x: x + rect.left, y: y + rect.top };
  }, [lon, lat]);
}
async function drop(page: Page, tool: string, lon: number, lat: number) {
  const button = (await page.getByTestId(`tool-${tool}`).boundingBox())!;
  const destination = await point(page, lon, lat);
  await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 4 });
  await page.mouse.up();
}

test('first visit: the tutorial builds a typhoon, then weakens it, then stays away', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const card = page.getByTestId('tutorial');
  const step = (id: string) => expect(card).toHaveAttribute('data-step', id);
  await expect(card).toBeVisible();
  await expect(page.getByTestId('help-dialog')).not.toBeVisible();
  await step('welcome');
  await expect(page.getByTestId('tutorial-count')).toHaveText('1 / 10');

  await page.getByTestId('tutorial-next').click();
  await step('conditions');
  await expect(page.getByTestId('tool-warm')).toHaveClass(/tutorial-highlight/);
  await page.getByTestId('tutorial-next').click();
  await step('warm');
  await expect(page.getByTestId('tutorial-next')).toBeHidden();

  await drop(page, 'warm', 140, 16);
  await step('moisture');
  await drop(page, 'moisture', 140, 16);
  await step('low');
  await drop(page, 'low', 140, 16);
  await step('play');

  await expect(page.getByTestId('speed-next')).toHaveClass(/tutorial-highlight/);
  await expect(page.getByTestId('tutorial-body')).toContainText(timeSpeedLabel(MAX_TIME_SPEED));
  await setSpeed(page, MAX_TIME_SPEED);
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', 'Pause');
  await expect.poll(async () => card.getAttribute('data-step'), { timeout: 60_000, intervals: [500] }).toBe('formed');

  await page.getByTestId('tutorial-next').click();
  await step('damage');
  await page.getByTestId('tutorial-next').click();
  await step('weaken');
  await expect(page.getByTestId('tutorial-count')).toHaveText('9 / 10');
  for (const [language, text] of [['ko', '차가운 바다는'], ['ja', '冷たい海は'], ['zh-CN', '冷海水'], ['zh-TW', '冷海水'], ['en', 'Cool water cuts off']]) {
    await page.getByTestId('language-select').evaluate((el: HTMLSelectElement, language) => {
      el.value = language;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, language);
    await expect(page.getByTestId('tutorial-body')).toContainText(text);
    await expect(page.getByTestId('tutorial-body')).toContainText('Q');
    await step('weaken');
  }
  await expect(page.getByTestId('tool-warm')).toHaveClass(/tutorial-highlight/);
  await page.getByTestId('tool-warm').click();
  await page.getByTestId('tool-warm').click();
  await expect(page.getByTestId('tool-warm')).toHaveAttribute('data-variant', 'cool');
  await drop(page, 'warm', 142, 17);
  await step('done');

  await expect(page.getByTestId('tutorial-next')).toHaveText('Finish');
  await page.getByTestId('tutorial-next').click();
  await expect(card).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('typhoon-lab:tutorial'))).toBe('done');

  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(card).toBeHidden();
  await expect(page.getByTestId('help-dialog')).not.toBeVisible();
});

test('Skip ends the tutorial for good, and Help can reopen it', async ({ page }) => {
  await page.goto(URL);
  await expect(page.getByTestId('tutorial')).toBeVisible();
  await page.getByTestId('tutorial-skip').click();
  await expect(page.getByTestId('tutorial')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('typhoon-lab:tutorial'))).toBe('done');
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('tutorial')).toBeHidden();

  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tutorial').click();
  await expect(page.getByTestId('help-dialog')).not.toBeVisible();
  await expect(page.getByTestId('tutorial')).toHaveAttribute('data-step', 'welcome');
});

test('help=0 never shows the tutorial', async ({ page }) => {
  await page.goto(`${URL}&help=0`);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('tutorial')).toBeHidden();
  await expect(page.getByTestId('help-dialog')).not.toBeVisible();
});
