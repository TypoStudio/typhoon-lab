import type { GameState } from '../types';
import { isLand, LAND_WIND_FACTOR, steeringFlow, stormVortexAt } from '../simulation/engine';
import { sampleGrid, type FieldData } from './fields';
import { distanceKm, smoothstep } from '../simulation/geo';

/** Replace only the coarse cyclone contribution; preserve the surrounding weather field. */
export function attachStormWind(field: FieldData, state: GameState): void {
  field.windAt = undefined;
  field.windAnimationRadiusKm = undefined;
  field.windVisibilityAt = undefined;
  const vortices = [
    ...state.storms.map(storm => ({ storm: { ...storm }, motion: steeringFlow(state, storm) })),
    ...state.remnants.map(storm => ({ storm: { ...storm }, motion: { u: 0, v: 0 } })),
  ];
  if (!vortices.length) return;
  // Use the same maturity range as the simulation's dry eye. Weak depressions and
  // dissipated remnants should not acquire a clear eye merely by having a centre.
  const eyes = state.storms.filter(storm => storm.wind > 25).map(storm => ({
    lon: storm.lon, lat: storm.lat, radiusKm: storm.radiusKm, maturity: smoothstep(25, 40, storm.wind),
  }));
  if (eyes.length) field.windVisibilityAt = (lon, lat) => {
    let visibility = 1;
    for (const eye of eyes) {
      const r = distanceKm(eye.lon, eye.lat, lon, lat) / eye.radiusKm;
      visibility = Math.min(visibility, 1 - eye.maturity * (1 - smoothstep(0.3, 0.85, r)));
    }
    return visibility;
  };
  field.windAnimationRadiusKm = (lon, lat) => {
    let radius = Infinity;
    for (const { storm } of vortices) {
      // A soft core keeps the centre traversable and avoids an abrupt speed change at the eye.
      radius = Math.min(radius, Math.hypot(distanceKm(storm.lon, storm.lat, lon, lat), storm.radiusKm * 0.25));
    }
    return radius;
  };

  const backgroundU = field.u.slice(), backgroundV = field.v.slice();
  const wind = new Float64Array(2);
  const circulation = (lon: number, lat: number, out: Float64Array): void => {
    let u = 0, v = 0;
    for (const { storm, motion } of vortices) {
      const local = stormVortexAt(storm, motion, lon, lat);
      u += local.u; v += local.v;
    }
    const friction = (u !== 0 || v !== 0) && isLand(lon, lat) ? LAND_WIND_FACTOR : 1;
    out[0] = u * friction; out[1] = v * friction;
  };
  // The simulation already includes these vortices in grid.u/v. Subtract before
  // adding their exact values, otherwise their strength would be counted twice.
  state.grid.forEach((cell, k) => {
    circulation(cell.lon, cell.lat, wind);
    backgroundU[k] -= wind[0]; backgroundV[k] -= wind[1];
  });
  field.windAt = (lon, lat, out) => {
    circulation(lon, lat, out);
    out[0] += sampleGrid(field, backgroundU, lon, lat);
    out[1] += sampleGrid(field, backgroundV, lon, lat);
  };
}
