import { describe, expect, it } from 'vitest';
import { cycloneSymbolPaths } from '../src/render/cyclone-symbol';

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe('cycloneSymbolPaths', () => {
  it('rank 0 is a ring (radii R and 0.6R) with no tails', () => {
    const { ring, tails } = cycloneSymbolPaths(10, 0);
    const radii = [...ring.matchAll(/A(\S+) (\S+) /g)].map(m => Number(m[1]));
    expect(count(ring, /A/g)).toBe(4);
    expect(new Set(radii)).toEqual(new Set([10, 6]));
    expect(tails).toBe('');
  });

  it('inner hole is 0.41R from rank 1', () => {
    expect(cycloneSymbolPaths(10, 2).ring).toContain('A4.1 4.1');
  });

  it('rank 2 has two mirrored tails built from C and Q curves', () => {
    const { tails } = cycloneSymbolPaths(10, 2);
    expect(count(tails, /M/g)).toBe(2);
    expect(count(tails, /C/g)).toBe(2);
    expect(count(tails, /Q/g)).toBe(2);
    const [a, b] = tails.split('M').filter(Boolean).map(sub => sub.match(/^(-?[\d.]+) (-?[\d.]+)/)!.slice(1).map(Number));
    expect(a[0]).toBeCloseTo(-b[0], 1);
    expect(a[1]).toBeCloseTo(-b[1], 1);
  });

  it('typhoon tails reach further than storm tails', () => {
    const reach = (rank: number) => Math.max(...cycloneSymbolPaths(10, rank).tails.match(/-?[\d.]+/g)!.map(v => Math.abs(Number(v))));
    expect(reach(4)).toBeGreaterThan(reach(2));
  });
});
