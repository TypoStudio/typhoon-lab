import { smoothstep } from '../simulation/geo';
import { sampleGrid, sampleSmoothGrid, type FieldData } from './fields';

export interface PrecipitationSample { rain: number; snow: number; snowFraction: number; blizzard: number }

/** Interpolate continuous weather first, then blend rain/snow instead of interpolating binary cell masks. */
export function samplePrecipitation(field: FieldData, lon: number, lat: number,
  out: PrecipitationSample = { rain: 0, snow: 0, snowFraction: 0, blizzard: 0 }, windSpeed?: number): PrecipitationSample {
  out.rain = Math.max(0, Math.min(60, sampleSmoothGrid(field, field.rain, lon, lat)));
  if (!out.rain) { out.snow = 0; out.snowFraction = 0; out.blizzard = 0; return out; }
  const temperature = sampleSmoothGrid(field, field.airTemperature, lon, lat);
  out.snowFraction = 1 - smoothstep(-1, 1, temperature);
  out.snow = out.rain * out.snowFraction;
  const wind = windSpeed ?? Math.hypot(sampleGrid(field, field.u, lon, lat), sampleGrid(field, field.v, lon, lat));
  out.blizzard = out.snowFraction * smoothstep(0.5, 2, out.snow) * smoothstep(12, 18, wind);
  return out;
}
