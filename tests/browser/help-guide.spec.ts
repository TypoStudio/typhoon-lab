import { expect, test } from '@playwright/test';

test('condition text and all disaster guides translate independently in every language', async ({ page }) => {
  test.setTimeout(60_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?renderer=canvas&map=flat&lang=en&help=0&weather=base&start=2026-08-01');
  await expect(page.getByTestId('app')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('play-toggle').click();
  if (!(await page.getByTestId('sidebar').isVisible())) await page.getByTestId('sidebar-toggle').click();
  const sources = await page.evaluate(async () => {
    const enginePath = '/src/simulation/engine.ts', helpPath = '/src/ui/disaster-help.ts';
    const { TOOLS } = await import(enginePath);
    const { DISASTER_HELP } = await import(helpPath);
    return { tools: TOOLS, disasters: DISASTER_HELP };
  });
  for (const language of ['ko', 'ja', 'zh-CN', 'zh-TW', 'en']) {
    await page.getByTestId('language-select').selectOption(language);
    await page.getByTestId('help-open').click();
    await page.getByTestId('help-tab-conditions').click();
    const conditions = page.getByTestId('help-panel-conditions');
    await expect(conditions.locator('[data-help-condition]')).toHaveCount(14);
    const conditionText = await conditions.locator('[data-help-condition]').evaluateAll(entries => entries.map(entry => ({
      type: entry.getAttribute('data-help-condition'), name: entry.querySelector('strong')!.textContent!.trim(), description: entry.querySelector('span')!.textContent!.trim(),
    })));
    for (const tool of sources.tools) {
      const { name, description } = conditionText.find(entry => entry.type === tool.type)!;
      if (language === 'en') {
        expect(name).toBe(tool.name); expect(description).toBe(tool.description);
      } else {
        expect(name, `${language}: ${tool.type} name`).not.toBe(tool.name);
        expect(description, `${language}: ${tool.type} description`).not.toBe(tool.description);
      }
    }
    await page.getByTestId('help-tab-disasters').click();
    const disasters = page.getByTestId('help-panel-disasters');
    await expect(disasters).toBeVisible();
    await expect(disasters.locator('[data-help-disaster]')).toHaveCount(11);
    const disasterText = await disasters.locator('[data-help-disaster]').evaluateAll(entries => entries.map(entry => ({
      kind: entry.getAttribute('data-help-disaster'), text: [entry.querySelector('h3 span')!.textContent!.trim(),
        entry.querySelector('p span')!.textContent!.trim(), entry.querySelector('p:last-child')!.textContent!.trim()],
    })));
    for (const guide of sources.disasters) {
      const { text } = disasterText.find(entry => entry.kind === guide.kind)!;
      const original = [guide.name, guide.conditions, guide.description];
      for (let i = 0; i < text.length; i++) {
        if (language === 'en') expect(text[i]).toBe(original[i]);
        else expect(text[i], `${language}: ${guide.kind}`).not.toBe(original[i]);
      }
    }
    await page.getByTestId('help-close').click();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  if (await page.getByTestId('sidebar').isVisible()) await page.getByTestId('sidebar-toggle').click();
  await page.getByTestId('help-open').click();
  await page.getByTestId('help-tab-disasters').click();
  expect(await page.getByTestId('help-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1)).toBe(true);
  expect(await page.locator('[data-help-disaster]').evaluateAll(entries => entries.every(entry => entry.scrollWidth <= entry.clientWidth + 1))).toBe(true);
  await page.getByTestId('help-close').click();
  expect(errors).toEqual([]);
});
