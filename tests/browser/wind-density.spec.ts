import { expect, test } from '@playwright/test';

test('stronger visible wind keeps the same particle budget', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        (window as any).__windDensityWorker = this;
      }
      postMessage(message: any, options?: any) {
        if (message?.type === 'traffic-view') return;
        super.postMessage(message, options);
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&lang=ko&help=0&seed=42&start=2026-08-01&map=flat');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/render/particles.ts')?.name;
    if (!url) throw new Error('Particle module was not loaded');
    // Keep measured frame timing steady so this test isolates wind strength from FPS adaptation.
    const budgetPath = '/src/render/wind-budget.ts';
    const budgetUrl = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === budgetPath)?.name ?? budgetPath;
    const { WindParticleBudget } = await import(budgetUrl);
    const sample = WindParticleBudget.prototype.sample;
    WindParticleBudget.prototype.sample = function (_ms: number, active: boolean) {
      return sample.call(this, 1000 / 60, active);
    };
    const { ParticleSystem } = await import(url);
    const update = ParticleSystem.prototype.update;
    ParticleSystem.prototype.update = function (...args: any[]) {
      update.apply(this, args);
      (window as any).__windDensityCount = this.count;
    };
    (window as any).__typhoonLab.mapView.setHome(130, 20, 50);
  });
  const setWind = async (speed: number) => page.evaluate(speed => {
    const lab = (window as any).__typhoonLab;
    const state = structuredClone(lab.state);
    state.tick++; state.hours = state.tick * 0.25;
    for (const cell of state.grid) { cell.u = speed; cell.v = 0; }
    (window as any).__windDensityWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state, clockHours: state.hours } }));
    return state.tick;
  }, speed);
  const count = () => page.evaluate(() => (window as any).__windDensityCount as number);
  const calmTick = await setWind(0);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-rendered-tick', String(calmTick));
  await expect.poll(count).toBe(3033);
  const strongTick = await setWind(35);
  await expect(page.getByTestId('map-stage')).toHaveAttribute('data-rendered-tick', String(strongTick));
  const counts = await page.evaluate(() => new Promise<number[]>(resolve => {
    const values: number[] = [];
    const start = performance.now();
    const sample = () => {
      values.push((window as any).__windDensityCount);
      if (performance.now() - start >= 1200) resolve(values);
      else requestAnimationFrame(sample);
    };
    sample();
  }));
  expect(new Set(counts)).toEqual(new Set([3033]));
  expect(errors).toEqual([]);
});
