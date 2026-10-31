import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { byteRange, findRecord, parseIdx } from '@azohra/meteo.grib';

const pattern = 'https://storage.googleapis.com/download/storage/v1/b/global-forecast-system/o/**';
const index = readFileSync(new URL('../fixtures/gfs/20261027-00.idx', import.meta.url), 'utf8');
const records = parseIdx(index);
const fields = [
  ['pressure', 'PRMSL', 'mean sea level'], ['u', 'UGRD', '10 m above ground'], ['v', 'VGRD', '10 m above ground'],
  ['seaTemperature', 'TMP', 'surface'], ['airTemperature', 'TMP', '2 m above ground'],
  ['land', 'LAND', 'surface'], ['ice', 'ICEC', 'surface'],
] as const;

test('starts with GFS pressure/wind and reuses the saved analysis on re-entry', async ({ page, context }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let downloads = 0;
  await context.route(pattern, async route => {
    downloads++;
    const request = route.request(), path = decodeURIComponent(request.url());
    const run = path.match(/gfs\.(\d{4})(\d{2})(\d{2})\/(\d{2})\/atmos/)!;
    const range = request.headers()['range'];
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/octet-stream' };
    if (!range) return route.fulfill({ status: 200, headers, body: index });
    const field = fields.find(([, variable, level]) => byteRange(findRecord(records, variable, level, 'anl')) === range)!;
    const bytes = readFileSync(new URL(`../fixtures/gfs/${field[0]}.grib2`, import.meta.url));
    // Keep the real analysis values but pin section 1 to the requested cycle so this test is timeless.
    bytes.writeUInt16BE(Number(run[1]), 28);
    bytes[30] = Number(run[2]); bytes[31] = Number(run[3]); bytes[32] = Number(run[4]);
    await route.fulfill({ status: 206, headers, body: bytes });
  });
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const weather = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { source: s.weatherSource, pressure: s.initialWeather?.pressure, gridPressure: s.grid.map((c: any) => c.pressure),
      seaTemperature: s.initialWeather?.seaTemperature, airTemperature: s.initialWeather?.airTemperature,
      gridAir: s.grid.map((c: any) => c.airTemperature) };
  });
  expect(weather.source).toBe('live');
  expect(weather.pressure).toEqual(weather.gridPressure);
  expect(Math.min(...weather.pressure)).toBe(946.9);
  expect(weather.seaTemperature).toHaveLength(16200);
  expect(weather.airTemperature).toEqual(weather.gridAir);
  await expect(page.getByTestId('historic-hud')).toBeHidden();
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tab-data').click();
  await expect(page.getByTestId('help-weather-data')).toContainText('시작 기상 자료 · NOAA GFS');
  expect(downloads).toBe(8);
  await page.reload();
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tab-data').click();
  await expect(page.getByTestId('help-weather-data')).toContainText('저장된 분석 자료');
  expect(downloads).toBe(8);
  expect(errors).toEqual([]);
});

test('network failure still starts a playable world with an accurate fallback label', async ({ page, context }) => {
  await context.route(pattern, route => route.abort('failed'));
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('historic-hud')).toBeHidden();
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tab-data').click();
  await expect(page.getByTestId('help-weather-data')).toContainText('실시간 자료 연결 실패');
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.initialWeather)).toBeUndefined();
});

test('date-pinned scenarios keep their reproducible base weather', async ({ page, context }) => {
  let requests = 0;
  await context.route(pattern, route => { requests++; return route.abort('failed'); });
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.initialWeather)).toBeUndefined();
  expect(requests).toBe(0);
});
