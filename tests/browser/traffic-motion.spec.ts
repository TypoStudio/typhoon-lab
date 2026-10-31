import { expect, test } from '@playwright/test';

test('high-speed aircraft do not reverse when clock checkpoints repeat', async ({ page }) => {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options); (window as any).__trafficWorker = this;
      }
      postMessage(message: any, options?: any) {
        if (message?.type !== 'traffic-view') super.postMessage(message, options);
      }
    };
  });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&weather=base&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const speedSteps = await page.evaluate(async () => {
    const routing = '/src/simulation/traffic-routing.ts', time = '/src/time.ts';
    const { trafficDistance } = await import(routing);
    const { TIME_SPEEDS } = await import(time);
    const state = (window as any).__typhoonLab.state;
    const plane = state.traffic.vehicles.filter((v: any) => v.kind === 'planes' && v.status === 'travelling')
      .sort((a: any, b: any) => trafficDistance(b, b.destination) - trafficDistance(a, a.destination))[0];
    if (trafficDistance(plane, plane.destination) < 5000) throw new Error('Fixture needs a long-haul flight.');
    const moduleUrl = performance.getEntriesByType('resource').find(e => new URL(e.name).pathname === '/src/render/traffic.ts')?.name;
    if (!moduleUrl) throw new Error('Traffic renderer was not loaded');
    const { TrafficAnimation } = await import(moduleUrl);
    const frame = TrafficAnimation.prototype.frame;
    (window as any).__trafficSamples = [];
    TrafficAnimation.prototype.frame = function (...args: any[]) {
      const markers = frame.apply(this, args), marker = markers.find((m: any) => m.id === plane.id);
      if (marker && (window as any).__typhoonLab.speed === TIME_SPEEDS[TIME_SPEEDS.length - 1]) {
        (window as any).__trafficSamples.push({ at: args[0], distance: trafficDistance(marker, plane.destination) });
      }
      return markers;
    };
    return TIME_SPEEDS.length - 1;
  });
  for (let i = 0; i < speedSteps; i++) await page.getByTestId('speed-next').click();
  const samples = await page.evaluate(async () => {
    (window as any).__trafficSamples.length = 0;
    // Placement and traffic-view responses can repeat the last fixed-step clock.
    const timer = setInterval(() => {
      const lab = (window as any).__typhoonLab;
      (window as any).__trafficWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'progress', clockHours: lab.state.hours } }));
    }, 40);
    await new Promise(resolve => setTimeout(resolve, 1100));
    clearInterval(timer);
    return (window as any).__trafficSamples as { at: number; distance: number }[];
  });
  expect(samples.length).toBeGreaterThan(10);
  for (let i = 1; i < samples.length; i++) expect(samples[i].distance).toBeLessThanOrEqual(samples[i - 1].distance + 0.05);
  expect(samples[0].distance - samples[samples.length - 1].distance).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});
