import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/?renderer=canvas&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
}

async function beginDrag(page: Page, tool = 'warm') {
  const button = page.getByTestId(`tool-${tool}`);
  await button.evaluate(el => el.addEventListener('pointerdown', ev => {
    (window as any).__palettePointer = (ev as PointerEvent).pointerId;
  }, { once: true }));
  const rect = (await button.boundingBox())!;
  const destination = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination[0], destination[1], { steps: 3 });
  await expect(page.locator('.drag-ghost')).toHaveCount(1);
  return destination as number[];
}

async function noDrag(page: Page) {
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await expect(page.locator('.tool.is-dragging')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveClass(/is-tool-dragging/);
}

test('drop removes the floating icon and the placed condition moves with the map', async ({ page }) => {
  await ready(page);
  await beginDrag(page);
  await page.mouse.up();
  await noDrag(page);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  const before = await page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    const effect = lab.state.effects[0];
    return { effect, px: lab.mapView.lonLatToPx(effect.lon, effect.lat) };
  });
  await page.mouse.move(600, 400);
  await page.mouse.down();
  await page.mouse.move(720, 400, { steps: 3 });
  await page.mouse.up();
  const after = await page.evaluate(() => {
    const lab = (window as any).__typhoonLab;
    const effect = lab.state.effects[0];
    return { effect, px: lab.mapView.lonLatToPx(effect.lon, effect.lat) };
  });
  expect(after.effect).toEqual(before.effect);
  expect(after.px[0] - before.px[0]).toBeCloseTo(120, 5);
  expect(after.px[1]).toBeCloseTo(before.px[1], 5);
  await noDrag(page);
});

test('a plain sea-temperature drag is warm; clicking twice selects cool for the next drag', async ({ page }) => {
  await ready(page);
  await beginDrag(page, 'warm');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects[0].type)).toBe('warm');

  const button = page.getByTestId('tool-warm');
  await button.click();
  await expect(button).toHaveAttribute('data-variant', 'warm');
  await button.click();
  await expect(button).toHaveAttribute('data-variant', 'cool');
  await beginDrag(page, 'warm');
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects[1].type)).toBe('cool');
});

test('interrupted drags clean up and cannot leave multiple floating icons', async ({ page }) => {
  test.setTimeout(60_000);
  await ready(page);
  for (const interruption of ['blur', 'escape', 'released-outside', 'cancel']) {
    await beginDrag(page, 'moisture');
    if (interruption === 'cancel') {
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: (window as any).__palettePointer })));
    } else if (interruption === 'blur') {
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    } else if (interruption === 'escape') {
      await page.keyboard.press('Escape');
    } else {
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointermove', {
        pointerId: (window as any).__palettePointer, pointerType: 'mouse', buttons: 0,
      })));
    }
    await noDrag(page);
    await page.mouse.up();
    expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(0);
  }
  // Releasing outside the captured element must still finish exactly one drop.
  const [clientX, clientY] = await beginDrag(page, 'low');
  await page.evaluate(({ clientX, clientY }) => window.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: (window as any).__palettePointer, pointerType: 'mouse', clientX, clientY,
  })), { clientX, clientY });
  await noDrag(page);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
});

test('a fast release still drops when the browser delivers no intermediate move', async ({ page }) => {
  await ready(page);
  const button = page.getByTestId('tool-moisture');
  const destination = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
  await button.evaluate((el, [x, y]) => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 71, pointerType: 'mouse', button: 0, buttons: 1,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 71, pointerType: 'mouse', button: 0, buttons: 0, clientX: x, clientY: y }));
  }, destination);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  await noDrag(page);
});

test('losing pointer capture does not discard a drop that still finishes inside the window', async ({ page }) => {
  await ready(page);
  const [x, y] = await beginDrag(page, 'moisture');
  await page.getByTestId('tool-moisture').evaluate(el => el.releasePointerCapture((window as any).__palettePointer));
  await page.mouse.move(x + 3, y);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  await noDrag(page);
});

test('rapid repeated drops place each tool once without arming buttons or moving the camera', async ({ page }) => {
  await ready(page);
  const initial = await page.evaluate(() => {
    const v = (window as any).__typhoonLab.mapView;
    return { cx: v.cx, cy: v.cy, scale: v.scale };
  });
  const destination = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
  const tools = ['warm', 'moisture', 'low', 'low-shear'];
  for (let n = 0; n < 16; n++) {
    const button = page.getByTestId(`tool-${tools[n % 4]}`);
    const r = (await button.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination[0], destination[1]);
    await page.mouse.up();
  }
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.actions.length)).toBe(16);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.actions.map((a: any) => a.type)))
    .toEqual(Array.from({ length: 16 }, (_, i) => tools[i % 4]));
  for (const type of tools) await expect(page.getByTestId(`tool-${type}`)).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => {
    const v = (window as any).__typhoonLab.mapView;
    return { cx: v.cx, cy: v.cy, scale: v.scale };
  })).toEqual(initial);
  await noDrag(page);
});

test('secondary pointers cannot steal a drag and a delayed click cannot arm another tool', async ({ page }) => {
  await ready(page);
  await beginDrag(page, 'moisture');
  await page.getByTestId('tool-low').dispatchEvent('pointerdown', {
    pointerId: 88, pointerType: 'touch', clientX: 700, clientY: 800, buttons: 1,
  });
  await page.getByTestId('tool-low').dispatchEvent('pointerup', { pointerId: 88, pointerType: 'touch' });
  await page.getByTestId('tool-low').dispatchEvent('click', { detail: 1 });
  await expect(page.getByTestId('tool-low')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.drag-ghost--moisture')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects[0].type)).toBe('moisture');
  await noDrag(page);
  // Start a synthetic fast drag with no automatic click; dispatch its delayed compatibility click.
  const destination = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
  await page.getByTestId('tool-moisture').evaluate((el, [x, y]) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 77, pointerType: 'pen', buttons: 1, clientX: r.x, clientY: r.y }));
    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 77, pointerType: 'pen', clientX: x, clientY: y }));
  }, destination);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  await page.getByTestId('tool-low').dispatchEvent('click', { detail: 1 });
  await expect(page.getByTestId('tool-low')).toHaveAttribute('aria-pressed', 'false');
  // A fresh intentional click and keyboard activation still work.
  await page.getByTestId('tool-low').click();
  await expect(page.getByTestId('tool-low')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('tool-low').press('Enter');
  await expect(page.getByTestId('tool-low')).toHaveAttribute('data-variant', 'high');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('tool-low')).toHaveAttribute('aria-pressed', 'false');
});


test('condition range follows armed hover and reveals placed effects only near their icons', async ({ page }) => {
  await page.addInitScript(() => {
    const proto = CanvasRenderingContext2D.prototype;
    const clear = proto.clearRect, ellipse = proto.ellipse;
    proto.clearRect = function(...args) {
      if (this.canvas.classList.contains('map-canvas--overlay')) (window as any).__rangeCalls = [];
      return clear.apply(this, args);
    };
    proto.ellipse = function(...args) {
      if (this.canvas.classList.contains('map-canvas--overlay') && args[2] > 20 && args[3] > 20) {
        ((window as any).__rangeCalls ??= []).push(args.slice(0, 4));
      }
      return ellipse.apply(this, args);
    };
  });
  await ready(page);
  const point = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
  const ranges = () => page.evaluate(() => (window as any).__rangeCalls as number[][]);
  await page.getByTestId('tool-warm').click();
  await page.mouse.move(point[0], point[1]);
  await expect.poll(async () => (await ranges()).some(r => Math.abs(r[0] - point[0]) < 1 && Math.abs(r[1] - point[1]) < 1)).toBe(true);
  await page.mouse.move(point[0] - 50, point[1] - 50);
  await expect.poll(async () => (await ranges()).some(r => Math.abs(r[0] - point[0] + 50) < 1)).toBe(true);
  await page.mouse.click(point[0], point[1]);
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(1);
  await page.keyboard.press('Escape');
  await page.mouse.move(point[0] + 100, point[1] + 100);
  await expect.poll(async () => (await ranges()).length).toBe(0);
  await page.mouse.move(point[0], point[1]);
  await expect.poll(async () => (await ranges()).length).toBeGreaterThan(0);
  await page.mouse.move(2, 2);
  await expect.poll(async () => (await ranges()).length).toBe(0);
  await beginDrag(page, 'moisture');
  await expect.poll(async () => (await ranges()).length).toBeGreaterThan(0);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await noDrag(page);
  await expect.poll(async () => (await ranges()).length).toBe(0);
});

test('seven paired buttons cycle warm/cool and the other opposites by key', async ({ page }) => {
  await ready(page);
  const pairs = [['warm', 'cool'], ['moisture', 'dry'], ['low', 'high'], ['low-shear', 'high-shear'], ['warm-air', 'cold-air'], ['updraft', 'downdraft'], ['unstable-air', 'stable-air']];
  await expect(page.locator('[data-palette-panel="conditions"] [data-tool]')).toHaveCount(7);
  await expect(page.locator('[data-testid^="conditions-"]')).toHaveCount(0);
  await expect(page.getByTestId('weather-palette')).toContainText('Drag onto the map');
  await expect(page.locator('#map-help')).toContainText('Keys Q to U cycle paired conditions');
  for (const [index, [first, second]] of pairs.entries()) {
    const key = 'qwertyu'[index];
    const button = page.getByTestId(`tool-${first}`);
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-keyshortcuts', key.toUpperCase());
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(button).toHaveAttribute('data-variant', first);
    await page.keyboard.press(key);
    await expect(button).toHaveAttribute('data-variant', second);
    await page.keyboard.press('Escape');
    await expect(button).toHaveAttribute('aria-pressed', 'false');
  }
});

test.describe('phone palette', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('a swipe along the row scrolls it; a vertical drag from a cell places the tool on the map', async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto('/?renderer=canvas&help=0&start=2026-08-01&map=flat&seed=20261022');
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    const row = page.locator('[data-palette-panel="conditions"]');
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const effects = () => page.evaluate(() => (window as any).__typhoonLab.state.effects.length);
    // Cells are about 3.25rem wide in one row; the keys and testids are unchanged.
    const warm = (await page.getByTestId('tool-warm').boundingBox())!;
    expect(warm.width).toBeGreaterThanOrEqual(44);
    expect(warm.width).toBeLessThanOrEqual(56);
    const start = { x: warm.x + warm.width / 2, y: warm.y + warm.height / 2 };

    // Sideways: the row scrolls and no ghost icon or effect appears.
    const before = await row.evaluate(el => el.scrollLeft);
    await touch('touchStart', start.x + 120, start.y);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', start.x + 120 - i * 14, start.y); await page.waitForTimeout(20); }
    await expect(page.locator('.drag-ghost')).toHaveCount(0);
    await touch('touchEnd');
    await expect.poll(() => row.evaluate(el => el.scrollLeft)).toBeGreaterThan(before);
    expect(await effects()).toBe(0);
    await row.evaluate(el => { el.scrollLeft = 0; });

    // Up onto the sea: the drop point is raised 44px above the finger on touch.
    const box = (await page.getByTestId('map-stage').boundingBox())!;
    const sea = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
    const end = { x: box.x + sea[0], y: box.y + sea[1] + 44 };
    await touch('touchStart', start.x, start.y);
    for (let i = 1; i <= 12; i++) { await touch('touchMove', start.x + (end.x - start.x) * i / 12, start.y + (end.y - start.y) * i / 12); await page.waitForTimeout(20); }
    await expect(page.locator('.drag-ghost')).toHaveCount(1);
    await touch('touchEnd');
    await expect.poll(effects).toBe(1);
    expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects[0].type)).toBe('warm');
    await cdp.detach();
  });
});
