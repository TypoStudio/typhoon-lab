import { setSpeed } from './speed';
import { test, expect, type Page } from '@playwright/test';

async function expectedMetrics(page: Page) {
  return page.evaluate(async () => {
    const modulePath = '/src/simulation/engine.ts';
    const { totalPressure } = await import(modulePath);
    const state = (window as any).__typhoonLab.state;
    return state.storms.map((storm: any) => {
      return { id: storm.id, wind: `${storm.wind.toFixed(0)} m/s`,
        movement: `${storm.movementSpeedKmh.toFixed(1)} km/h`,
        pressure: `${totalPressure(state, storm.lon, storm.lat).toFixed(0)} hPa`,
        gale: `${storm.galeRadiusKm.toFixed(0)} km` };
    });
  });
}

async function verifyRows(page: Page, expected: Awaited<ReturnType<typeof expectedMetrics>>) {
  await expect(page.getByTestId('storm-row')).toHaveCount(expected.length);
  for (const storm of expected) {
    const row = page.locator(`[data-storm-id="${storm.id}"]`);
    await expect(row.getByTestId('storm-movement-speed')).toHaveText(storm.movement);
    await expect(row.getByTestId('storm-max-wind')).toHaveText(storm.wind);
    await expect(row.getByTestId('storm-central-pressure')).toHaveText(storm.pressure);
    await expect(row.getByTestId('storm-gale-radius')).toHaveText(storm.gale);
    await expect(row.getByTestId('storm-center-wind')).toHaveCount(0);
  }
}

test('each storm shows movement speed, maximum wind, centre pressure and radii in both languages', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const meta = await page.evaluate(() => {
    const { scenarioId, version, seed } = (window as any).__typhoonLab.state;
    return { scenarioId, version, seed };
  });
  await page.getByTestId('tab-replay').click();
  const replay = { ...meta, format: 'typhoon-lab-replay', formatVersion: 6, startDayOfYear: 213, untilTick: 128,
    actions: [
      { tick: 0, type: 'warm', lon: 140, lat: 16 }, { tick: 0, type: 'moisture', lon: 140, lat: 16 },
      { tick: 0, type: 'low', lon: 140, lat: 16 }, { tick: 0, type: 'low', lon: 141, lat: 16 },
    ] };
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'metrics.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText('틱 128');
  await page.getByTestId('tab-storms').click();
  const expected = await expectedMetrics(page);
  expect(expected).toHaveLength(2);
  await verifyRows(page, expected);
  await expect(page.getByTestId('storm-wind-note')).toContainText('이동 거리 기준입니다');
  const first = page.locator(`[data-storm-id="${expected[0].id}"]`);
  for (const label of ['최대 풍속', '중심 기압', '강풍 반경', '이동속도']) await expect(first).toContainText(label);
  await first.click();
  const detail = page.getByTestId('storm-detail');
  await expect(detail.locator('[data-metric="movementSpeed"]')).toHaveText(expected[0].movement);
  await expect(detail.locator('[data-metric="pressure"]')).toHaveText(expected[0].pressure);
  await expect(detail.locator('[data-metric="centerWind"]')).toHaveCount(0);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
    expect(await page.getByTestId('storm-row').evaluateAll(rows => rows.every(row => {
      const r = row.getBoundingClientRect();
      return row.scrollWidth <= row.clientWidth && r.left >= 0 && r.right <= innerWidth;
    }))).toBe(true);
  }
  await page.getByTestId('language-select').selectOption('en');
  for (const label of ['Max wind', 'Central pressure', 'Gale radius', 'Movement speed']) await expect(first).toContainText(label);
  await verifyRows(page, expected);
  // New worker states must refresh all metrics, not only the original maximum-wind field.
  await setSpeed(page, 14400);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.tick)).toBeGreaterThan(140);
  await page.getByTestId('play-toggle').click();
  await expect.poll(() => page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    return lab.renderedTick === lab.state.tick;
  })).toBe(true);
  const updated = await expectedMetrics(page);
  expect(updated).not.toEqual(expected);
  await verifyRows(page, updated);
});
