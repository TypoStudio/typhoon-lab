import { describe, expect, it } from 'vitest';
import { WindParticleBudget } from '../src/render/wind-budget';

function run(budget: WindParticleBudget, fps: number, seconds: number, active = true): void {
  for (let frame = 0; frame < fps * seconds; frame++) budget.sample(1000 / fps, active);
}

describe('wind particle frame budget', () => {
  it('reduces sustained slow wind frames promptly and respects the minimum', () => {
    const budget = new WindParticleBudget(5000);
    run(budget, 20, 3);
    expect(budget.count).toBeLessThan(5000);
    expect(budget.fps).toBeCloseTo(20, -1);
    run(budget, 10, 30);
    expect(budget.count).toBe(3500);
  });

  it('restores particles gradually when frames recover without exceeding the original maximum', () => {
    const budget = new WindParticleBudget(5000);
    run(budget, 20, 3);
    const reduced = budget.count;
    run(budget, 60, 1);
    expect(budget.count).toBe(reduced);
    run(budget, 60, 4);
    expect(budget.count).toBeGreaterThan(reduced);
    expect(budget.count).toBeLessThan(5000);
    run(budget, 60, 120);
    expect(budget.count).toBe(5000);
  });

  it('keeps the budget stable at a healthy frame rate and after an isolated short stall', () => {
    const budget = new WindParticleBudget(5000);
    run(budget, 60, 3);
    budget.sample(100);
    run(budget, 60, 3);
    expect(budget.count).toBe(5000);
    run(budget, 40, 10);
    expect(budget.count).toBe(5000);
  });

  it('records the measured FPS and counts before reducing and keeps the first reduction', () => {
    const budget = new WindParticleBudget(5000);
    run(budget, 20, 3);
    const first = budget.firstReduction;
    expect(first).toEqual({ fpsBefore: 20, particlesBefore: 5000, particlesAfter: 4500 });
    run(budget, 20, 10);
    expect(budget.firstReduction).toEqual(first);
    expect(budget.lastAdjustment!.particlesAfter).toBe(3500);
    expect(budget.lastAdjustment!.fpsBefore).toBe(20);
  });

  it('holds the count during pause or gestures and discards suspension time', () => {
    const budget = new WindParticleBudget(5000);
    run(budget, 20, 3);
    const before = budget.count;
    run(budget, 5, 20, false);
    run(budget, 60, 20, false);
    expect(budget.count).toBe(before);
    for (const gap of [5000, Number.NaN, -10, 0]) budget.sample(gap);
    expect(budget.count).toBe(before);
    budget.sample(1000 / 60);
    expect(budget.count).toBe(before);
  });
});
