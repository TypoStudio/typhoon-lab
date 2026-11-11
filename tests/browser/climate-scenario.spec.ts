import { expect, test, type Page } from '@playwright/test';
import { timeSpeedLabel } from '../../src/time';
import { setSpeed } from './speed';

const LAB = '/?renderer=canvas&lang=en&help=0&seed=42&start=2026-08-01&map=flat';
const px = (page: Page, lon: number, lat: number) => page.evaluate(([x, y]) => (window as any).__typhoonLab.mapView.lonLatToPx(x, y) as [number, number], [lon, lat]);

test('a climate scenario loads from the panel, sets the date and year, and the Nino 3.4 chart draws the observed line', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(LAB);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');

  // Looking at a tile shows the description; only pressing it loads.
  await page.getByTestId('palette-tab-climate').click();
  await expect(page.locator('[data-experience^="scenario:"]')).toHaveCount(2);
  const nino = page.getByTestId('experience-scenario-nino-1997');
  await expect(nino).toContainText('westerly wind bursts');
  await nino.hover();
  await expect(page.locator('#tip')).toContainText('westerly wind bursts');
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.climateScenario)).toBeUndefined();
  await nino.click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.climateScenario?.year)).toBe(1997);
  await expect(page.getByTestId('clock')).toContainText('Jan 1, 1997');
  // (The "loaded" toast is replaced within a second: the weather now runs at 4h/s and its own news follows.)
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.climateLayer.core.script.length)).toBeGreaterThan(0);
  // Loading sets 4h/s and turns Natural typhoon formation on, so the weather runs and storms form on the changed climate.
  await expect(page.getByTestId('speed-value')).toHaveText(timeSpeedLabel(14_400));
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.genesis.enabled)).toBe(true);

  // The Nino 3.4 chart, then fast time.
  await page.getByTestId('palette-tab-measure').click();
  await page.keyboard.press('.');
  const [x, y] = await px(page, 110, 25);
  await page.mouse.click(x, y);
  const card = page.getByTestId('measure-card-measure-nino34');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('measure-observed')).toContainText('Observed');
  await setSpeed(page, 604_800);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.climateTime?.total ?? 0), { timeout: 60_000 }).toBeGreaterThan(150);
  await expect(page.getByTestId('clock')).toContainText('1997');
  await expect(card.getByTestId('measure-observed')).toContainText('°C');
  await expect(page.getByTestId('measure-plot-measure-nino34-0')).toHaveAttribute('aria-label', /Observed/);
  expect(errors).toEqual([]);
});

test('Reset climate switches a loaded scenario off at once: tile cleared, Nino 3.4 neutral, the button disables', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(LAB);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const get = (expr: string) => page.evaluate(`(() => { const s = window.__typhoonLab.state; return ${expr}; })()`);
  const reset = page.getByTestId('climate-reset');
  await expect(reset).toBeDisabled();
  await page.getByTestId('palette-tab-climate').click();
  const nino = page.getByTestId('experience-scenario-nino-1997');
  await nino.click();
  await expect.poll(() => get('s.climateScenario?.id')).toBe('nino-1997');
  await expect(nino).toHaveAttribute('aria-pressed', 'true');
  await expect(reset).toBeEnabled(); // every slider is 0, yet the climate is not normal
  await page.getByTestId('palette-tab-measure').click();
  await page.keyboard.press('.');
  const [x, y] = await px(page, 110, 25);
  await page.mouse.click(x, y);
  const card = page.getByTestId('measure-card-measure-nino34');
  await expect(card).toBeVisible();
  await reset.click();
  await expect.poll(() => get('s.climateScenario === undefined')).toBe(true);
  expect(await get('s.actions.at(-1).type')).toBe('climate-reset');
  expect(await get('s.climateLayer === null')).toBe(true);
  expect(await get('s.climate')).toEqual({ warming: 0, enso: 0, polar: 0 });
  await page.getByTestId('palette-tab-climate').click();
  await expect(nino).toHaveAttribute('aria-pressed', 'false');
  await expect(nino).not.toHaveClass(/is-live/);
  await page.getByTestId('palette-tab-measure').click();
  await expect(card).toContainText('No ENSO climate layer'); // neutral: nothing is simulated any more
  await expect(reset).toBeDisabled();
  expect(errors).toEqual([]);
});
