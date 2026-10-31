import { expect, test } from '@playwright/test';

for (const [renderer, mode] of [['canvas', 'flat'], ['webgl', 'flat'], ['webgl', 'globe']] as const) {
  test(`${renderer}/${mode}: temperature and population colour the existing surfaces`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && /THREE|shader|WebGL/i.test(message.text())) errors.push(message.text());
    });
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(`/?help=0&lang=ko&seed=42&start=2026-08-01&map=${mode}${renderer === 'canvas' ? '&renderer=canvas' : ''}`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('map-stage')).toHaveAttribute('data-renderer', renderer);
    await page.getByTestId('play-toggle').click();
    await page.evaluate(async (kind) => {
      const path = kind === 'webgl' ? '/src/render/webgl.ts' : '/src/render/canvas2d.ts';
      const url = performance.getEntriesByType('resource').find(entry => new URL(entry.name).pathname === path)?.name ?? path;
      const module = await import(url);
      const prototype = (kind === 'webgl' ? module.ThreeBase : module.CanvasBase).prototype;
      const upload = prototype.setSurfaceImages, draw = prototype.draw;
      prototype.setSurfaceImages = function (...args: any[]) {
        const [sea, land] = args;
        const pixel = (119 * 360 + 257) * 4; // Delhi.
        (window as any).__surfaceInput = { sea: Array.from(sea.subarray(0, 3)), land: Array.from(land.subarray(pixel, pixel + 3)),
          opaque: sea.every((value: number, index: number) => index % 4 !== 3 || value === 255)
            && land.every((value: number, index: number) => index % 4 !== 3 || value === 255) };
        upload.apply(this, args);
      };
      prototype.draw = function (...args: any[]) {
        const result = draw.apply(this, args);
        const surfaces = args[0].kind === 'globe' ? this.globeScene?.surfaces : [this.sea?.material, this.landUnder?.material];
        (window as any).__surfaceDraw = { base: args[3].rgb, precipitation: this.hasPrecipitation,
          bound: kind !== 'webgl' || surfaces.every((material: any) => material?.uniforms.hasSurface.value && !material.transparent) };
        return result;
      };
    }, renderer);
    if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
    const temperature = page.getByTestId('layer-temperature');
    await temperature.click(); // Rebuild and observe the surface upload.
    await expect.poll(() => page.evaluate(() => (window as any).__surfaceDraw?.bound)).toBe(true);
    const disabled = await page.evaluate(() => ({ input: (window as any).__surfaceInput, draw: (window as any).__surfaceDraw }));
    expect(disabled.input.opaque).toBe(true);
    expect(disabled.input.sea).toEqual(disabled.draw.base.sea);
    await temperature.click();
    const enabled = await page.evaluate(() => (window as any).__surfaceInput);
    expect(enabled.sea).not.toEqual(disabled.input.sea);
    expect(enabled.land).not.toEqual(disabled.input.land);
    await page.getByTestId('layer-population').click();
    await expect(page.getByTestId('legend-temperature').locator('.legend__bar')).toHaveCount(1);
    await expect(page.getByTestId('legend-temperature').locator('.legend__tick')).toHaveCount(2);
    await expect(page.getByTestId('legend-temperature-air')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => (window as any).__surfaceInput.land)).not.toEqual(enabled.land);
    expect(await page.evaluate(() => (window as any).__surfaceInput.sea)).toEqual(enabled.sea);
    await temperature.click();
    await expect(page.getByTestId('legend-temperature')).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__surfaceInput.land)).toEqual(disabled.draw.base.land);
    await page.getByTestId('layer-rain').click();
    await expect.poll(() => page.evaluate(() => (window as any).__surfaceDraw.precipitation)).toBe(false);
    expect(errors).toEqual([]);
  });
}
