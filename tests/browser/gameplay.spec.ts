import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Keep polling small: the worker integration test compares the full weather grid separately.
const state = (page: Page) => page.evaluate(() => {
  const { grid: _grid, ...snapshot } = (window as any).__typhoonLab.state;
  return snapshot;
});
async function ready(page: Page, url = '/?map=flat') {
  const withSeed = url.includes('seed=') ? url : `${url}${url.includes('?') ? '&' : '?'}seed=20261022`;
  await page.goto(`${withSeed}&help=0&start=2026-08-01`);
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  // These multi-basin fixtures intentionally use the world overview; production startup is regional.
  await page.evaluate(() => {
    document.querySelector('[data-testid="map-stage"]')!.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
    const view = (window as any).__typhoonLab.mapView;
    view.zoomAt(1 / view.zoom, view.width / 2, view.height / 2);
    view.centerOn(150, 0);
  });
}
async function hideSidebar(page: Page) {
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
}
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

async function loadCycloneReplay(page: Page) {
  const replay = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const game = createGame();
    for (const type of ['warm', 'moisture', 'low']) placeTool(game, type, 140, 16);
    for (let i = 0; i < 600 && !game.storms.some((storm: any) => storm.wind >= 33); i++) stepGame(game);
    return buildReplay(game);
  });
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'cyclone.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(String(replay.untilTick));
  const snapshot = await state(page);
  expect(snapshot.storms.some((storm: any) => storm.wind >= 33)).toBe(true);
  expect(snapshot.actions).toEqual(replay.actions);
  expect(snapshot.tick).toBe(replay.untilTick);
  return snapshot;
}

async function expectOverlays(page: Page, enabled: string[]) {
  await expect.poll(async () => (await page.getByTestId('map-stage').getAttribute('data-overlays') ?? '').split(/\s+/).filter(Boolean)).toEqual(enabled);
  for (const id of ['wind', 'humidity', 'rain', 'pressure', 'temperature', 'population']) {
    await expect(page.getByTestId(`layer-${id}`)).toHaveAttribute('aria-pressed', String(enabled.includes(id)));
    if (id !== 'wind') await expect(page.getByTestId(`legend-${id}`)).toHaveCount(enabled.includes(id) ? 1 : 0);
  }
}

// Observe the render-boundary alpha without reading or capturing canvas pixels.
async function observeWindDraw(page: Page) {
  await page.evaluate(async () => {
    const kind = (window as any).__typhoonLab.renderer;
    const modulePath = kind === 'webgl' ? '/src/render/webgl.ts' : '/src/render/canvas2d.ts';
    // Reuse Vite's loaded URL, including its HMR timestamp, to patch the live module instance.
    const moduleUrl = performance.getEntriesByType('resource').map(entry => entry.name)
      .find(url => new URL(url).pathname === modulePath) ?? modulePath;
    const module = await import(moduleUrl);
    const prototype = (kind === 'webgl' ? module.ThreeBase : module.CanvasBase).prototype;
    const original = prototype.draw;
    prototype.draw = function (...args: any[]) {
      (window as any).__windDrawAlpha = args[2];
      (window as any).__windDrawHumidity = args[4];
      (window as any).__particleHumidity = Array.from(args[1].humidity.subarray(0, 8));
      return original.apply(this, args);
    };
  });
}

async function expectWindDraw(page: Page, visible: boolean) {
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-wind', visible ? 'visible' : 'hidden');
  await expect.poll(() => page.evaluate(() => (window as any).__windDrawAlpha)).toBe(visible ? 1 : 0);
}

async function expectHumidityDraw(page: Page, enabled: boolean) {
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-humidity', enabled ? 'wind' : 'off');
  await expect.poll(() => page.evaluate(() => (window as any).__windDrawHumidity)).toBe(enabled);
}

test('free drag-and-drop conditions create multiple storms in a live empty world', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  expect((await state(page)).storms).toHaveLength(0);
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(0);
  await hideSidebar(page);
  await page.getByTestId('play-toggle').click();
  for (const [lon, lat] of [[140, 16], [-55, 16]]) {
    for (const tool of ['warm', 'moisture', 'low']) await drop(page, tool, lon, lat);
  }
  await expect.poll(async () => (await state(page)).effects.length).toBe(6);
  expect((await state(page)).storms).toHaveLength(0);
  for (const overlay of ['pressure', 'temperature', 'population']) {
    const button = page.getByTestId(`layer-${overlay}`);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'false');
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
  }
  await page.getByTestId('speed-12').click();
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await state(page)).storms.length, { timeout: 25_000 }).toBeGreaterThanOrEqual(2);
  const young = (await state(page)).storms;
  await expect.poll(async () => (await state(page)).storms.some((s: any) => s.wind >= 33), { timeout: 25_000 }).toBe(true);
  const grown = (await state(page)).storms;
  expect(grown.some((s: any) => young.some((y: any) => s.id === y.id && s.galeRadiusKm > y.galeRadiusKm))).toBe(true);
  if (process.env.TYPHOON_SCREENSHOTS === '1') await page.screenshot({ path: 'test-results/multiple-storms.png', fullPage: true });
  await page.getByTestId('reset').click();
  await expect.poll(async () => (await state(page)).storms.length).toBe(0);
  expect((await state(page)).effects).toHaveLength(0);
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('panning freezes the rendered weather while the simulation clock keeps running', async ({ page }) => {
  await ready(page);
  await hideSidebar(page);
  const map = page.getByTestId('map-stage');
  await page.mouse.move(650, 430);
  await page.mouse.down();
  await page.mouse.move(690, 450, { steps: 5 });
  await expect(map).toHaveAttribute('data-interacting', 'true');
  const frozenTick = await map.getAttribute('data-rendered-tick');
  const runningTick = (await state(page)).tick;
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(runningTick + 2);
  expect(await map.getAttribute('data-rendered-tick')).toBe(frozenTick);
  await page.mouse.move(730, 470, { steps: 5 });
  expect(await map.getAttribute('data-rendered-tick')).toBe(frozenTick);
  await page.mouse.up();
  await expect(map).toHaveAttribute('data-interacting', 'false');
  await expect.poll(async () => Number(await map.getAttribute('data-rendered-tick'))).toBeGreaterThan(Number(frozenTick));
  expect((await state(page)).effects).toHaveLength(0);
});

test('snapshot export/import reproduces the moment and reset resumes live play', async ({ page }) => {
  await ready(page);
  await hideSidebar(page);
  await page.getByTestId('play-toggle').click();
  await drop(page, 'warm', 140, 16);
  await expect.poll(async () => (await state(page)).actions.length).toBe(1);
  const snapshot = await state(page);
  await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  const downloading = page.waitForEvent('download');
  await page.getByTestId('export-replay').click();
  const download = await downloading;
  const replay = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(replay.untilTick).toBe(snapshot.tick);
  expect(replay.actions).toHaveLength(1);
  expect(replay).not.toHaveProperty('budget');
  expect(replay.formatVersion).toBe(6);
  expect(replay.startDayOfYear).toBe(213);
  expect(replay).not.toHaveProperty('mode');
  expect(replay).not.toHaveProperty('typhoonId');
  // Change the world first so equality cannot pass before import has actually completed.
  await page.getByTestId('reset').click();
  await expect.poll(async () => (await state(page)).actions.length).toBe(0);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'replay.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect.poll(async () => (await state(page)).actions.length).toBe(1);
  await expect.poll(async () => (await state(page)).tick).toBe(snapshot.tick);
  expect(await state(page)).toEqual(snapshot);
  await page.getByTestId('reset').click();
  await expect.poll(async () => (await state(page)).actions.length).toBe(0);
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(0);
});

test('Canvas fallback supports the worldwide map and free tool drops', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: any[]): any {
      if (type.startsWith('webgl') || type === 'experimental-webgl') return null;
      return (original as any).apply(this, [type, ...args]);
    } as typeof original;
  });
  await ready(page);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-renderer', 'canvas');
  await observeWindDraw(page);
  await expectWindDraw(page, true);
  await expectHumidityDraw(page, true);
  await expect.poll(() => page.evaluate(() => (window as any).__particleHumidity?.some((value: number) => value > 0 && value <= 1))).toBe(true);
  await expect(page.getByTestId('legend-humidity').locator('[data-tip]')).toHaveAttribute('data-tip', 'Higher humidity makes wind streaks brighter.');
  await page.getByTestId('layer-humidity').click();
  await expectHumidityDraw(page, false);
  await expectWindDraw(page, true);
  await expect(page.getByTestId('legend-humidity')).toHaveCount(0);
  await page.getByTestId('layer-humidity').click();
  await expectHumidityDraw(page, true);
  await expect(page.getByTestId('layer-wind')).not.toHaveAttribute('role', 'tab');
  await expect(page.getByTestId('renderer-note')).toBeVisible();
  await hideSidebar(page);
  await drop(page, 'warm', -55, 16);
  await expect.poll(async () => (await state(page)).effects.length).toBe(1);
  const snapshot = await loadCycloneReplay(page);
  await page.getByTestId('layer-wind').click();
  await expectOverlays(page, ['humidity', 'rain', 'pressure', 'temperature', 'population']);
  await expectWindDraw(page, false);
  await expectHumidityDraw(page, true);
  await expect(page.getByTestId('legend-humidity').locator('[data-tip]')).toHaveAttribute('data-tip', 'Turn on Wind to see humidity colours.');
  await expect(page.getByTestId('legend-humidity').locator('.legend__bar')).toHaveCount(0);
  await expect(page.getByTestId('legend')).toContainText('Wind streaks are hidden.');
  expect(await state(page)).toEqual(snapshot);
  await page.getByTestId('layer-wind').click();
  await expectWindDraw(page, true);
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'temperature', 'population']);
  await page.getByTestId('layer-temperature').click();
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'population']);
  await page.getByTestId('layer-temperature').click();
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'temperature', 'population']);
  await expect(page.getByTestId('legend')).toContainText('Moving streaks show wind.');
  expect(await state(page)).toEqual(snapshot);
  await page.getByTestId('reset').click();
  await expect.poll(async () => (await state(page)).storms.length).toBe(0);
  if (process.env.TYPHOON_SCREENSHOTS === '1') await page.screenshot({ path: 'test-results/canvas-world.png', fullPage: true });
});

test('WebGL context loss recovers without resetting the world', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  test.skip(await page.getByTestId('map-stage').getAttribute('data-renderer') !== 'webgl', 'WebGL is unavailable.');
  const before = (await state(page)).tick;
  const supported = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.map-canvas--base')!;
    const extension = canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    (window as any).restoreTestContext = () => extension.restoreContext();
    extension.loseContext();
    return true;
  });
  test.skip(!supported, 'Context-loss extension is unavailable.');
  await expect(page.getByTestId('renderer-note')).toContainText('context lost');
  await page.evaluate(() => (window as any).restoreTestContext());
  await expect.poll(async () => page.evaluate(() => document.querySelector<HTMLCanvasElement>('.map-canvas--base')!.getContext('webgl2')!.isContextLost())).toBe(false);
  await expect.poll(async () => (await page.getByTestId('renderer-note').isVisible()) && (await page.getByTestId('renderer-note').innerText()).includes('context lost')).toBe(false);
  await expect.poll(async () => (await state(page)).tick).toBeGreaterThan(before);
  expect(errors).toEqual([]);
});

test('touch dragging places a condition and cancelled dragging does not', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 414, height: 896 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await ready(page);
    await hideSidebar(page);
    const cdp = await context.newCDPSession(page);
    const button = (await page.getByTestId('tool-warm').boundingBox())!;
    // Use the actual camera conversion: portrait layout may use a different initial fit.
    const destination = await point(page, 140, 16);
    // Touch icons are lifted 44 px; the preview and placement use that visible centre.
    const finger = { x: destination.x, y: destination.y + 44 };
    const start = { x: button.x + button.width / 2, y: button.y + button.height / 2 };
    const send = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: x === undefined ? [] : [{ x, y, id: 1 }],
    } as any);
    await send('touchStart', start.x, start.y);
    for (let i = 1; i <= 10; i++) await send('touchMove', start.x + (finger.x - start.x) * i / 10, start.y + (finger.y - start.y) * i / 10);
    const ghost = (await page.locator('.drag-ghost').boundingBox())!;
    expect(ghost.x + ghost.width / 2).toBeCloseTo(destination.x, 0);
    expect(ghost.y + ghost.height / 2).toBeCloseTo(destination.y, 0);
    await send('touchEnd');
    await expect.poll(async () => (await state(page)).effects.length).toBe(1);
    expect((await state(page)).effects[0]).toMatchObject({ lon: 140, lat: 16 });
    await send('touchStart', start.x, start.y);
    await send('touchMove', finger.x, finger.y);
    await send('touchCancel');
    expect((await state(page)).effects).toHaveLength(1);
    await expect(page.getByTestId('map-stage')).toHaveAttribute('data-interacting', 'false');
  } finally { await context.close(); }
});

test('wheel zoom freezes animation briefly and resumes without placing tools', async ({ page }) => {
  await ready(page);
  await hideSidebar(page);
  const before = await page.evaluate(() => (window as any).__typhoonLab.mapView.scale);
  const interacting = await page.locator('.map-canvas--overlay').evaluate(canvas => {
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -150, clientX: 640, clientY: 440, bubbles: true, cancelable: true }));
    return canvas.closest('[data-testid="map-stage"]')!.getAttribute('data-interacting');
  });
  expect(interacting).toBe('true');
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-interacting', 'false');
  expect(await page.evaluate(() => (window as any).__typhoonLab.mapView.scale)).toBeGreaterThan(before);
  expect((await state(page)).effects).toHaveLength(0);
});

test('same-tick replays with different tool positions refresh the visible weather field', async ({ page }) => {
  await ready(page);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  const initial = await state(page);
  const makeReplay = (lon: number) => ({ format: 'typhoon-lab-replay', formatVersion: 6, startDayOfYear: 213, scenarioId: initial.scenarioId, version: initial.version, seed: initial.seed, untilTick: 24, actions: [{ tick: 0, type: 'low', lon, lat: 16 }] });
  const load = async (lon: number) => {
    await page.getByTestId('import-replay-input').setInputFiles({ name: 'snapshot.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeReplay(lon))) });
    await expect.poll(async () => (await state(page)).actions[0]?.lon).toBe(lon);
    await expect(page.getByTestId('replay-message')).toContainText(/loaded/i);
    await expect.poll(async () => page.getByTestId('map-stage').getAttribute('data-rendered-tick')).toBe('24');
  };
  const p = await point(page, 140, 16);
  await load(140);
  await page.mouse.move(p.x - 2, p.y);
  await page.mouse.move(p.x, p.y);
  await expect(page.getByTestId('coords')).toContainText('140');
  await expect(page.getByTestId('legend-wind')).toContainText('Wind');
  const localLow = await page.getByTestId('legend-wind').innerText();
  await load(-55);
  await page.mouse.move(p.x - 2, p.y);
  await page.mouse.move(p.x, p.y);
  await expect(page.getByTestId('legend-wind')).not.toHaveText(localLow);
});

test('keyboard placement works and map clicks reject warm water on land', async ({ page }) => {
  await ready(page);
  await hideSidebar(page);
  await page.getByTestId('play-toggle').click();
  await page.getByTestId('tool-warm').click();
  const land = await point(page, 139.7, 35.7);
  await page.mouse.click(land.x, land.y);
  await expect(page.getByTestId('status')).toContainText(/ocean/i);
  expect((await state(page)).effects).toHaveLength(0);
  // A keyboard target starts at the map centre (150 E, 0 N). Move north to tropical ocean.
  await page.getByTestId('map-stage').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Shift+ArrowUp');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await state(page)).effects.length).toBe(1);
  expect((await state(page)).effects[0].lat).toBe(15);
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', 'Pause');
  await page.keyboard.press('Space');
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', 'Play');
});

test('shortcuts work with focus in the sidebar, except Space on a focused control', async ({ page }) => {
  await ready(page);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const playing = () => page.evaluate(() => (window as any).__typhoonLab.playing as boolean);
  const armed = (tool: string) => page.getByTestId(`tool-${tool}`).getAttribute('aria-pressed');
  await page.getByTestId('tab-environment').focus();
  await page.keyboard.press('4');
  expect(await armed('low-shear')).toBe('true');
  // Space on a focused tab presses that tab; it does not play or pause.
  await page.getByTestId('tab-storms').focus();
  const before = await playing();
  await page.keyboard.press('Space');
  expect(await playing()).toBe(before);
  await page.getByTestId('tab-environment').focus();
  await page.keyboard.press('Space');
  await expect(page.getByTestId('tab-environment')).toHaveAttribute('aria-selected', 'true');
  expect(await playing()).toBe(before);
  // Space on a non-control element inside the sidebar plays or pauses.
  await page.locator('#panel-environment').focus();
  await page.keyboard.press('Space');
  expect(await playing()).toBe(!before);
  await page.keyboard.press('Space');
  expect(await playing()).toBe(before);
  await page.keyboard.press('Escape');
  expect(await armed('low-shear')).toBe('false');
  // Typing in a field keeps the shortcuts out of the way.
  await page.getByTestId('language-select').focus();
  await page.keyboard.press('3');
  expect(await armed('low')).toBe('false');
  // Arrow keys on a tablist still rove between tabs instead of panning.
  await page.getByTestId('tab-environment').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('tab-news')).toBeFocused();
  // Shift + zooms from the sidebar.
  const zoom = () => page.evaluate(() => (window as any).__typhoonLab.mapView.zoom as number);
  const z0 = await zoom();
  await page.keyboard.press('Shift+Equal');
  expect(await zoom()).toBeGreaterThan(z0);
});

test('World climate Reset is disabled at 0, returns every slider to 0 and clears the HUD line', async ({ page }) => {
  await ready(page);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const reset = page.getByTestId('climate-reset');
  await expect(reset).toBeDisabled();
  await expect(reset).toHaveText('Reset');
  expect((await reset.boundingBox())!.height).toBeCloseTo(24, 0);
  await page.getByTestId('climate-warming').fill('2');
  await page.getByTestId('climate-polar').fill('-1.5');
  await expect(reset).toBeEnabled();
  await expect(page.getByTestId('climate-hud')).toBeVisible();
  await reset.click();
  for (const key of ['warming', 'enso', 'polar']) await expect(page.getByTestId(`climate-${key}`)).toHaveValue('0');
  await expect(page.getByTestId('climate-warming-value')).toHaveText('0 °C');
  await expect(page.getByTestId('climate-hud')).toBeHidden();
  await expect(reset).toBeDisabled();
  expect((await state(page)).climate).toEqual({ warming: 0, enso: 0, polar: 0 });
});

test('Season icons show the calendar season, move the calendar and keep the world running', async ({ page }) => {
  await ready(page);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const checked = async () => (await Promise.all(['spring', 'summer', 'autumn', 'winter'].map(async id => [id, await page.getByTestId(`season-${id}`).getAttribute('aria-checked')]))).filter(([, v]) => v === 'true').map(([id]) => id);
  expect(await checked()).toEqual(['summer']); // ?start=2026-08-01
  await expect(page.getByTestId('clock')).toContainText('Aug 1');
  await expect(page.getByTestId('season-winter')).toHaveAttribute('aria-label', 'Winter');
  await page.getByTestId('season-winter').click();
  await expect(page.getByTestId('season-winter')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('season-summer')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByTestId('clock')).toContainText('Jan 15');
  const snap = await state(page);
  expect(snap.actions.filter((a: any) => a.type === 'season')).toEqual([expect.objectContaining({ dayOfYear: 15 })]);
});

test('combined overlays independently toggle wind and preserve replay state across Korean switching', async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await ready(page, '/?map=flat&lang=en');
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-renderer', 'webgl');
  await observeWindDraw(page);
  await expectWindDraw(page, true);
  await expectHumidityDraw(page, true);
  await expect(page.getByTestId('layer-wind')).not.toHaveAttribute('role', 'tab');
  await expect(page.locator('[data-overlay]')).toHaveCount(6);
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'temperature', 'population']);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const replay = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts';
    const storagePath = '/src/ui/storage.ts';
    const { createGame, placeTool, stepGame } = await import(enginePath);
    const { buildReplay } = await import(storagePath);
    const game = createGame();
    for (const type of ['warm-air', 'moisture', 'updraft']) placeTool(game, type, 140, 16);
    for (let i = 0; i < 96 && game.thunderstorms.length === 0; i++) stepGame(game);
    return buildReplay(game);
  });
  await page.getByTestId('tab-replay').click();
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'thunderstorms.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toContainText(`tick ${replay.untilTick}`);
  const snapshot = await state(page);
  expect(snapshot.thunderstorms.length).toBeGreaterThan(0);
  expect(snapshot.storms).toHaveLength(0);
  await page.getByTestId('tab-storms').click();
  await expect(page.locator('[data-ref="stormSummary"]')).toContainText(`Thunderstorms: ${snapshot.thunderstorms.length}`);
  await expect(page.locator('[data-ref="stormSummary"]')).not.toContainText('The world is calm.');
  await expect(page.locator('[data-ref="stormCount"]')).toHaveText(String(snapshot.storms.length + snapshot.thunderstorms.length));
  await page.getByTestId('layer-pressure').press('Space');
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'temperature', 'population']);
  await page.getByTestId('layer-temperature').press('Enter');
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'population']);
  await page.getByTestId('layer-population').click();
  await expectOverlays(page, ['wind', 'humidity', 'rain']);
  await expect(page.getByTestId('legend')).toContainText('Moving streaks show wind.');
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.getByTestId('layer-wind')).toHaveAccessibleName('바람');
  await expect(page.getByTestId('legend')).toContainText('흐름선은 바람을 나타냅니다.');
  await expect(page.locator('[data-ref="stormSummary"]')).toContainText('뇌우');
  expect(await state(page)).toEqual(snapshot);
  await page.getByTestId('help-open').click();
  await expect(page.getByTestId('help-dialog')).toContainText('뇌우');
  await page.getByTestId('help-close').click();
  const cyclone = await loadCycloneReplay(page);
  await page.getByTestId('layer-wind').press('Space');
  await expectOverlays(page, ['humidity', 'rain']);
  await expectWindDraw(page, false);
  await expect(page.getByTestId('legend')).toContainText('바람 흐름선은 숨겨져 있습니다.');
  await page.getByTestId('legend-humidity').locator('.legend__info').hover();
  await expect(page.locator('#tip')).toContainText('습도 색상을 보려면 바람을 켜십시오.');
  await page.getByTestId('layer-humidity').press('Space');
  await expectHumidityDraw(page, false);
  await expectWindDraw(page, false);
  await page.getByTestId('layer-humidity').press('Enter');
  await expectHumidityDraw(page, true);
  await expectWindDraw(page, false);
  expect(await state(page)).toEqual(cyclone);
  await page.getByTestId('layer-wind').press('Enter');
  await expectWindDraw(page, true);
  await page.getByTestId('legend-humidity').locator('.legend__info').hover();
  await expect(page.locator('#tip')).toContainText('습도가 높을수록 바람 흐름선이 밝아집니다.');
  await expect(page.getByTestId('legend-humidity').locator('.legend__ticks')).toHaveText('050100');
  const humidity = await page.evaluate(() => (window as any).__particleHumidity as number[]);
  expect(humidity).toHaveLength(8);
  expect(humidity.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
  await expectOverlays(page, ['wind', 'humidity', 'rain']);
  for (const overlay of ['pressure', 'temperature', 'population']) {
    await page.getByTestId(`layer-${overlay}`).click();
  }
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'temperature', 'population']);
  await page.getByTestId('layer-temperature').click();
  await expectOverlays(page, ['wind', 'humidity', 'rain', 'pressure', 'population']);
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('legend')).toContainText('Moving streaks show wind.');
  const ocean = await point(page, 140, 16);
  await page.mouse.move(ocean.x, ocean.y);
  await expect(page.getByTestId('coords').locator('[data-terrain]')).toHaveAttribute('data-terrain', 'sea');
  await expect(page.getByTestId('coords').locator('[data-terrain]')).toHaveAttribute('aria-label', 'Sea');
  await expect(page.getByTestId('legend-wind')).toContainText(/Wind \d+ m\/s.*(Up|Down)draft \d+\.\d m\/s/);
  await expect(page.getByTestId('legend-pressure')).toContainText(/\d{3,4} hPa/);
  await expect(page.getByTestId('legend-humidity')).toContainText(/\d+%/);
  await expect(page.getByTestId('legend-rain')).toContainText('mm/h');
  await expect(page.getByTestId('legend-population').locator('.legend__value')).toHaveText(/^\d+(\.\d)?[kM]?$/);
  await expect(page.getByTestId('legend-pressure').locator('.legend__tick')).toBeVisible();
  await expect(page.getByTestId('legend-pressure')).toContainText(/\d{3,4} hPa/);
  await page.getByTestId('layer-population').click();
  await expect(page.getByTestId('legend-population')).toHaveCount(0);
  await page.getByTestId('layer-temperature').click();
  await expect(page.getByTestId('legend-temperature')).toContainText(/\d+\.\d \/ \d+\.\d °C/);
  await page.getByTestId('layer-population').click();
  expect(await state(page)).toEqual(cyclone);
  await page.getByTestId('layer-wind').click();
  await expectWindDraw(page, false);
  await page.getByTestId('reset').click();
  await expect.poll(async () => (await state(page)).storms.length).toBe(0);
  await expectOverlays(page, ['humidity', 'rain', 'pressure', 'temperature', 'population']);
  await expectWindDraw(page, false);
  expect(errors).toEqual([]);
});
