import type { ToolType } from '../types';

export type RGB = [number, number, number];

/** Piecewise-linear colour ramp baked to a 256-entry lookup table. */
export class Ramp {
  private readonly lut = new Uint8ClampedArray(256 * 3);
  constructor(private readonly stops: RGB[], private readonly positions: number[]) {
    const lo = positions[0];
    const hi = positions[positions.length - 1];
    for (let i = 0; i < 256; i++) {
      const v = lo + ((hi - lo) * i) / 255;
      const [r, g, b] = this.exact(v);
      this.lut[i * 3] = r;
      this.lut[i * 3 + 1] = g;
      this.lut[i * 3 + 2] = b;
    }
  }
  private exact(v: number): RGB {
    const { stops, positions } = this;
    if (v <= positions[0]) return stops[0];
    for (let k = 1; k < positions.length; k++) {
      if (v <= positions[k]) {
        const t = (v - positions[k - 1]) / (positions[k] - positions[k - 1]);
        const a = stops[k - 1];
        const b = stops[k];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      }
    }
    return stops[stops.length - 1];
  }
  /** Normalised position 0..1 inside the ramp's domain. */
  at(v: number, out: Uint8ClampedArray | Uint8Array, offset: number): void {
    const lo = this.positions[0];
    const hi = this.positions[this.positions.length - 1];
    let i = Math.round(((v - lo) / (hi - lo)) * 255);
    i = !Number.isFinite(i) || i < 0 ? 0 : i > 255 ? 255 : i;
    out[offset] = this.lut[i * 3];
    out[offset + 1] = this.lut[i * 3 + 1];
    out[offset + 2] = this.lut[i * 3 + 2];
  }
  get domain(): [number, number] { return [this.positions[0], this.positions[this.positions.length - 1]]; }
}

export interface Theme {
  paper: string; sea: string; land: string; coast: string; grid: string; equator: string; tropics: string; rule: string; ink: string; muted: string;
  accent: string; accentInk: string; wind: string; danger: string; warn: string; ok: string; track: string; recordedPath: string; storm: string;
  fx: Record<ToolType, string>;
  font: string; mono: string;
  rgb: { paper: RGB; sea: RGB; land: RGB; wind: RGB; ink: RGB };
  ramps: { wind: Ramp; humidity: Ramp; pressure: Ramp; temperature: Ramp; airTemperature: Ramp; population: Ramp; rain: Ramp; snow: Ramp };
}

let probe: CanvasRenderingContext2D | null = null;

/** Converts any CSS colour (including oklch) to sRGB bytes via a 1×1 canvas. Returns null if unparseable. */
export function cssColorToRgb(value: string): RGB | null {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe) return null;
  const read = (seed: string): RGB => {
    probe!.clearRect(0, 0, 1, 1);
    probe!.fillStyle = seed;
    probe!.fillStyle = value;
    probe!.fillRect(0, 0, 1, 1);
    const d = probe!.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const a = read('#000000');
  const b = read('#ffffff');
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] ? a : null;
}

function token(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function rgbToken(name: string, fallback: RGB): RGB {
  return cssColorToRgb(token(name, '')) ?? fallback;
}

function rampFrom(prefix: string, count: number, positions: number[], fallback: RGB[]): Ramp {
  const stops: RGB[] = [];
  for (let i = 0; i < count; i++) stops.push(rgbToken(`${prefix}-${i}`, fallback[Math.min(i, fallback.length - 1)]));
  return new Ramp(stops, positions);
}

/** Reads the locked design tokens from :root. Call once the stylesheet has loaded. */
export function loadTheme(): Theme {
  const dark: RGB = [16, 26, 40];
  const grey: RGB = [128, 140, 156];
  return {
    paper: token('--color-paper', '#101a28'), sea: token('--color-sea', '#14213a'), land: token('--color-land', '#2a3640'),
    coast: token('--color-coast', '#c9dde4'), grid: token('--color-grid', '#3a4a64'), rule: token('--color-rule', '#34445c'),
    equator: token('--color-equator', '#f4d577'), tropics: token('--color-tropics', '#9ed8e4'),
    ink: token('--color-ink', '#eef3f7'), muted: token('--color-muted', '#b3bfcb'),
    accent: token('--color-accent', '#f2b84b'), accentInk: token('--color-accent-ink', '#2a1d08'),
    wind: token('--color-wind', '#8fd8e8'), danger: token('--color-danger', '#ef6a5a'), warn: token('--color-warn', '#f09a3e'),
    ok: token('--color-ok', '#7fd6a2'), track: token('--color-track', '#f3efd8'), recordedPath: token('--color-recorded-path', '#c79ad2'), storm: token('--color-storm', '#ef5b4b'),
    fx: {
      cool: token('--fx-cool', '#75c6ef'), dry: token('--fx-dry', '#d6bc8b'),
      'cold-air': token('--fx-cold-air', '#8eaddf'), downdraft: token('--fx-downdraft', '#b9a5e8'),
      'warm-air': token('--fx-warm-air', '#f1bd77'), updraft: token('--fx-updraft', '#b5d897'),
      warm: token('--fx-warm', '#f08a4b'), moisture: token('--fx-moisture', '#7fd4cc'),
      low: token('--fx-low', '#b79be0'), high: token('--fx-high', '#a9c6f0'),
      'low-shear': token('--fx-low-shear', '#8fdcb4'), 'high-shear': token('--fx-high-shear', '#ee8aa8'),
      'unstable-air': token('--fx-unstable-air', '#efc075'), 'stable-air': token('--fx-stable-air', '#9dbce1'),
    },
    font: token('--font-body', 'sans-serif'), mono: token('--font-mono', 'monospace'),
    rgb: {
      paper: rgbToken('--color-paper', dark), sea: rgbToken('--color-sea', [20, 33, 58]), land: rgbToken('--color-land', [42, 54, 64]),
      wind: rgbToken('--color-wind', [143, 216, 232]), ink: rgbToken('--color-ink', [238, 243, 247]),
    },
    ramps: {
      humidity: rampFrom('--ramp-humidity', 3, [0, 0.5, 1], [[53, 91, 118], [139, 198, 219], [239, 252, 255]]),
      wind: rampFrom('--ramp-wind', 8, [0, 4, 9, 15, 22, 30, 40, 55], [dark, grey]),
      pressure: rampFrom('--ramp-pressure', 6, [960, 985, 1000, 1010, 1020, 1035], [dark, grey]),
      temperature: rampFrom('--ramp-temperature', 6, [22, 25, 27, 29, 30.5, 32], [dark, grey]),
      airTemperature: rampFrom('--ramp-air-temperature', 7, [-40, -20, 0, 10, 20, 30, 40], [[115, 105, 190], [70, 130, 215], [105, 195, 225], [105, 195, 165], [230, 215, 105], [235, 155, 75], [215, 80, 65]]),
      population: rampFrom('--ramp-population', 5, [4.5, 5.3, 5.9, 6.5, 7.2], [dark, grey]),
      rain: rampFrom('--ramp-rain', 5, [0, 5, 15, 30, 50], [[190, 240, 245], [90, 200, 245], [170, 130, 245], [235, 110, 215], [250, 230, 245]]),
      snow: rampFrom('--ramp-snow', 3, [0, 5, 20], [[215, 222, 230], [248, 250, 252], [232, 246, 255]]),
    },
  };
}
