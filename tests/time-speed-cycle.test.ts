import { expect, it } from 'vitest';
import { adjacentTimeSpeed, takeSteps, timeSpeedLabel, windAnimationMultiplier, TIME_SPEEDS } from '../src/time';

it('cycles through every speed in both directions', () => {
  for (let i = 0; i < TIME_SPEEDS.length; i++) {
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], 1)).toBe(TIME_SPEEDS[(i + 1) % TIME_SPEEDS.length]);
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], -1)).toBe(TIME_SPEEDS[(i - 1 + TIME_SPEEDS.length) % TIME_SPEEDS.length]);
  }
});

it('labels sub-day steps as real-time multiples and day steps as days per second', () => {
  expect(TIME_SPEEDS.map(timeSpeedLabel)).toEqual(['×200', '×600', '×1.2k', '×2.4k', '×4.8k', '×14.4k', '1 day/s', '2 days/s', '1 month/s']);
});

it('keeps wind animation within 1 to 3 for every step', () => {
  expect(TIME_SPEEDS.map(windAnimationMultiplier)).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3]);
});

it('takes whole steps and caps the leftover backlog', () => {
  expect(takeSteps(4.25, 64)).toEqual({ steps: 4, carry: 0.25 });
  expect(takeSteps(0.5, 64)).toEqual({ steps: 0, carry: 0.5 });
  expect(takeSteps(500, 64)).toEqual({ steps: 64, carry: 64 });
});
