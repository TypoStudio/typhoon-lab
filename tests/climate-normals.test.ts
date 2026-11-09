import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { equatorNormalSst } from '../src/data/climate-normals';

interface Fixture {
  nino34Start: string;
  nino34: number[];
  profileLonsEast: number[];
  equatorProfiles: Record<string, number[]>;
}
const fixture: Fixture = JSON.parse(readFileSync(new URL('./fixtures/enso-observed.json', import.meta.url), 'utf8'));
const months = Array.from({ length: 12 }, (_, m) => m);
const nino = (year: number, month: number) => fixture.nino34[(year - 1950) * 12 + month];
const djf = (startYear: number) => (nino(startYear, 11) + nino(startYear + 1, 0) + nino(startYear + 1, 1)) / 3;

describe('equatorial SST normals', () => {
  it('western Pacific warm pool is 28.5-30.5 C all year', () => {
    for (const m of months) {
      const v = equatorNormalSst(m, 160);
      expect(v).toBeGreaterThan(28.5);
      expect(v).toBeLessThan(30.5);
    }
  });

  it('95W is coldest in Aug-Oct, warmest in Mar-Apr, within 21-28 C', () => {
    const v = months.map((m) => equatorNormalSst(m, 265));
    expect(Math.min(...v)).toBeGreaterThan(21);
    expect(Math.max(...v)).toBeLessThan(28);
    expect([7, 8, 9]).toContain(v.indexOf(Math.min(...v)));
    expect([2, 3]).toContain(v.indexOf(Math.max(...v)));
  });

  it('cold tongue at 140W is colder than 160E in every month', () => {
    for (const m of months) expect(equatorNormalSst(m, 220)).toBeLessThan(equatorNormalSst(m, 160));
  });

  it('interpolates cyclically between months', () => {
    expect(equatorNormalSst(12, 200)).toBeCloseTo(equatorNormalSst(0, 200), 10);
    const mid = equatorNormalSst(11.5, 200);
    expect(mid).toBeCloseTo((equatorNormalSst(11, 200) + equatorNormalSst(0, 200)) / 2, 10);
  });

  it('throws over land', () => {
    expect(() => equatorNormalSst(0, 25)).toThrow();
  });
});

describe('observed ENSO fixture', () => {
  it('has Jan 1950 to Dec 2024 monthly Nino-3.4', () => {
    expect(fixture.nino34Start).toBe('1950-01');
    expect(fixture.nino34).toHaveLength(900);
  });

  it('shows the 1997/98 El Nino and 2010/11 La Nina', () => {
    expect(djf(1997)).toBeGreaterThanOrEqual(2.0);
    expect(djf(2010)).toBeLessThanOrEqual(-1.0);
  });

  it('has a plausible standard deviation', () => {
    const mean = fixture.nino34.reduce((a, b) => a + b, 0) / 900;
    const std = Math.sqrt(fixture.nino34.reduce((a, b) => a + (b - mean) ** 2, 0) / 900);
    expect(std).toBeGreaterThan(0.6);
    expect(std).toBeLessThan(1.1);
  });

  it('1997/98 equatorial warming peaks east of 150W', () => {
    const p = fixture.equatorProfiles['DJF 1997/98'];
    const max = Math.max(...p);
    expect(max).toBeGreaterThanOrEqual(3);
    expect(fixture.profileLonsEast[p.indexOf(max)]).toBeGreaterThan(210);
  });
});
