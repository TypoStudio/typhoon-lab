import { expect, type Page } from '@playwright/test';
import { TIME_SPEEDS, timeSpeedLabel, type TimeSpeed } from '../../src/time';

/** Drive the two arrow controls as a player without slow repeated pointer travel. */
export async function setSpeed(page: Page, target: TimeSpeed): Promise<void> {
  await page.evaluate(({ wanted, speeds, labels }) => {
    const value = document.querySelector<HTMLOutputElement>('[data-testid="speed-value"]')!;
    const next = document.querySelector<HTMLButtonElement>('[data-testid="speed-next"]')!;
    const previous = document.querySelector<HTMLButtonElement>('[data-testid="speed-prev"]')!;
    const read = () => speeds[labels.indexOf(value.textContent!)];
    for (let n = 0; read() !== wanted && n < speeds.length; n++) (read() < wanted ? next : previous).click();
    if (read() !== wanted) throw new Error(`Could not select ${wanted} game seconds per real second`);
  }, { wanted: target, speeds: [...TIME_SPEEDS], labels: TIME_SPEEDS.map(timeSpeedLabel) });
  await expect(page.getByTestId('speed-value')).toHaveText(timeSpeedLabel(target));
}
