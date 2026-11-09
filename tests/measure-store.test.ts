import { describe, expect, it } from 'vitest';
import { MAX_POINTS, MIN_SPACING_DAYS, addSample, createSeries, halve, lastValue, nearestIndex, niceRange, axisUnit, elapsedTicks, trimNumber } from '../src/ui/measure-store';

const fill = (n: number, step = MIN_SPACING_DAYS) => {
  const s = createSeries();
  for (let i = 0; i < n; i++) addSample(s, i * step, i);
  return s;
};

describe('measure series', () => {
  it('keeps every sample a run apart by the minimum spacing and drops closer ones', () => {
    const s = createSeries();
    expect(addSample(s, 0, 1)).toBe(true);
    expect(addSample(s, MIN_SPACING_DAYS / 2, 2)).toBe(false);
    expect(addSample(s, MIN_SPACING_DAYS, 3)).toBe(true);
    expect(s.t).toHaveLength(2);
    expect(lastValue(s)).toBe(3);
  });

  it('ignores a sample from the past and a non-finite time', () => {
    const s = fill(3);
    expect(addSample(s, 0, 9)).toBe(false);
    expect(addSample(s, Number.NaN, 9)).toBe(false);
    expect(s.t).toHaveLength(3);
  });

  it('merges older points in pairs once full, doubling the spacing, and stays detailed before that', () => {
    const short = fill(MAX_POINTS);
    expect(short.t).toHaveLength(MAX_POINTS);
    expect(short.stride).toBe(MIN_SPACING_DAYS);
    const full = fill(MAX_POINTS + 1);
    expect(full.t).toHaveLength(MAX_POINTS / 2 + 1);
    expect(full.stride).toBe(MIN_SPACING_DAYS * 2);
    expect(full.t[0]).toBe(0);
    expect(full.t[1]).toBeCloseTo(2.5 * MIN_SPACING_DAYS);
    expect(full.v[0]).toBeCloseTo(0.5);
    expect(full.t.every((t, i) => i === 0 || t > full.t[i - 1])).toBe(true);
  });

  it('stays bounded over a very long run and keeps covering it', () => {
    const s = createSeries();
    for (let day = 0; day < 36_500; day += 0.25) addSample(s, day, Math.sin(day));
    expect(s.t.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(s.t.length).toBeGreaterThan(MAX_POINTS / 2 - 1);
    expect(s.t[0]).toBe(0);
    expect(s.t[s.t.length - 1]).toBeGreaterThan(36_000);
  });

  it('follows a jump ahead in time (the fast climate path) without losing order', () => {
    const s = createSeries();
    addSample(s, 1, 10);
    addSample(s, 1 + MIN_SPACING_DAYS, 11);
    expect(addSample(s, 1 + 3 * 365, 12)).toBe(true);
    expect(addSample(s, 1 + 3 * 365 + MIN_SPACING_DAYS, 13)).toBe(true);
    expect(s.t).toEqual([1, 1 + MIN_SPACING_DAYS, 1 + 3 * 365, 1 + 3 * 365 + MIN_SPACING_DAYS]);
  });

  it('averages around gaps and keeps a gap when both are missing', () => {
    const s = createSeries();
    s.t = [0, 1, 2, 3]; s.v = [Number.NaN, 4, Number.NaN, Number.NaN];
    halve(s);
    expect(s.v[0]).toBe(4);
    expect(Number.isNaN(s.v[1])).toBe(true);
  });

  it('finds the nearest point and the last real value', () => {
    const s = createSeries();
    s.t = [0, 10, 20]; s.v = [1, 2, Number.NaN];
    expect(nearestIndex(s, 4)).toBe(0);
    expect(nearestIndex(s, 6)).toBe(1);
    expect(nearestIndex(s, 99)).toBe(2);
    expect(lastValue(s)).toBe(2);
  });
});

describe('measure axes', () => {
  const labels = (span: number) => elapsedTicks(span).map(t => `${trimNumber(t.value)}${t.unit}`);
  it('picks hours, days, months and years to suit the elapsed span', () => {
    expect(axisUnit(0.25)).toBe('h');
    expect(axisUnit(1)).toBe('h');
    expect(axisUnit(12)).toBe('d');
    expect(axisUnit(200)).toBe('mo');
    expect(axisUnit(365 * 12)).toBe('y');
  });

  it('always makes exactly five ticks from 0 to the span, in one unit', () => {
    for (const span of [0.1, 1, 7, 40, 400, 5000, 70_000]) {
      const ticks = elapsedTicks(span);
      expect(ticks.map(t => t.frac)).toEqual([0, 0.25, 0.5, 0.75, 1]);
      expect(new Set(ticks.map(t => t.unit)).size).toBe(1);
      expect(ticks[0].value).toBe(0);
    }
  });

  it('labels hour, day, month and year spans with short rounded values', () => {
    expect(labels(1)).toEqual(['0h', '6h', '12h', '18h', '24h']);
    expect(labels(10)).toEqual(['0d', '2.5d', '5d', '7.5d', '10d']);
    expect(labels(10.3)).toEqual(['0d', '2.6d', '5.2d', '7.7d', '10.3d']);
    expect(labels(365 / 12 * 8)).toEqual(['0mo', '2mo', '4mo', '6mo', '8mo']);
    expect(labels(365 * 6)).toEqual(['0y', '1.5y', '3y', '4.5y', '6y']);
  });

  it('measures elapsed time from the earliest start among a chart\'s lines', () => {
    const early = createSeries(), late = createSeries();
    addSample(early, 100, 1); addSample(early, 104, 2);
    addSample(late, 102, 3); addSample(late, 104, 4);
    const t0 = Math.min(early.t[0], late.t[0]), t1 = Math.max(early.t[1], late.t[1]);
    expect(labels(t1 - t0)).toEqual(['0d', '1d', '2d', '3d', '4d']);
    expect(late.t[0] - t0).toBe(2); // the later pin's line starts half-way along
  });

  it('rounds the value range to clean tick values', () => {
    const r = niceRange(26.3, 29.4, 3);
    expect(r.min).toBeLessThanOrEqual(26.3);
    expect(r.max).toBeGreaterThanOrEqual(29.4);
    expect(r.ticks.length).toBeGreaterThanOrEqual(2);
    expect(niceRange(5, 5).max).toBeGreaterThan(5);
    expect(niceRange(Number.NaN, 1).ticks).toEqual([0, 1]);
  });
});
