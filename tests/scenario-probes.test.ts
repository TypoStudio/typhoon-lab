import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../src/i18n';
import { createGame, loadClimateScenario, endClimateScenarioNow } from '../src/simulation/engine';
import { MAX_PINS, MEASURE_BY_ID, ProbeBook, inThermoclineStrip } from '../src/ui/measure';
import { SCENARIO_PROBES, SCENARIO_PROBE_PINS } from '../src/ui/scenario-probes';

afterEach(() => setLanguage('en'));

describe('the starter Measure set of a climate scenario', () => {
  it('names real items, keeps thermocline probes in the Pacific strip and fits the pin cap with room to spare', () => {
    for (const p of SCENARIO_PROBES) {
      const item = MEASURE_BY_ID.get(p.item)!;
      expect(item, p.item).toBeDefined();
      expect(Boolean(p.label)).toBe(!item.basin);
      if (p.item === 'measure-thermocline') expect(inThermoclineStrip(p.lon)).toBe(true);
    }
    expect(SCENARIO_PROBE_PINS).toBe(9);
    const book = new ProbeBook();
    expect(book.addSet(SCENARIO_PROBES)).toBe(SCENARIO_PROBES.length);
    expect(book.pins).toHaveLength(9);
    expect(book.pins.length).toBeLessThanOrEqual(MAX_PINS - 3);
    expect([...book.charts.keys()].sort()).toEqual(['measure-formation', 'measure-humidity', 'measure-nino34', 'measure-pressure', 'measure-sea-temperature', 'measure-soi-wwv', 'measure-thermocline']);
    expect(book.charts.get('measure-sea-temperature')!.size).toBe(3);
    expect(book.charts.get('measure-thermocline')!.size).toBe(2);
    expect(book.pins.every(p => p.label)).toBe(true);
  });

  it('has a translated place name for every label in all four other languages', () => {
    const labels = [...new Set(SCENARIO_PROBES.map(p => p.label).filter(Boolean))] as string[];
    for (const lang of ['ko', 'ja', 'zh-CN', 'zh-TW'] as const) {
      setLanguage(lang);
      for (const label of labels) expect(t(label), `${lang} ${label}`).not.toMatch(/^[A-Za-z ]+$/);
    }
  });

  it('adds only what fits when the player already uses pins, and never exceeds the cap', () => {
    const book = new ProbeBook();
    for (let i = 0; i < 6; i++) book.add('measure-wind', 10 + i * 20, 50);
    const before = book.pins.length;
    const added = book.addSet(SCENARIO_PROBES);
    expect(book.pins.length).toBeLessThanOrEqual(MAX_PINS);
    expect(book.pins.length).toBe(MAX_PINS);
    expect(added).toBeLessThan(SCENARIO_PROBES.length);
    expect(book.pins.length - before).toBe(MAX_PINS - before);
    book.removeAuto();
    expect(book.pins).toHaveLength(before);
    expect([...book.charts.keys()]).toEqual(['measure-wind']);
  });

  it('a line the player removes and adds again is theirs: switching the set off keeps it, for a pin chart and a basin chart', () => {
    const book = new ProbeBook();
    book.addSet(SCENARIO_PROBES);
    const pointProbe = SCENARIO_PROBES.find(p => !MEASURE_BY_ID.get(p.item)!.basin)!, basinProbe = SCENARIO_PROBES.find(p => MEASURE_BY_ID.get(p.item)!.basin)!;
    book.remove(pointProbe.item);
    book.remove(basinProbe.item);
    expect(book.add(pointProbe.item, pointProbe.lon, pointProbe.lat).ok).toBe(true);
    expect(book.add(basinProbe.item, 0, 0).ok).toBe(true);
    book.removeAuto();
    expect(book.charts.has(pointProbe.item)).toBe(true);
    expect(book.charts.has(basinProbe.item)).toBe(true);
  });

  it('replaces the set as a group, leaving no stale pins, and keeps what the player placed', () => {
    const book = new ProbeBook();
    book.addSet(SCENARIO_PROBES);
    const mine = book.add('measure-wind', 30, 40);
    expect(mine.ok && mine.pin!.n).toBeTruthy();
    // The player also uses the Darwin place for another chart, and re-adds a chart the set made: both become theirs.
    expect(book.add('measure-air-temperature', 130.9, -12.4).ok).toBe(true);
    expect(book.add('measure-nino34', 0, 0).ok).toBe(false);
    book.removeAuto();
    expect([...book.charts.keys()].sort()).toEqual(['measure-air-temperature', 'measure-nino34', 'measure-wind']);
    expect(book.pins.map(p => [p.lon, p.lat]).sort()).toEqual([[30, 40], [130.9, -12.4]].sort());
    // A second scenario starts a fresh set with nothing left from the first.
    book.addSet(SCENARIO_PROBES);
    book.removeAuto();
    book.addSet(SCENARIO_PROBES);
    expect(book.pins).toHaveLength(2 + 8); // Darwin is shared with the player's chart
    expect(new Set(book.pins.map(p => p.n)).size).toBe(book.pins.length);
    book.removeAuto();
    expect(book.pins).toHaveLength(2);
  });

  it('samples every chart in a real scenario world, and switching off drops the Observed line but keeps recording', () => {
    const s = createGame(20261110);
    loadClimateScenario(s, 'nino-1997');
    const book = new ProbeBook();
    book.addSet(SCENARIO_PROBES);
    expect(book.sample(s)).toBe(true);
    expect(book.observed).not.toBeNull();
    expect(book.seriesOf('measure-nino34', 0, 0)!.t).toHaveLength(1);
    for (const pin of book.pins) expect(book.seriesOf('measure-pressure', 0, pin.n) ?? book.seriesOf('measure-sea-temperature', 0, pin.n) ?? book.seriesOf('measure-humidity', 0, pin.n) ?? book.seriesOf('measure-formation', 0, pin.n) ?? book.seriesOf('measure-thermocline', 0, pin.n), `pin ${pin.n}`).toBeDefined();
    // Humidity at the two places reads a value, not a gap.
    const peru = book.pins.find(p => p.label === 'Coastal Peru')!, indo = book.pins.find(p => p.label === 'Indonesia')!;
    expect(Number.isFinite(book.latest('measure-humidity', 0, peru.n))).toBe(true);
    expect(Number.isFinite(book.latest('measure-humidity', 0, indo.n))).toBe(true);
    for (const pin of book.pins.filter(p => ['Central Pacific', 'East Pacific', 'Warm pool'].includes(p.label!))) expect(Number.isFinite(book.latest('measure-sea-temperature', 0, pin.n))).toBe(true);
    s.hours += 24;
    endClimateScenarioNow(s);
    const before = book.seriesOf('measure-nino34', 0, 0)!.t.length;
    book.sample(s);
    expect(book.observed).toBeNull();
    expect(book.seriesOf('measure-nino34', 0, 0)!.t.length).toBeGreaterThanOrEqual(before);
  });
});
