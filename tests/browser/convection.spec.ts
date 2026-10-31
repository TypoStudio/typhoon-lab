import { setSpeed } from './speed';
import { test, expect } from '@playwright/test';

for (const renderer of ['canvas', 'webgl']) {
  test(`warm air and updraft drag, keyboard, Korean readout and replay (${renderer})`, async ({ page }) => {
    await page.goto(`/?renderer=${renderer}&lang=ko&seed=20261022&help=0&start=2026-08-01`);
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('play-toggle').click();
    if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
    const point = await page.evaluate(() => (window as any).__typhoonLab.mapView.lonLatToPx(140, 16));
    for (const [type, label] of [['warm-air', '따뜻한 기온'], ['updraft', '상승 기류']]) {
      const button = page.getByTestId(`tool-${type}`);
      await expect(button).toHaveAttribute('aria-label', new RegExp(label));
      const box = (await button.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(point[0], point[1], { steps: 4 });
      await expect(page.locator('.drag-ghost')).toHaveCount(1);
      await page.mouse.up();
      await expect(page.locator('.drag-ghost')).toHaveCount(0);
    }
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.map((e: any) => e.type))).toEqual(['warm-air', 'updraft']);
    for (const [key, type] of [['t', 'warm-air'], ['y', 'updraft']]) {
      await page.getByTestId('map-stage').focus();
      await page.keyboard.press(key);
      await expect(page.getByTestId(`tool-${type}`)).toHaveAttribute('aria-pressed', 'true');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
    }
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.effects.length)).toBe(4);
    await setSpeed(page, 14400);
    await page.getByTestId('play-toggle').click();
    await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.hours)).toBeGreaterThanOrEqual(6);
    await page.getByTestId('play-toggle').click();
    const fixture = await page.evaluate(async () => {
      const path = '/src/ui/storage.ts'; const { buildReplay } = await import(path);
      const lab = (window as any).__typhoonLab;
      return { replay: buildReplay(lab.state), effects: lab.state.effects, fields: lab.state.grid.filter((c: any) => c.lon === 139 && c.lat === 15) };
    });
    expect(fixture.fields[0].airHeating).toBeGreaterThan(0);
    expect(fixture.fields[0].updraft).toBeGreaterThan(0);
    await page.mouse.move(point[0], point[1]);
    await page.mouse.move(point[0] + 1, point[1]);
    await expect(page.getByTestId('legend-temperature')).toContainText(/\d+\.\d \/ \d+\.\d °C/);
    await expect(page.getByTestId('legend-wind')).toContainText('상승 기류');
    await page.getByTestId('sidebar-toggle').click();
    await page.getByTestId('tab-replay').click();
    await page.getByTestId('import-replay-input').setInputFiles({ name: 'convection.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture.replay)) });
    await expect(page.getByTestId('replay-message')).toContainText(String(fixture.replay.untilTick));
    expect(await page.evaluate(() => (window as any).__typhoonLab.state.effects)).toEqual(fixture.effects);
    expect(await page.evaluate(() => (window as any).__typhoonLab.state.grid.filter((c: any) => c.lon === 139 && c.lat === 15))).toEqual(fixture.fields);
  });
}
