import { expect, test } from '@playwright/test';
import { TIME_SPEEDS } from '../../src/time';

test('wind animation caps at the third time-speed step and keeps moving when model time is paused', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => {
    const path = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === '/src/render/particles.ts')?.name;
    if (!path) throw new Error('Particle module was not loaded');
    const { ParticleSystem } = await import(path);
    const update = ParticleSystem.prototype.update;
    ParticleSystem.prototype.update = function (...args: any[]) {
      const before = this.lon.slice(0, 16);
      update.apply(this, args);
      (window as any).__windSpeedStep = { multiplier: args[6], paused: this.paused,
        moved: before.some((lon: number, i: number) => lon !== this.lon[i]) };
    };
  });
  const wind = () => page.evaluate(() => (window as any).__windSpeedStep);
  for (const [index] of TIME_SPEEDS.entries()) {
    const multiplier = Math.min(3, index + 1);
    await expect.poll(async () => (await wind())?.multiplier).toBe(multiplier);
    if (index < TIME_SPEEDS.length - 1) await page.getByTestId('speed-next').click();
  }
  await page.getByTestId('play-toggle').click();
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
  await page.waitForTimeout(250); // Let the worker acknowledge any in-flight step.
  const tick = await page.evaluate(() => (window as any).__typhoonLab.state.tick);
  await expect.poll(async () => (await wind())?.moved).toBe(true);
  expect((await wind()).paused).toBe(false);
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as any).__typhoonLab.state.tick)).toBe(tick);
  await page.getByTestId('speed-reset').click();
  await expect.poll(async () => (await wind())?.multiplier).toBe(1);
  await page.getByTestId('play-toggle').click();
  await expect.poll(async () => (await wind())?.paused).toBe(false);
});
