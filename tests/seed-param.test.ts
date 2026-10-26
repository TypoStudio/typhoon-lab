import { describe, expect, it } from 'vitest';
import { parseSeedParam, randomSeed } from '../src/ui/storage';
import { isValidSeed } from '../src/simulation/engine';

describe('?seed= query parameter', () => {
  it('accepts a uint32', () => {
    expect(parseSeedParam('?seed=12345')).toBe(12345);
    expect(parseSeedParam('?lang=ko&seed=0&map=flat')).toBe(0);
    expect(parseSeedParam('?seed=4294967295')).toBe(4294967295);
  });

  it('rejects anything else', () => {
    for (const q of ['?seed=abc', '?seed=-5', '?seed=1.5', '?seed=', '?seed=4294967296', '?seed=1e3', '?seed=0x10', '?seed= 7', '?lang=ko', '']) {
      expect(parseSeedParam(q), q).toBeNull();
    }
  });

  it('draws a different valid seed each time when the parameter is absent', () => {
    const draws = Array.from({ length: 4 }, () => parseSeedParam('?lang=ko') ?? randomSeed());
    expect(draws.every(isValidSeed)).toBe(true);
    expect(new Set(draws).size).toBeGreaterThan(1);
  });
});
