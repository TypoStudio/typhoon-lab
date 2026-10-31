import { describe, expect, it } from 'vitest';
import type { Effect, GameState, Storm, ToolType } from '../src/types';
import { STEP_HOURS, TOOLS, createGame, gridIndex, placeTool, sampleEnvironment, stepGame } from '../src/simulation/engine';

const SHEAR_TOOLS: ToolType[] = ['low-shear', 'high-shear'];
/** A fully ramped-in synthetic effect, independent of placement rules. */
const effect = (type: ToolType, lon: number, lat: number, id = 900): Effect => ({ id, type, lon, lat, radiusKm: 400, remainingHours: 24, ageHours: 24 });
function run(s: GameState, hours: number): void {
  const until = s.tick + Math.round(hours / STEP_HOURS);
  while (s.tick < until) stepGame(s);
}
function matureStorm(lon = 145, lat = 16, wind = 45): Storm {
  return { id: 1, lon, lat, wind, movementSpeedKmh: 0, pressure: 980, radiusKm: 40, galeRadiusKm: 200,
    stage: 'Typhoon', ageHours: 48, peakWind: wind, track: [{ lon, lat }], forecast: [], history: [], damageScore: 0, windDelta: 0 };
}

describe('shear conditions', () => {
  it('are simulation tools in the agreed order, with the specified size and wording', () => {
    expect(TOOLS.map(t => t.type)).toEqual(['warm', 'moisture', 'low', 'low-shear', 'warm-air', 'updraft', 'cool', 'dry', 'high', 'cold-air', 'downdraft', 'high-shear', 'unstable-air', 'stable-air']);
    for (const type of SHEAR_TOOLS) {
      const tool = TOOLS.find(t => t.type === type)!;
      expect([tool.radiusKm, tool.durationHours]).toEqual([400, 48]);
    }
    expect(TOOLS.find(t => t.type === 'low-shear')!.description).toBe('Calms the upper winds so a storm can stay upright. Stacking is capped at −60 m/s.');
    expect(TOOLS.find(t => t.type === 'high-shear')!.description).toBe('Adds upper-level wind that tilts and tears a storm apart. Stacking is capped at +60 m/s.');
  });

  it('change shear by 10 m/s per placement and cap the stack at 60 m/s either way', () => {
    const [lon, lat] = [160, 30]; // base shear ~ 8 + 18 * smoothstep(22,38,30) ≈ 17 m/s: room both ways
    const base = sampleEnvironment(createGame(1), lon, lat).shear;
    const at = (type: ToolType, n: number) => {
      const s = createGame(1);
      for (let k = 0; k < n; k++) s.effects.push(effect(type, lon, lat, 900 + k));
      return sampleEnvironment(s, lon, lat).shear;
    };
    expect(at('high-shear', 1)).toBeCloseTo(base + 10, 6);
    expect(at('high-shear', 2)).toBeCloseTo(base + 20, 6);
    expect(at('high-shear', 5)).toBeCloseTo(base + 50, 6);
    expect(at('high-shear', 8)).toBeCloseTo(base + 60, 6);
    expect(at('low-shear', 1)).toBeCloseTo(Math.max(0, base - 10), 6);
    expect(at('low-shear', 2)).toBeCloseTo(Math.max(0, base - 20), 6);
    expect(at('low-shear', 5)).toBeCloseTo(Math.max(0, base - 50), 6);
  });

  it('never drive shear below zero, in point samples or the grid', () => {
    const s = createGame(1);
    for (let k = 0; k < 4; k++) expect(placeTool(s, 'low-shear', 150, 0)).toEqual({ ok: true }); // equatorial base shear is under 20 m/s
    run(s, 12);
    expect(sampleEnvironment(s, 150, 0).shear).toBe(0);
    expect(s.grid[gridIndex(150, 0)].shear).toBe(0);
    expect(Math.min(...s.grid.map(c => c.shear))).toBeGreaterThanOrEqual(0);
  });

  it('give the grid the same shear as a point sample at the cell centre', () => {
    const s = createGame(1);
    placeTool(s, 'high-shear', 140, 16); placeTool(s, 'low-shear', 150, 30);
    run(s, 12);
    for (const [lon, lat] of [[140, 16], [150, 30], [145, 22]]) {
      const cell = s.grid[gridIndex(lon, lat)];
      expect(cell.shear).toBeCloseTo(sampleEnvironment(s, cell.lon, cell.lat).shear, 6);
    }
  });
});

describe('shear and storms', () => {
  // Tyrrhenian Sea: base shear ~27 m/s, SST ~20 °C, far from what a depression needs.
  const MED: [number, number] = [14.27, 38.72];
  const place = (tools: ToolType[]): GameState => {
    const s = createGame(20261022);
    for (const t of tools) expect(placeTool(s, t, MED[0], MED[1])).toEqual({ ok: true });
    return s;
  };

  it('Low shear x2 + Warm water x4 + Moisture x2 + Low forms a Mediterranean depression within 600 steps', () => {
    const s = place(['low-shear', 'low-shear', 'warm', 'warm', 'warm', 'warm', 'moisture', 'moisture', 'low']);
    let formedAt = -1;
    for (let k = 0; k < 600 && formedAt < 0; k++) { stepGame(s); if (s.storms.length) formedAt = k; }
    expect(formedAt).toBeGreaterThan(0);
    expect(Math.hypot(s.storms[0].lon - MED[0], s.storms[0].lat - MED[1])).toBeLessThan(3);
  });

  it('Warm water x3 is not enough there: SST stays under the 26 °C genesis floor, so the stack needs a fourth', () => {
    const s = place(['low-shear', 'low-shear', 'warm', 'warm', 'warm', 'moisture', 'low']);
    run(s, 12);
    const env = sampleEnvironment(s, MED[0], MED[1]);
    expect(env.shear).toBeLessThan(8); // the shear is already tamed
    expect(env.temperature).toBeLessThan(26);
    run(s, 138);
    expect(s.storms).toHaveLength(0);
  });

  it('a single Low shear cannot tame the Mediterranean even with six Warm water', () => {
    const s = place(['low-shear', 'warm', 'warm', 'warm', 'warm', 'warm', 'warm', 'moisture', 'moisture', 'low']);
    run(s, 150);
    expect(s.storms).toHaveLength(0);
  });

  it('Strong shear x2 renewed under a mature storm roughly halves its wind within 48 h, against a control run', () => {
    const wind = (sheared: boolean): number => {
      const s = createGame(20261022);
      s.storms = [matureStorm()];
      for (let k = 0; k < 192; k++) {
        const storm = s.storms[0];
        // The player renews the patch every 6 h under the moving storm; a single placement is outrun in about a day.
        if (sheared && k % 24 === 0) for (let n = 0; n < 2; n++) placeTool(s, 'high-shear', storm.lon, storm.lat);
        stepGame(s);
      }
      return s.storms[0].wind;
    };
    const control = wind(false);
    expect(control).toBeGreaterThan(40);
    expect(wind(true)).toBeLessThanOrEqual(0.55 * control);
  });

  it('a single Strong shear x2 placement weakens a storm only a little, because the storm outruns the patch', () => {
    const wind = (sheared: boolean): number => {
      const s = createGame(20261022);
      s.storms = [matureStorm()];
      if (sheared) for (let n = 0; n < 2; n++) placeTool(s, 'high-shear', 145, 16);
      run(s, 48);
      return s.storms[0].wind;
    };
    const control = wind(false);
    const once = wind(true);
    expect(once).toBeLessThan(control);
    expect(once).toBeGreaterThan(0.8 * control);
  });
});
