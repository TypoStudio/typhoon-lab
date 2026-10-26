import { test, expect } from '@playwright/test';

for (const width of [1440, 768, 414, 375, 320]) {
  test(`world map and floating controls fit a ${width}px screen`, async ({ page }) => {
    test.setTimeout(90_000); // the default view is a globe, which is slow under software GL
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/?help=0&start=2026-08-01');
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    const map = page.getByTestId('map-stage');
    await expect(map.locator('canvas').first()).toBeVisible();
    // From 48rem the sidebar sits beside the map and the stage shrinks to what is left; below it overlays the full-width stage.
    const sidebar = page.getByTestId('sidebar');
    const beside = width >= 768;
    // Below 48rem the controls form a top strip (brand row + clock row) and a bottom strip (the palette); the stage sits between them.
    const phone = width < 768;
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const sidebarWidthIfOpen = async () => ((await sidebar.isVisible()) && beside ? (await sidebar.boundingBox())!.width : 0);
    const box = (await map.boundingBox())!;
    expect(box.x).toBe(0);
    expect(box.width).toBeCloseTo(width - (await sidebarWidthIfOpen()), 0);
    if (width === 1440) expect(box.width).toBeCloseTo(1440 - 22 * rem, 0);
    if (phone) {
      const clockbar = (await page.locator('.clockbar').boundingBox())!;
      const strip = (await page.getByTestId('weather-palette').boundingBox())!;
      expect(box.y).toBeCloseTo(clockbar.y + clockbar.height, 0);
      expect(box.y + box.height).toBeCloseTo(strip.y, 0);
      expect(box.height / 900).toBeGreaterThanOrEqual(0.6);
      expect(clockbar.height).toBeLessThanOrEqual(2.25 * rem + 0.5);
      expect(strip.height).toBeLessThanOrEqual(5.5 * rem + 0.5);
      expect((await page.locator('.brandbar').boundingBox())!.height).toBeLessThanOrEqual(2.5 * rem + 0.5);
      // Legend is a chip until opened; the zoom buttons are gone (pinch zooms) but reset-view stays.
      await expect(page.getByTestId('legend-toggle')).toBeVisible();
      await expect(page.getByTestId('legend')).toBeHidden();
      await expect(page.getByTestId('zoom-in')).toBeHidden();
      await expect(page.getByTestId('zoom-out')).toBeHidden();
      await expect(page.getByTestId('view-reset')).toBeVisible();
      const clockText = page.getByTestId('clock');
      expect(await clockText.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await clockText.evaluate(el => getComputedStyle(el, '::after').content)).toMatch(/^"D\d+ \d\d:\d\d"$/);
    } else {
      expect(box.y).toBe(0);
      expect(box.height).toBe(900);
      await expect(page.getByTestId('legend-toggle')).toBeHidden();
    }
    const layout = await page.evaluate(phone => {
      // The phone palette is a sideways-scrolling row, so tools beyond the edge are expected.
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden' && !(phone && button.matches('[data-tool]')));
      return {
        scrollWidth: document.documentElement.scrollWidth,
        scrollHeight: document.documentElement.scrollHeight,
        outside: buttons.filter(button => { const r = button.getBoundingClientRect(); return r.left < -1 || r.right > innerWidth + 1; }).map(button => button.textContent),
        unnamed: buttons.filter(button => !(button.getAttribute('aria-label') || button.textContent)?.trim()).length,
      };
    }, phone);
    expect(layout.scrollWidth).toBe(width);
    expect(layout.scrollHeight).toBeLessThanOrEqual(900);
    expect(layout.outside).toEqual([]);
    expect(layout.unnamed).toBe(0);
    if (beside && (await sidebar.isVisible())) {
      const reset = (await page.getByTestId('climate-reset').boundingBox())!;
      const head = (await page.locator('.settings__head').boundingBox())!;
      expect(reset.height).toBeCloseTo(24, 0);
      expect(reset.x + reset.width).toBeLessThanOrEqual(head.x + head.width + 1);
    }
    if (!(await sidebar.isVisible())) await page.getByTestId('sidebar-toggle').click();
    if (phone) {
      // The settings block lives behind the first tab on phones; all six tab labels must fit the strip unclipped.
      const strip = (await page.getByTestId('tab-settings').locator('xpath=..').boundingBox())!;
      for (const id of ['settings', 'storms', 'environment', 'news', 'rank', 'replay']) {
        const tab = page.getByTestId(`tab-${id}`);
        const bounds = (await tab.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(strip.x - 1);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(strip.x + strip.width + 1);
        expect(await tab.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      }
      await page.getByTestId('tab-settings').click();
    } else {
      await expect(page.getByTestId('tab-settings')).toBeHidden();
    }
    const overlayRow = (await page.locator('.map-overlays').boundingBox())!;
    expect(overlayRow.width).toBeLessThanOrEqual(190);
    for (const [id, label] of [['wind', 'Wind'], ['humidity', 'Humidity'], ['rain', 'Rain'], ['pressure', 'Pressure'], ['temperature', 'Sea temp'], ['population', 'Population']]) {
      const button = page.getByTestId(`layer-${id}`);
      await expect(button).toHaveAccessibleName(label);
      await expect(button).toHaveText('');
      await expect(button.locator('svg')).toHaveCount(1);
      await expect(button).toHaveRole('button');
      await expect(button).toHaveAttribute('aria-pressed', 'true');
      await expect(button).toHaveAttribute('data-tip-title', label);
      const bounds = (await button.boundingBox())!;
      expect(bounds.width).toBeCloseTo(28, 0);
      expect(bounds.height).toBeCloseTo(28, 0);
      const icon = (await button.locator('svg').boundingBox())!;
      expect(icon.width).toBeCloseTo(16, 0);
      expect(icon.height).toBeCloseTo(16, 0);
      expect(bounds.x).toBeGreaterThanOrEqual(overlayRow.x);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(overlayRow.x + overlayRow.width);
      expect(await button.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    }
    await expect(page.locator('[data-testid^="legend-"]:not([data-testid="legend-toggle"], [data-testid="legend-close"])')).toHaveCount(6);
    // A button can be inside the viewport yet clipped by a shrinking flex container.
    const speedRow = (await page.locator('.speed').boundingBox())!;
    for (const speed of [1, 4, 12]) {
      const button = (await page.getByTestId(`speed-${speed}`).boundingBox())!;
      expect(button.x).toBeGreaterThanOrEqual(speedRow.x);
      expect(button.x + button.width).toBeLessThanOrEqual(speedRow.x + speedRow.width);
    }
    const palette = (await page.getByTestId('weather-palette').boundingBox())!;
    expect(palette.y).toBeGreaterThan(600);
    expect(palette.y + palette.height).toBeLessThanOrEqual(900);
    // Floating controls belong to the stage: inside its box, the palette centred in it, never under the sidebar.
    const stageBox = (await map.boundingBox())!;
    expect(Math.abs(palette.x + palette.width / 2 - (stageBox.x + stageBox.width / 2))).toBeLessThanOrEqual(2);
    for (const target of [...(phone ? [] : [page.getByTestId('zoom-in')]), page.getByTestId('weather-palette'), page.locator('.zoom'), page.locator('.brandbar'), page.locator('.clockbar')]) {
      const r = (await target.boundingBox())!;
      expect(r.x).toBeGreaterThanOrEqual(stageBox.x - 1);
      expect(r.x + r.width).toBeLessThanOrEqual(stageBox.x + stageBox.width + 1);
    }
    const tools = ['warm', 'moisture', 'low', 'low-shear', 'warm-air', 'updraft', 'cool', 'dry', 'high', 'cold-air', 'downdraft', 'high-shear'];
    await expect(page.locator('[data-tool]')).toHaveCount(12);
    for (const [index, tool] of tools.entries()) {
      const button = page.getByTestId(`tool-${tool}`);
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('aria-keyshortcuts', '1234567890-='[index]);
      const bounds = (await button.boundingBox())!;
      if (!phone) {
        expect(bounds.x).toBeGreaterThanOrEqual(palette.x);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(palette.x + palette.width);
      }
      expect(bounds.width).toBeGreaterThanOrEqual(44);
    }
    // One scrolling row of cells on phones, 6 x 2 up to 70rem, one row of 12 above.
    const rows = new Set(await page.locator('[data-palette-panel="conditions"] [data-tool]').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top))));
    expect(rows.size).toBe(phone || width >= 1120 ? 1 : 2);
    if (phone) expect(await page.locator('[data-palette-panel="conditions"]').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    await expect(page.locator('[data-mode], [data-testid^="mode-"], [data-testid^="conditions-"]')).toHaveCount(0);
    await expect(page.getByTestId('weather-palette')).toContainText('Drag onto the map');
    // The only panel must open from the right, including on narrow screens.
    if (!(await sidebar.isVisible())) await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar).toBeVisible();
    for (const id of ['genesis-toggle', 'historic-select', 'historic-load', 'recorded-path-toggle']) await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('genesis-toggle')).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByTestId('recorded-path-toggle')).toHaveAttribute('aria-checked', 'true');
    const panelBox = (await sidebar.boundingBox())!;
    expect(Math.abs(panelBox.x + panelBox.width - width)).toBeLessThanOrEqual(2);
    const openStage = (await map.boundingBox())!;
    expect(openStage.width).toBeCloseTo(beside ? width - panelBox.width : width, 0);
    if (beside) expect(openStage.x + openStage.width).toBeLessThanOrEqual(panelBox.x + 1);
    await page.getByTestId('sidebar-toggle').click();
    await expect(sidebar).not.toBeVisible();
    expect((await map.boundingBox())!.width).toBeCloseTo(width, 0);
    await expect(page.locator('body')).not.toContainText(/\bbudget\b|\bcosts?\b|resource points/i);
    if (process.env.TYPHOON_SCREENSHOTS === '1') await page.screenshot({ path: `test-results/world-${width}.png`, fullPage: true });
    expect(errors).toEqual([]);
  });
}
