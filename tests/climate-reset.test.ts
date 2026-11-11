import { describe, expect, it, vi } from 'vitest';
import { climateIndices } from '../src/simulation/climate-core';
import { climateIsNormal, createGame, loadClimateScenario, placeTool, replayActivatesClimateLayer, replayGame, resetClimateNow, sampleEnvironment, setClimate, setClimateMode, setGenesis, validateActions } from '../src/simulation/engine';
import { actionKey, buildReplay } from '../src/ui/storage';
import { activeExperienceKeys } from '../src/ui/experience';
import { skipDays } from './climate-helpers';

vi.setConfig({ testTimeout: 300_000 });
const SEED = 20261111;
type Game = ReturnType<typeof createGame>;
const SPOTS: [number, number][] = [[200, 0], [150, 10], [250, -5], [140, 20], [120, 5]];
const envOf = (s: Game) => SPOTS.map(([lon, lat]) => { const e = sampleEnvironment(s, lon, lat); return [e.temperature, e.airTemperature, e.pressure, e.u, e.v, e.humidity]; });

describe('resetting the climate', () => {
  it('is rejected, and not recorded, when the climate is already normal', () => {
    const s = createGame(SEED);
    expect(climateIsNormal(s)).toBe(true);
    expect(resetClimateNow(s).ok).toBe(false);
    expect(s.actions).toEqual([]);
    setClimate(s, 'warming', 1);
    expect(climateIsNormal(s)).toBe(false);
    expect(resetClimateNow(s).ok).toBe(true);
    expect(resetClimateNow(s).ok).toBe(false); // twice
  });

  it('sliders only: all three go to 0, the layer goes, the map matches a world that never moved them', () => {
    const s = createGame(SEED);
    setClimate(s, 'warming', 2); setClimate(s, 'polar', -1.5); setClimate(s, 'enso', 1.5);
    expect(s.climateLayer).not.toBeNull();
    expect(resetClimateNow(s)).toEqual({ ok: true });
    expect(s.climate).toEqual({ warming: 0, enso: 0, polar: 0 });
    expect(s.climateLayer).toBeNull();
    expect(climateIsNormal(s)).toBe(true);
    expect(s.actions.at(-1)).toEqual({ tick: s.tick, type: 'climate-reset' });
    expect(s.news.at(-1)).toMatchObject({ title: 'Climate reset', kind: 'info' });
    expect(envOf(s)).toEqual(envOf(createGame(SEED)));
  });

  it('a scenario: switched off at once with natural formation restored, the ENSO slider and trade winds cleared', () => {
    const s = createGame(SEED);
    expect(s.genesis.enabled).toBe(false);
    loadClimateScenario(s, 'nino-1997');
    setGenesis(s, false);
    skipDays(s, 20);
    setClimate(s, 'enso', 1);
    expect(s.genesis.enabled).toBe(false);
    expect(resetClimateNow(s).ok).toBe(true);
    expect(s.climateScenario).toBeUndefined();
    expect(activeExperienceKeys(s).size).toBe(0);
    expect(s.climate.enso).toBe(0);
    expect(s.climateLayer).toBeNull();
    // A load that turned natural formation on gives the earlier setting back.
    const t = createGame(SEED);
    loadClimateScenario(t, 'nina-2010');
    expect(t.genesis.enabled).toBe(true);
    resetClimateNow(t);
    expect(t.genesis.enabled).toBe(false);
  });

  it('fast-path variability: natural noise is off and the layer is neutral, kept for the fast path itself', () => {
    const s = createGame(SEED, 213);
    setClimateMode(s, true);
    expect(s.climateLayer!.core.stochastic).toBe(true);
    expect(climateIsNormal(s)).toBe(false);
    expect(resetClimateNow(s).ok).toBe(true);
    expect(s.climateTime!.active).toBe(true);
    expect(s.climateLayer).not.toBeNull(); // the fast path needs a layer to advance
    expect(s.climateLayer!.core.stochastic).toBe(false);
    expect(s.climateLayer!.core.tradeAnomaly).toBe(0);
    expect(Math.abs(climateIndices(s.climateLayer!.core).nino34)).toBeLessThan(0.3);
    expect(climateIsNormal(s)).toBe(true);
  });

  it('tropical conditions are re-fed into a fresh neutral layer; tropical-free worlds drop it', () => {
    const s = createGame(SEED);
    loadClimateScenario(s, 'nino-1997');
    expect(placeTool(s, 'warm', -170, 0).ok).toBe(true);
    expect(resetClimateNow(s).ok).toBe(true);
    expect(s.climateScenario).toBeUndefined();
    expect(s.climateLayer).not.toBeNull();
    expect(s.climateLayer!.core.nPatches).toBeGreaterThan(0);
    expect(s.climateLayer!.core.script).toHaveLength(0);
    expect(s.climateLayer!.core.stochastic).toBe(false);
    expect(climateIsNormal(s)).toBe(true); // what the tools warm is theirs, not a leftover
    const poles = createGame(SEED);
    setClimate(poles, 'warming', 1);
    expect(placeTool(poles, 'warm', -170, 45).ok).toBe(true);
    resetClimateNow(poles);
    expect(poles.climateLayer).toBeNull();
    expect(poles.effects.length).toBeGreaterThan(0); // the tool itself stays
  });

  it('replays identically in every case, and is a valid, keyed, exported action that activates the layer', () => {
    const worlds: ((s: Game) => void)[] = [
      s => { setClimate(s, 'warming', 2); setClimate(s, 'enso', -1); skipDays(s, 3); resetClimateNow(s); skipDays(s, 3); },
      s => { loadClimateScenario(s, 'nino-1997'); skipDays(s, 12); resetClimateNow(s); skipDays(s, 3); },
      s => { setClimateMode(s, true); resetClimateNow(s); skipDays(s, 2); },
      s => { loadClimateScenario(s, 'nina-2010'); skipDays(s, 2); placeTool(s, 'warm', -170, 0); resetClimateNow(s); },
    ];
    for (const run of worlds) {
      const s = createGame(SEED);
      run(s);
      const r = replayGame(SEED, s.actions, s.tick);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.state.climate).toEqual(s.climate);
        expect(r.state.climateScenario).toEqual(s.climateScenario);
        expect(r.state.climateLayer?.core ?? null).toEqual(s.climateLayer?.core ?? null);
        expect(r.state.genesis.enabled).toBe(s.genesis.enabled);
        expect(r.state.hours).toBe(s.hours);
      }
    }
    const s = createGame(SEED);
    setClimate(s, 'polar', 1);
    resetClimateNow(s);
    expect(validateActions([{ tick: 0, type: 'climate-reset', extra: 1 }])).toEqual({ ok: true, actions: [{ tick: 0, type: 'climate-reset' }] });
    expect(replayGame(SEED, [{ tick: 0, type: 'climate-reset' }], 0).ok).toBe(false); // nothing to reset
    expect(actionKey(s.actions.at(-1)!)).toEqual([s.tick, 'climate-reset']);
    expect(buildReplay(s).actions.at(-1)).toEqual({ tick: s.tick, type: 'climate-reset' });
    expect(replayActivatesClimateLayer([{ tick: 0, type: 'climate-reset' }])).toBe(true);
  });
});
