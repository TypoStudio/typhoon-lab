import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface Env {
  typhoonId: string;
  source: { reanalysis: string; sst: string; urls: string[]; fetchedAt: string };
  lons: number[];
  lats: number[];
  days: string[];
  scale: Record<string, number>;
  fields: Record<'sst' | 'air' | 'rhum' | 'slp' | 'u' | 'v', (number | null)[][]>;
}
interface Storm { id: string; points: { t: string }[] }

const read = (rel: string) => JSON.parse(readFileSync(new URL(`../src/data/generated/${rel}`, import.meta.url), 'utf8'));
interface Listed extends Storm { agency: string }
const all: Listed[] = read('typhoons.json').typhoons;
// Only the JMA (western Pacific) storms have a reanalysis environment; the NHC and IBTrACS storms fall back to the base climate.
const storms: Listed[] = all.filter(s => s.agency === 'JMA');
const envs = new Map<string, Env>(storms.map(s => [s.id, read(`environment/${s.id}.json`) as Env]));

const RANGES: Record<string, [number, number]> = {
  sst: [-2, 35], air: [-40, 45], rhum: [0, 100], slp: [850, 1080], u: [-60, 60], v: [-60, 60],
};
const day = (t: string) => t.slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

describe('historical environment data', () => {
  it('has a file for every JMA storm', () => {
    expect(storms.length).toBeGreaterThan(0);
    expect(envs.size).toBe(storms.length);
  });

  for (const s of storms) {
    const e = envs.get(s.id)!;
    describe(s.id, () => {
      it('uses the odd-degree game lattice', () => {
        expect(e.typhoonId).toBe(s.id);
        expect(e.lons.length).toBe(52);
        expect(e.lats.length).toBe(36);
        for (const l of e.lons) { expect(Math.abs(l) % 2).toBe(1); expect(l).toBeGreaterThan(-180); expect(l).toBeLessThanOrEqual(180); }
        for (const l of e.lats) expect(Math.abs(l) % 2).toBe(1);
        expect(e.lons[0]).toBe(97);
        expect(e.lons.at(-1)).toBe(-161);
        expect(e.lats[0]).toBe(-5);
        expect(e.lats.at(-1)).toBe(65);
      });

      it('covers the track range plus or minus one day', () => {
        const first = day(s.points[0].t);
        const last = day(s.points.at(-1)!.t);
        expect(e.days[0]).toBe(addDays(first, -1));
        expect(e.days.at(-1)).toBe(addDays(last, 1));
        e.days.forEach((d, i) => { if (i > 0) expect(d).toBe(addDays(e.days[i - 1], 1)); });
      });

      it('has correctly sized fields within physical ranges', () => {
        const n = e.lats.length * e.lons.length;
        for (const [name, [lo, hi]] of Object.entries(RANGES)) {
          const days = e.fields[name as keyof Env['fields']];
          expect(days).toHaveLength(e.days.length);
          const k = e.scale[name];
          for (const d of days) {
            expect(d).toHaveLength(n);
            let bad = 0;
            for (const v of d) {
              if (v === null) { if (name !== 'sst') bad++; continue; }
              if (!Number.isInteger(v) || v * k < lo || v * k > hi) bad++;
            }
            expect(bad).toBe(0);
          }
        }
      });
    });
  }

  const cell = (e: Env, name: keyof Env['fields'], d: string, lat: number, lon: number) => {
    const v = e.fields[name][e.days.indexOf(d)][e.lats.indexOf(lat) * e.lons.length + e.lons.indexOf(lon)];
    return v === null ? null : v * e.scale[name];
  };

  it('Maemi 2003: R1 shows a low near its track on 12 Sep', () => {
    // Best track at 12 UTC is 34.9N 128.3E (955 hPa). R1 is a 2.5 degree daily mean, so it smooths the core to about 1000 hPa.
    const e = envs.get('maemi-2003')!;
    expect(cell(e, 'slp', '2003-09-12', 33, 129)!).toBeLessThan(1008);
    let min = Infinity;
    for (const lat of [33, 35, 37]) for (const lon of [125, 127, 129, 131]) min = Math.min(min, cell(e, 'slp', '2003-09-12', lat, lon)!);
    expect(min).toBeLessThan(1002);
  });

  it('Maemi 2003: ERSST east of the Philippines is warm in September', () => {
    const e = envs.get('maemi-2003')!;
    expect(cell(e, 'sst', '2003-09-08', 15, 135)!).toBeGreaterThan(28);
    expect(cell(e, 'sst', '2003-09-08', 15, 135)!).toBeLessThan(33);
  });
});
