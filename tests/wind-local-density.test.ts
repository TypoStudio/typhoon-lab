import { expect, it } from 'vitest';
import { createGame } from '../src/simulation/engine';
import { buildFieldData } from '../src/render/fields';
import { ParticleSystem } from '../src/render/particles';

it('extends lifetime with wind speed while keeping the same spawn positions and count', () => {
  const field = buildFieldData(createGame(1).grid)!;
  const bounds = { west: 120, east: 140, south: 10, north: 30 };
  const sample = (speed: number) => {
    field.u.fill(0); field.v.fill(speed);
    field.blizzard.fill(speed ? 1 : 0);
    const particles = new ParticleSystem();
    particles.resize(4000); particles.life.fill(0);
    particles.update(0, field, bounds, 65);
    return particles;
  };
  const calm = sample(0);
  for (const [speed, multiplier] of [[12.5, 1.5], [25, 2], [100, 2]]) {
    const strong = sample(speed);
    expect(strong.count).toBe(calm.count);
    expect(strong.lon).toEqual(calm.lon);
    expect(strong.lat).toEqual(calm.lat);
    for (let i = 0; i < calm.count; i++) {
      expect(strong.life[i]).toBeCloseTo(calm.life[i] * multiplier, 5);
    }
  }
});
