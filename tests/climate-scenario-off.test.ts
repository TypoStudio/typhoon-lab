import { describe, expect, it, vi } from 'vitest';
import { climateIndices } from '../src/simulation/climate-core';
import { createGame, dayOfYear, endClimateScenarioNow, loadClimateScenario, placeTool, replayGame, sampleEnvironment, setClimate, setClimateMode, setGenesis, setSeason, validateActions } from '../src/simulation/engine';
import { actionKey, buildReplay } from '../src/ui/storage';
import { activeExperienceKeys } from '../src/ui/experience';
import { skipDays } from './climate-helpers';

vi.setConfig({ testTimeout: 300_000 });
const SEED = 20261110;
const SPOTS: [number, number][] = [[200, 0], [150, 10], [250, -5], [140, 20], [120, 5]];
const envOf = (s: ReturnType<typeof createGame>) => SPOTS.map(([lon, lat]) => { const e = sampleEnvironment(s, lon, lat); return [e.temperature, e.airTemperature, e.pressure, e.u, e.v, e.humidity]; });

describe('switching a climate scenario off', () => {
  it('is rejected, and not recorded, when no scenario is loaded', () => {
    const s = createGame(SEED);
    expect(endClimateScenarioNow(s).ok).toBe(false);
    expect(s.actions).toEqual([]);
  });

  it('ends the scenario at once: clock, layer, news and the active tile go, the date stays, the map is neutral again', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    setGenesis(s, false); // a quiet world that skipDays can jump through (a load turns natural formation on)
    skipDays(s, 40);
    const during = envOf(s);
    expect(activeExperienceKeys(s).has('scenario:nino-1997')).toBe(true);
    const dateBefore = dayOfYear(s), hoursBefore = s.hours;
    expect(endClimateScenarioNow(s)).toEqual({ ok: true });
    expect(s.climateScenario).toBeUndefined();
    expect(s.climateLayer).toBeNull();
    expect(activeExperienceKeys(s).size).toBe(0);
    expect(dayOfYear(s)).toBeCloseTo(dateBefore, 6);
    expect(s.hours).toBe(hoursBefore);
    expect(s.actions.at(-1)).toEqual({ tick: s.tick, type: 'climate-scenario-off' });
    expect(s.news.at(-1)).toMatchObject({ title: 'Climate scenario ended', kind: 'info' });
    // The same date in a world that never had a layer gives the same fields.
    const base = createGame(SEED);
    skipDays(base, 40);
    expect(setSeason(base, dayOfYear(s)).ok).toBe(true);
    expect(envOf(s)).toEqual(envOf(base));
    expect(envOf(s)).not.toEqual(during);
    // Off twice is rejected: nothing is loaded any more.
    expect(endClimateScenarioNow(s).ok).toBe(false);
  });

  it('keeps a layer only where something else needs it: the ENSO slider, a placed tropical condition, natural variability', () => {
    const held = createGame(SEED);
    loadClimateScenario(held, 'nina-2010');
    skipDays(held, 5);
    expect(setClimate(held, 'enso', 1.5).ok).toBe(true);
    endClimateScenarioNow(held);
    expect(held.climateLayer).not.toBeNull();
    expect(held.climateLayer!.core.script).toHaveLength(0);
    expect(held.climateLayer!.core.tradeAnomaly).toBe(0);
    expect(climateIndices(held.climateLayer!.core).nino34).toBeCloseTo(1.5, 1);
    // The slider back to 0 leaves the layer harmless; a world with the slider at 0 and no tools drops it.
    const tool = createGame(SEED);
    loadClimateScenario(tool, 'nino-1997');
    expect(placeTool(tool, 'warm', -170, 0).ok).toBe(true);
    endClimateScenarioNow(tool);
    expect(tool.climateLayer).not.toBeNull();
    expect(tool.climateLayer!.core.nPatches).toBeGreaterThan(0);
    expect(climateIndices(tool.climateLayer!.core).nino34).toBeLessThan(1);
    const fast = createGame(SEED, 213);
    setClimateMode(fast, true);
    loadClimateScenario(fast, 'nina-2010');
    expect(fast.climateTime!.active).toBe(true);
    endClimateScenarioNow(fast);
    expect(fast.climateLayer).not.toBeNull();
    expect(fast.climateScenario).toBeUndefined();
    // A formation recipe or a condition outside the tropics does not need the layer.
    const poles = createGame(SEED);
    loadClimateScenario(poles, 'nino-1997');
    expect(placeTool(poles, 'warm', -170, 45).ok).toBe(true);
    endClimateScenarioNow(poles);
    expect(poles.climateLayer).toBeNull();
  });

  it('replays identically, including the slider-held, tool and fast-path cases, and stays a valid, keyed, exported action', () => {
    const worlds = [
      (s: ReturnType<typeof createGame>) => { loadClimateScenario(s, 'nino-1997'); skipDays(s, 12); endClimateScenarioNow(s); skipDays(s, 3); },
      (s: ReturnType<typeof createGame>) => { loadClimateScenario(s, 'nina-2010'); setClimate(s, 'enso', -1); skipDays(s, 8); endClimateScenarioNow(s); skipDays(s, 4); },
      (s: ReturnType<typeof createGame>) => { loadClimateScenario(s, 'nino-1997'); skipDays(s, 2); placeTool(s, 'warm', -170, 0); endClimateScenarioNow(s); loadClimateScenario(s, 'nina-2010'); skipDays(s, 2); }, // skipDays drops tools, so the tool is placed just before the switches that re-feed it
    ];
    for (const run of worlds) {
      const s = createGame(SEED);
      run(s);
      const r = replayGame(SEED, s.actions, s.tick);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.state.climateScenario).toEqual(s.climateScenario);
        expect(r.state.climateLayer?.core ?? null).toEqual(s.climateLayer?.core ?? null);
        expect(r.state.hours).toBe(s.hours);
      }
    }
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    endClimateScenarioNow(s);
    expect(validateActions([{ tick: 0, type: 'climate-scenario-off', extra: 1 }])).toEqual({ ok: true, actions: [{ tick: 0, type: 'climate-scenario-off' }] });
    expect(replayGame(SEED, [{ tick: 0, type: 'climate-scenario-off' }], 0).ok).toBe(false); // nothing to switch off
    expect(actionKey(s.actions.at(-1)!)).toEqual([s.tick, 'climate-scenario-off']);
    const file = buildReplay(s);
    expect(file.actions.at(-1)).toEqual({ tick: s.tick, type: 'climate-scenario-off' });
  });
});
