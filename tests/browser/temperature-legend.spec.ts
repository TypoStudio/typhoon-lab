import { expect, test } from '@playwright/test';

test('one temperature scale shows water and air markers, with water hidden over land', async ({ page }) => {
  await page.goto('/?renderer=canvas&map=flat&lang=ko&help=0&seed=42&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  const pointAt = async (lon: number, lat: number) => {
    const point = await page.evaluate(({ lon, lat }) => {
      const view = (window as any).__typhoonLab.mapView;
      view.setHome(lon, lat, 20);
      return view.lonLatToPx(lon, lat);
    }, { lon, lat });
    const box = (await page.getByTestId('map-stage').boundingBox())!;
    await page.mouse.move(box.x + point[0] + 2, box.y + point[1]);
    await page.mouse.move(box.x + point[0], box.y + point[1]);
  };
  await pointAt(140, 16);
  const legend = page.getByTestId('legend-temperature');
  await expect(legend.locator('.legend__bar')).toHaveCount(1);
  await expect(legend.locator('.legend__tick')).toHaveCount(2);
  await expect(legend.locator('.legend__tick--sea')).toBeVisible();
  await expect(legend.locator('.legend__tick--air')).toBeVisible();
  await expect(page.getByTestId('legend-temperature-sea')).toContainText(/\d+\.\d °C/);
  await expect(page.getByTestId('legend-temperature-air')).toContainText(/\d+\.\d °C/);
  await expect(legend.getByRole('img', { name: '지표 부근 기온' })).toBeVisible();
  await expect(legend.getByRole('img', { name: '해수면 온도' })).toBeVisible();
  const layout = await legend.evaluate(element => {
    const title = element.querySelector('.legend__title')!;
    const air = element.querySelector('.legend__tick--air')!.getBoundingClientRect();
    const sea = element.querySelector('.legend__tick--sea')!.getBoundingClientRect();
    const readings = Array.from(element.querySelectorAll('.legend__temperature-reading'));
    return { inline: readings.every(reading => title.contains(reading)),
      fits: title.scrollWidth <= title.clientWidth, airAboveSea: air.y < sea.y };
  });
  expect(layout).toEqual({ inline: true, fits: true, airAboveSea: true });
  for (const [kind, value] of [['sea', 'legend-temperature-sea'], ['air', 'legend-temperature-air']]) {
    const degrees = Number((await page.getByTestId(value).innerText()).match(/-?\d+\.\d/)![0]);
    const left = await legend.locator(`.legend__tick--${kind}`).evaluate(element => parseFloat((element as HTMLElement).style.left));
    expect(left).toBeCloseTo((degrees + 40) / 80 * 100, 0);
  }
  await pointAt(127, 37);
  await expect(page.getByTestId('legend-temperature-sea')).toContainText('—');
  await expect(legend.locator('.legend__tick--sea')).toBeHidden();
  await expect(legend.locator('.legend__tick--air')).toBeVisible();
});
