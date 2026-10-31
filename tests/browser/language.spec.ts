import { test, expect } from '@playwright/test';

test('Korean controls, help, errors and live language changes preserve the world', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByTestId('play-toggle')).toHaveAttribute('aria-label', '일시정지');
  await page.getByTestId('play-toggle').click();
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await expect(page.getByTestId('layer-wind')).toHaveAccessibleName('바람');
  for (const [id, label] of [['humidity', '습도'], ['rain', '강수'], ['pressure', '기압'], ['temperature', '온도'], ['population', '인구']]) {
    await expect(page.getByTestId(`layer-${id}`)).toHaveAccessibleName(label);
    // data-tip-title holds the English key; the opened tooltip is what the player reads.
    await page.getByTestId(`layer-${id}`).hover();
    await expect(page.locator('#tip')).toBeVisible();
    await expect(page.locator('#tip .tip__title')).toHaveText(label);
  }
  await expect(page.getByTestId('tool-warm')).toHaveAttribute('aria-label', /따뜻한 바다/);
  await expect(page.getByTestId('genesis-toggle')).toHaveText('꺼짐');
  await expect(page.getByTestId('recorded-path-toggle')).toHaveText('켜짐');
  await expect(page.getByTestId('historic-load')).toHaveText('불러오기');
  await expect(page.getByTestId('climate-reset')).toHaveText('초기화');
  await expect(page.getByTestId('climate-reset')).toHaveAttribute('data-tip', 'Set ocean warming, ENSO and polar temperature back to 0');
  await expect(page.getByTestId('storm-active-title')).toHaveText('진행 중인 재난 · 0');
  await expect(page.getByTestId('storm-ended-title')).toHaveText('종료된 재난 · 0');
  await expect(page.getByTestId('genesis-toggle')).toHaveAccessibleName('태풍 자연 발생');
  await expect(page.getByTestId('sidebar')).toContainText('과거 태풍');
  await expect(page.getByTestId('recorded-path-toggle')).toHaveAccessibleName('기록 경로');
  await page.getByTestId('tab-environment').click();
  await expect(page.getByTestId('place-confirm')).toHaveCount(0);
  await expect(page.locator('#panel-environment')).toContainText('재난 노출 인구');
  const snapshot = await page.evaluate(() => {
    const { grid, ...rest } = (window as any).__typhoonLab.state;
    return rest;
  });
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#panel-environment')).toContainText('People exposed to disasters');
  await expect(page.getByTestId('layer-wind')).toHaveAccessibleName('Wind');
  for (const [id, label] of [['humidity', 'Humidity'], ['rain', 'Rain'], ['pressure', 'Pressure'], ['temperature', 'Temperature'], ['population', 'Population']]) {
    await expect(page.getByTestId(`layer-${id}`)).toHaveAccessibleName(label);
    // data-tip-title holds the English key; the opened tooltip is what the player reads.
    await page.getByTestId(`layer-${id}`).hover();
    await expect(page.locator('#tip')).toBeVisible();
    await expect(page.locator('#tip .tip__title')).toHaveText(label);
  }
  await page.getByTestId('language-select').selectOption('ko');
  await expect(page.locator('#panel-environment')).toContainText('재난 노출 인구');
  expect(await page.evaluate(() => {
    const { grid, ...rest } = (window as any).__typhoonLab.state;
    return rest;
  })).toEqual(snapshot);
  await page.getByTestId('help-open').click();
  await expect(page.getByTestId('help-dialog')).toContainText('키보드로 조작');
  await expect(page.getByTestId('help-dialog')).toContainText('Q–U 키도 같습니다');
  await expect(page.getByTestId('help-dialog')).toContainText('단축키는 입력란에 글자를 입력하는 중이거나');
  await expect(page.getByTestId('help-close')).toHaveText('확인');
  await page.getByTestId('help-close').click();
  await page.getByTestId('tab-replay').click();
  await page.locator('.replay__paste summary').click();
  await page.getByTestId('import-replay-text').fill('{broken');
  await page.getByTestId('import-replay-paste').click();
  await expect(page.getByTestId('replay-message')).toHaveText('올바른 JSON 파일이 아닙니다.');
  // Preference survives navigation without a language query.
  await page.goto('/?renderer=canvas&help=0&start=2026-08-01');
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.getByTestId('layer-wind')).toHaveAccessibleName('바람');
});

test('Korean browser default and controls fit a 320px screen', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'ko-KR', viewport: { width: 320, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto('/?renderer=canvas&help=0&start=2026-08-01');
    await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    const layout = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      // The phone palette is one sideways-scrolling row; its cells are checked below by scrolling.
      outside: [...document.querySelectorAll('button')].filter(b => {
        if (!b.getClientRects().length || b.closest('.palette__tools')) return false;
        const r = b.getBoundingClientRect();
        return r.left < 0 || r.right > innerWidth;
      }).map(b => b.textContent),
    }));
    expect(layout).toEqual({ scroll: 320, outside: [] });
    const row = page.locator('.palette__tools[data-palette-panel="conditions"]');
    const fits = (loc: typeof row) => loc.evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; });
    expect(await fits(row)).toBe(true);
    const tools = row.locator('[data-tool]');
    const first = tools.first();
    const last = tools.last();
    const inView = (loc: typeof row) => loc.evaluate(el => {
      const r = el.getBoundingClientRect(), h = el.closest('.palette__tools')!.getBoundingClientRect();
      return r.left >= Math.max(0, h.left) && r.right <= Math.min(innerWidth, h.right);
    });
    expect(await inView(first)).toBe(true);
    await last.scrollIntoViewIfNeeded();
    await expect.poll(() => inView(last)).toBe(true);
    expect(await page.getByTestId('clock').evaluate(el => el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await page.getByTestId('sidebar-toggle').click();
    await expect(page.getByTestId('language-select')).toBeVisible();
    await page.getByTestId('language-select').selectOption('en');
    await expect(page.getByTestId('tab-storms')).toHaveText('Disasters');
    await page.getByTestId('language-select').selectOption('ko');
    if (process.env.TYPHOON_SCREENSHOTS === '1') await page.screenshot({ path: 'test-results/korean-320.png' });
  } finally { await context.close(); }
});

test('storm news and replay results are Korean while the simulation remains unchanged', async ({ page }) => {
  await page.goto('/?renderer=canvas&lang=ko&help=0&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  const initial = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { scenarioId: s.scenarioId, version: s.version, seed: s.seed };
  });
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('tab-replay').click();
  const replay = { ...initial, format: 'typhoon-lab-replay', formatVersion: 6, startDayOfYear: 213, untilTick: 80,
    actions: ['warm', 'moisture', 'low'].map(type => ({ tick: 0, type, lon: 140, lat: 16 })) };
  await page.getByTestId('import-replay-input').setInputFiles({ name: 'storm.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(replay)) });
  await expect(page.getByTestId('replay-message')).toHaveText('틱 80까지 다시 보기를 불러와 일시정지했습니다. 계속하려면 재생을 누르십시오.');
  const stormId = await page.evaluate(() => (window as any).__typhoonLab.state.storms[0].id);
  await page.getByTestId('tab-news').click();
  await expect(page.getByTestId('news-list')).toContainText(`열대저기압 #${stormId} 발생`);
  await expect(page.getByTestId('news-list')).not.toContainText('Tropical Depression');
  await page.getByTestId('language-select').selectOption('en');
  await expect(page.getByTestId('news-list')).toContainText(`Tropical Depression #${stormId} forms`);
  const after = await page.evaluate(() => {
    const s = (window as any).__typhoonLab.state;
    return { tick: s.tick, actions: s.actions, formation: s.news.find((n: any) => n.kind === 'formation').title };
  });
  expect(after).toEqual({ tick: 80, actions: replay.actions, formation: `Tropical Depression #${stormId} forms` });
});
