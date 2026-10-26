import { describe, expect, it } from 'vitest';
import { TYPHOONS, TYPHOON_SOURCE, TYPHOON_SOURCES, typhoonById } from '../src/data/typhoons';

const JMA_IDS = ['5914', '0215', '0314', '0711', '1007', '1215', '1216', '1618', '1913', '1918', '2211', '7920', '1330', '1822'];
// Galveston 1900 (AL031900) and Bhola 1970 have no pressure in their records, so they are not bundled.
const NHC_IDS = ['AL091969', 'AL041992', 'AL131998', 'AL122005', 'AL252005', 'AL182012', 'AL092017', 'AL112017', 'AL152017', 'AL052019', 'AL092022', 'EP202015', 'EP182023'];
const IBTRACS_IDS = ['1999298N12099', '2007151N14072', '2007314N10093', '2008117N11090', '2019116N02090', '2020136N10088', '2019063S18038', '2023036S12117', '1974354S08135', '2016041S14170', '2015066S08170', '2011028S13180', '2004086S29318'];
const idsOf = (agency: string) => TYPHOONS.filter(t => t.agency === agency).map(t => t.jmaId).sort();

describe('bundled best-track typhoons', () => {
  it('has the JMA, NHC and IBTrACS storms, ordered by year, with unique ids', () => {
    expect(idsOf('JMA')).toEqual([...JMA_IDS].sort());
    expect(idsOf('NHC')).toEqual([...NHC_IDS].sort());
    expect(idsOf('IBTrACS')).toEqual([...IBTRACS_IDS].sort());
    expect(TYPHOONS).toHaveLength(JMA_IDS.length + NHC_IDS.length + IBTRACS_IDS.length);
    expect(new Set(TYPHOONS.map(t => t.id)).size).toBe(TYPHOONS.length);
    expect(TYPHOONS.map(t => t.year)).toEqual([...TYPHOONS.map(t => t.year)].sort((a, b) => a - b));
    for (const t of TYPHOONS) expect(t.basin.length).toBeGreaterThan(0);
  });

  it('names its sources, licences and archive hashes', () => {
    expect(TYPHOON_SOURCE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(TYPHOON_SOURCE.licence).toContain('JMA Public Data License');
    expect(TYPHOON_SOURCE.url).toContain('jma.go.jp');
    expect(TYPHOON_SOURCES[0]).toEqual(TYPHOON_SOURCE);
    for (const host of ['jma.go.jp', 'nhc.noaa.gov', 'ncei.noaa.gov']) expect(TYPHOON_SOURCES.some(s => s.url.includes(host))).toBe(true);
    for (const s of TYPHOON_SOURCES) {
      expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(s.licence.length).toBeGreaterThan(0);
      expect(s.fetchedAt).toMatch(/^\d{4}-\d\d-\d\d$/);
    }
  });

  for (const t of TYPHOONS) {
    it(`${t.id} has a sane track`, () => {
      expect(t.points.length).toBeGreaterThanOrEqual(4);
      expect(t.nameKo.length).toBeGreaterThan(0);
      for (let k = 0; k < t.points.length; k++) {
        const p = t.points[k];
        if (k > 0) expect(Date.parse(p.t)).toBeGreaterThan(Date.parse(t.points[k - 1].t));
        expect(p.t).toMatch(/^\d{4}-\d\d-\d\dT\d\d:00:00Z$/);
        // Extratropical rows run past 60°N (Hinnamnor 61.7°N), so the bound is wider than the tropics.
        expect(p.lat).toBeGreaterThanOrEqual(-70);
        expect(p.lat).toBeLessThanOrEqual(70);
        if (t.agency === 'JMA') expect(p.lon >= 100 && p.lon <= 200 || p.lon <= -160).toBe(true);
        else { expect(p.lon).toBeGreaterThanOrEqual(-180); expect(p.lon).toBeLessThanOrEqual(180); }
        expect(p.pressure).toBeGreaterThanOrEqual(850);
        expect(p.pressure).toBeLessThanOrEqual(1020);
        if (p.windMs !== null) {
          expect(p.windMs).toBeGreaterThanOrEqual(t.agency === 'JMA' ? 10 : 4); // NHC / IBTrACS tracks also start as weak disturbances
          expect(p.windMs).toBeLessThanOrEqual(90);
        }
        expect(['TD', 'TS', 'STS', 'TY', 'L']).toContain(p.grade);
      }
      expect(t.peakPressure).toBe(Math.min(...t.points.map(p => p.pressure)));
    });
  }

  it('keeps the known peaks and treats pre-1977 wind as missing, not zero', () => {
    expect(typhoonById('sarah-1959')!.peakWindMs).toBeNull();
    expect(typhoonById('sarah-1959')!.points.every(p => p.windMs === null)).toBe(true);
    expect(typhoonById('tip-1979')!.peakPressure).toBe(870);
    expect(typhoonById('maemi-2003')!.peakPressure).toBe(910);
    expect(typhoonById('nope')).toBeUndefined();
  });

  it('keeps the known peaks of the NHC and IBTrACS storms, with winds converted to 10-minute m/s', () => {
    expect(typhoonById('katrina-2005')).toMatchObject({ jmaId: 'AL122005', agency: 'NHC', basin: 'North Atlantic', nameKo: '카트리나', peakPressure: 902, peakWindMs: 71.8 }); // 150 kt * 0.514444 * 0.93
    expect(typhoonById('wilma-2005')!.peakPressure).toBe(882);
    expect(typhoonById('patricia-2015')).toMatchObject({ agency: 'NHC', basin: 'Eastern North Pacific', peakPressure: 872 });
    expect(typhoonById('tracy-1974')).toMatchObject({ agency: 'IBTrACS', basin: 'Australian region', peakPressure: 950 });
    expect(typhoonById('odisha-1999')).toMatchObject({ agency: 'IBTrACS', basin: 'North Indian Ocean', peakPressure: 912 });
    expect(typhoonById('galveston-1900')).toBeUndefined();
    expect(typhoonById('bhola-1970')).toBeUndefined();
  });
});
