import { expect, it } from 'vitest';
import { temperatureHexCenter } from '../src/render/temperature-hex';

it('uses fixed hexagon centres and wraps the grid across the date line', () => {
  const center = new Float64Array(2), nearby = new Float64Array(2), wrapped = new Float64Array(2);
  temperatureHexCenter(140, 20, center);
  for (let angle = 0; angle < 2 * Math.PI; angle += Math.PI / 3) {
    temperatureHexCenter(center[0] + 0.5 * Math.cos(angle), center[1] + 0.5 * Math.sin(angle), nearby);
    expect(Array.from(nearby)).toEqual(Array.from(center));
  }
  temperatureHexCenter(140 + 360, 20, wrapped);
  expect(wrapped[0] - center[0]).toBeCloseTo(360);
  expect(wrapped[1]).toBeCloseTo(center[1]);
});
