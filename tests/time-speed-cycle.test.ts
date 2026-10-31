import { expect, it } from 'vitest';
import { adjacentTimeSpeed, TIME_SPEEDS } from '../src/time';

it('cycles through every speed in both directions', () => {
  for (let i = 0; i < TIME_SPEEDS.length; i++) {
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], 1)).toBe(TIME_SPEEDS[(i + 1) % TIME_SPEEDS.length]);
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], -1)).toBe(TIME_SPEEDS[(i - 1 + TIME_SPEEDS.length) % TIME_SPEEDS.length]);
  }
});
