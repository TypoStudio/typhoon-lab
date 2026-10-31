import { describe, expect, it } from 'vitest';
import { WIND_STREAK_PX, setWindStreakTail } from '../src/render/particles';

describe('wind display density', () => {
  it('draws the same length for slow and fast wind in either direction', () => {
    const out = new Float64Array(2);
    for (const [x, y] of [[99.9, 100], [80, 100], [70, 60], [100, 100]]) {
      setWindStreakTail(100, 100, x, y, out);
      expect(Math.hypot(100 - out[0], 100 - out[1])).toBeCloseTo(WIND_STREAK_PX, 8);
    }
  });

});
