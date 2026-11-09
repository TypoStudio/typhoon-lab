/** Model seconds advanced per real second at each displayed setting. */
export const TIME_SPEEDS = [200, 600, 1_200, 2_400, 4_800, 14_400, 86_400, 172_800] as const;
export type TimeSpeed = (typeof TIME_SPEEDS)[number];
export const DEFAULT_TIME_SPEED: TimeSpeed = TIME_SPEEDS[0];
export const MIN_TIME_SPEED = TIME_SPEEDS[0];
/** Fastest step the tutorial asks for; the day-per-second steps can outrun the CPU. */
export const TUTORIAL_TIME_SPEED: TimeSpeed = 14_400;
export const MAX_TIME_SPEED = TIME_SPEEDS[TIME_SPEEDS.length - 1];

export function isTimeSpeed(value: unknown): value is TimeSpeed {
  return typeof value === 'number' && TIME_SPEEDS.some(speed => speed === value);
}

export function timeSpeedLabel(speed: TimeSpeed): string {
  return speed >= 86_400 ? `${speed / 86_400} ${speed === 86_400 ? 'day' : 'days'}/s` : `×${speed.toLocaleString('en-US')}`;
}

/** Wind animation follows the time setting up to the third visual speed step. */
export function windAnimationMultiplier(speed: number): number {
  return isTimeSpeed(speed) ? Math.min(3, TIME_SPEEDS.indexOf(speed) + 1) : 1;
}

/** Whole steps due from the fractional backlog; what is left is capped at `maxSteps` so a slow CPU never builds an unbounded backlog. */
export function takeSteps(carry: number, maxSteps: number): { steps: number; carry: number } {
  const steps = Math.min(maxSteps, Math.floor(carry + 1e-9));
  return { steps, carry: Math.min(maxSteps, carry - steps) };
}

export function adjacentTimeSpeed(speed: TimeSpeed, direction: -1 | 1): TimeSpeed {
  const index = TIME_SPEEDS.indexOf(speed);
  return TIME_SPEEDS[(index + direction + TIME_SPEEDS.length) % TIME_SPEEDS.length];
}
