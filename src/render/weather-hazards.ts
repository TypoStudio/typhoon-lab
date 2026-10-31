import { WEATHER_HAZARDS } from '../data/weather-hazards';
import { t } from '../i18n';
import { smoothstep } from '../simulation/geo';
import type { WeatherHazard, WeatherHazardKind } from '../types';
import type { MapCamera } from './camera';
import { groundCircle } from './geo-draw';

const icons = new Map<WeatherHazardKind, Path2D>();
const FOOTPRINT_BANDS = 32;

/** Shared flat/globe symbols and geographic footprints for non-cyclone weather. */
export function drawWeatherHazards(ctx: CanvasRenderingContext2D, view: MapCamera, hazards: readonly WeatherHazard[], font: string, paper: string): void {
  const point = new Float64Array(3);
  ctx.save();
  ctx.font = `11px ${font}`;
  for (const hazard of hazards) {
    const definition = WEATHER_HAZARDS[hazard.kind];
    ctx.fillStyle = definition.color;
    // Feather in geographic distance so the tint follows the surface on both maps,
    // including partially visible events at the globe's horizon.
    let opacity = 0;
    for (let band = FOOTPRINT_BANDS; band > 0; band--) {
      const radius = band / FOOTPRINT_BANDS;
      const next = 0.12 * hazard.intensity * (1 - smoothstep(0.2, 1, (band - 0.5) / FOOTPRINT_BANDS));
      if (next <= opacity) continue;
      ctx.globalAlpha = (next - opacity) / (1 - opacity);
      ctx.beginPath(); groundCircle(view, ctx, hazard.lon, hazard.lat, hazard.radiusKm * radius, 'fill'); ctx.fill();
      opacity = next;
    }
    view.projectZ(hazard.lon, hazard.lat, point);
    if (point[2] <= 0 || point[0] < -100 || point[0] > view.width + 100 || point[1] < -30 || point[1] > view.height + 30) continue;
    const icon = icons.get(hazard.kind) ?? new Path2D(definition.iconPath);
    icons.set(hazard.kind, icon);
    ctx.globalAlpha = hazard.intensity;
    ctx.save(); ctx.translate(point[0] - 10, point[1] - 10); ctx.scale(0.85, 0.85);
    ctx.strokeStyle = paper; ctx.lineWidth = 4; ctx.stroke(icon);
    ctx.strokeStyle = definition.color; ctx.lineWidth = 1.8; ctx.stroke(icon); ctx.restore();
    const label = `${t(definition.name)} · ${Math.ceil(hazard.durationHours - hazard.ageHours)} h`;
    ctx.strokeStyle = paper; ctx.lineWidth = 3; ctx.strokeText(label, point[0] + 14, point[1] + 4);
    ctx.fillStyle = definition.color; ctx.fillText(label, point[0] + 14, point[1] + 4);
  }
  ctx.restore();
}
