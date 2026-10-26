import { describe, expect, it } from 'vitest';
import { TUTORIAL_KEY, TUTORIAL_SPOT, TUTORIAL_STEPS, createTutorialMachine, markTutorialDone, shouldAutoStart, type MachineView } from '../src/ui/tutorial';
import type { GameState, ToolType } from '../src/types';

const effect = (type: ToolType, lon = TUTORIAL_SPOT.lon, lat = TUTORIAL_SPOT.lat) => ({ id: 1, type, lon, lat, radiusKm: 500, remainingHours: 50, ageHours: 0 });
const world = (over: { effects?: ReturnType<typeof effect>[]; storms?: object[]; hours?: number } = {}) =>
  ({ effects: over.effects ?? [], storms: over.storms ?? [], hours: over.hours ?? 0 }) as unknown as GameState;
const ids = TUTORIAL_STEPS.map(s => s.id);

function harness(initial: GameState = world()) {
  let state = initial;
  let ended = 0;
  let view: MachineView | null = null;
  const machine = createTutorialMachine(TUTORIAL_STEPS, () => state, v => { view = v; }, () => { ended++; });
  return {
    machine,
    set(next: GameState) { state = next; machine.update(); },
    get id() { return view?.step.id ?? null; },
    get view() { return view; },
    get ended() { return ended; },
  };
}
const toStep = (h: ReturnType<typeof harness>, id: string) => { h.machine.start(); while (h.id !== id) h.machine.next(); };

describe('tutorial steps', () => {
  it('walks welcome, conditions, three placements, play, formed, damage, weaken, done', () => {
    expect(ids).toEqual(['welcome', 'conditions', 'warm', 'moisture', 'low', 'play', 'formed', 'damage', 'weaken', 'done']);
  });

  it('advances on done(state): placements within 400 km count, farther or wrong-type ones do not', () => {
    const h = harness();
    toStep(h, 'warm');
    h.set(world({ effects: [effect('moisture')] }));
    expect(h.id).toBe('warm');
    h.set(world({ effects: [effect('warm', TUTORIAL_SPOT.lon + 6, TUTORIAL_SPOT.lat)] })); // about 640 km east
    expect(h.id).toBe('warm');
    h.set(world({ effects: [effect('warm', TUTORIAL_SPOT.lon + 3, TUTORIAL_SPOT.lat)] })); // about 320 km east
    expect(h.id).toBe('moisture');
    h.set(world({ effects: [effect('warm'), effect('moisture')] }));
    expect(h.id).toBe('low');
    h.set(world({ effects: [effect('warm'), effect('moisture'), effect('low')] }));
    expect(h.id).toBe('play');
    h.set(world({ effects: [effect('low')], storms: [{}] }));
    expect(h.id).toBe('formed');
  });

  it('skips ahead through steps whose goal is already met when entered going forward', () => {
    const h = harness(world({ effects: [effect('warm'), effect('moisture'), effect('low')] }));
    toStep(h, 'conditions');
    h.machine.next();
    expect(h.id).toBe('play');
  });

  it('advances weaken on any weakening condition and not on a forming one', () => {
    const h = harness();
    toStep(h, 'weaken');
    h.set(world({ effects: [effect('warm', 142, 17)] }));
    expect(h.id).toBe('weaken');
    h.set(world({ effects: [effect('cool', 142, 17)] }));
    expect(h.id).toBe('done');
  });

  it('shows Next only on steps without a goal, or when a goal step was reached with Back', () => {
    const h = harness();
    h.machine.start();
    expect(h.view?.showNext).toBe(true);
    toStep(h, 'warm');
    expect(h.view?.showNext).toBe(false);
    h.set(world({ effects: [effect('warm')] }));
    expect(h.id).toBe('moisture');
    h.machine.back();
    expect(h.id).toBe('warm');
    expect(h.view?.showNext).toBe(true); // goal still met: Back must not bounce forward
    h.set(world());
    expect(h.view?.showNext).toBe(false); // goal seen unmet: armed again
    h.set(world({ effects: [effect('warm')] }));
    expect(h.id).toBe('moisture');
  });

  it('Back stops at the first step, Next on the last step finishes', () => {
    const h = harness();
    h.machine.start();
    h.machine.back();
    expect(h.id).toBe('welcome');
    toStep(h, 'done');
    expect(h.ended).toBe(0);
    h.machine.next();
    expect(h.ended).toBe(1);
    expect(h.view).toBeNull();
    expect(h.machine.active).toBe(false);
  });

  it('Skip ends from any step and Back/Next do nothing afterwards', () => {
    const h = harness();
    toStep(h, 'moisture');
    h.machine.skip();
    expect(h.ended).toBe(1);
    h.machine.next();
    h.machine.back();
    h.set(world({ effects: [effect('moisture')] }));
    expect(h.view).toBeNull();
    expect(h.ended).toBe(1);
  });

  it('suggests placing the conditions again after 72 hours without a storm', () => {
    const h = harness(world({ hours: 100 }));
    toStep(h, 'play');
    expect(h.view?.stuck).toBe(false);
    h.set(world({ hours: 160 }));
    expect(h.view?.stuck).toBe(false);
    h.set(world({ hours: 172 }));
    expect(h.view?.stuck).toBe(true);
  });
});

describe('tutorial gate', () => {
  const storage = (value: string | null) => ({ getItem: (key: string) => (key === TUTORIAL_KEY ? value : 'other') });
  it('opens on a first visit only', () => {
    expect(shouldAutoStart('?map=flat', storage(null))).toBe(true);
    expect(shouldAutoStart('', storage(null))).toBe(true);
    expect(shouldAutoStart('?map=flat', storage('done'))).toBe(false);
  });
  it('stays shut for ?help=0 and when storage is unavailable', () => {
    expect(shouldAutoStart('?help=0', storage(null))).toBe(false);
    expect(shouldAutoStart('?seed=1&help=0&start=2026-08-01', storage(null))).toBe(false);
    expect(shouldAutoStart('?help=1', storage(null))).toBe(true);
    expect(shouldAutoStart('', null)).toBe(false);
    expect(shouldAutoStart('', { getItem: () => { throw new Error('blocked'); } })).toBe(false);
  });
  it('writes the done flag, and a blocked storage does not throw', () => {
    const saved = new Map<string, string>();
    markTutorialDone({ setItem: (k, v) => { saved.set(k, v); } });
    expect(saved.get('typhoon-lab:tutorial')).toBe('done');
    expect(shouldAutoStart('', { getItem: k => saved.get(k) ?? null })).toBe(false);
    expect(() => markTutorialDone({ setItem: () => { throw new Error('blocked'); } })).not.toThrow();
    expect(() => markTutorialDone(null)).not.toThrow();
  });
});
