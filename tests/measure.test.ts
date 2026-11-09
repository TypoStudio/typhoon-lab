import { describe, expect, it } from 'vitest';
import { createGame, placeTool, readClimateIndices } from '../src/simulation/engine';
import { MAX_PINS, MEASURE_ITEMS, ProbeBook, elapsedDays, inThermoclineStrip, pinStyle } from '../src/ui/measure';
import { MAX_POINTS, MIN_SPACING_DAYS } from '../src/ui/measure-store';
import type { GameState } from '../src/types';

const world = (): GameState => createGame(20261022, 305);
const at = (s: GameState, hours: number, calendarOffsetDays = 0): GameState => ({ ...s, hours, calendarOffsetDays });
const SEA = 'measure-sea-temperature';
const HUMID = 'measure-humidity';

describe('probe book', () => {
  it('adds a pin per place and shares it between items', () => {
    const book = new ProbeBook();
    const a = book.add(SEA, 140, 15);
    expect(a.ok && a.pin?.n).toBe(1);
    const b = book.add('measure-wind', 140.1, 15.1);
    expect(b.ok && b.pin?.n).toBe(1);
    const c = book.add(SEA, 160, 5);
    expect(c.ok && c.pin?.n).toBe(2);
    expect(book.pins).toHaveLength(2);
    expect([...book.charts.get(SEA)!]).toEqual([1, 2]);
  });

  it('does not duplicate the same item at the same pin location', () => {
    const book = new ProbeBook();
    book.add(SEA, 140, 15);
    const again = book.add(SEA, 140.2, 14.9);
    expect(again).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(book.pins).toHaveLength(1);
    expect(book.charts.get(SEA)!.size).toBe(1);
  });

  it('adds a basin index once, without a pin', () => {
    const book = new ProbeBook();
    expect(book.add('measure-nino34', 10, 10)).toMatchObject({ ok: true, pin: null });
    expect(book.add('measure-nino34', 50, -20)).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(book.pins).toHaveLength(0);
  });

  it('rejects the thermocline outside the equatorial Pacific strip, 120E to 280E, across the date line', () => {
    const book = new ProbeBook();
    expect(book.add('measure-thermocline', 60, 0)).toMatchObject({ ok: false, reason: 'strip' });
    expect(book.add('measure-thermocline', -60, 0)).toMatchObject({ ok: false, reason: 'strip' });
    expect(book.add('measure-thermocline', 119, 0)).toMatchObject({ ok: false, reason: 'strip' });
    expect(book.add('measure-thermocline', 170, 0)).toMatchObject({ ok: true });
    expect(book.add('measure-thermocline', -150, 0)).toMatchObject({ ok: true });
    expect(book.add('measure-thermocline', -80, 0)).toMatchObject({ ok: true });
    expect(inThermoclineStrip(-79)).toBe(false);
    expect(book.pins).toHaveLength(3);
  });

  it(`caps pins at ${MAX_PINS} and keeps working for existing places`, () => {
    const book = new ProbeBook();
    for (let i = 0; i < MAX_PINS; i++) expect(book.add(SEA, -170 + i * 20, 10).ok).toBe(true);
    expect(book.add(SEA, 0, 50)).toMatchObject({ ok: false, reason: 'pins' });
    expect(book.add('measure-wind', -170, 10)).toMatchObject({ ok: true });
  });

  it('removes a chart and only the pins no other chart uses; reuses the freed number', () => {
    const book = new ProbeBook();
    book.add(SEA, 140, 15); book.add('measure-wind', 140, 15); book.add('measure-wind', 160, 5);
    book.remove(SEA);
    expect(book.pins.map(p => p.n)).toEqual([1, 2]);
    book.remove('measure-wind');
    expect(book.pins).toHaveLength(0);
    expect(book.size).toBe(0);
    const again = book.add(SEA, 10, 10);
    expect(again.ok && again.pin?.n).toBe(1);
  });

  it('records on arrival, spaces samples, and a fast speed does not over-sample', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(SEA, 140, 15);
    expect(book.sample(at(s, 0))).toBe(true);
    expect(book.sample(at(s, 0.1))).toBe(false); // 6 model minutes
    expect(book.sample(at(s, 24 * MIN_SPACING_DAYS))).toBe(true);
    const line = book.seriesOf(SEA, 0, 1)!;
    expect(line.t).toHaveLength(2);
    expect(Number.isFinite(line.v[0])).toBe(true);
  });

  it('keeps the time axis growing when the calendar jumps ahead and the hours do not', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(SEA, 140, 15);
    book.sample(at(s, 100, 0));
    book.sample(at(s, 100, 365));
    book.sample(at(s, 100, 730));
    const line = book.seriesOf(SEA, 0, 1)!;
    expect(line.t).toEqual([elapsedDays(at(s, 100, 0)), elapsedDays(at(s, 100, 365)), elapsedDays(at(s, 100, 730))]);
    expect(line.t[2] - line.t[0]).toBe(730);
  });

  it('stays bounded per line over a long run', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(HUMID, 140, 15);
    for (let h = 0; h < 24 * 365; h += 3) book.sample(at(s, h));
    for (const plot of [0, 1]) expect(book.seriesOf(HUMID, plot, 1)!.t.length).toBeLessThanOrEqual(MAX_POINTS);
  });

  it('starts a line for a pin dropped later with its own fine spacing', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(SEA, 140, 15);
    for (let h = 0; h < 24 * 60; h += 1) book.sample(at(s, h));
    book.add(SEA, 160, 5);
    book.sample(at(s, 24 * 60));
    expect(book.seriesOf(SEA, 0, 2)!.t).toHaveLength(1);
    expect(book.seriesOf(SEA, 0, 2)!.stride).toBe(MIN_SPACING_DAYS);
  });

  it('clears for a new seed or when time runs backwards (a new world or a replay)', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(SEA, 140, 15);
    book.sample(at(s, 48));
    expect(book.size).toBe(1);
    book.sample(at(s, 12));
    expect(book.size).toBe(0);
    expect(book.pins).toHaveLength(0);
    book.add(SEA, 140, 15);
    book.sample(at(s, 48));
    book.sample({ ...at(s, 49), seed: s.seed + 1 });
    expect(book.size).toBe(0);
    book.add('measure-nino34', 0, 0);
    book.clear();
    expect(book.size).toBe(0);
  });

  it('reads sea temperature as a gap over land and every item as numbers', () => {
    const s = world();
    const book = new ProbeBook();
    book.add(SEA, 100, 40); // Eurasia
    book.add('measure-pressure', 100, 40);
    book.sample(at(s, 1));
    expect(Number.isNaN(book.latest(SEA, 0, 1))).toBe(true);
    expect(book.latest('measure-pressure', 0, 1)).toBeGreaterThan(900);
  });

  it('reads every item without a climate layer: indices are zero, the thermocline is the mean profile', () => {
    const s = world();
    expect(s.climateLayer).toBeNull();
    const book = new ProbeBook();
    for (const item of MEASURE_ITEMS) book.add(item.id, 170, 5);
    book.sample(at(s, 1));
    for (const item of MEASURE_ITEMS) {
      item.plots.forEach((_, i) => {
        const pins = item.basin ? [0] : [1];
        for (const n of pins) if (item.id !== SEA) expect(Number.isFinite(book.latest(item.id, i, n))).toBe(true);
      });
    }
    expect(book.latest('measure-nino34', 0, 0)).toBe(0);
    expect(book.latest('measure-soi-wwv', 1, 0)).toBe(0);
    expect(book.latest('measure-thermocline', 1, 1)).toBe(0);
    expect(book.latest('measure-thermocline', 0, 1)).toBeGreaterThan(40);
    expect(book.latest(HUMID, 0, 1)).toBeLessThanOrEqual(100);
  });

  it('reads the live indices once a layer is active, without changing the simulation', () => {
    const s = world();
    for (let i = 0; i < 6; i++) placeTool(s, 'warm', -120, 0);
    expect(s.climateLayer).not.toBeNull();
    const before = JSON.stringify([s.tick, s.hours, s.effects.length, s.actions.length, readClimateIndices(s)]);
    const book = new ProbeBook();
    book.add('measure-nino34', 0, 0); book.add('measure-thermocline', -120, 0); book.add(SEA, -120, 0);
    book.sample(at(s, s.hours + 1));
    book.sample(at(s, s.hours + 48));
    expect(JSON.stringify([s.tick, s.hours, s.effects.length, s.actions.length, readClimateIndices(s)])).toBe(before);
    expect(book.latest('measure-nino34', 0, 0)).toBe(readClimateIndices(s)!.nino34);
  });

  it('gives pins their colours in a fixed order, dashing the ones past eight', () => {
    expect(pinStyle(1).color).not.toBe(pinStyle(2).color);
    expect(pinStyle(8).dashed).toBe(false);
    expect(pinStyle(9)).toMatchObject({ color: pinStyle(1).color, dashed: true });
  });
});
