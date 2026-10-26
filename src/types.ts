import type { LocalNames } from './i18n';

export interface GeoPoint { lon: number; lat: number }
export type Coordinate = [number, number];
export interface LandPolygon {
  outer: Coordinate[];
  holes?: Coordinate[][];
  /** Island that must stay visible when tiny islands are hidden (Ulleungdo, Dokdo). */
  pinned?: boolean;
  /** Present on rings added from a higher-resolution Natural Earth file. */
  source?: 'ne10m';
}
export interface City extends GeoPoint { id: string; name: string; nameKo?: string | null; names?: LocalNames; population: number; populationYear: number }
export interface Scenario {
  id: string; name: string; seed: number; version: string;
  description: string; populationNote: string; sources: { name: string; url: string; license: string }[];
}
export type ToolType = 'warm' | 'moisture' | 'low' | 'high' | 'warm-air' | 'updraft' | 'cool' | 'dry' | 'cold-air' | 'downdraft' | 'low-shear' | 'high-shear';
export type Layer = 'wind' | 'pressure' | 'temperature' | 'population' | 'rain';
/** Independent map overlays. */
export interface MapOverlays { wind: boolean; humidity: boolean; rain: boolean; pressure: boolean; temperature: boolean; population: boolean }
export const DEFAULT_MAP_OVERLAYS: Readonly<MapOverlays> = { wind: true, humidity: true, rain: true, pressure: true, temperature: true, population: true };
export interface ToolDefinition { type: ToolType; name: string; radiusKm: number; durationHours: number; description: string }
/** What is left of a dissipated storm: a decaying vortex (wind, pressure dip, rain) that drifts with the flow and fades out. `hours` counts since dissipation; `ageHours` continues the storm's age. */
export interface Remnant extends GeoPoint { id: number; wind: number; radiusKm: number; ageHours: number; hours: number }
export interface Effect extends GeoPoint { id: number; type: ToolType; radiusKm: number; remainingHours: number; ageHours: number }
export interface EnvironmentCell extends GeoPoint { land: boolean; temperature: number; airTemperature: number; airHeating: number; updraft: number; humidity: number; rain: number; snow: number; blizzard: boolean; shear: number; pressure: number; u: number; v: number; population: number; cityId: string | null; maxDamage: number; calmHours: number; exposed: boolean;
  /** Snow lying on the ground (cm). Persistent; built up by snowfall and melted by warm air during simulation steps. */
  snowCm: number;
  /** Convective potential (0 = none; >= 1 lets thunderstorms start). Player-driven: zero in an untouched world. */
  convection: number }
/** Hourly observations plus every stage change, birth and ending. */
export interface StormSample extends GeoPoint {
  hour: number; wind: number; pressure: number; stage: string; grade: number;
  movementSpeedKmh: number; circulationRadiusKm: number; galeRadiusKm: number;
}
export interface Storm extends GeoPoint {
  id: number; /** Display name; set on loaded historic storms (e.g. "Maemi"). */ name?: string; wind: number; movementSpeedKmh: number; pressure: number; radiusKm: number; galeRadiusKm: number;
  stage: string; ageHours: number; peakWind: number; track: GeoPoint[]; forecast: GeoPoint[]; history: StormSample[];
  /** People-weighted cumulative damage this storm caused (same unit as `GameState.score`). */
  damageScore: number;
  /** Player-driven departure from the recorded wind (m/s); loaded historic storms only, 0 elsewhere. */
  windDelta: number;
  /** Set on loaded historic storms: the recorded typhoon they follow and the world hour it was loaded. */
  record?: { typhoonId: string; startHour: number };
}
export interface StormRecord extends Storm {
  endedHour: number; endReason: 'dissipated' | 'extratropical' | 'merged'; mergedIntoId?: number;
}
/** A short-lived convective cell (game model), drifting with the surface flow. Rebuilt from seed + actions on replay. */
export interface Thunderstorm extends GeoPoint {
  id: number;
  /** Current strength 0–1: life-cycle envelope × local convective support. */
  intensity: number;
  radiusKm: number;
  /** Current peak surface gust (m/s); the wind used for damage. */
  gustMs: number;
  /** Approximate cloud-top temperature (°C); colder values indicate deeper convection. */
  cloudTopC: number;
  ageHours: number;
  durationHours: number;
}
/** A patch of conditions that has not yet formed a depression. */
export interface GenesisCandidate extends GeoPoint { id: number; progressHours: number }
export interface CityImpact { id: string; score: number; damage: number; exposedPopulation: number; maxWind: number; blizzardHours: number }
/** Cumulative fictional city estimates at this bulletin's time; not additional losses. */
export interface DamageReport { displaced: number; missing: number; deaths: number; floodedHomes: number; lossUsd: number; area: string }
export interface NewsItem { id: string; hour: number; kind: 'formation' | 'intensity' | 'landfall' | 'city' | 'ended' | 'merger' | 'blizzard' | 'recovery' | 'info'; title: string; text: string; damage?: DamageReport; cityId?: string; absorbedId?: number; mergedIntoId?: number }
export interface PlaceAction extends GeoPoint { tick: number; type: ToolType }
export interface GenesisAction { tick: number; type: 'genesis'; on: boolean }
export interface HistoricAction { tick: number; type: 'historic'; typhoonId: string }
/** World-wide climate controls: warming (°C), enso (El Niño positive) and polar (°C) offsets. Global, not a patch. */
export type ClimateKey = 'warming' | 'enso' | 'polar';
export type ClimateState = Record<ClimateKey, number>;
export interface ClimateAction { tick: number; type: 'climate'; key: ClimateKey; value: number }
/** Moves the calendar to this day of the year (0..366) at the current model hour. */
export interface SeasonAction { tick: number; type: 'season'; dayOfYear: number }
export type ActionRecord = PlaceAction | GenesisAction | HistoricAction | ClimateAction | SeasonAction;
/** Natural typhoon formation: while enabled, waves of formation conditions appear at seeded intervals. */
export interface GenesisState { enabled: boolean; waves: number; nextSpawnTick: number; lastSite?: GeoPoint }
/** One recorded typhoon loaded into the world at `startHour`; its storm follows the record from then on. */
export interface HistoricLoad { typhoonId: string; stormId: number; startHour: number; finished: boolean; environment: 'loaded' | 'missing' }
export type HistoricField = 'sst' | 'air' | 'rhum' | 'slp' | 'u' | 'v';
/**
 * Reanalysis fields for one historic typhoon on the game lattice (cell centres, 2° step).
 * `fields[f][d]` is a flat row-major array (row 0 = southernmost) of scaled integers for `days[d]`; null = missing.
 */
export interface HistoricEnvironment {
  typhoonId: string;
  source: { reanalysis: string; sst: string; urls: string[]; fetchedAt: string };
  lons: number[]; lats: number[]; days: string[];
  scale: Record<HistoricField, number>;
  fields: Record<HistoricField, (number | null)[][]>;
}
export type HistoricGrade = 'TD' | 'TS' | 'STS' | 'TY' | 'L';
/** One best-track row. `lon` is degrees east (0–360) for JMA storms and -180..180 for the others; `windMs` is 10-minute wind and null where the record has no wind. */
export interface HistoricPoint { t: string; lat: number; lon: number; pressure: number; windMs: number | null; grade: HistoricGrade }
export type HistoricAgency = 'JMA' | 'NHC' | 'IBTrACS';
export interface HistoricTyphoon {
  /** `jmaId` is the agency's own id despite the name: the JMA number, the NHC ATCF id (e.g. AL122005) or the IBTrACS SID. */
  id: string; jmaId: string; name: string; nameKo: string; year: number; agency: HistoricAgency; basin: string;
  peakPressure: number; peakWindMs: number | null; points: HistoricPoint[];
}
export interface HistoricSource { name: string; url: string; licence: string; sha256: string; fetchedAt: string }
export interface HistoricTyphoonData {
  /** The JMA archive; `sources` lists every downloaded file, this one first. */
  source: HistoricSource;
  sources: HistoricSource[];
  typhoons: HistoricTyphoon[];
}
export interface GameState {
  genesis: GenesisState; climate: ClimateState; historic: HistoricLoad[]; nextStormId: number;
  scenarioId: string; version: string; seed: number; tick: number; hours: number;
  /** Calendar: day of the year (0..365.25, fractional) at hour 0; moved by season actions. `dayOfYear(state)` is today's date. */
  startDayOfYear: number;
  /** The `startDayOfYear` the world was created with; the replay header, since season actions rewrite `startDayOfYear`. */
  initialStartDayOfYear: number;
  phase: 'seeding' | 'active'; score: number; exposedPopulation: number;
  storms: Storm[]; remnants: Remnant[]; stormArchive: StormRecord[]; thunderstorms: Thunderstorm[]; nextThunderstormId: number; candidates: GenesisCandidate[]; effects: Effect[]; grid: EnvironmentCell[]; cities: CityImpact[];
  news: NewsItem[]; actions: ActionRecord[]; peakWind: number;
  /** Number of blizzard cells after the latest refresh (used to detect world-wide onset). */
  blizzardCells: number;
}
export interface PlacementResult { ok: boolean; reason?: string }
export type WorkerRequest =
  | { type: 'init'; seed?: number; startDayOfYear?: number }
  | { type: 'play'; playing: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'place'; tool: ToolType; lon: number; lat: number }
  | { type: 'reset'; seed?: number; startDayOfYear?: number }
  | { type: 'genesis'; on: boolean }
  | { type: 'historic'; typhoonId: string }
  | { type: 'climate'; key: ClimateKey; value: number }
  | { type: 'season'; dayOfYear: number }
  | { type: 'replay'; seed: number; actions: ActionRecord[]; untilTick: number; startDayOfYear: number };
export type WorkerResponse =
  | { type: 'state'; state: GameState }
  | { type: 'placement'; result: PlacementResult }
  | { type: 'error'; message: string };
