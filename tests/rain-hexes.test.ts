import { describe, expect, it } from 'vitest';
import { HEX_BUCKETS, SNOW_HAZE_ALPHA, blurRadiusFor, hexAlpha, hexBucket, hexBucketRain, hexCentres, hexCorners, hexRadius } from '../src/render/hexes';

describe('hex grid', () => {
  const R = 11; const w = Math.sqrt(3) * R;
  const c = hexCentres(200, 100, R);
  const pts = Array.from({ length: c.length / 2 }, (_, i) => [c[2 * i], c[2 * i + 1]]);

  it('uses a pointy-top lattice: row step 1.5R, odd rows shifted half a width', () => {
    const rows = [...new Set(pts.map(p => p[1]))].sort((a, b) => a - b);
    rows.forEach((y, r) => expect(y).toBeCloseTo(r * 1.5 * R, 3));
    const row0 = pts.filter(p => p[1] === rows[0]).map(p => p[0]);
    const row1 = pts.filter(p => p[1] === rows[1]).map(p => p[0]);
    expect(row0[1] - row0[0]).toBeCloseTo(w, 3);
    expect(row0[0]).toBeCloseTo(0, 3);
    expect(row1[0]).toBeCloseTo(-w / 2, 3);
  });

  it('covers the whole viewport', () => {
    expect(Math.min(...pts.map(p => p[0]))).toBeLessThanOrEqual(0);
    expect(Math.max(...pts.map(p => p[0])) + w / 2).toBeGreaterThanOrEqual(200);
    expect(Math.max(...pts.map(p => p[1])) + R).toBeGreaterThanOrEqual(100);
    for (const [x, y] of pts) { expect(x).toBeGreaterThanOrEqual(-w / 2 - 1e-3); expect(x - w / 2).toBeLessThanOrEqual(200); expect(y - R).toBeLessThanOrEqual(100); }
  });

  it('stays in the 3-4k range at 1440x900', () => {
    const n = hexCentres(1440, 900, 11).length / 2;
    expect(n).toBeGreaterThan(3000);
    expect(n).toBeLessThan(5000);
  });

  it('shrinks the radius on phones only', () => {
    expect(hexRadius(1440)).toBe(14);
    expect(hexRadius(700)).toBe(14);
    expect(hexRadius(699)).toBe(11);
  });

  it('does not inset corners, so tiles touch', () => {
    const k = hexCorners(14);
    for (let i = 0; i < 6; i++) expect(Math.hypot(k[2 * i], k[2 * i + 1])).toBeCloseTo(14, 4);
    expect(k[0]).toBeGreaterThan(0); expect(k[1]).toBeCloseTo(7, 4); // first corner at 30 degrees
  });

  it('blurs by 0.45 R', () => {
    expect(blurRadiusFor(14)).toBeCloseTo(6.3, 5);
    expect(blurRadiusFor(11)).toBeCloseTo(4.95, 5);
  });
});

describe('hex intensity buckets', () => {
  it('quantises 0.5..20 mm/h into 8 buckets and clamps outside', () => {
    expect(hexBucket(0.5)).toBe(0);
    expect(hexBucket(2.9)).toBe(0);
    expect(hexBucket(3)).toBe(1);
    expect(hexBucket(10)).toBe(3);
    expect(hexBucket(19.9)).toBe(HEX_BUCKETS - 1);
    expect(hexBucket(80)).toBe(HEX_BUCKETS - 1);
    expect(hexBucket(0)).toBe(0);
  });

  it('maps each bucket centre back into the same bucket', () => {
    for (let b = 0; b < HEX_BUCKETS; b++) expect(hexBucket(hexBucketRain(b))).toBe(b);
  });
});

describe('hex alpha', () => {
  it('rain follows 0.08 + 0.72 t^0.7, scaled by 0.9', () => {
    expect(hexAlpha(0.5, false)).toBeCloseTo(0.08 * 0.9, 5);
    expect(hexAlpha(1, false)).toBeCloseTo(0.12 * 0.9, 1);
    expect(hexAlpha(5, false)).toBeCloseTo(0.38 * 0.9, 1);
    expect(hexAlpha(10, false)).toBeCloseTo(0.55 * 0.9, 1);
    expect(hexAlpha(10.25, false)).toBeCloseTo((0.08 + 0.72 * 0.5 ** 0.7) * 0.9, 5);
    expect(hexAlpha(20, false)).toBeCloseTo(0.8 * 0.9, 5);
    expect(hexAlpha(100, false)).toBeCloseTo(0.8 * 0.9, 5);
  });

  it('snow is capped at the haze alpha', () => {
    expect(hexAlpha(0.5, true)).toBeCloseTo(0.08 * 0.9, 5); // below the cap
    expect(hexAlpha(20, true)).toBeCloseTo(SNOW_HAZE_ALPHA * 0.9, 5);
    expect(hexAlpha(10, true)).toBeLessThan(hexAlpha(10, false));
  });
});
