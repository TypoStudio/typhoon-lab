import { GENESIS_THRESHOLD, readClimateIndices, readClimatePoint, readThermocline, type ClimatePointReading } from '../simulation/engine';
import { OCEAN_LON0, thermoclineMeanDepth } from '../simulation/climate-core';
import { wrapLon } from '../render/view';
import type { GameState } from '../types';
import { addSample, createSeries, isDue, lastValue, type Series } from './measure-store';

/** One graph inside a card (a card stacks one or two). */
export interface MeasurePlot {
  label: string;
  unit: string;
  digits: number;
  /** Guide lines drawn in the plot, e.g. the formation threshold. */
  guides?: { value: number; label: string }[];
  /** Keep zero inside the range (anomalies and indices). */
  zero?: boolean;
}

/** What a reader gets: the state plus the point, with the point's environment read once however many items use it. */
export interface MeasureReader { state: GameState; lon: number; lat: number; point(): ClimatePointReading }

export interface MeasureItem {
  id: string;
  /** Shortcut on the Measure palette tab. */
  key: string;
  name: string;
  tip: string;
  /** True for basin indices: no pin, one chart. */
  basin: boolean;
  plots: MeasurePlot[];
  /** One value per plot; NaN where the quantity does not exist (sea temperature over land). */
  read(r: MeasureReader): number[];
  /** Shown under the card while the world has no climate layer. */
  needsLayer?: boolean;
}

const lonEast = (lon: number): number => ((lon % 360) + 360) % 360;
/** The equatorial Pacific strip the thermocline exists in, degrees east. */
export const THERMOCLINE_STRIP = [OCEAN_LON0, 280] as const;
export const inThermoclineStrip = (lon: number): boolean => { const e = lonEast(lon); return e >= THERMOCLINE_STRIP[0] && e <= THERMOCLINE_STRIP[1]; };

const NINO_GUIDES = [{ value: 0.5, label: 'El Niño' }, { value: -0.5, label: 'La Niña' }];

export const MEASURE_ITEMS = [
  { id: 'measure-sea-temperature', key: 'z', name: 'Sea temperature', basin: false,
    tip: 'Drop on the map to graph the sea surface temperature there. Land shows a gap.',
    plots: [{ label: 'Sea temperature', unit: '°C', digits: 1 }], read: r => [r.point().seaTemperature ?? NaN] },
  { id: 'measure-air-temperature', key: 'x', name: 'Air temperature', basin: false,
    tip: 'Drop on the map to graph the air temperature near the surface there.',
    plots: [{ label: 'Air temperature', unit: '°C', digits: 1 }], read: r => [r.point().airTemperature] },
  { id: 'measure-pressure', key: 'c', name: 'Sea-level pressure', basin: false,
    tip: 'Drop on the map to graph the sea-level pressure there.',
    plots: [{ label: 'Sea-level pressure', unit: 'hPa', digits: 1 }], read: r => [r.point().pressure] },
  { id: 'measure-wind', key: 'v', name: 'Wind speed', basin: false,
    tip: 'Drop on the map to graph the surface wind speed there, storms included.',
    plots: [{ label: 'Wind speed', unit: 'm/s', digits: 1 }], read: r => [r.point().windSpeed] },
  { id: 'measure-humidity', key: 'b', name: 'Humidity and rainfall', basin: false,
    tip: 'Drop on the map to graph the humidity and the rainfall there, in two plots.',
    plots: [{ label: 'Humidity', unit: '%', digits: 0 }, { label: 'Rainfall', unit: 'mm/h', digits: 1 }],
    read: r => { const p = r.point(); return [p.humidity * 100, p.rainfall]; } },
  { id: 'measure-shear', key: 'n', name: 'Wind shear', basin: false,
    tip: 'Drop on the map to graph the wind shear between 200 and 850 hPa there.',
    plots: [{ label: 'Wind shear', unit: 'm/s', digits: 1 }], read: r => [r.point().shear] },
  { id: 'measure-formation', key: 'm', name: 'Formation potential', basin: false,
    tip: 'Drop on the map to graph the typhoon formation score there. Over land it is 0.',
    plots: [{ label: 'Typhoon formation potential', unit: 'score', digits: 2, guides: [{ value: GENESIS_THRESHOLD, label: 'Formation threshold' }] }],
    read: r => [r.point().genesisPotential] },
  { id: 'measure-thermocline', key: ',', name: 'Thermocline depth', basin: false, needsLayer: true,
    tip: 'Drop inside the equatorial Pacific, 120°E to 80°W, to graph the thermocline depth and how far it is from normal. It depends on longitude only.',
    plots: [{ label: 'Thermocline depth', unit: 'm', digits: 0 }, { label: 'Thermocline anomaly', unit: 'm', digits: 1, zero: true }],
    read: r => {
      const e = lonEast(r.lon);
      const tc = readThermocline(r.state, e);
      return tc ? [tc.depth, tc.anomaly] : [thermoclineMeanDepth(e), 0];
    } },
  { id: 'measure-nino34', key: '.', name: 'Niño 3.4', basin: true, needsLayer: true,
    tip: 'Drop anywhere to graph the Niño 3.4 index, the Pacific temperature anomaly that defines El Niño and La Niña.',
    plots: [{ label: 'Niño 3.4', unit: '°C', digits: 2, zero: true, guides: NINO_GUIDES }],
    read: r => [readClimateIndices(r.state)?.nino34 ?? 0] },
  { id: 'measure-soi-wwv', key: '/', name: 'SOI and warm water', basin: true, needsLayer: true,
    tip: 'Drop anywhere to graph the Southern Oscillation Index and the warm water volume of the Pacific.',
    plots: [{ label: 'Southern Oscillation Index', unit: 'index', digits: 1, zero: true }, { label: 'Warm water volume', unit: 'm', digits: 1, zero: true }],
    read: r => { const i = readClimateIndices(r.state); return [i?.soi ?? 0, i?.wwv ?? 0]; } },
] as const satisfies readonly MeasureItem[];

export type MeasureId = (typeof MEASURE_ITEMS)[number]['id'];
export const MEASURE_BY_ID: ReadonlyMap<string, MeasureItem> = new Map(MEASURE_ITEMS.map(i => [i.id, i]));
export const isMeasureId = (id: string | null): id is MeasureId => id !== null && MEASURE_BY_ID.has(id);
/** Shortcut characters of the Measure tab in palette order. */
export const MEASURE_KEYS: readonly string[] = MEASURE_ITEMS.map(i => i.key);

// ---- Pins and charts ---------------------------------------------------------------------------

export const MAX_PINS = 12;
/** Two drops closer than this (degrees, both axes) are the same place. */
export const PIN_MERGE_DEG = 0.25;
/** Categorical slots 1-8, validated on the dark surface; pins 9-12 reuse them with a dashed line. */
export const PIN_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'] as const;
const luminance = (hex: string): number => {
  const c = [1, 3, 5].map(i => { const v = parseInt(hex.slice(i, i + 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
/** Colour, dash and the text colour that reads on it (white or near-black, by the fill's luminance). */
export const pinStyle = (n: number): { color: string; dashed: boolean; ink: string } => {
  const color = PIN_COLORS[(n - 1) % PIN_COLORS.length];
  return { color, dashed: n > PIN_COLORS.length, ink: luminance(color) > 0.2 ? '#0b0b0b' : '#ffffff' };
};

export interface Pin { n: number; lon: number; lat: number }
export type AddResult =
  | { ok: true; pin: Pin | null; item: MeasureItem; isNewChart: boolean }
  | { ok: false; reason: 'duplicate' | 'pins' | 'strip'; item: MeasureItem };

/** Model days since the world began; keeps growing when the fast climate path jumps the calendar ahead. */
export const elapsedDays = (state: { hours: number; calendarOffsetDays?: number }): number => state.hours / 24 + (state.calendarOffsetDays ?? 0);

const seriesKey = (item: string, plot: number, pin: number): string => `${item}|${plot}|${pin}`;

/** Everything the Measure tab shows: pins, the pins each chart plots, and the recorded series. No DOM, no simulation writes. */
export class ProbeBook {
  readonly pins: Pin[] = [];
  /** Chart per item, in the order added; the set holds pin numbers (empty for basin indices). */
  readonly charts = new Map<string, Set<number>>();
  readonly series = new Map<string, Series>();
  /** Bumped whenever a redraw is due: a sample landed or the layout changed. */
  rev = 0;
  /** Bumped when pins or charts change (the cards need rebuilding, not just redrawing). */
  layoutRev = 0;
  private seed: number | null = null;
  private lastT = -Infinity;

  get size(): number { return this.charts.size; }

  seriesOf(item: string, plot: number, pin: number): Series | undefined { return this.series.get(seriesKey(item, plot, pin)); }
  latest(item: string, plot: number, pin: number): number { return lastValue(this.seriesOf(item, plot, pin)); }

  clear(): void {
    if (!this.charts.size && !this.pins.length) { this.seed = null; this.lastT = -Infinity; return; }
    this.pins.length = 0; this.charts.clear(); this.series.clear();
    this.seed = null; this.lastT = -Infinity;
    this.rev++; this.layoutRev++;
  }

  private pinNear(lon: number, lat: number): Pin | undefined {
    return this.pins.find(p => Math.abs(wrapLon(p.lon - lon)) <= PIN_MERGE_DEG && Math.abs(p.lat - lat) <= PIN_MERGE_DEG);
  }

  /** Adds a probe. A basin index ignores the point and is added once; a point item reuses a pin at the same place. */
  add(itemId: string, lon: number, lat: number): AddResult {
    const item = MEASURE_BY_ID.get(itemId)!;
    if (item.basin) {
      if (this.charts.has(item.id)) return { ok: false, reason: 'duplicate', item };
      this.charts.set(item.id, new Set());
      this.rev++; this.layoutRev++;
      return { ok: true, pin: null, item, isNewChart: true };
    }
    lon = wrapLon(lon);
    if (item.id === 'measure-thermocline' && !inThermoclineStrip(lon)) return { ok: false, reason: 'strip', item };
    let pin = this.pinNear(lon, lat);
    if (pin && this.charts.get(item.id)?.has(pin.n)) return { ok: false, reason: 'duplicate', item };
    if (!pin) {
      if (this.pins.length >= MAX_PINS) return { ok: false, reason: 'pins', item };
      let n = 1;
      while (this.pins.some(p => p.n === n)) n++;
      pin = { n, lon: Math.round(lon * 100) / 100, lat: Math.round(lat * 100) / 100 };
      this.pins.push(pin);
    }
    const isNewChart = !this.charts.has(item.id);
    const lines = this.charts.get(item.id) ?? new Set<number>();
    lines.add(pin.n);
    this.charts.set(item.id, lines);
    this.rev++; this.layoutRev++;
    return { ok: true, pin, item, isNewChart };
  }

  /** Removes a chart and the pins no other chart plots. */
  remove(itemId: string): void {
    const lines = this.charts.get(itemId);
    if (!lines) return;
    this.charts.delete(itemId);
    for (const key of [...this.series.keys()]) if (key.startsWith(`${itemId}|`)) this.series.delete(key);
    for (const n of lines) if (![...this.charts.values()].some(l => l.has(n))) this.pins.splice(this.pins.findIndex(p => p.n === n), 1);
    this.rev++; this.layoutRev++;
  }

  /**
   * Records one sample per due line from the state. A new seed or time running backwards means a new world, which
   * starts empty. A line is read only when its spacing allows it, so a fast speed costs almost nothing.
   */
  sample(state: GameState): boolean {
    const t = elapsedDays(state);
    if (this.seed !== null && (state.seed !== this.seed || t < this.lastT - 1e-9)) this.clear();
    this.seed = state.seed; this.lastT = t;
    let changed = false;
    const readings = new Map<number, ClimatePointReading>();
    for (const [itemId, lines] of this.charts) {
      const item = MEASURE_BY_ID.get(itemId)!;
      for (const n of item.basin ? [0] : lines) {
        const pin = this.pins.find(p => p.n === n);
        const due = item.plots.map((_, i) => {
          const key = seriesKey(itemId, i, n);
          let s = this.series.get(key);
          if (!s) { s = createSeries(); this.series.set(key, s); }
          return isDue(s, t);
        });
        if (!due.some(Boolean)) continue;
        const values = item.read({ state, lon: pin?.lon ?? NaN, lat: pin?.lat ?? NaN, point: () => readings.get(n) ?? readings.set(n, readClimatePoint(state, pin!.lon, pin!.lat)).get(n)! });
        due.forEach((d, i) => { if (d && addSample(this.series.get(seriesKey(itemId, i, n))!, t, values[i])) changed = true; });
      }
    }
    if (changed) this.rev++;
    return changed;
  }
}
