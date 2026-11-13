import { expect, test, type Page } from '@playwright/test';

const SHOTS = '/tmp/typhoon-shot';

async function loadHinnamnor(page: Page, map: 'globe' | 'flat') {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(map === 'flat' ? '/?renderer=canvas&lang=ko&help=0&start=2026-08-01&map=flat' : '/?lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('palette-tab-typhoons').click();
  await page.getByTestId('experience-typhoon-hinnamnor-2022').click();
  await expect.poll(() => page.evaluate(() => (window as any).__typhoonLab.state.storms.length)).toBeGreaterThan(0);
  // Skip ahead until the recorded storm has grown into a strong typhoon.
  for (let i = 0; i < 60 && (await page.evaluate(() => (window as any).__typhoonLab.state.storms[0]?.wind ?? 0)) < 50; i++) {
    await expect(page.getByTestId('skip-4h')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('skip-4h').click();
    await page.waitForTimeout(150);
  }
  await page.getByTestId('sidebar-toggle').click();
}

/** Centres the first storm and sets the web zoom. */
async function frame(page: Page, zoom: number) {
  await page.evaluate(z => {
    const lab = (window as any).__typhoonLab;
    const v = lab.mapView;
    const s = lab.state.storms[0];
    const target = (Math.pow(2, z) * 256) / 360;
    // Step towards the target, re-centring on the storm each time so it never leaves the globe's visible disc.
    for (let i = 0; i < 40 && Math.abs(Math.log(target / v.scale)) > 0.01; i++) {
      const [px, py] = v.lonLatToPx(s.lon, s.lat);
      v.dragPx?.(px, py, v.width / 2, v.height / 2);
      v.zoomAt(Math.min(1.3, Math.max(1 / 1.3, target / v.scale)), v.width / 2, v.height / 2);
    }
    const [px, py] = v.lonLatToPx(s.lon, s.lat);
    v.dragPx?.(px, py, v.width / 2, v.height / 2);
  }, zoom);
  await page.waitForTimeout(400);
}

const stormBoxes = (page: Page) => page.evaluate(() => {
  const o = (window as any).__typhoonLab.overlayObstacles;
  const v = (window as any).__typhoonLab.mapView;
  const s = (window as any).__typhoonLab.state.storms[0];
  const [px, py] = v.lonLatToPx(s.lon, s.lat);
  // The glyph box is centred on the storm; the label box starts beside it.
  const near = (o.hard as number[][]).filter(b => b[2] >= px - 400 && b[0] <= px + 400 && b[3] >= py - 60 && b[1] <= py + 60);
  return { px, py, boxes: near };
});

for (const map of ['globe', 'flat'] as const) {
  test(`far zoom: storm glyph is small and its label is one line (${map})`, async ({ page }) => {
    test.setTimeout(240_000);
    await loadHinnamnor(page, map);
    await frame(page, 2.6);
    const { px, py, boxes } = await stormBoxes(page);
    const glyph = boxes.find(b => b[0] < px && b[2] > px && b[1] < py && b[3] > py)!;
    expect(glyph, 'glyph box').toBeTruthy();
    expect(glyph[2] - glyph[0]).toBeLessThan(18);
    const label = boxes.find(b => b !== glyph && b[0] >= px && b[3] - b[1] <= 20)!;
    expect(label, 'one-line label box').toBeTruthy();
    expect(label[3] - label[1]).toBeLessThanOrEqual(20);
    await frame(page, 6.5);
    const near = await stormBoxes(page);
    const g2 = near.boxes.find(b => b[0] < near.px && b[2] > near.px && b[1] < near.py && b[3] > near.py)!;
    expect(g2[2] - g2[0]).toBeGreaterThan(glyph[2] - glyph[0]);
    const label2 = near.boxes.find(b => b !== g2 && b[3] - b[1] > 20);
    expect(label2, 'two-line label near').toBeTruthy();
  });
}

test('screenshots at three zoom levels (globe, ko)', async ({ page }) => {
  test.setTimeout(240_000);
  await loadHinnamnor(page, 'globe');
  for (const [name, zoom] of [['far', 2.6], ['mid', 4.4], ['near', 6.2]] as const) {
    await frame(page, zoom);
    await page.screenshot({ path: `${SHOTS}/storm-zoom-ko-${name}.png` });
  }
});
