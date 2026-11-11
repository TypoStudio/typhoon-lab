import type { LocalNames } from './i18n';
import type { ClimateLayer } from './simulation/climate-coupling';

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
export type ToolType = 'warm' | 'moisture' | 'low' | 'high' | 'warm-air' | 'updraft' | 'cool' | 'dry' | 'cold-air' | 'downdraft' | 'low-shear' | 'high-shear' | 'unstable-air' | 'stable-air';
export type WeatherHazardKind = 'heatwave' | 'drought' | 'downpour' | 'coldwave' | 'hail' | 'dust' | 'gust' | 'finedust';
export type FormationKind = 'typhoon' | 'blizzard' | 'tornado' | WeatherHazardKind;
export interface WeatherHazard extends GeoPoint {
  id: number; kind: WeatherHazardKind; radiusKm: number; ageHours: number; durationHours: number; intensity: number; directionRad: number;
  /** Started by the climate (climate-events.ts) rather than by a placed recipe; set only while a climate scenario is loaded. */
  climate?: true;
}
export type DisasterKind = WeatherHazardKind | 'blizzard' | 'tornado' | 'thunderstorm';
export interface DisasterSample {
  hour: number; wind: number; pressure: number; airTemperature: number; humidity: number; rain: number; snowCm: number; damageScore: number;
}
/** Non-cyclone disaster observations and attributed losses; retained after the event ends. */
export interface DisasterRecord extends GeoPoint {
  id: string; kind: DisasterKind; startedHour: number; updatedHour: number; endedHour?: number;
  ageHours: number; radiusKm: number; intensity: number; movementSpeedKmh: number;
  wind: number; peakWind: number; pressure: number; airTemperature: number; humidity: number; rain: number; snowCm: number;
  damageScore: number; transportLossUsd: number; history: DisasterSample[];
}
export type Layer = 'wind' | 'pressure' | 'temperature' | 'population' | 'rain';
/** Independent map overlays. */
export interface MapOverlays { wind: boolean; humidity: boolean; rain: boolean; finedust: boolean; pressure: boolean; temperature: boolean; population: boolean; ships: boolean; planes: boolean }
export const DEFAULT_MAP_OVERLAYS: Readonly<MapOverlays> = { wind: true, humidity: true, rain: true, finedust: true, pressure: true, temperature: true, population: true, ships: true, planes: true };
export interface ToolDefinition { type: ToolType; name: string; radiusKm: number; durationHours: number; description: string }
export type TrafficKind = 'ships' | 'planes';
export interface TrafficVehicle extends GeoPoint {
  serviceId: string;
  id: string; kind: TrafficKind; home: GeoPoint; homeName: string; destination: GeoPoint; destinationName: string;
  scheduledDestination: GeoPoint; scheduledName: string; route: GeoPoint[]; next: number; toward: GeoPoint;
  diverted: boolean; holding: boolean; grounded: boolean; status: 'travelling' | 'parked' | 'inactive' | 'crashed' | 'sunk';
  waitHours: number; retryAt: number; exposureHours: number; motion: (GeoPoint & { hour: number })[];
  /** Model hour when the current journey began (can be before hour zero for seeded traffic). */
  departedAtHour?: number;
}
export interface TrafficDispatch { tick: number; assignments: { vehicleId: string; departureId: string }[]; inactive?: string[] }
export interface TrafficSimulation { vehicles: TrafficVehicle[]; lossUsd: number; crashes: number; sinkings: number; dispatches: TrafficDispatch[] }
export interface TransportReport {
  vehicleId: string; kind: TrafficKind; event: 'diversion' | 'landing' | 'crash' | 'sinking';
  from: string; to: string; windMs: number; lossUsd: number;
}
/** What is left of a dissipated storm: a decaying vortex (wind, pressure dip, rain) that drifts with the flow and fades out. `hours` counts since dissipation; `ageHours` continues the storm's age. */
export interface Remnant extends GeoPoint { id: number; wind: number; radiusKm: number; ageHours: number; hours: number }
export interface Effect extends GeoPoint { id: number; type: ToolType; radiusKm: number; remainingHours: number; ageHours: number; formation?: FormationKind; triggered?: boolean }
export interface EnvironmentCell extends GeoPoint { land: boolean; temperature: number; airTemperature: number; airHeating: number; updraft: number; instability: number; humidity: number; rain: number; snow: number; blizzard: boolean; shear: number; pressure: number; u: number; v: number; population: number; cityId: string | null; maxDamage: number; calmHours: number; exposed: boolean;
  /** Snow lying on the ground (cm). Persistent; built up by snowfall and melted by warm air during simulation steps. */
  snowCm: number;
  /** Convective potential (0 = none; >= 1 lets thunderstorms start). Player-driven: zero in an untouched world. */
  convection: number;
  /** Fine particulate matter PM2.5 (µg/m³) carried by the wind; 0 unless a fine-dust event has run. */
  pm25: number }
/** Hourly observations plus every stage change, birth and ending. */
export interface StormSample extends GeoPoint {
  hour: number; wind: number; pressure: number; stage: string; grade: number;
  movementSpeedKmh: number; circulationRadiusKm: number; galeRadiusKm: number;
}
export interface Storm extends GeoPoint {
  formation?: true;
  id: number; /** Display name; set on loaded historic storms (e.g. "Maemi"). */ name?: string; wind: number; movementSpeedKmh: number; pressure: number; radiusKm: number; galeRadiusKm: number;
  stage: string; ageHours: number; peakWind: number; track: GeoPoint[]; forecast: GeoPoint[]; history: StormSample[];
  /** People-weighted cumulative damage this storm caused (same unit as `GameState.score`). */
  damageScore: number;
  /** Vehicle/cargo losses, separate from population-weighted land damage. */
  transportLossUsd?: number;
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
  /** A ground-level vortex inside a rotating thunderstorm. */
  tornado?: boolean;
  tornadoReported?: boolean;
  tornadoStartAgeHours?: number;
  tornadoEnded?: boolean;
  tornadoTrack?: GeoPoint[];
  tornadoDistanceKm?: number;
  tornadoLongReported?: boolean;
  /** Smoothed heading and final segment velocity for simulation and display interpolation. */
  tornadoMotion?: { headingRad: number; u: number; v: number };
}
/** A patch of conditions that has not yet formed a depression. */
export interface GenesisCandidate extends GeoPoint { id: number; progressHours: number }
export interface CityImpact { id: string; score: number; damage: number; exposedPopulation: number; maxWind: number; blizzardHours: number }
/** Cumulative fictional city estimates at this bulletin's time; not additional losses. */
export interface DamageReport { displaced: number; missing: number; deaths: number; floodedHomes: number; lossUsd: number; area: string }
export interface NewsItem { id: string; hour: number; kind: 'formation' | 'intensity' | 'landfall' | 'city' | 'ended' | 'merger' | 'blizzard' | 'tornado' | 'recovery' | 'info' | 'transport' | 'weather'; title: string; text: string; phenomenon?: WeatherHazardKind; damage?: DamageReport; transport?: TransportReport; cityId?: string; absorbedId?: number; mergedIntoId?: number; lon?: number; lat?: number; serial?: number }
export interface PlaceAction extends GeoPoint { tick: number; type: ToolType; formation?: FormationKind }
export interface GenesisAction { tick: number; type: 'genesis'; on: boolean }
export interface HistoricAction { tick: number; type: 'historic'; typhoonId: string }
/** World-wide climate controls: warming (°C), enso (El Niño positive) and polar (°C) offsets. Global, not a patch. */
export type ClimateKey = 'warming' | 'enso' | 'polar';
export type ClimateState = Record<ClimateKey, number>;
export interface ClimateAction { tick: number; type: 'climate'; key: ClimateKey; value: number }
/** Moves the calendar to this day of the year (0..366) at the current model hour. */
export interface SeasonAction { tick: number; type: 'season'; dayOfYear: number }
/** Enters (on) or leaves (off) the fast climate path, which the worker takes by itself above 2 days of model time per second. Entering makes the ENSO layer exist with natural variability. */
export interface ClimateModeAction { tick: number; type: 'climate-mode'; on: boolean }
/** Whole model days of climate time that passed while in climate mode. Consecutive records at the same tick are merged. */
export interface ClimateAdvanceAction { tick: number; type: 'climate-advance'; days: number }
/** Loads a historic climate scenario (see climate-scenarios.ts): a new noise-free ENSO layer with scripted forcing, on 1 January of the scenario's first year. */
export interface ClimateScenarioAction { tick: number; type: 'climate-scenario'; scenarioId: string }
/** Switches the loaded climate scenario off: the world goes back to the normal climate (see `endClimateScenarioNow`). */
export interface ClimateScenarioOffAction { tick: number; type: 'climate-scenario-off' }
/** Returns the whole climate to normal: sliders at 0, scenario off, ENSO layer neutral (see `resetClimateNow`). */
export interface ClimateResetAction { tick: number; type: 'climate-reset' }
export type ActionRecord = PlaceAction | GenesisAction | HistoricAction | ClimateAction | SeasonAction | ClimateModeAction | ClimateAdvanceAction | ClimateScenarioAction | ClimateScenarioOffAction | ClimateResetAction;
/** The climate scenario that last started the world: its calendar year, for the clock. */
export interface ClimateScenarioInfo {
  id: string;
  /** Number of scenario loads in this world so far (this one included), so loading the same scenario twice is told apart. */
  loads: number;
  /** Calendar year shown on the scenario's start date. */
  year: number;
  /** Whole days (unwrapped `startDayOfYear + hours / 24 + calendarOffsetDays`) at the 1 January that begins that year. */
  yearStartDay: number;
  /** Model days since the world began (hours / 24 plus the days the fast path added) when it was loaded. */
  elapsedDays: number;
  /** Natural typhoon formation as the player had it before the load; restored when the scenario ends. */
  priorGenesis: boolean;
  /** Climate-driven events started so far in this load (climate-events.ts). */
  eventSeq: number;
  /** Model day of the last climate-driven event of each region of the table, or null. */
  eventLast: (number | null)[];
  /** Date serial (year * 400 + day of the year) up to which the historic record has been posted. */
  recordSerial: number;
}
/** Bookkeeping of the fast climate path (the weather engine is paused while `active`). */
export interface ClimateTime {
  active: boolean;
  /** Model days advanced since the mode was last entered. */
  sinceEntry: number;
  /** Model days advanced in the whole run (limited to CLIMATE_MAX_DAYS). */
  total: number;
}
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
/** Frozen starting analysis, on the game's south-to-north 2° cell-centred global grid. */
export interface LiveWeatherSnapshot {
  source: 'NOAA GFS'; modelRun: string;
  pressure: number[]; u: number[]; v: number[];
  /** Celsius; null where the source surface is land. Optional for older replay files. */
  seaTemperature?: (number | null)[];
  airTemperature?: number[];
}
/** Current mutable background; the original analysis is kept separately for replay. */
export type WeatherField = Pick<LiveWeatherSnapshot, 'pressure' | 'u' | 'v' | 'seaTemperature' | 'airTemperature'>;
export interface GameState {
  initialWeather?: LiveWeatherSnapshot;
  weather?: WeatherField;
  weatherSource?: 'live' | 'cached' | 'base';
  /** The fast climate path dropped the live analysis (it went out of date); the world goes on with the base climate and the ENSO layer. */
  liveEnded?: true;
  traffic: TrafficSimulation;
  genesis: GenesisState; climate: ClimateState;
  /** Dynamic ENSO layer (see climate-coupling.ts); null until the ENSO slider, a warm/cool tool within 30 degrees or a live start activates it. Derived from seed, actions and the starting weather, so replays do not store it. */
  climateLayer: ClimateLayer | null;
  /** Fast climate path bookkeeping (see ClimateTime); null in a world that never took it. */
  climateTime: ClimateTime | null;
  /** Days the fast climate path has added to the calendar: `dayOfYear(state)` is (startDayOfYear + hours / 24 + calendarOffsetDays) mod the year. */
  calendarOffsetDays: number;
  /** Set once a historic climate scenario has been loaded; absent in every other world. */
  climateScenario?: ClimateScenarioInfo;
  historic: HistoricLoad[]; nextStormId: number;
  scenarioId: string; version: string; seed: number; tick: number; hours: number;
  /** Calendar: day of the year (0..365.25, fractional) at hour 0; moved by season actions. `dayOfYear(state)` is today's date. */
  startDayOfYear: number;
  /** The `startDayOfYear` the world was created with; the replay header, since season actions rewrite `startDayOfYear`. */
  initialStartDayOfYear: number;
  phase: 'seeding' | 'active'; score: number; exposedPopulation: number;
  storms: Storm[]; remnants: Remnant[]; stormArchive: StormRecord[]; thunderstorms: Thunderstorm[]; nextThunderstormId: number; candidates: GenesisCandidate[]; effects: Effect[]; grid: EnvironmentCell[]; cities: CityImpact[];
  weatherHazards: WeatherHazard[];
  /** Grid rows (south, north) that may hold fine dust; absent when the whole field is clean, so plain worlds skip the tracer. */
  fineDustRows?: [number, number];
  disasters?: DisasterRecord[];
  news: NewsItem[]; actions: ActionRecord[]; peakWind: number;
  /** Number of blizzard cells after the latest refresh (used to detect world-wide onset). */
  blizzardCells: number;
}
export interface PlacementResult { ok: boolean; reason?: string }
export type WorkerRequest =
  | { type: 'init'; seed?: number; startDayOfYear?: number; weather?: 'live' | 'base' }
  | { type: 'play'; playing: boolean }
  | { type: 'interaction'; active: boolean }
  | { type: 'speed'; speed: number }
  | { type: 'traffic-view'; tick: number; departures: string[]; visibleVehicles: string[] }
  | { type: 'place'; tool: ToolType; lon: number; lat: number }
  | { type: 'formation'; kind: FormationKind; lon: number; lat: number }
  | { type: 'reset'; seed?: number; startDayOfYear?: number; weather?: 'live' | 'base' }
  | { type: 'genesis'; on: boolean }
  | { type: 'historic'; typhoonId: string }
  | { type: 'climate'; key: ClimateKey; value: number }
  | { type: 'climate-scenario'; scenarioId: string }
  | { type: 'climate-scenario-off' }
  | { type: 'climate-reset' }
  | { type: 'season'; dayOfYear: number }
  | { type: 'replay'; seed: number; actions: ActionRecord[]; untilTick: number; startDayOfYear: number; trafficDispatches?: TrafficDispatch[]; initialWeather?: LiveWeatherSnapshot };
export type WorkerResponse =
  | { type: 'state'; state: GameState; clockHours: number }
  | { type: 'interaction'; active: boolean; state: GameState; clockHours: number }
  | { type: 'progress'; clockHours: number }
  /** A replay being rebuilt reached `tick` of `untilTick`. */
  | { type: 'replay-progress'; tick: number; untilTick: number }
  | { type: 'placement'; result: PlacementResult }
  /** The worker changed the time speed by itself (the run's fast climate time is used up). */
  | { type: 'speed'; speed: number }
  | { type: 'error'; message: string };
