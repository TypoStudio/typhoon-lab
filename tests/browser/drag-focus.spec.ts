import { expect, test, type Page } from '@playwright/test';

const url = (lang: string) => `/?renderer=canvas&lang=${lang}&help=0&seed=42&start=2026-08-01&map=flat`;

async function ready(page: Page, width: number, lang = 'en', height = 900) {
  await page.setViewportSize({ width, height });
  await page.goto(url(lang));
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('play-toggle').click();
}

/** Page coordinates of a point on the map (the stage may sit below a top strip on phones). */
async function mapPoint(page: Page, lon: number, lat: number) {
  const box = (await page.getByTestId('map-stage').boundingBox())!;
  const [x, y] = await page.evaluate(([a, b]) => (window as any).__typhoonLab.mapView.lonLatToPx(a, b) as [number, number], [lon, lat]);
  return { x: box.x + x, y: box.y + y };
}

async function beginDrag(page: Page, testid: string, lon = 140, lat = 16) {
  const rect = (await page.getByTestId(testid).boundingBox())!;
  const to = await mapPoint(page, lon, lat);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await expect(page.locator('.drag-ghost')).toHaveCount(1);
  return to;
}

const rectOf = (page: Page, selector: string) => page.evaluate(sel => {
  const nodes = [...document.querySelectorAll<HTMLElement>(sel)].filter(n => !n.hidden && getComputedStyle(n).visibility !== 'hidden');
  return nodes.map(n => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height }; }).filter(r => r.width > 0 && r.height > 0);
}, selector);

/** The shared gap between stacked floating cards (`--gap`) and the margin to the viewport edge (`--edge`), in px. */
const gapToken = (page: Page) => page.evaluate(() => { const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--gap)'; document.querySelector('.app')!.append(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w; });
const edgeToken = (page: Page) => page.evaluate(() => { const probe = document.createElement('div'); probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--edge)'; document.querySelector('.app')!.append(probe); const w = probe.getBoundingClientRect().width; probe.remove(); return w; });

/** The worst case for the strips under the legend chip: natural formation running and a long loss figure. */
async function longStrips(page: Page) {
  await page.evaluate(() => {
    const wave = document.querySelector<HTMLElement>('[data-testid="genesis-wave"]')!;
    wave.hidden = false; wave.textContent = '태풍 자연 발생 · 4차 발생 · 다음 조건 배치까지 1시간';
    document.querySelector('[data-ref="damageLoss"]')!.textContent = '추정 피해액: 1조 9,956억 원';
    document.querySelector('[data-testid="coords"]')!.textContent = '동경 130.13° 북위 20.44° · 바다 · 풍속 12 m/s';
  });
}

/** Two charts (one with two pins) from the Measure tab, dropped on the map. */
async function dropCharts(page: Page, drops: [string, number, number][]) {
  await page.waitForTimeout(800); // the map settles after the sidebar closes
  await page.getByTestId('palette-tab-measure').click();
  for (const [tool, lon, lat] of drops) {
    const rect = (await page.getByTestId(`tool-measure-${tool}`).boundingBox())!;
    const to = await mapPoint(page, lon, lat);
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  }
  await page.getByTestId('palette-tab-conditions').click();
}

async function armToast(page: Page) {
  await page.getByTestId('tool-warm').click();
  await expect(page.getByTestId('status')).toBeVisible();
}

test('dragging an icon shows only its description; the drop restores everything', async ({ page }) => {
  await ready(page, 1440);
  await page.getByTestId('palette-tab-formation').click();
  await page.getByTestId('palette-tab-conditions').click();
  await armToast(page);
  await page.keyboard.press('Escape');
  const palette = page.getByTestId('weather-palette');
  await expect(page.locator('.drag-card')).toBeHidden();
  const to = await beginDrag(page, 'tool-moisture');
  await expect(page.locator('.drag-card')).toBeVisible();
  await expect(page.locator('.drag-card__name')).toHaveText('Moisture');
  await expect(page.locator('.drag-card__desc')).toContainText('Moistens the mid-level air');
  await expect(page.locator('.drag-card__meta')).toContainText('550 km');
  await expect(page.getByTestId('announce')).toContainText('Moistens the mid-level air');
  for (const sel of ['[data-ref="mapStatus"]', '.notes', '[data-testid="weather-palette"]']) {
    await expect(page.locator(sel)).toHaveCSS('visibility', 'hidden');
    await expect(page.locator(sel)).toHaveCSS('pointer-events', 'none');
  }
  // The drop point is the bare map, and the card does not cover the ghost.
  expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName, [to.x, to.y])).toBe('CANVAS');
  const card = (await page.locator('.drag-card').boundingBox())!;
  const ghost = (await page.locator('.drag-ghost').boundingBox())!;
  expect(ghost.y + ghost.height <= card.y || ghost.y >= card.y + card.height).toBe(true);
  await page.mouse.up();
  await expect(page.locator('.drag-card')).toBeHidden();
  for (const sel of ['[data-ref="mapStatus"]', '[data-testid="weather-palette"]']) await expect(page.locator(sel)).toHaveCSS('visibility', 'visible');
  await expect(palette).toHaveCSS('opacity', '1');
  await expect(page.getByTestId('status')).toContainText('placed');
  await expect(page.getByTestId('palette-tab-conditions')).toHaveAttribute('aria-selected', 'true');
});

test('a cancelled drag restores the other palette tabs and their scroll', async ({ page }) => {
  await ready(page, 390);
  await page.getByTestId('palette-tab-formation').click();
  const row = page.locator('[data-palette-panel="formation"]');
  await row.evaluate(el => { el.scrollLeft = 20; });
  const before = await row.evaluate(el => el.scrollLeft);
  await beginDrag(page, 'tool-genesis-typhoon');
  await page.keyboard.press('Escape');
  await expect(page.locator('.drag-card')).toBeHidden();
  await expect(page.getByTestId('weather-palette')).toHaveCSS('visibility', 'visible');
  await expect(page.getByTestId('palette-tab-formation')).toHaveAttribute('aria-selected', 'true');
  expect(await row.evaluate(el => el.scrollLeft)).toBe(before);
});

for (const width of [1440, 390]) {
  test(`the toast stack sits directly on the palette at ${width}`, async ({ page }) => {
    await ready(page, width);
    await armToast(page);
    const palette = (await rectOf(page, '[data-testid="weather-palette"]'))[0];
    const notes = await rectOf(page, '.notes > *');
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...notes.map(n => n.bottom))).toBeGreaterThan(0);
    const gap = await gapToken(page);
    expect(Math.abs(Math.max(...notes.map(n => n.bottom)) - (palette.top - gap))).toBeLessThanOrEqual(1);
    // A taller palette (a wrapped tab row would do the same) moves the stack with it.
    await page.setViewportSize({ width, height: 600 });
    await expect.poll(async () => Math.abs(Math.max(...(await rectOf(page, '.notes > *')).map(n => n.bottom)) - ((await rectOf(page, '[data-testid="weather-palette"]'))[0].top - gap))).toBeLessThanOrEqual(1);
  });
}

const overlaps = (a: { top: number; bottom: number; left: number; right: number }, b: typeof a) =>
  a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;

for (const lang of ['ko', 'en']) {
  test(`the bottom stack and the floating panels never overlap (${lang})`, async ({ page }) => {
    test.setTimeout(240_000);
    await ready(page, 1440, lang);
    for (const width of [320, 375, 390, 600, 768, 850, 900, 1024, 1280, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      if (width < 768 && (await page.locator('.onmap-card').count()) === 0) {
        await page.getByTestId('palette-tab-measure').click();
        for (const [tool, lat] of [['sea-temperature', 10], ['air-temperature', 4]] as const) {
          const rect = (await page.getByTestId(`tool-measure-${tool}`).boundingBox())!;
          const to = await mapPoint(page, 140, lat);
          await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
          await page.mouse.down();
          await page.mouse.move(to.x, to.y, { steps: 4 });
          await page.mouse.up();
        }
        await page.getByTestId('palette-tab-conditions').click();
      }
      const check = async () => {
      await armToast(page);
      await page.waitForTimeout(150);
      await longStrips(page);
      const parts: Record<string, Awaited<ReturnType<typeof rectOf>>> = {
        speed: await rectOf(page, '.clockbar'),
        brand: await rectOf(page, '.brandbar'),
        controls: await rectOf(page, '.zoom'),
        toggle: await rectOf(page, '.sidebar-toggle'),
        palette: await rectOf(page, '[data-testid="weather-palette"]'),
        toasts: await rectOf(page, '.notes > *'),
        legend: await rectOf(page, '.legend-chip, [data-testid="coords"], [data-testid="legend"]'),
        strips: await rectOf(page, '.damage-hud, .historic-hud'),
        cards: await rectOf(page, '.onmap-card:not([hidden])'),
      };
      expect(parts.palette.length, `palette at ${width}`).toBe(1);
      expect(parts.toasts.length, `toasts at ${width}`).toBeGreaterThanOrEqual(2);
      if (width < 768) expect(parts.cards.length, `on-map graphs at ${width}`).toBeGreaterThanOrEqual(1);
      const named = Object.entries(parts).flatMap(([name, list]) => list.map((r, i) => ({ name: `${name}${i}`, r })));
      for (let i = 0; i < named.length; i++) for (let j = i + 1; j < named.length; j++) {
        const a = named[i], b = named[j];
        if (a.name.startsWith('toasts') && b.name.startsWith('toasts')) continue;
        if (width < 768 && a.name.startsWith('brand') && b.name.startsWith('toggle')) continue; // on phones the toggle sits inside the brand bar by design
        expect(overlaps(a.r, b.r), `${a.name} overlaps ${b.name} at ${width} (${lang})`).toBe(false);
      }
      // The speed bar lives at the top, inside the viewport; the toast stack rests on the palette.
      expect(parts.speed.length, `speed bar at ${width}`).toBe(1);
      expect(parts.speed[0].top, `speed bar top at ${width}`).toBeGreaterThanOrEqual(0);
      expect(parts.speed[0].bottom, `speed bar region at ${width}`).toBeLessThan(160);
      expect(parts.speed[0].right, `speed bar inside viewport at ${width}`).toBeLessThanOrEqual(width + 0.5);
      if (width < 768) expect(parts.speed[0].height, `speed bar touch height at ${width}`).toBeGreaterThanOrEqual(44);
      expect(Math.abs(Math.max(...parts.toasts.map(n => n.bottom)) - (parts.palette[0].top - await gapToken(page))), `toast dock at ${width}`).toBeLessThanOrEqual(1);
      if (width >= 768) { // the sidebar takes 22rem of the map: the speed bar stays inside what is left and clear of the panels
        await page.getByTestId('sidebar-toggle').click();
        await expect(page.getByTestId('sidebar')).toBeVisible();
        await page.waitForTimeout(150);
        const wrap = (await page.getByTestId('map-stage').boundingBox())!;
        const open: Record<string, Awaited<ReturnType<typeof rectOf>>> = {
          speed: await rectOf(page, '.clockbar'), brand: await rectOf(page, '.brandbar'), controls: await rectOf(page, '.zoom'),
          legend: await rectOf(page, '[data-testid="coords"], [data-testid="legend"]'), palette: await rectOf(page, '[data-testid="weather-palette"]'), toasts: await rectOf(page, '.notes > *'),
        };
        expect(open.speed.length, `speed bar (sidebar open) at ${width}`).toBe(1);
        expect(open.speed[0].right, `speed bar inside the map (sidebar open) at ${width}`).toBeLessThanOrEqual(wrap.x + wrap.width + 0.5);
        const entries = Object.entries(open).flatMap(([name, list]) => list.map((r, i) => ({ name: `${name}${i}`, r })));
        for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
          if (entries[i].name.startsWith('toasts') && entries[j].name.startsWith('toasts')) continue;
          expect(overlaps(entries[i].r, entries[j].r), `${entries[i].name} overlaps ${entries[j].name} at ${width} with the sidebar open (${lang})`).toBe(false);
        }
        await page.getByTestId('sidebar-toggle').click();
        await expect(page.getByTestId('sidebar')).toBeHidden();
      }
      if (width === 390 || width === 850 || width === 1440) await page.screenshot({ path: `/tmp/typhoon-shot/${lang === 'ko' ? 'speedbar-pos-ko' : 'speedbar-pos-en'}-${width}.png` });
      };
      if (width < 768) { await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(140, 10)); await page.waitForTimeout(300); }
      await check();
    }
  });
}

test('one spacing system: equal gaps between stacked cards, equal edge margins, aligned rows', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page, 1440, 'ko');
  for (const width of [390, 850, 1440]) {
    await page.setViewportSize({ width, height: width === 850 ? 1070 : 900 });
    await armToast(page);
    await page.waitForTimeout(200);
    const gap = await gapToken(page), edge = await edgeToken(page);
    const one = async (sel: string) => (await rectOf(page, sel))[0];
    const brand = await one('.brandbar'), clock = await one('.clockbar'), palette = await one('[data-testid="weather-palette"]');
    const chip = await one('.legend-chip'), coords = await one('[data-testid="coords"]'), legend = await one('[data-testid="legend"]'), damage = await one('.damage-hud');
    const toasts = (await rectOf(page, '.notes > *')).sort((a, b) => a.top - b.top);
    const at = `at ${width}`;
    const near = (a: number, b: number, what: string) => expect(Math.abs(a - b), `${what} ${at}: ${a} vs ${b}`).toBeLessThanOrEqual(1);
    // Toasts: equal gaps between them, and the same gap above the palette.
    expect(toasts.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < toasts.length; i++) near(toasts[i].top - toasts[i - 1].bottom, gap, 'toast gap');
    near(palette.top - toasts[toasts.length - 1].bottom, gap, 'toast to palette gap');
    if (width < 768) {
      // Phone: the top strips are bars; the legend column hangs below them with the same gap everywhere.
      near(chip.top - clock.bottom, gap, 'strip to chip');
      near(damage.top - chip.bottom, gap, 'chip to damage');
      near(coords.top - damage.bottom, gap, 'damage to readout');
      near(chip.left, edge, 'chip left edge');
      near(toasts[0].left, edge, 'toast left edge'); // the stack is inset by the edge margin too
      near(width - toasts[0].right, edge, 'toast right edge');
    } else {
      const toggle = await one('.sidebar-toggle'), zoom = await one('.zoom');
      const stacked = clock.top > brand.bottom;
      near(brand.left, edge, 'brand left edge'); near(brand.top, edge, 'brand top edge');
      near(toggle.top, edge, 'toggle top edge'); near(width - toggle.right, edge, 'toggle right edge');
      near(width - zoom.right, edge, 'zoom right edge');
      near(await page.evaluate(() => innerHeight) - palette.bottom, edge, 'palette bottom edge');
      near(coords.left, edge, 'legend left edge');
      near(zoom.top - toggle.bottom, gap, 'toggle to zoom');
      if (stacked) {
        near(clock.left, edge, 'speed bar left edge');
        near(clock.top - brand.bottom, gap, 'brand to speed bar');
        near(coords.top - clock.bottom, gap, 'speed bar to legend');
        near(zoom.top, clock.top, 'zoom row aligned with the speed bar');
      } else {
        near(clock.top, brand.top, 'speed bar aligned with the brand panel');
        near(coords.top - brand.bottom, gap, 'brand to legend');
        near(zoom.top, coords.top, 'zoom row aligned with the legend');
      }
      near(damage.top - legend.bottom, gap, 'legend to damage');
    }
    await page.screenshot({ path: `/tmp/typhoon-shot/spacing-ko-${width}.png` });
  }
});

for (const lang of ['ko', 'en', 'ja']) {
  test(`wide layout: the speed bar starts one gap after the brand panel and clears the top-right controls (${lang})`, async ({ page }) => {
    test.setTimeout(90_000);
    await ready(page, 1440, lang);
    for (const width of [1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(200);
      const gap = await gapToken(page);
      const one = async (sel: string) => (await rectOf(page, sel))[0];
      const brand = await one('.brandbar'), clock = await one('.clockbar'), toggle = await one('.sidebar-toggle'), zoom = await one('.zoom');
      expect(Math.abs(clock.left - brand.right - gap), `brand to speed bar at ${width} (${lang})`).toBeLessThanOrEqual(1);
      expect(Math.abs(clock.top - brand.top), `speed bar top at ${width} (${lang})`).toBeLessThanOrEqual(1);
      expect(clock.right, `speed bar clears the toggle at ${width} (${lang})`).toBeLessThan(toggle.left);
      expect(overlaps(clock, zoom) || overlaps(clock, toggle)).toBe(false);
    }
  });
}

test('phone 375: on-map cards say what they measure, tap moves the map, (i) opens the card, locate closes the sidebar, trash removes', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page, 375, 'ko', 800);
  await dropCharts(page, [['sea-temperature', 140, 10], ['sea-temperature', 132, 4], ['wind', 140, 10]]);
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await armToast(page);
  await longStrips(page);
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(2);
  // No top-right stack any more; each line of a card starts with the item's icon, and the card carries no number badge.
  await expect(page.locator('.mini-measure, .mini-chart')).toHaveCount(0);
  await expect(page.locator('.pin-badge')).toHaveCount(0);
  const pin1 = page.getByTestId('onmap-pin-1');
  await expect(pin1.locator('.onmap-row')).toHaveCount(2);
  await expect(pin1.locator('.onmap-row .onmap-icon svg')).toHaveCount(2);
  // The legend column keeps its full width and clears the cards.
  const column = await rectOf(page, '.legend-chip, [data-testid="coords"], .damage-hud, [data-testid="genesis-wave"], .damage-hud p');
  const cards = await cardsOnMap(page);
  for (const a of column) for (const b of cards) expect(overlaps(a, b), 'legend column overlaps an on-map card').toBe(false);
  const coords = (await rectOf(page, '[data-testid="coords"]'))[0];
  expect(coords.right, 'the readout may use the full width').toBeGreaterThan(260);
  await page.screenshot({ path: '/tmp/typhoon-shot/onmap-graphs-ko-375.png' });
  // Tap: the map centres on the pin of the card.
  const centre = () => page.evaluate(() => (window as any).__typhoonLab.mapView.centerLonLat() as [number, number]);
  await page.getByTestId('onmap-pin-2').click();
  await expect.poll(async () => Math.hypot(((await centre())[0]) - 132, ((await centre())[1]) - 4)).toBeLessThan(2);
  await expect(page.locator('.locate-flash')).toHaveCount(1);
  await expect(page.getByTestId('sidebar')).toBeHidden();
  // The (i) button has a 44 x 44 hit area and opens the Measure tab at that card.
  const info = page.getByTestId('onmap-info-1');
  const box = (await info.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
  await info.click();
  await expect(page.getByTestId('sidebar')).toBeVisible();
  await expect(page.getByTestId('tab-measure')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('measure-card-measure-sea-temperature')).toBeVisible();
  await page.screenshot({ path: '/tmp/typhoon-shot/measure-card-ko-375.png' });
  // The card's locate button moves the map and, on a phone, closes the sidebar.
  await page.getByTestId('measure-locate-measure-wind').click();
  await expect(page.getByTestId('sidebar')).toBeHidden();
  await expect.poll(async () => Math.hypot(((await centre())[0]) - 140, ((await centre())[1]) - 10)).toBeLessThan(2);
  // Trash removes the card.
  await page.getByTestId('onmap-info-1').click();
  await expect(page.getByTestId('measure-card-measure-wind')).toBeVisible();
  await page.getByTestId('measure-remove-measure-wind').click();
  await expect(page.getByTestId('measure-card-measure-wind')).toHaveCount(0);
});

test('desktop 1440: card locate (per card and per pin) centres the map; trash removes', async ({ page }) => {
  test.setTimeout(120_000);
  await ready(page, 1440, 'ko');
  await dropCharts(page, [['sea-temperature', 140, 16], ['sea-temperature', 150, 24]]);
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-measure').click();
  const centre = () => page.evaluate(() => (window as any).__typhoonLab.mapView.centerLonLat() as [number, number]);
  const locate = page.getByTestId('measure-locate-measure-sea-temperature');
  await locate.click();
  await expect.poll(async () => Math.hypot(((await centre())[0]) - 140, ((await centre())[1]) - 16)).toBeLessThan(2);
  await locate.click();
  await expect.poll(async () => Math.hypot(((await centre())[0]) - 150, ((await centre())[1]) - 24)).toBeLessThan(2);
  await page.getByTestId('measure-line-locate-measure-sea-temperature-1').click();
  await expect.poll(async () => Math.hypot(((await centre())[0]) - 140, ((await centre())[1]) - 16)).toBeLessThan(2);
  await expect(page.getByTestId('sidebar')).toBeVisible(); // beside the map: stays open
  await page.screenshot({ path: '/tmp/typhoon-shot/measure-card-ko-1440.png' });
  await page.getByTestId('measure-remove-measure-sea-temperature').click();
  await expect(page.getByTestId('measure-card-measure-sea-temperature')).toHaveCount(0);
});

const cardsOnMap = (page: Page) => rectOf(page, '.onmap-card:not([hidden])');
const pinPoints = (page: Page) => page.evaluate(() => {
  const lab = (window as any).__typhoonLab;
  const box = document.querySelector('[data-testid="map-stage"]')!.getBoundingClientRect();
  return (lab.probes.pins as { n: number; lon: number; lat: number }[]).map(p => { const px = lab.mapView.lonLatToPx(p.lon, p.lat); return px ? { n: p.n, x: box.left + px[0], y: box.top + px[1] } : null; }).filter(Boolean) as { n: number; x: number; y: number }[];
});
const floating = (page: Page) => rectOf(page, '.brandbar, .clockbar, .zoom, .sidebar-toggle, .palette, .notes > *, .legend-chip, [data-testid="coords"], [data-testid="legend"], .damage-hud');

test('graphs on the map: stacked per pin, follow a pan, off-screen pins hide, the toggle turns them off, nothing overlaps', async ({ page }) => {
  test.setTimeout(150_000);
  await ready(page, 1440, 'ko');
  await dropCharts(page, [['sea-temperature', 140, 16], ['sea-temperature', 150, 24], ['wind', 140, 16], ['pressure', 125, 10], ['air-temperature', 132, 4]]);
  await armToast(page);
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(4);
  const cards = await cardsOnMap(page);
  const floats = await floating(page);
  const pins = await pinPoints(page);
  for (const [i, a] of cards.entries()) {
    for (const f of floats) expect(overlaps(a, f), `card ${i} overlaps floating UI`).toBe(false);
    for (const [j, b] of cards.entries()) if (j > i) expect(overlaps(a, b), `cards ${i} and ${j} overlap`).toBe(false);
    for (const p of pins) expect(p.x > a.left - 4 && p.x < a.right + 4 && p.y > a.top - 4 && p.y < a.bottom + 4, `card ${i} covers pin ${p.n}`).toBe(false);
  }
  // Pin 1 is used by two charts (sea temperature and wind): one card with two lines.
  await expect(page.getByTestId('onmap-pin-1').locator('.onmap-row')).toHaveCount(2);
  await expect(page.getByTestId('onmap-pin-1')).toContainText('°C');
  await expect(page.getByTestId('onmap-pin-1')).toContainText('m/s');
  // Basin charts sit at their ocean: the Niño 3.4 box is outlined and carries its card while it is on screen.
  await dropCharts(page, [['nino34', 150, 12], ['soi-wwv', 145, 18]]);
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(-175, 8));
  await expect(page.getByTestId('onmap-measure-nino34')).toBeVisible();
  await expect(page.locator('.onmap-box')).toBeVisible();
  await expect(page.getByTestId('onmap-measure-nino34').locator('.onmap-icon svg')).toHaveCount(1);
  await page.screenshot({ path: '/tmp/typhoon-shot/onmap-graphs-ko-1440-pacific.png' });
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(140, 14));
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(4);
  await page.screenshot({ path: '/tmp/typhoon-shot/onmap-graphs-ko-1440.png' });
  // A tap on a card moves the map to its pin; (i) opens the card in the Measure tab.
  const before = await page.getByTestId('onmap-pin-2').boundingBox();
  const centre = () => page.evaluate(() => (window as any).__typhoonLab.mapView.centerLonLat() as [number, number]);
  await page.getByTestId('onmap-pin-2').click();
  await expect.poll(async () => Math.hypot((await centre())[0] - 150, (await centre())[1] - 24)).toBeLessThan(2);
  expect(before).not.toBeNull();
  // A pan moves the cards with their pins.
  const first = (await page.getByTestId('onmap-pin-1').boundingBox())!;
  await page.evaluate(() => { const v = (window as any).__typhoonLab.mapView; const [lon, lat] = v.centerLonLat(); v.centerOn(lon + 6, lat); });
  await expect.poll(async () => Math.abs(((await page.getByTestId('onmap-pin-1').boundingBox()) ?? first).x - first.x)).toBeGreaterThan(10);
  // Off-screen pins have no card.
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(-100, 10));
  await expect.poll(async () => (await cardsOnMap(page)).length).toBe(0);
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(140, 14));
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(2);
  // The (i) button opens the Measure tab at the card.
  await page.getByTestId('onmap-info-1').click();
  await expect(page.getByTestId('tab-measure')).toHaveAttribute('aria-selected', 'true');
  // The switch in the overlay row hides them and turns them back on.
  const toggle = page.getByTestId('label-graphs-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await cardsOnMap(page)).length).toBe(0);
  await toggle.click();
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(2);
});

test('graphs on the map: the per-frame cost with 12 pins', async ({ page }) => {
  test.setTimeout(150_000);
  await ready(page, 1440, 'ko');
  const spots: [string, number, number][] = [];
  for (const lat of [5, 12, 19]) for (const lon of [105, 115, 125, 135, 145]) spots.push(['sea-temperature', lon, lat]);
  await dropCharts(page, spots);
  const n = await page.evaluate(() => (window as any).__typhoonLab.probes.pins.length);
  expect(n).toBeGreaterThanOrEqual(8);
  const result = await page.evaluate(async () => {
    const lab = (window as any).__typhoonLab;
    const v = lab.mapView;
    const before = lab.onMapStats;
    for (let i = 0; i < 60; i++) { v.centerOn(125 + Math.sin(i / 6) * 12, 12 + Math.cos(i / 6) * 6); await new Promise(r => requestAnimationFrame(r)); }
    const after = lab.onMapStats;
    return { pins: lab.probes.pins.length, runs: after.runs - before.runs, ms: (after.totalMs - before.totalMs) / Math.max(1, after.runs - before.runs) };
  });
  console.log(`ON-MAP GRAPH COST with ${result.pins} pins: ${result.ms.toFixed(3)} ms per view change over ${result.runs} recomputes`);
  expect(result.ms).toBeLessThan(4);
});

test('graphs on the map at 375: on-screen charts have cards, off-screen ones none, nothing overlaps', async ({ page }) => {
  test.setTimeout(150_000);
  await ready(page, 375, 'ko', 800);
  await dropCharts(page, [['sea-temperature', 140, 10], ['sea-temperature', 132, 4], ['air-temperature', 136, 14]]);
  await armToast(page);
  await longStrips(page);
  await expect.poll(async () => (await cardsOnMap(page)).length).toBeGreaterThanOrEqual(2);
  const cards = await cardsOnMap(page);
  const floats = await floating(page);
  for (const [i, a] of cards.entries()) {
    for (const f of floats) expect(overlaps(a, f), `card ${i} overlaps floating UI`).toBe(false);
    for (const [j, b] of cards.entries()) if (j > i) expect(overlaps(a, b), `cards ${i} and ${j} overlap`).toBe(false);
  }
  await page.screenshot({ path: '/tmp/typhoon-shot/onmap-graphs-ko-375.png' });
  // Pan far away: the spots are off-screen and nothing is drawn for them.
  await page.evaluate(() => (window as any).__typhoonLab.mapView.centerOn(-100, 10));
  await expect.poll(async () => (await cardsOnMap(page)).length).toBe(0);
});
