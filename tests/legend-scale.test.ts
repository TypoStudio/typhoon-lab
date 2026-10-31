import { describe, expect, it } from 'vitest';
import { layerLegend } from '../src/render/fields';
import { tickPosition, tickValue } from '../src/ui/legend-scale';

describe('legend scale', () => {
  it('reads tick labels', () => {
    expect([tickValue('0'), tickValue('40+'), tickValue('30k'), tickValue('15M')]).toEqual([0, 40, 30000, 15000000]);
    expect(tickValue('x')).toBeNaN();
    expect(tickValue('-40')).toBe(-40);
  });

  it('interpolates linearly between ticks', () => {
    const pressure = layerLegend('pressure').ticks;
    expect(tickPosition(pressure, 960)).toBe(0);
    expect(tickPosition(pressure, 1035)).toBe(1);
    expect(tickPosition(pressure, 972.5)).toBeCloseTo(0.165, 5);
    const humidity = [{ label: '0', pos: 0 }, { label: '50', pos: 0.5 }, { label: '100', pos: 1 }];
    expect(tickPosition(humidity, 59)).toBeCloseTo(0.59, 5);
  });

  it('interpolates on log10 for the population bar', () => {
    const population = layerLegend('population').ticks;
    expect(tickPosition(population, 30000, true)).toBe(0);
    expect(tickPosition(population, 200000, true)).toBeCloseTo(0.3, 5);
    expect(tickPosition(population, Math.sqrt(200000 * 3e6), true)).toBeCloseTo(0.5, 5);
    expect(tickPosition(population, 15e6, true)).toBeCloseTo(1, 5);
  });

  it('is null below the bar range or for unusable values, and holds the last tick above it', () => {
    const sea = layerLegend('temperature').ticks;
    expect(tickPosition(sea, -40.1)).toBeNull();
    expect(tickPosition(sea, 0)).toBe(0.5);
    expect(tickPosition(sea, 40)).toBe(1);
    expect(tickPosition(sea, NaN)).toBeNull();
    expect(tickPosition(layerLegend('population').ticks, 0, true)).toBeNull();
    expect(tickPosition(layerLegend('population').ticks, 1000, true)).toBeNull();
    expect(tickPosition(layerLegend('rain').ticks, 80)).toBe(1);
  });
});
