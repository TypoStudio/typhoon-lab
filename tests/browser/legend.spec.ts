import { test, expect, type Page } from '@playwright/test';

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

async function ready(page: Page) {
  await page.goto('/?renderer=canvas&map=flat&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  const map = (await page.getByTestId('map-stage').boundingBox())!;
  const touch = await page.context().newCDPSession(page);
  const point = { x: Math.round(map.x + map.width / 2), y: Math.round(map.y + map.height / 2) };
  return {
    point,
    start: () => touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }),
    move: (points: typeof point[]) => touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points }),
    pinch: () => touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point, { x: point.x + 50, y: point.y }] }),
    end: () => touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }),
    cancel: () => touch.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }),
  };
}

test('holding the mobile map shows a live legend with desktop sizing until release', async ({ page }) => {
  const touch = await ready(page);
  const legend = page.getByTestId('legend');
  await touch.start();
  await expect(legend).toBeHidden();
  await expect(legend).toBeVisible();
  await expect(page.getByTestId('legend-pressure')).toContainText(/\d{3,4} hPa/);
  const sizing = () => legend.evaluate(el => ({
    width: el.getBoundingClientRect().width,
    font: getComputedStyle(el).fontSize,
    barHeight: getComputedStyle(el.querySelector('.legend__bar')!).height,
    tickFont: getComputedStyle(el.querySelector('.legend__ticks span')!).fontSize,
    titleWrap: getComputedStyle(el.querySelector('.legend__title')!).flexWrap,
  }));
  const mobileSizing = await sizing();
  expect(await legend.evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem('typhoon-lab-legend'))).toBeNull();
  await touch.end();
  await expect(legend).toBeHidden();
  await expect(page.getByTestId('legend-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(legend).toBeVisible();
  expect(await sizing()).toEqual(mobileSizing);
  await page.setViewportSize({ width: 375, height: 812 });
  // The button still opens a scrollable panel that can be closed explicitly.
  await page.getByTestId('legend-toggle').tap();
  await expect(legend).toBeVisible();
  await page.getByTestId('legend-close').tap();
  await expect(legend).toBeHidden();
});

test('a mouse can hold the map in the mobile development layout', async ({ page }) => {
  const { point } = await ready(page);
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await expect(page.getByTestId('legend')).toBeVisible();
  await page.mouse.up();
  await expect(page.getByTestId('legend')).toBeHidden();
});

test('a quick tap, pan or second finger cancels the pending legend', async ({ page }) => {
  const touch = await ready(page);
  const legend = page.getByTestId('legend');
  await touch.start();
  await touch.end();
  await page.waitForTimeout(550);
  await expect(legend).toBeHidden();
  const center = () => page.evaluate(() => (window as any).__typhoonLab.mapView.centerLonLat());
  const before = await center();
  await touch.start();
  await touch.move([{ x: touch.point.x + 35, y: touch.point.y }]);
  await page.waitForTimeout(550);
  await expect(legend).toBeHidden();
  await touch.end();
  expect(await center()).not.toEqual(before);
  await touch.start();
  await touch.pinch();
  await page.waitForTimeout(550);
  await expect(legend).toBeHidden();
  await touch.end();
});

test('an armed drop tool still places on release after a long touch', async ({ page }) => {
  const touch = await ready(page);
  await page.getByTestId('tool-moisture').tap();
  await touch.start();
  await page.waitForTimeout(550);
  await expect(page.getByTestId('legend')).toBeHidden();
  await touch.end();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
});

test('moving, cancellation and losing focus close a held legend', async ({ page }) => {
  const touch = await ready(page);
  const legend = page.getByTestId('legend');
  for (const interrupt of [
    () => touch.move([{ x: touch.point.x + 35, y: touch.point.y }]),
    touch.cancel,
    () => page.evaluate(() => window.dispatchEvent(new Event('blur'))),
  ]) {
    await touch.start();
    await expect(legend).toBeVisible();
    await interrupt();
    await expect(legend).toBeHidden();
    if (interrupt !== touch.cancel) await touch.end();
  }
});
