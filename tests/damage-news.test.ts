import { afterEach, describe, expect, it } from 'vitest';
import { CITIES } from '../src/data/world';
import { estimateCityDamage, cityDamageBulletin } from '../src/simulation/damage-news';
import { cityLabel, registerNames, setLanguage, t } from '../src/i18n';
import { NEWS_MIN_CITY_POPULATION, createGame, loadHistoric, stepGame } from '../src/simulation/engine';
import { ORIGINAL_CITY_IDS } from './fixtures/original-cities';

const city = CITIES.find(c => c.id === 'manila')!;
const impact = { id: city.id, score: 0, damage: 0, exposedPopulation: 0, maxWind: 0, blizzardHours: 0 };
afterEach(() => setLanguage('en'));

describe('fictional city damage bulletins', () => {
  it('starts at zero and bounds people and homes by the exposed population', () => {
    expect(estimateCityDamage(city, impact)).toMatchObject({ displaced: 0, missing: 0, deaths: 0, floodedHomes: 0, lossUsd: 0 });
    for (const score of [100, 10_000, city.population, city.population * 10]) {
      const report = estimateCityDamage(city, { ...impact, score, exposedPopulation: 50_000 });
      expect(report.displaced + report.missing + report.deaths).toBeLessThanOrEqual(50_000);
      expect(report.missing).toBeLessThanOrEqual(report.deaths);
      expect(report.floodedHomes).toBeLessThanOrEqual(report.displaced);
      for (const value of [report.displaced, report.missing, report.deaths, report.floodedHomes, report.lossUsd]) {
        expect(Number.isSafeInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('grows cumulative estimates without mutating earlier bulletins or rerolling locations', () => {
    const first = cityDamageBulletin(city, { ...impact, score: 100_000, damage: 100_000, exposedPopulation: 1_000_000, maxWind: 40 }, 1);
    const saved = structuredClone(first);
    const next = cityDamageBulletin(city, { ...impact, score: 500_000, exposedPopulation: 2_000_000, maxWind: 50 }, 2);
    expect(first).toEqual(saved);
    expect(next.damage.area).toBe(first.damage.area);
    for (const key of ['displaced', 'missing', 'deaths', 'floodedHomes', 'lossUsd'] as const) expect(next.damage[key]).toBeGreaterThan(first.damage[key]);
    expect(cityDamageBulletin(city, { ...impact, score: 100_000, damage: 100_000, exposedPopulation: 1_000_000, maxWind: 40 }, 1)).toEqual(saved);
  });

  it('translates the whole incident and metric units without losing city or numbers', () => {
    const report = cityDamageBulletin(city, { ...impact, score: 100_000, damage: 100_000, exposedPopulation: 1_000_000, maxWind: 40 }, 1);
    setLanguage('ko');
    expect(t(report.title)).toContain('마닐라');
    expect(t(report.text)).toContain('침수 피해가 발생했습니다');
    expect(t(report.text)).toContain('40 m/s');
    expect(t(report.text)).not.toMatch(/Flooding|residential|Roads|Peak/);
    expect(t('35,000 people')).toBe('35,000명');
    expect(t('7,583 homes')).toBe('7,583채');
  });

  it('translates cities that have no ko.ts entry through registered Korean names', () => {
    const daegu = CITIES.find(c => c.id === 'daegu')!;
    registerNames({ [daegu.name]: daegu.nameKo! });
    const bulletin = cityDamageBulletin(daegu, { id: daegu.id, score: 100_000, damage: 100_000, exposedPopulation: 1_000_000, maxWind: 40, blizzardHours: 0 }, 1);
    setLanguage('ko');
    expect(t('Gales reach Daegu')).toBe('대구에 강풍 도달');
    expect(t(bulletin.title)).toContain('대구');
    expect(t(bulletin.text)).toContain('대구');
    expect(cityLabel(daegu)).toBe('대구');
    expect(cityLabel({ name: 'Nowhereville', nameKo: '노웨어빌' })).toBe('노웨어빌');
    expect(cityLabel({ name: 'Nowhereville' })).toBe('Nowhereville');
    expect(cityLabel(city)).toBe('마닐라');
    setLanguage('en');
    expect(cityLabel(daegu)).toBe('Daegu');
  });
});

describe('city news is limited to large cities', () => {
  it('damages and counts small cities but only reports cities of 1 M or more', () => {
    const s = createGame(1);
    expect(loadHistoric(s, 'maemi-2003')).toEqual({ ok: true });
    while (!s.historic.every(h => h.finished) && s.tick < 400_000) stepGame(s);
    const index = new Map(CITIES.map((c, i) => [c.id, i]));
    const damaged = CITIES.filter((c, i) => s.cities[i].score > 0);
    const small = damaged.filter(c => c.population < NEWS_MIN_CITY_POPULATION);
    const large = damaged.filter(c => c.population >= NEWS_MIN_CITY_POPULATION);
    expect(small.length).toBeGreaterThan(0);
    expect(large.length).toBeGreaterThan(0);
    const reported = new Set(s.news.filter(n => n.kind === 'city').map(n => n.cityId!));
    for (const id of reported) expect(CITIES[index.get(id)!].population, id).toBeGreaterThanOrEqual(NEWS_MIN_CITY_POPULATION);
    for (const c of small) expect(reported.has(c.id), c.id).toBe(false);
    expect(large.some(c => reported.has(c.id))).toBe(true);
    // Cities beyond the original 71 are part of the damage model now.
    const originals = new Set(ORIGINAL_CITY_IDS);
    expect(damaged.filter(c => !originals.has(c.id)).length).toBeGreaterThanOrEqual(5);
  }, 60_000);
});
