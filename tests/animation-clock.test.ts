import { describe, expect, it } from 'vitest';
import { AnimationClock } from '../src/render/animation-clock';

describe('map animation clock', () => {
  it('freezes every animation phase and resumes without including gesture time', () => {
    const clock = new AnimationClock();
    clock.setPaused(true, 1000);
    expect(clock.read(5000)).toBe(1000);
    clock.setPaused(false, 5000);
    expect(clock.read(5016)).toBe(1016);
    clock.setPaused(true, 5100);
    expect(clock.read(9000)).toBe(1100);
    clock.setPaused(false, 9000);
    expect(clock.read(9016)).toBe(1116);
  });

  it('does not restart a pause or count the same gesture twice', () => {
    const clock = new AnimationClock();
    clock.setPaused(false, 500);
    clock.setPaused(true, 1000);
    clock.setPaused(true, 2000);
    expect(clock.read(3000)).toBe(1000);
    clock.setPaused(false, 3000);
    clock.setPaused(false, 4000);
    expect(clock.read(4016)).toBe(2016);
  });
});
