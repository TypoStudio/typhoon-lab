import type { City, CityImpact, DamageReport } from '../types';

export const CITY_DAMAGE_LEVELS = [0.0005, 0.01, 0.05, 0.15] as const;
const AREAS = ['northern residential blocks', 'southern residential blocks', 'eastern residential blocks', 'western residential blocks'] as const;
const HEADLINES = ['opens shelters after flooding', 'reports widespread flooding', 'expands rescue operations', 'faces a major disaster'] as const;
const WINTER_HEADLINES = ['opens warming shelters', 'reports widespread power outages', 'expands snow rescue operations', 'faces a major winter disaster'] as const;

/** Fictional story estimates from cumulative wind damage, not hydrology or actuarial models.
 * Rates are gameplay constants, fitted for order-of-magnitude agreement with public records of
 * Maemi 2003 (primary anchor: ~4.2-5.5 trillion KRW = ~USD 3.5-4.5 B, 117 dead + 14 missing, ~61,000 displaced,
 * ~40,000 flooded or damaged homes) and cross-checked with Rusa 2002 (~5.1 trillion KRW, 246 dead/missing, ~88,000
 * displaced), Hinnamnor 2022 (~1.7-2.4 trillion KRW, 11-12 dead) and Haiyan 2013 (~USD 2.9 B, 6,300 dead).
 * They stay fictional: the impact cities are every Natural Earth place of 500,000 people or more plus the original demo set. Counts are city totals at the report time, never event deltas.
 * No random draws or clock reads: the same replay regenerates the same report.
 */
export const stormLossUsd = (damageScore: number): number => Math.round(damageScore * 4_120 / 1_000) * 1_000;

/** Story figures per damage unit, fitted to a Maemi replay (about 1.02 million damage units across ~1,000 impact cities, after wind over land was weakened to 70 %):
 * loss USD 4,120 (Maemi ~USD 4.2 B; was 2,950 per unit at 1.41 million units), displaced 0.0620 (~63,000),
 * deaths 0.000103 (~104 dead) and missing 0.0000210 (~21 missing), flooded homes = displaced × 0.65 (~40,000 homes), losses via `stormLossUsd`.
 * Used for a storm's own `damageScore` and, bounded by exposure, for city totals.
 */
export function estimateStormDamage(damageScore: number) {
  const damage = Math.max(0, damageScore);
  const displaced = Math.floor(damage * 0.062);
  return {
    displaced,
    missing: Math.floor(damage * 0.000021),
    deaths: Math.floor(damage * 0.000103),
    floodedHomes: Math.floor(displaced * 0.65),
    lossUsd: stormLossUsd(damage),
  };
}

export function estimateCityDamage(city: City, impact: CityImpact): DamageReport {
  const exposure = Math.max(0, Math.min(city.population, impact.exposedPopulation));
  const damage = Math.max(0, Math.min(exposure, impact.score));
  const areaIndex = [...city.id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % AREAS.length;
  return { ...estimateStormDamage(damage), area: AREAS[areaIndex] };
}

export function cityDamageBulletin(city: City, impact: CityImpact, level: number, cause: 'cyclone' | 'thunderstorm' | 'blizzard' = 'cyclone') {
  const damage = estimateCityDamage(city, impact);
  return {
    title: `${city.name} ${(cause === 'blizzard' ? WINTER_HEADLINES : HEADLINES)[level]}`,
    text: cause === 'blizzard'
      ? `Heavy snow in ${city.name}: ${damage.area}. Roofs are collapsing under the snow load, power lines are down and roads are closed. Peak local wind: ${impact.maxWind.toFixed(0)} m/s.`
      : cause === 'thunderstorm'
      ? `Severe thunderstorms in ${city.name}: ${damage.area}. Flash floods and fallen trees close roads and residents are moving to shelters. Peak local gust: ${impact.maxWind.toFixed(0)} m/s.`
      : `Flooding in ${city.name}: ${damage.area}. Roads are closed and residents are moving to shelters. Peak local wind: ${impact.maxWind.toFixed(0)} m/s.`,
    damage,
  };
}
