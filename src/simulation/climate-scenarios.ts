import { OCEAN_LON0, OCEAN_N, OCEAN_DLON, createClimate, nino34Of, setClimateScript, type ClimateState } from './climate-core';

/**
 * Historic climate scenarios. Each one is a noise-free ENSO core with an ocean start state and scripted forcing by day (the wind events that
 * drove the real event), so the cause and effect are the model's own: the winds act on the thermocline, the thermocline on the sea
 * temperature, the sea temperature on the atmosphere. The dates and strengths are approximate: they reproduce the causes of the event,
 * not its exact history. After the script ends the layer evolves on its own physics.
 */
export const CLIMATE_SCENARIO_IDS = ['nino-1997', 'nina-2010'] as const;
export type ClimateScenarioId = (typeof CLIMATE_SCENARIO_IDS)[number];

export interface ClimateScenario {
  id: ClimateScenarioId;
  /** First calendar year; the scenario starts on 1 January of it. */
  year: number;
  name: string;
  description: string;
  /** Zonal-mean thermocline-depth anomaly at the start (m, positive = recharged, deeper than normal). */
  thermocline: number;
  /** Niño 3.4 of the initial warm SST anomaly (degC) left over from the preceding event, or 0. */
  startNino34: number;
  /** Scripted forcing, entries of [day, kind, a, b, c] as ClimateState.script. */
  script: number[];
}

const burst = (day: number, lonEast: number, speed: number, days: number): number[] => [day, 0, lonEast, speed, days];
/** Piecewise-linear trade-wind anomaly (m/s, easterly +) between [day, value] knots, set every 30 days. */
function tradeRamp(knots: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (let k = 0; k + 1 < knots.length; k++) {
    const [d0, v0] = knots[k], [d1, v1] = knots[k + 1];
    for (let d = d0; d < d1; d += 30) out.push(d, 1, Math.round((v0 + ((v1 - v0) * (d - d0)) / (d1 - d0)) * 100) / 100, 0, 0);
  }
  out.push(knots[knots.length - 1][0], 1, knots[knots.length - 1][1], 0, 0);
  return out;
}

export const CLIMATE_SCENARIOS: readonly ClimateScenario[] = [
  {
    // Westerly wind bursts of late Dec 1996 - Jan, March and May-June 1997 in the western Pacific on a recharged ocean (warm water volume well above
    // normal in 1996), after McPhaden (1999), Science 283, 950-954. Timing, longitude and speed of the bursts are approximate.
    id: 'nino-1997',
    year: 1997,
    name: '1997–98 El Niño',
    description: 'Strong westerly wind bursts blew over the western Pacific during 1997, on an ocean that had stored extra warm water. The warm water spread east and the strongest El Niño of the century followed. Watch Niño 3.4 climb above +2 °C by winter, the thermocline deepen in the east, and the typhoon formation area move east. Dates and strengths are approximate.',
    thermocline: 10,
    startNino34: 0,
    // The last entry (trade wind back to 0 on day 600, mid-August 1998) marks the end of the scripted period: natural variability can start after it, once the event has run its course.
    script: [burst(0, 150, 6, 12), burst(57, 155, 7, 15), burst(124, 160, 8, 20), burst(164, 165, 6, 12), [600, 1, 0, 0, 0]].flat(),
  },
  {
    // The 2009-10 El Nino ended early in 2010 and left the equatorial Pacific drained of warm water; trade winds then strengthened through 2010 and
    // 2011 (NOAA CPC monitoring of the 2010-11 La Nina; Boening et al. 2012, GRL 39, L19602). The trade-wind anomaly (about 0.5-1.8 m/s, a basin-wide mean) is an
    // approximation tuned only here; the double dip of late 2011 is not scripted.
    id: 'nina-2010',
    year: 2010,
    name: '2010–11 La Niña',
    description: 'A decaying El Niño left the Pacific drained of warm water, and the trade winds strengthened through 2010. Cold water rose in the east and a strong La Niña followed. Watch Niño 3.4 fall below −1 °C by winter, the thermocline rise in the east, and the Southern Oscillation Index turn positive. Dates and strengths are approximate.',
    thermocline: -15,
    startNino34: 1.5,
    script: tradeRamp([[90, 0.5], [150, 1.2], [210, 1.7], [330, 1.8], [450, 1.8], [540, 1.4], [630, 0.9], [720, 0.5], [810, 0]]),
  },
];

export const isClimateScenarioId = (id: unknown): id is ClimateScenarioId => typeof id === 'string' && CLIMATE_SCENARIO_IDS.includes(id as ClimateScenarioId);
export const climateScenarioById = (id: ClimateScenarioId): ClimateScenario => CLIMATE_SCENARIOS.find(s => s.id === id)!;

/** The noise-free core of a scenario on 1 January of its year. */
export function createScenarioCore(seed: number, id: ClimateScenarioId): ClimateState {
  const def = climateScenarioById(id);
  const core = createClimate(seed, 1, def.year, false);
  core.K.fill(def.thermocline / 2);
  core.R.fill(def.thermocline / 2);
  if (def.startNino34 !== 0) {
    // A broad warm anomaly of the central-eastern Pacific, scaled so that Nino 3.4 starts at exactly `startNino34`.
    for (let j = 0; j < OCEAN_N; j++) core.T[j] = Math.exp(-(((OCEAN_LON0 + (j + 0.5) * OCEAN_DLON - 215) / 40) ** 2));
    const scale = def.startNino34 / nino34Of(core);
    for (let j = 0; j < OCEAN_N; j++) core.T[j] *= scale;
  }
  if (!setClimateScript(core, def.script)) throw new Error(`Climate scenario ${id} has an invalid script.`);
  return core;
}
