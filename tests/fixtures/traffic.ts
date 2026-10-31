import { createGame, stepGame } from '../../src/simulation/engine';
import { moveKm } from '../../src/simulation/geo';
import type { Storm } from '../../src/types';

/** A strong wind wall forms under one flight and one ship; run the real engine, not a fake wind sampler. */
export function transportAccidentFixture(seed = 42) {
  const state = createGame(seed);
  state.traffic.vehicles = [state.traffic.vehicles.find(v => v.kind === 'planes')!, state.traffic.vehicles.find(v => v.kind === 'ships')!];
  const position = moveKm(140, 20, 0, 30);
  for (const v of state.traffic.vehicles) { v.lon = position.lon; v.lat = position.lat; }
  state.storms = [{
    id: 999, lon: 140, lat: 20, wind: 90, movementSpeedKmh: 0, pressure: 900, radiusKm: 30, galeRadiusKm: 400,
    ageHours: 72, peakWind: 90, stage: 'Violent Typhoon', track: [], forecast: [], history: [], damageScore: 0, windDelta: 0,
  } satisfies Storm];
  for (let i = 0; i < 8 && state.traffic.crashes + state.traffic.sinkings < 2; i++) stepGame(state);
  return state;
}
