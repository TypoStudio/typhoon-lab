import { expect, it } from 'vitest';
import { adjacentTimeSpeed, takeSteps, timeSpeedDescription, timeSpeedLabel, windAnimationMultiplier, DEFAULT_TIME_SPEED, TIME_SPEEDS, TUTORIAL_TIME_SPEED } from '../src/time';

it('cycles through every speed in both directions', () => {
  for (let i = 0; i < TIME_SPEEDS.length; i++) {
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], 1)).toBe(TIME_SPEEDS[(i + 1) % TIME_SPEEDS.length]);
    expect(adjacentTimeSpeed(TIME_SPEEDS[i], -1)).toBe(TIME_SPEEDS[(i - 1 + TIME_SPEEDS.length) % TIME_SPEEDS.length]);
  }
});

it('has exactly the nine steps, labels the steps as model time per second: 10m/s ... 4h/s, 1d/s, 2d/s and 7d/s', () => {
  expect([...TIME_SPEEDS]).toEqual([1, 600, 1_800, 3_600, 7_200, 14_400, 86_400, 172_800, 604_800]);
  expect(TIME_SPEEDS.map(timeSpeedLabel)).toEqual(['Real time', '10m/s', '30m/s', '1h/s', '2h/s', '4h/s', '1d/s', '2d/s', '7d/s']);
});

it('describes every step in words', () => {
  expect(TIME_SPEEDS.map(timeSpeedDescription)).toEqual([
    'Real time: 1 second per second', '10 minutes per second', '30 minutes per second', '1 hour per second', '2 hours per second',
    '4 hours per second', '1 day per second', '2 days per second', '7 days per second',
  ]);
});

it('resets to 600 and keeps the tutorial speed on step 6', () => {
  expect(DEFAULT_TIME_SPEED).toBe(600);
  expect(TIME_SPEEDS.indexOf(TUTORIAL_TIME_SPEED)).toBe(5);
});

it('keeps wind animation within 1 to 3 for every step', () => {
  expect(TIME_SPEEDS.map(windAnimationMultiplier)).toEqual([1, 2, 3, 3, 3, 3, 3, 3, 3]);
});

it('takes whole steps and caps the leftover backlog', () => {
  expect(takeSteps(4.25, 64)).toEqual({ steps: 4, carry: 0.25 });
  expect(takeSteps(0.5, 64)).toEqual({ steps: 0, carry: 0.5 });
  expect(takeSteps(500, 64)).toEqual({ steps: 64, carry: 64 });
});

it('accumulates one model second per second into whole 15-minute steps', () => {
  // 250 ms ticks at 1 model s/s: a step is due only after 900 real seconds.
  let carry = 0, total = 0;
  for (let i = 0; i < 3_600; i++) {
    carry += 250 * 1 / 900_000;
    const due = takeSteps(carry, 64);
    carry = due.carry;
    total += due.steps;
  }
  expect(total).toBe(1);
});
