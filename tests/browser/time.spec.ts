import { expect, test } from '@playwright/test';

test('wind uses camera scale regardless of time speed and freezes while paused', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/render/particles.ts')?.name;
    if (!path) throw new Error('Particle module was not loaded');
    const { ParticleSystem } = await import(path);
    const update = ParticleSystem.prototype.update;
    ParticleSystem.prototype.update = function (...args: any[]) {
      update.apply(this, args);
      (window as any).__windFrame = { scale: args[3], paused: this.paused,
        lon: this.lon[0], lat: this.lat[0], age: this.age[0] };
    };
  });
  const wind = () => page.evaluate(() => (window as any).__windFrame);
  const cameraScale = () => page.evaluate(() => (window as any).__typhoonLab.mapView.scale);
  await expect.poll(async () => (await wind())?.scale).toBe(await cameraScale());
  await page.getByTestId('speed-next').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(600);
  expect((await wind()).scale).toBe(await cameraScale());
  await page.getByTestId('speed-next').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(1_200);
  expect((await wind()).scale).toBe(await cameraScale());
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await wind()).paused).toBe(true);
  const before = await wind();
  await page.waitForTimeout(300);
  expect(await wind()).toEqual(before);
  await page.getByTestId('speed-reset').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(1);
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await wind()).paused).toBe(false);
  expect(errors).toEqual([]);
});

test('the clock starts locally and SVG arrows cycle through speeds', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?renderer=canvas&lang=ko&help=0');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const start = await page.evaluate(() => ({
    current: new Date(),
    world: (window as any).__typhoonLab.state.startDayOfYear,
    clock: document.querySelector<HTMLElement>('[data-testid="clock"]')!.dataset.short!,
  }));
  const now = new Date(start.current);
  const monthLengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const today = monthLengths.slice(0, now.getMonth()).reduce((a, b) => a + b, 0) + Math.min(now.getDate(), monthLengths[now.getMonth()]);
  expect(Math.floor(start.world)).toBe(today);
  const startSeconds = (start.world % 1) * 86400;
  const currentSeconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  expect(Math.abs(startSeconds - currentSeconds)).toBeLessThan(30);
  await expect.poll(() => page.getByTestId('clock').getAttribute('data-short')).not.toBe(start.clock);
  await expect(page.getByTestId('speed-prev').locator('svg')).toHaveCount(1);
  await expect(page.getByTestId('speed-next').locator('svg')).toHaveCount(1);
  await expect(page.getByTestId('speed-prev')).toHaveText('');
  await expect(page.getByTestId('speed-next')).toHaveText('');
  await expect(page.getByTestId('speed-prev')).toBeEnabled();
  await expect(page.getByTestId('speed-value')).toHaveText('x1');
  expect(await page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(1);
  await page.getByTestId('speed-next').click();
  await expect(page.getByTestId('speed-value')).toHaveText('x4');
  expect(await page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(600);
  await page.getByTestId('speed-next').click();
  await expect(page.getByTestId('speed-value')).toHaveText('x8');
  expect(await page.evaluate(() => (window as any).__typhoonLab.speed)).toBe(1200);
  await expect(page.getByTestId('speed-next')).toBeEnabled();
  await page.getByTestId('speed-prev').click();
  await expect(page.getByTestId('speed-value')).toHaveText('x4');
  await page.getByTestId('speed-prev').click();
  await expect(page.getByTestId('speed-value')).toHaveText('x1');
});

test('speed reset returns to x1 without restarting or unpausing the world', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=17&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const reset = page.getByTestId('speed-reset');
  await expect(reset).toHaveAccessibleName('속도 초기화');
  await expect(reset).toBeDisabled();
  await page.getByTestId('speed-next').click();
  await page.getByTestId('speed-next').click();
  await expect(page.getByTestId('speed-value')).toHaveText('x8');
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.tick)).toBeGreaterThan(0);
  const before = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { seed: s.seed, tick: s.tick, start: s.initialStartDayOfYear, actions: s.actions };
  });
  await page.getByTestId('play-toggle').click();
  await reset.click();
  await expect(page.getByTestId('speed-value')).toHaveText('x1');
  await expect(reset).toBeDisabled();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  const after = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { seed: s.seed, tick: s.tick, start: s.initialStartDayOfYear, actions: s.actions };
  });
  expect(after.seed).toBe(before.seed);
  expect(after.tick).toBeGreaterThanOrEqual(before.tick);
  expect(after.start).toBe(before.start);
  expect(after.actions).toEqual(before.actions);
});
