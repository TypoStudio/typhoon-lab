import { afterEach, describe, expect, it } from 'vitest';
import { TYPHOONS } from '../src/data/typhoons';
import { setLanguage, t } from '../src/i18n';
import { CLIMATE_SCENARIOS } from '../src/simulation/climate-scenarios';
import { EXPERIENCE_ITEMS, SCENARIO_ICON, activeExperienceKeys, typhoonTipSource } from '../src/ui/experience';

afterEach(() => setLanguage('en'));

describe('Experience palette items', () => {
  it('lists the scenarios first, then every typhoon once, oldest year first', () => {
    expect(EXPERIENCE_ITEMS).toHaveLength(CLIMATE_SCENARIOS.length + TYPHOONS.length);
    expect(EXPERIENCE_ITEMS.slice(0, CLIMATE_SCENARIOS.length).map(i => i.kind)).toEqual(CLIMATE_SCENARIOS.map(() => 'scenario'));
    const typhoons = EXPERIENCE_ITEMS.slice(CLIMATE_SCENARIOS.length);
    expect(new Set(typhoons.map(i => i.id)).size).toBe(TYPHOONS.length);
    const years = typhoons.map(i => TYPHOONS.find(h => h.id === i.id)!.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(new Set(EXPERIENCE_ITEMS.map(i => i.key)).size).toBe(EXPERIENCE_ITEMS.length);
  });
  it('has its own icon for every scenario', () => {
    for (const s of CLIMATE_SCENARIOS) expect(SCENARIO_ICON[s.id]).toContain('<svg');
  });
  it('builds the tooltip from basin, peak pressure and wind, leaving the wind out when it is not recorded', () => {
    expect(typhoonTipSource({ basin: 'Western North Pacific', peakPressure: 910, peakWindMs: 64.6 })).toBe('Western North Pacific · Peak pressure 910 hPa · Peak wind 65 m/s');
    expect(typhoonTipSource({ basin: 'North Atlantic', peakPressure: 905, peakWindMs: null })).toBe('North Atlantic · Peak pressure 905 hPa');
  });
  it('translates the tooltip in every language', () => {
    const source = typhoonTipSource({ basin: 'Western North Pacific', peakPressure: 910, peakWindMs: 65 });
    for (const lang of ['ko', 'ja', 'zh-CN', 'zh-TW'] as const) {
      setLanguage(lang);
      expect(t(source)).not.toMatch(/[A-Za-z]{4}/);
      expect(t(source)).toContain('910 hPa');
    }
  });
  it('marks the loaded scenario and the typhoons that are still running', () => {
    const keys = activeExperienceKeys({
      climateScenario: { id: 'nino-1997', loads: 1, year: 1997 },
      storms: [{ record: { typhoonId: 'maemi-2003', startHour: 0 } }, {}],
    } as never);
    expect([...keys].sort()).toEqual(['scenario:nino-1997', 'typhoon:maemi-2003']);
    expect(activeExperienceKeys({ storms: [] } as never).size).toBe(0);
  });
});
