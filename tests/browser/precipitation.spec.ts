import { expect, test } from '@playwright/test';

for (const renderer of ['canvas', 'webgl']) {
  test(`${renderer}: a real blizzard field draws and its rain overlay toggles without errors`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 800, height: 600 });
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          (window as any).__precipitationWorker = this;
        }
      };
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`/?seed=42&lang=ko&help=0&map=flat&start=2026-08-01${renderer === 'canvas' ? '&renderer=canvas' : ''}`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('play-toggle').click();
    await expect(page.getByTestId('play-toggle')).toHaveAttribute('data-state', 'paused');
    const fixture = await page.evaluate(async () => {
      const path = '/src/simulation/engine.ts';
      const { createGame, placeFormation, stepGame } = await import(path);
      const state = createGame(42, 213);
      if (!placeFormation(state, 'blizzard', 127.79, 36.23).ok) throw new Error('Blizzard recipe failed');
      for (let tick = 0; tick < 48; tick++) stepGame(state);
      (window as any).__typhoonLab.mapView.setHome(127, 36, 16);
      (window as any).__precipitationWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } }));
      return { tick: state.tick, blizzardCells: state.blizzardCells };
    });
    expect(fixture.blizzardCells).toBeGreaterThan(0);
    const stage = page.getByTestId('map-stage');
    await expect(stage).toHaveAttribute('data-renderer', renderer);
    await expect(stage).toHaveAttribute('data-rendered-tick', String(fixture.tick));
    if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('layer-rain').click();
    await expect(page.getByTestId('layer-rain')).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('layer-rain').click();
    await expect(page.getByTestId('layer-rain')).toHaveAttribute('aria-pressed', 'true');
    // Let both drawing paths consume the wet field; inspect errors without capturing an image.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(errors).toEqual([]);
  });
}
