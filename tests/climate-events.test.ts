import { writeFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CLIMATE_COOLDOWN_DAYS, CLIMATE_MAX_ACTIVE, CLIMATE_NINO_MIN, CLIMATE_REGIONS, HISTORIC_RECORD, HISTORIC_RECORD_TEXT, monthOf, stepClimateEvents, trimNews, type ClimateEventHost } from '../src/simulation/climate-events';
import { climateScenarioById } from '../src/simulation/climate-scenarios';
import { advanceClimateTime, createGame, dayOfYear, endClimateScenarioNow, isLand, loadClimateScenario, replayGame, setClimateMode, setGenesis, setSeason, stepGame } from '../src/simulation/engine';
import { freshNews } from '../src/ui/news-fresh';
import { newAnomalyPoint } from '../src/simulation/climate-coupling';
import type { GameState } from '../src/types';
import { TICKS_PER_DAY, skipDays } from './climate-helpers';

vi.setConfig({ testTimeout: 600_000 });
const SEED = 20261110;
const climateNews = (s: GameState) => s.news.filter(n => n.id.startsWith('climate-event-'));
const log: string[] = [];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Runs `days` of full weather and collects every climate-driven event, record post and typhoon formation, with the date. */
function run(id: 'nino-1997' | 'nina-2010', days: number, patch?: (s: GameState) => void) {
  const s = createGame(SEED);
  loadClimateScenario(s, id);
  patch?.(s);
  const seen = new Set<string>(), events: string[] = [], records: string[] = [], formed: string[] = [];
  const hazardIds = new Set<number>();
  let maxActive = 0, typhoons = 0, wall = 0;
  const year0 = climateScenarioById(id).year;
  const label = () => { const d = dayOfYear(s); const m = monthOf(d); return `${year0 + Math.floor(s.hours / 24 / 365.25)}-${MONTHS[m - 1]}`; };
  const t0 = performance.now();
  for (let d = 0; d < days; d++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) stepGame(s);
    maxActive = Math.max(maxActive, (s.weatherHazards ?? []).filter(h => h.climate).length);
    for (const h of s.weatherHazards ?? []) if (h.climate) hazardIds.add(h.id);
    for (const n of s.news) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      if (n.id.startsWith('climate-event-')) events.push(`${label()}  ${n.title}`);
      else if (n.id.startsWith('climate-record-')) records.push(`${label()}  ${n.title}`);
      else if (n.id.startsWith('formation-')) { typhoons++; formed.push(`${label()}  ${n.title}`); }
    }
  }
  wall = performance.now() - t0;
  return { s, events, records, formed, maxActive, typhoons, wall, ids: hazardIds };
}

const TIMELINE = it.skipIf(!process.env.CLIMATE_TIMELINE);
const DAYS = 700;
function timeline(id: 'nino-1997' | 'nina-2010', file: string) {
  const { s, events, records, formed, maxActive, wall } = run(id, DAYS);
  const perYear = [0, 1].map(y => events.filter(e => e.startsWith(String(climateScenarioById(id).year + y))).length);
  const all = [...s.stormArchive, ...s.storms], strong = all.filter(x => x.peakWind >= 33).length;
  const lines = [`${id}: ${events.length} climate events in ${DAYS} days (per calendar year ${perYear.join(' / ')}), ${formed.length} depressions formed, ${all.length} storms recorded of which ${strong} reached typhoon strength (33 m/s), max concurrent climate hazards ${maxActive}, ${(wall / 1000).toFixed(0)} s wall`,
    '-- climate-driven events', ...events, '-- record of real events', ...records, '-- typhoon formation (first 8)', ...formed.slice(0, 8)];
  writeFileSync(file, lines.join('\n'));
  return { s, events, records, formed, maxActive };
}

/** A synthetic host: every probe reads twice the full-effect anomaly of its region in the region's own direction, or nothing. */
function host(state: GameState, nino: number, strong: boolean, day: number, emitted: string[]) {
  const h: ClimateEventHost = {
    nino, day, doy: 1 + (day % 365),
    probe: (lon, lat) => {
      const r = CLIMATE_REGIONS.find(x => x.probe.lon === lon && x.probe.lat === lat)!;
      const p = newAnomalyPoint();
      if (strong) p[r.field] = (r.kind === 'drought' ? -1 : 1) * r.hi * 2;
      return p;
    },
    sample: () => state.grid[0],
  };
  return { h, run: () => stepClimateEvents(state, h, n => emitted.push(n.title)) };
}
const regionOf = (lon: number, lat: number) => CLIMATE_REGIONS.findIndex(r => r.lon === lon && r.lat === lat);

/** Steps the game one tick per model day (skipDays) and clears finished climate hazards daily, so the cap does not hide the rate; returns events by day. */
function cheapRun(id: 'nino-1997' | 'nina-2010', days: number) {
  const s = createGame(SEED);
  loadClimateScenario(s, id);
  const out: { day: number; side: string; title: string; month: number; region: number }[] = [];
  const seen = new Set<string>();
  for (let d = 0; d < days; d++) {
    skipDays(s, 1);
    for (const n of s.news) if (n.id.startsWith('climate-event-') && !seen.has(n.id)) {
      seen.add(n.id);
      out.push({ day: d, side: n.title.startsWith('El Niño') ? 'nino' : 'nina', title: n.title, month: monthOf(dayOfYear(s)), region: regionOf(n.lon!, n.lat!) });
    }
    s.weatherHazards = [];
  }
  return { s, out };
}

describe('climate-driven events and the record of real events', () => {
  it('the region table is consistent: land for droughts, valid seasons, both sides present', () => {
    for (const r of CLIMATE_REGIONS) {
      expect(r.hi).toBeGreaterThan(r.lo);
      expect(r.from >= 1 && r.from <= 12 && r.to >= 1 && r.to <= 12).toBe(true);
      expect(isLand(r.lon, r.lat), `${r.kind} ${r.place}`).toBe(true); // every kind needs a valid surface at its start point: land for all 16
      if (r.field !== 'sst') expect(isLand(r.probe.lon, r.probe.lat), r.place).toBe(true);
    }
    expect(CLIMATE_REGIONS.filter(r => r.driver === 'nino').length).toBeGreaterThanOrEqual(8);
    expect(CLIMATE_REGIONS.filter(r => r.driver === 'nina').length).toBeGreaterThanOrEqual(6);
  });

  it('with the anomaly neutralised nothing fires; with it, events are on the right side, in season, rested and capped', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    s.weatherHazards = [];
    for (const nino of [3, -3, 0.3]) {
      const neutral: string[] = [];
      for (let d = 0; d < 730; d++) host(s, nino, false, d, neutral).run();
      expect(neutral, `neutral anomaly, nino ${nino}`).toEqual([]);
    }
    expect(s.weatherHazards).toEqual([]);
    for (const nino of [3, -3]) {
      const w = createGame(SEED);
      loadClimateScenario(w, 'nino-1997');
      w.weatherHazards = [];
      const last = new Map<number, number>();
      const per = new Map<number, number>();
      let started = 0;
      for (let d = 0; d < 730; d++) {
        const before = w.weatherHazards.length;
        w.weatherHazards = w.weatherHazards.filter(h => h.ageHours < h.durationHours); // finished events go
        for (const h of w.weatherHazards) h.ageHours += 24;
        const emitted: string[] = [];
        const n = host(w, nino, true, d, emitted).run();
        expect(n).toBe(emitted.length);
        expect(w.weatherHazards.filter(h => h.climate).length).toBeLessThanOrEqual(CLIMATE_MAX_ACTIVE);
        for (const h of w.weatherHazards.slice(w.weatherHazards.length - n)) {
          const i = regionOf(h.lon, h.lat), r = CLIMATE_REGIONS[i];
          expect(r.driver).toBe(nino > 0 ? 'nino' : 'nina');
          const m = monthOf(1 + (d % 365));
          expect(r.from <= r.to ? m >= r.from && m <= r.to : m >= r.from || m <= r.to, `${r.place} month ${m}`).toBe(true);
          if (last.has(i)) expect(d - last.get(i)!).toBeGreaterThanOrEqual(CLIMATE_COOLDOWN_DAYS);
          last.set(i, d); per.set(i, (per.get(i) ?? 0) + 1); started++;
        }
        void before;
      }
      expect(started).toBeGreaterThan(5);
      log.push(`synthetic full anomaly, nino ${nino}: ${started} events in 2 years, ${per.size} regions`);
    }
  });

  it('is deterministic and silent below the Nino threshold', () => {
    const a: string[] = [], b: string[] = [];
    for (const out of [a, b]) {
      const s = createGame(SEED);
      loadClimateScenario(s, 'nino-1997');
      s.weatherHazards = [];
      for (let d = 0; d < 365; d++) { host(s, 3, true, d, out).run(); s.weatherHazards = s.weatherHazards.slice(0, 0); }
    }
    expect(a.length).toBeGreaterThan(0);
    expect(a).toEqual(b);
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    const quiet: string[] = [];
    for (let d = 0; d < 365; d++) host(s, CLIMATE_NINO_MIN - 0.01, true, d, quiet).run();
    expect(quiet).toEqual([]);
  });

  it('an engine scenario with no anomaly (flat ocean, no wind) fires nothing', () => {
    const def = climateScenarioById('nina-2010'), saved = { t: def.thermocline, n: def.startNino34, sc: def.script };
    try {
      def.thermocline = 0; def.startNino34 = 0; def.script = [];
      const { s, out } = cheapRun('nina-2010', 400);
      expect(out).toEqual([]);
      expect(s.news.some(n => n.id.startsWith('climate-event-'))).toBe(false);
    } finally { def.thermocline = saved.t; def.startNino34 = saved.n; def.script = saved.sc; }
  });

  it('1997-98: El Nino-side events only through the peak, in season; 2010-11: the reverse', () => {
    const a = cheapRun('nino-1997', 540);
    expect(a.out.length).toBeGreaterThan(3);
    expect(a.out.every(e => e.side === 'nino')).toBe(true);
    for (const e of a.out) { const r = CLIMATE_REGIONS[e.region]; expect(r.from <= r.to ? e.month >= r.from && e.month <= r.to : e.month >= r.from || e.month <= r.to).toBe(true); }
    const b = cheapRun('nina-2010', 700);
    const late = b.out.filter(e => e.day > 150 && e.day <= 540); // the peak; the model turns to a new El Niño after the script ends (day 660 on)
    expect(late.length).toBeGreaterThan(2);
    expect(late.every(e => e.side === 'nina')).toBe(true);
    log.push('cheap run 1997 (one tick per day, finished events cleared): ' + a.out.map(e => `d${e.day} ${e.title}`).join('; '));
    log.push('cheap run 2010: ' + b.out.map(e => `d${e.day} ${e.title}`).join('; '));
  });

  it('the fast path starts no climate-driven disaster but the record of real events appears on its dates, as on the weather path', () => {
    const fast = createGame(SEED);
    loadClimateScenario(fast, 'nino-1997');
    setClimateMode(fast, true);
    const posted: string[] = [];
    for (let d = 0; d < 520; d++) {
      advanceClimateTime(fast, 1);
      for (const n of fast.news) if (n.id.startsWith('climate-record-') && !posted.includes(n.id)) posted.push(n.id);
    }
    expect(fast.news.some(n => n.id.startsWith('climate-event-'))).toBe(false);
    expect(fast.weatherHazards ?? []).toEqual([]);
    const titles = fast.news.filter(n => n.id.startsWith('climate-record-')).map(n => n.title);
    expect(titles).toEqual(HISTORIC_RECORD.filter(e => e.scenario === 'nino-1997' && e.year * 12 + e.month <= 1998 * 12 + 6).map(e => `Historical record: ${e.name}`));
    expect(fast.news.find(n => n.id.startsWith('climate-record-'))).toMatchObject({ kind: 'info', text: HISTORIC_RECORD_TEXT });
    expect(fast.news.find(n => n.title.includes('Paka'))).toMatchObject({ lon: 144.8, lat: 13.5 });
    // Dates: before 15 September 1997 (day 257 of the year) none, on that date the first.
    const early = createGame(SEED);
    loadClimateScenario(early, 'nino-1997');
    setClimateMode(early, true);
    advanceClimateTime(early, 256);
    expect(early.news.some(n => n.id.startsWith('climate-record-'))).toBe(false);
    advanceClimateTime(early, 2);
    expect(early.news.filter(n => n.id.startsWith('climate-record-')).map(n => n.title)).toEqual(['Historical record: Indonesian forest fires and haze']);
    // The weather path posts the same items.
    const weather = createGame(SEED);
    loadClimateScenario(weather, 'nino-1997');
    skipDays(weather, 520);
    expect(weather.news.filter(n => n.id.startsWith('climate-record-')).map(n => n.title)).toEqual(titles);
  });

  it('Natural typhoon formation is part of the load and the player\'s setting returns when the scenario ends', () => {
    for (const prior of [false, true]) for (const end of ['off', 'season'] as const) {
      const s = createGame(SEED);
      if (prior) setGenesis(s, true);
      expect(s.genesis.enabled).toBe(prior);
      loadClimateScenario(s, 'nino-1997');
      expect(s.genesis.enabled).toBe(true);
      expect(s.climateScenario!.priorGenesis).toBe(prior);
      skipDays(s, 3);
      if (end === 'off') expect(endClimateScenarioNow(s).ok).toBe(true); else expect(setSeason(s, 200).ok).toBe(true);
      expect(s.genesis.enabled, `prior ${prior}, ${end}`).toBe(prior);
    }
    // A second load keeps the setting from before the first; a switch made during a scenario is the player's choice and stays.
    const a = createGame(SEED);
    loadClimateScenario(a, 'nino-1997'); loadClimateScenario(a, 'nina-2010');
    endClimateScenarioNow(a);
    expect(a.genesis.enabled).toBe(false);
    const b = createGame(SEED);
    loadClimateScenario(b, 'nino-1997');
    setGenesis(b, false); setGenesis(b, true);
    endClimateScenarioNow(b);
    expect(b.genesis.enabled).toBe(true);
  });

  it('replays identically across a load, climate events, scenario off, a reload and a season change', () => {
    const s = createGame(SEED, 213);
    loadClimateScenario(s, 'nino-1997');
    setClimateMode(s, true);
    advanceClimateTime(s, 250);
    setClimateMode(s, false);
    const T = (n: number) => { for (let k = 0; k < n * TICKS_PER_DAY; k++) stepGame(s); };
    T(25);
    const climateHazards = s.weatherHazards?.filter(h => h.climate).length ?? 0;
    endClimateScenarioNow(s);
    T(3);
    loadClimateScenario(s, 'nina-2010');
    T(5);
    setSeason(s, 100);
    T(3);
    const r = replayGame(SEED, s.actions, s.tick, 213);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.genesis).toEqual(s.genesis);
    expect(r.state.climateScenario).toEqual(s.climateScenario);
    expect(r.state.weatherHazards).toEqual(s.weatherHazards);
    expect(r.state.disasters).toEqual(s.disasters);
    expect(r.state.news).toEqual(s.news);
    expect(r.state.grid).toEqual(s.grid);
    log.push(`replay world: ${climateHazards} climate hazards active at the off, ${s.news.filter(n => n.id.startsWith('climate-event-')).length} climate events in the news`);
  });

  it('a climate event is an ordinary disaster: record, damage path and news', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    setClimateMode(s, true); advanceClimateTime(s, 280); setClimateMode(s, false);
    let found = false;
    for (let d = 0; d < 90 && !found; d++) { for (let k = 0; k < TICKS_PER_DAY; k++) stepGame(s); found = s.weatherHazards!.some(h => h.climate); }
    expect(found).toBe(true);
    const h = s.weatherHazards!.find(x => x.climate)!;
    expect(s.disasters!.some(d => d.id === `weather-${h.id}` && d.kind === h.kind)).toBe(true);
    const n = s.news.find(x => x.id === `climate-event-${h.id}`)!;
    expect(n).toMatchObject({ kind: 'weather', phenomenon: h.kind });
    expect(n.title).toMatch(/^El Niño: (heavy rain|drought|heat) in /);
  });

  it('costs next to nothing per day', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    const out: string[] = [];
    const { run: go } = host(s, 3, true, 0, out);
    let t = performance.now();
    for (let i = 0; i < 20000; i++) { s.climateScenario!.eventLast.length = 0; go(); s.weatherHazards = []; }
    const perCall = ((performance.now() - t) * 1000) / 20000;
    const plain = createGame(SEED);
    t = performance.now();
    let sink = 0;
    for (let i = 0; i < 1e6; i++) if (plain.climateScenario) sink++;
    const perCheck = ((performance.now() - t) * 1e6) / 1e6;
    log.push(`cost: stepClimateEvents ${perCall.toFixed(1)} us per model day (worst case, all in season); plain world check ${perCheck.toFixed(1)} ns per day (sink ${sink})`);
    expect(Number.isFinite(perCall)).toBe(true); // the number is printed, not bounded: wall-clock limits flake on a loaded machine
  });

  it('lasting news survives the cap and routine items go first; a feed without them loses its oldest items as before', () => {
    const plain = Array.from({ length: 70 }, (_, i) => ({ id: `n${i}` }));
    trimNews(plain, 60);
    expect(plain.map(n => n.id)).toEqual(Array.from({ length: 60 }, (_, i) => `n${i + 10}`));
    const mixed = [{ id: 'climate-record-1-5' }, ...Array.from({ length: 70 }, (_, i) => ({ id: `n${i}` })), { id: 'climate-event-9' }];
    trimNews(mixed, 60);
    expect(mixed).toHaveLength(60);
    expect(mixed[0].id).toBe('climate-record-1-5');
    expect(mixed.at(-1)!.id).toBe('climate-event-9');
    expect(mixed[1].id).toBe('n12');
  });

  it('the news notifier finds new items by id, so it keeps working at the cap', () => {
    const feed = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}` }));
    expect(freshNews(feed, 'n59')).toEqual([]);
    feed.push({ id: 'n60' }); feed.shift(); // the feed stays 60 long
    expect(freshNews(feed, 'n59').map(n => n.id)).toEqual(['n60']);
    expect(freshNews(feed, 'gone').length).toBe(60); // the last seen item was evicted: everything counts as new
    expect(freshNews(feed, null).length).toBe(60);
  });

  TIMELINE('1997-98 El Nino timeline', () => { const r = timeline('nino-1997', '/tmp/climate-timeline-1997.txt'); expect(r.events.some(e => e.includes('La Niña'))).toBe(false); });
  TIMELINE('2010-11 La Nina timeline', () => { timeline('nina-2010', '/tmp/climate-timeline-2010.txt'); });
  it('prints the log', () => { console.log('CE-LOG\n' + log.join('\n')); writeFileSync('/tmp/climate-events-log.txt', log.join('\n')); });
});
