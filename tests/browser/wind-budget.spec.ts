import { expect, test } from '@playwright/test';

test('wind count adapts during model pause while camera gestures hold it', async ({ page }) => {
  await page.goto('/?renderer=canvas&map=flat&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => {
    const path = '/src/render/map.ts';
    const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)?.name ?? path;
    const { MapRenderer } = await import(url);
    const track = MapRenderer.prototype.trackPerformance;
    MapRenderer.prototype.trackPerformance = function (elapsed: number) {
      (window as any).__windBudgetMap = this;
      track.call(this, elapsed);
    };
  });
  await expect.poll(() => page.evaluate(() => !!(window as any).__windBudgetMap)).toBe(true);
  const result = await page.evaluate(() => {
    const map = (window as any).__windBudgetMap;
    const frames = (time: number, count: number) => { for (let i = 0; i < count; i++) map.trackPerformance(time); };
    frames(1000 / 60, 6000);
    const maximum = map.stats().particles;
    frames(50, 60);
    const slow = map.stats();
    map.setInteracting(true);
    frames(100, 100);
    const gesture = map.stats().particles;
    map.setInteracting(false);
    const lab = (window as any).__typhoonLab;
    map.setSimulationClock(lab.state.hours, lab.speed, false);
    frames(100, 100);
    const paused = map.stats().particles;
    map.setSimulationClock(lab.state.hours, lab.speed, true);
    frames(1000 / 60, 6000);
    return { maximum, slow, gesture, paused, recovered: map.stats() };
  });
  expect(result.slow.particles).toBeLessThan(result.maximum);
  expect(result.slow.reduced).toBe(true);
  expect(result.gesture).toBe(result.slow.particles);
  expect(result.paused).toBeLessThan(result.slow.particles);
  expect(result.recovered.particles).toBe(result.maximum);
  expect(result.recovered.reduced).toBe(false);
});
