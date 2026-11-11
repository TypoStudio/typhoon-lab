/** Model seconds advanced per real second at each displayed setting. */
export const TIME_SPEEDS = [1, 600, 1_800, 3_600, 7_200, 14_400, 86_400, 172_800, 604_800] as const;
export type TimeSpeed = (typeof TIME_SPEEDS)[number];
/** Real time is too slow to watch a storm; 10 model minutes per second is the default and the reset target. */
export const DEFAULT_TIME_SPEED: TimeSpeed = 600;
export const MIN_TIME_SPEED = TIME_SPEEDS[0];
/** Fastest step the tutorial asks for; the day-per-second steps can outrun the CPU. */
export const TUTORIAL_TIME_SPEED: TimeSpeed = 14_400;
/** A loaded climate scenario sets this speed (4 hours per second), so that the weather runs and storms and climate-driven events form. */
export const SCENARIO_TIME_SPEED: TimeSpeed = 14_400;
export const MAX_TIME_SPEED = TIME_SPEEDS[TIME_SPEEDS.length - 1];

export function isTimeSpeed(value: unknown): value is TimeSpeed {
  return typeof value === 'number' && TIME_SPEEDS.some(speed => speed === value);
}

/** Fastest speed that steps the weather engine. Above it the worker advances the ENSO layer day by day on the fast climate path instead. */
export const MAX_WEATHER_SPEED = 172_800;
export const isFastClimateSpeed = (speed: number): boolean => speed > MAX_WEATHER_SPEED;

export function timeSpeedLabel(speed: TimeSpeed): string {
  if (speed === 1) return 'Real time';
  return speed >= 86_400 ? `${speed / 86_400}d/s` : speed >= 3_600 ? `${speed / 3_600}h/s` : `${speed / 60}m/s`;
}

/** The speed in words, for tooltips and accessible names. */
export function timeSpeedDescription(speed: TimeSpeed): string {
  if (speed === 1) return 'Real time: 1 second per second';
  const [amount, unit] = speed >= 86_400 ? [speed / 86_400, 'day'] : speed >= 3_600 ? [speed / 3_600, 'hour'] : [speed / 60, 'minute'];
  return `${amount} ${unit}${amount === 1 ? '' : 's'} per second`;
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
