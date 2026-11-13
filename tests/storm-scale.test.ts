import { describe, expect, it } from 'vitest';
import { STORM_FAR_ZOOM, STORM_NEAR_ZOOM, stormDetailLine, stormGlyphRadiusAt, stormLabelSize, stormZoomFactor } from '../src/render/storm-scale';

const zooms = Array.from({ length: 41 }, (_, i) => i * 0.25);

describe('storm symbol scaling', () => {
  it('grows monotonically with zoom and is clamped between the minimum and the full size', () => {
    for (const full of [6, 10, 16]) {
      let prev = 0;
      for (const z of zooms) {
        const r = stormGlyphRadiusAt(full, z);
        expect(r).toBeGreaterThanOrEqual(prev);
        expect(r).toBeLessThanOrEqual(full);
        expect(r).toBeGreaterThanOrEqual(5);
        prev = r;
      }
      expect(stormGlyphRadiusAt(full, STORM_NEAR_ZOOM)).toBe(full);
      expect(stormGlyphRadiusAt(full, 12)).toBe(full);
      expect(stormGlyphRadiusAt(full, 0)).toBe(stormGlyphRadiusAt(full, STORM_FAR_ZOOM));
    }
  });
  it('keeps a far typhoon small (under 7 px radius) and the factor within 0..1', () => {
    expect(stormGlyphRadiusAt(16, 2)).toBeLessThan(7);
    expect(stormZoomFactor(-5)).toBe(0);
    expect(stormZoomFactor(99)).toBe(1);
  });
  it('label font shrinks when zoomed out, and the second line needs zoom, selection or hover', () => {
    expect(stormLabelSize(2)).toBe(10);
    expect(stormLabelSize(8)).toBe(12);
    expect(stormDetailLine(2, false, false)).toBe(false);
    expect(stormDetailLine(2, true, false)).toBe(true);
    expect(stormDetailLine(2, false, true)).toBe(true);
    expect(stormDetailLine(STORM_NEAR_ZOOM, false, false)).toBe(true);
  });
});
