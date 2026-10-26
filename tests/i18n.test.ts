import { afterEach, describe, expect, it } from 'vitest';
import { SEAS } from '../src/data/seas';
import { LOCALES, cityLabel, detectLanguage, setLanguage, t, typhoonName, type Language } from '../src/i18n';
import { ko, koTemplates } from '../src/locales/ko';
import { createGame, loadHistoric, setHistoricEnvironment } from '../src/simulation/engine';
import type { HistoricEnvironment } from '../src/types';
import fixtureJson from './fixtures/environment-fixture.json';

afterEach(() => setLanguage('en'));
describe('Korean display translations', () => {
  it('keeps English intact and translates nested storm news, errors and units', () => {
    const news = '#3 upgraded to Very Strong Typhoon';
    expect(t(news)).toBe(news);
    setLanguage('ko');
    expect(t(news)).toBe('#3이 매우 강한 태풍 단계로 발달');
    expect(t('Maemi Severe Tropical Storm makes landfall near Sapporo')).toBe('매미 강한 열대폭풍, 삿포로 부근에 상륙');
    expect(t('Maemi Typhoon makes landfall')).toBe('매미 태풍 상륙');
    expect(t('Maemi upgraded to Typhoon')).toBe('매미, 태풍 단계로 발달');
    expect(t('Hinnamnor ends')).toBe('힌남노 기록 종료');
    expect(t('#3 Typhoon makes landfall near Sapporo')).toBe('#3 태풍, 삿포로 부근에 상륙');
    expect(t('Replay not loaded: The file is not valid JSON.')).toBe('다시 보기를 불러오지 못했습니다: 올바른 JSON 파일이 아닙니다.');
    expect(t('Warm water placed at 140.00°E 16.00°N.')).toBe('따뜻한 바다 조건을 동경 140.00° 북위 16.00°에 배치했습니다.');
    expect(t('Day 2 · 03:15')).toBe('2일째 · 03:15');
    expect(t('Day 2 · 03:15 · Watch')).toBe('2일째 · 03:15 · 관측');
    expect(t('140°E 16°N · sea · wind 12 m/s')).toBe('동경 140° 북위 16° · 바다 · 풍속 12 m/s');
    expect(t('37h')).toBe('37시간');
    expect(t('No storms yet. 2 patches are forming.')).toContain('2개 구역');
    expect(t('2 active storms · 1 forming.')).toBe('활동 중인 태풍 2개 · 발생 준비 1개');
    expect(t('Tropical Depression #2 forms')).toBe('열대저기압 #2 발생');
    expect(t('Grade 7 Typhoon')).toBe('7등급 태풍');
    expect(t('Grade 7 · Grade 8 Cyclone · 3.0 h')).toBe('7등급 · 8등급 사이클론 · 3.0시간');
    expect(t('Gales reach Tokyo')).toBe('도쿄에 강풍 도달');
    expect(t('Unexpected field "constructor".')).toBe('허용되지 않은 필드 "constructor"입니다.');
    expect(t('Replay rejected: Action 1 was rejected at hour 0: Warm water must be placed over the ocean.')).toBe('다시 보기가 거부되었습니다: 0시간 시점의 기록 1번이 거부되었습니다: 따뜻한 바다 조건은 바다에 배치해야 합니다.');
    setLanguage('en');
    expect(t(news)).toBe(news);
  });
  it('translates the historic-load news completely, with and without an environment record', () => {
    const only = (text: string) => text.replace(/NCEP\/NCAR|ERSST|JMA|v5/g, '');
    for (const loaded of [false, true]) {
      setLanguage('en');
      setHistoricEnvironment('maemi-2003', loaded ? fixtureJson as unknown as HistoricEnvironment : null);
      const world = createGame(1);
      loadHistoric(world, 'maemi-2003');
      const { title, text } = world.news.at(-1)!;
      setLanguage('ko');
      expect(t(title)).toBe('매미 (2003)');
      expect(t(text)).toContain(loaded ? 'NCEP/NCAR 재분석 1과 ERSST v5' : '기본 기후');
      expect(only(t(text))).not.toMatch(/[A-Za-z]/);
    }
    setHistoricEnvironment('maemi-2003', null);
  });
  it('translates replay errors, the track-end bulletin and money-bearing strings', () => {
    setLanguage('ko');
    expect(t('Unknown typhoon.')).toBe('알 수 없는 태풍입니다.');
    expect(t('The recorded track ends at 138.4°E 39.0°N after 156 hours. Peak 51 m/s.')).toBe('기록상 경로는 156시간 후 동경 138.4° 북위 39.0°에서 끝납니다. 최고 풍속은 51 m/s였습니다.');
    expect(t('Estimated loss: 16억 원')).toBe('추정 피해액: 16억 원');
    expect(t('Estimated loss: USD 1,000')).toBe('추정 피해액: USD 1,000');
    // The live-region announcement translates title and text separately so templates cannot straddle them.
    const announcement = `${t('News')}: ${t('Maemi upgraded to Typhoon')}. ${t('Gales reach Tokyo')}`;
    expect(announcement).toBe('소식: 매미, 태풍 단계로 발달. 도쿄에 강풍 도달');
    expect(t(announcement)).toBe(announcement);
  });
  it('preserves all template parameters, including reordered clauses, in every locale', () => {
    const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/g)].map(x => x[0]).sort();
    for (const locale of LOCALES.filter(l => l.code !== 'en')) {
      for (const [source, target] of Object.entries(locale.templates)) {
        expect(placeholders(target), `${locale.code}: ${source}`).toEqual(placeholders(source));
      }
    }
  });
});

describe('locale registry', () => {
  it('lists every language once with a native label and an html lang', () => {
    expect(LOCALES.map(l => l.code)).toEqual(['en', 'ko', 'ja', 'zh-CN', 'zh-TW']);
    expect(LOCALES.map(l => l.label)).toEqual(['English', '한국어', '日本語', '简体中文', '繁體中文']);
    for (const l of LOCALES) expect(l.htmlLang).toBe(l.code);
  });

  it('detects the browser language', () => {
    const cases: [string, Language][] = [
      ['ko-KR', 'ko'], ['ja', 'ja'], ['ja-JP', 'ja'], ['zh-CN', 'zh-CN'], ['zh', 'zh-CN'], ['zh-Hans-CN', 'zh-CN'], ['zh-SG', 'zh-CN'],
      ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant', 'zh-TW'], ['zh-Hant-TW', 'zh-TW'], ['en-US', 'en'], ['fr', 'en'],
    ];
    for (const [tag, expected] of cases) expect(detectLanguage(tag), tag).toBe(expected);
  });

  it('leaves untranslated text alone in every locale', () => {
    for (const l of LOCALES) {
      setLanguage(l.code);
      expect(t('Zzz untranslated')).toBe('Zzz untranslated');
    }
  });

  it('translates a few strings per locale', () => {
    const expected: Record<string, [string, string, string]> = {
      ja: ['台風ラボ', '過去の台風', '言語'],
      'zh-CN': ['台风实验室', '历史台风', '语言'],
      'zh-TW': ['颱風實驗室', '歷史颱風', '語言'],
    };
    for (const [code, values] of Object.entries(expected)) {
      setLanguage(code as Language);
      expect(['Typhoon Lab', 'Past typhoon', 'Language'].map(s => t(s)), code).toEqual(values);
    }
  });

  it('formats coordinates and hours without a table entry', () => {
    const expected: Record<string, [string, string]> = {
      ko: ['동경 140.00° 북위 16.00°', '37시간'],
      ja: ['東経140.00° 北緯16.00°', '37時間'],
      'zh-CN': ['东经140.00° 北纬16.00°', '37小时'],
      'zh-TW': ['東經140.00° 北緯16.00°', '37小時'],
    };
    for (const [code, [coordinates, hours]] of Object.entries(expected)) {
      setLanguage(code as Language);
      expect(t('140.00°E 16.00°N'), code).toBe(coordinates);
      expect(t('37h'), code).toBe(hours);
    }
  });

  it('labels cities and typhoons per language with English fallback', () => {
    const seoulville = { name: 'Seoulville', nameKo: '서울빌', names: { ja: 'ソウルビル', 'zh-CN': '首尔维尔', 'zh-TW': '首爾維爾' } };
    expect(cityLabel(seoulville)).toBe('Seoulville');
    for (const [code, label] of [['ko', '서울빌'], ['ja', 'ソウルビル'], ['zh-CN', '首尔维尔'], ['zh-TW', '首爾維爾']] as const) {
      setLanguage(code);
      expect(cityLabel(seoulville), code).toBe(label);
      expect(cityLabel({ name: 'Nowhereville' }), code).toBe('Nowhereville');
      expect(cityLabel({ name: 'Nowhereville', names: { ja: '' } }), code).toBe('Nowhereville');
    }
    setLanguage('ja');
    expect(typhoonName({ name: 'Maemi', nameKo: '매미' })).toBe(t('Maemi'));
    expect(typhoonName({ name: 'Unlisted', nameKo: '미등록' })).toBe('Unlisted');
    setLanguage('ko');
    expect(typhoonName({ name: 'Maemi', nameKo: '매미' })).toBe('매미');
  });
});

describe('translation key coverage', () => {
  it('has every ko key (and no extra key) in each other locale', () => {
    const seaNames = new Set(SEAS.map(s => s.name));
    const report: string[] = [];
    for (const locale of LOCALES.filter(l => l.code !== 'en' && l.code !== 'ko')) {
      const check = (label: string, expectedKeys: string[], actual: Record<string, string>, allowed: Set<string> = new Set()) => {
        const have = new Set(Object.keys(actual));
        const want = new Set(expectedKeys);
        const missing = expectedKeys.filter(k => !have.has(k));
        const extra = [...have].filter(k => !want.has(k) && !allowed.has(k));
        if (missing.length) report.push(`${locale.code} ${label} missing ${missing.length}: ${missing.join(' | ')}`);
        if (extra.length) report.push(`${locale.code} ${label} extra ${extra.length}: ${extra.join(' | ')}`);
        const empty = Object.entries(actual).filter(([, v]) => !v.trim()).map(([k]) => k);
        if (empty.length) report.push(`${locale.code} ${label} empty ${empty.length}: ${empty.join(' | ')}`);
      };
      // Sea names may sit in the main table or in a separate `<code>Seas` map; both are accepted.
      check('table', Object.keys(ko), locale.table, seaNames);
      check('templates', Object.keys(koTemplates), locale.templates);
      const seaMap = { ...locale.table, ...locale.seas };
      const seaMissing = SEAS.map(s => s.name).filter(n => !Object.hasOwn(seaMap, n));
      if (seaMissing.length) report.push(`${locale.code} seas missing ${seaMissing.length}: ${seaMissing.join(' | ')}`);
    }
    expect(report.join('\n'), report.join('\n')).toBe('');
  });
});
