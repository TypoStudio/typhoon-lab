import type { GameState } from '../types';
import { cosLat, smoothstep } from './geo';
import { hazardInfluence } from './weather-hazards';

/**
 * Fine dust (PM2.5, µg/m³): a tracer on the 2° weather grid, carried by the model's own surface wind.
 * Semi-Lagrangian advection (bilinear, so values never leave the range of their neighbours: stable at any wind and step, no negatives),
 * a little diffusion, then an implicit source/sink step. Sources: populated cells inside a fine-dust event. Build-up: a shallow mixing layer
 * (stable air, high pressure) raises the source's concentration; sinks: dry-air deposition, wind and unstable-air dispersal, rain washout.
 * Nothing runs unless an event exists or haze is left over (`state.fineDustRows`), and nothing is random.
 */
export const PM25_CAP = 600;
const EMISSION = 6; // µg/m³ per hour of mixed-layer concentration from a megacity cell, before the mixing-layer factor
const FULL_POPULATION = 2e7;
const DIFFUSION = 0.04; // fraction of the neighbour mean mixed in per step
const CLEAN = 0.2; // below this a cell is reset to zero so a clean world has no residue

/** US EPA PM2.5 bands (µg/m³, 24 h), with "unhealthy for sensitive groups" folded into unhealthy. */
export const PM25_BANDS = [
  { id: 'good air', max: 12.1 }, { id: 'moderate air', max: 35.5 }, { id: 'unhealthy air', max: 150.5 }, { id: 'very unhealthy air', max: 250.5 }, { id: 'hazardous air', max: Infinity },
] as const;
export type Pm25Band = typeof PM25_BANDS[number]['id'];
export const pm25Band = (pm25: number): Pm25Band => PM25_BANDS.find(band => pm25 < band.max)!.id;
/** Health damage ratio for a populated cell: none below the unhealthy band, rising to the cap in hazardous air. */
export const fineDustDamageRatio = (pm25: number): number => 0.02 * smoothstep(35.5, 250, pm25);

let cur = new Float32Array(0), adv = new Float32Array(0), emit = new Float32Array(0);

/** Emission in µg/m³ per hour at a population: sub-linear, none over open water. */
export const fineDustEmission = (population: number): number => EMISSION * Math.min(1, Math.max(0, population) / FULL_POPULATION) ** 0.6;

/** Mixing-layer factor: below 1 the layer is shallow (stable air, high pressure), so the same emission piles up. */
export const mixingFactor = (instability: number, pressure: number): number =>
  Math.min(2.5, Math.max(0.35, 1 + 0.5 * instability)) * Math.min(1.5, Math.max(0.5, 1 - (pressure - 1013) / 50));

/** Loss rate (1/h): deposition (slower in dry air), wind dispersal, unstable-air dispersal, rain washout. */
export function fineDustLoss(speed: number, humidity: number, instability: number, rain: number): number {
  return 0.004 + 0.012 * humidity + 0.002 * Math.max(0, speed - 6) ** 1.3 + 0.05 * Math.max(0, instability) + Math.min(0.5, 0.04 * rain);
}

export function stepFineDust(state: GameState, dt: number, cols: number, rows: number): void {
  const hazards = state.weatherHazards.filter(hazard => hazard.kind === 'finedust');
  if (!hazards.length && !state.fineDustRows) return;
  const n = cols * rows, grid = state.grid, step = 360 / cols;
  if (cur.length !== n) { cur = new Float32Array(n); adv = new Float32Array(n); emit = new Float32Array(n); }
  let lo = state.fineDustRows?.[0] ?? rows, hi = state.fineDustRows?.[1] ?? -1;
  for (const hazard of hazards) {
    const reach = hazard.radiusKm / 110.57 / step;
    const row = (hazard.lat + 90) / step;
    lo = Math.min(lo, Math.floor(row - reach)); hi = Math.max(hi, Math.ceil(row + reach));
  }
  lo = Math.max(0, lo - 2); hi = Math.min(rows - 1, hi + 2);
  const from = Math.max(0, lo - 1) * cols, to = Math.min(rows, hi + 2) * cols;
  for (let k = from; k < to; k++) { cur[k] = grid[k].pm25; emit[k] = 0; }
  // Sources: weight by the event's footprint and its life cycle, scaled by the people living in the cell.
  for (const hazard of hazards) {
    const ramp = smoothstep(0, 12, hazard.ageHours), reach = hazard.radiusKm / 110.57 / step;
    const row = (hazard.lat + 90) / step, centre = Math.floor((hazard.lon + 180) / step);
    const span = Math.min(cols, Math.ceil(hazard.radiusKm / (111.32 * Math.max(0.05, Math.cos((Math.min(89, Math.abs(hazard.lat) + hazard.radiusKm / 110.57)) * Math.PI / 180)) * step)) + 1);
    for (let j = Math.max(lo, Math.floor(row - reach)); j <= Math.min(hi, Math.ceil(row + reach)); j++) {
      const all = 2 * span + 1 >= cols;
      for (let d = all ? 0 : -span; d <= (all ? cols - 1 : span); d++) {
        const k = j * cols + (((all ? d : centre + d) % cols) + cols) % cols, cell = grid[k];
        if (cell.population <= 0) continue;
        const weight = hazardInfluence(hazard, cell);
        if (weight > 0) emit[k] += fineDustEmission(cell.population) * weight * ramp;
      }
    }
  }
  // Advection: look upwind along this step's displacement and interpolate.
  const dyKm = step * 110.57;
  for (let j = lo; j <= hi; j++) {
    const dxKm = step * 111.32 * Math.max(0.05, cosLat(grid[j * cols].lat));
    for (let i = 0; i < cols; i++) {
      const k = j * cols + i, c = grid[k], km = dt * 3.6;
      const gx = ((i - (c.u * km) / dxKm) % cols + cols) % cols;
      const gy = Math.min(rows - 1, Math.max(0, j - Math.max(-1, Math.min(1, (c.v * km) / dyKm))));
      const i0 = Math.floor(gx), j0 = Math.min(rows - 2, Math.floor(gy)), tx = gx - i0, ty = gy - j0;
      const i1 = i0 + 1 === cols ? 0 : i0 + 1, a = j0 * cols, b = a + cols;
      adv[k] = (cur[a + i0] * (1 - tx) + cur[a + i1] * tx) * (1 - ty) + (cur[b + i0] * (1 - tx) + cur[b + i1] * tx) * ty;
    }
  }
  // Diffusion, sources and sinks. Implicit sink keeps the update positive at any rate.
  let outLo = rows, outHi = -1;
  for (let j = lo; j <= hi; j++) {
    const south = (j > 0 ? j - 1 : j) * cols, north = (j < rows - 1 ? j + 1 : j) * cols, row = j * cols;
    for (let i = 0; i < cols; i++) {
      const k = row + i, c = grid[k], w = row + (i === 0 ? cols - 1 : i - 1), e = row + (i === cols - 1 ? 0 : i + 1);
      const mean = (adv[w] + adv[e] + adv[south + i] + adv[north + i]) / 4;
      let value = adv[k] + DIFFUSION * (mean - adv[k]);
      if (value > 0 || emit[k] > 0) {
        const loss = fineDustLoss(Math.hypot(c.u, c.v), c.humidity, c.instability, c.rain);
        value = (value + dt * emit[k] / mixingFactor(c.instability, c.pressure)) / (1 + dt * loss);
        value = value < CLEAN ? 0 : Math.min(PM25_CAP, value);
      } else value = 0;
      c.pm25 = value;
      if (value > 0) { if (j < outLo) outLo = j; if (j > outHi) outHi = j; }
    }
  }
  if (outHi < 0) delete state.fineDustRows;
  else state.fineDustRows = [outLo, outHi];
}
