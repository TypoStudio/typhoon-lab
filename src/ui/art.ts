import type { NewsItem } from '../types';
import { cycloneSymbolPaths } from '../render/cyclone-symbol';
import { svgEl } from './dom';

type Kind = NewsItem['kind'];
type Attrs = Record<string, string | number | null>;

const hashString = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
/** Deterministic 0..1 value for (seed, index). */
const rnd = (seed: number, i: number): number => {
  let h = seed ^ Math.imul(i + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return ((h >>> 0) % 1000) / 1000;
};

const C = (name: string) => `var(--color-${name})`;
const f = (n: number) => n.toFixed(1);
const path = (d: string, a: Attrs = {}) => svgEl('path', { d, fill: 'none', ...a });
const circle = (cx: number, cy: number, r: number, a: Attrs = {}) => svgEl('circle', { cx, cy, r, ...a });
const rect = (x: number, y: number, width: number, height: number, a: Attrs = {}) => svgEl('rect', { x, y, width, height, ...a });
const group = (a: Attrs, kids: SVGElement[]) => svgEl('g', a, kids);

/** Vertical gradient (colour tokens, optional stop opacity) wrapped in its own <defs>; ids are made unique per card by the caller. */
const gradient = (id: string, stops: [string, number?][], a: Attrs = {}) =>
  svgEl('defs', {}, [svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1, ...a },
    stops.map(([c, o], i) => svgEl('stop', { offset: i / (stops.length - 1), 'stop-color': C(c), 'stop-opacity': o ?? null })))]);

/** Rows of gentle sea swell spanning the card. */
function waves(y: number, rows: number, color = 'wind', opacity = 0.5, gap = 6): SVGElement {
  let d = '';
  for (let row = 0; row < rows; row++) d += `M${row % 2 ? -3 : 0} ${y + row * gap} q3 -2.5 6 0${' t6 0'.repeat(16)}`;
  return path(d, { stroke: C(color), 'stroke-width': 1.2, 'stroke-linecap': 'round', opacity });
}

/** Faint lat/long graticule so the cyclone cards read as a chart. */
const graticule = () => path('M0 20 Q48 16 96 20 M0 44 Q48 40 96 44 M30 0 Q27 32 30 64 M66 0 Q69 32 66 64', { stroke: C('grid'), 'stroke-width': 0.8, opacity: 0.7 });

interface SymbolOptions { dir?: 1 | -1; rot?: number; fill?: string; ghost?: boolean }
/**
 * The map's cyclone symbol (`cycloneSymbolPaths`): a ring with a hollow eye and, from rank 1, two tails. Filled with the storm
 * colour over a paper-coloured halo, as on the map. `rot` is degrees counter-clockwise, `dir` -1 mirrors it for the south;
 * `ghost` (a forming system) draws a faint dashed ring instead.
 */
function cycloneSymbol(cx: number, cy: number, R: number, rank: number, { dir = 1, rot = 0, fill = C('storm'), ghost = false }: SymbolOptions = {}): SVGElement {
  const { ring, tails } = cycloneSymbolPaths(R, rank);
  const halo = { stroke: C('paper'), 'stroke-width': 1.6, 'stroke-linejoin': 'round', opacity: 0.6 };
  const g = group({ transform: `translate(${f(cx)} ${f(cy)}) scale(${dir} 1) rotate(${f(-rot)})` }, []);
  if (ghost) {
    g.append(path(ring, { fill, 'fill-opacity': 0.14, 'fill-rule': 'evenodd', stroke: fill, 'stroke-width': 1, 'stroke-dasharray': '3 2', 'stroke-linejoin': 'round' }));
    return g;
  }
  g.append(path(ring, { ...halo, 'fill-rule': 'evenodd' }), path(tails, halo), path(ring, { fill, 'fill-rule': 'evenodd' }), path(tails, { fill }));
  return g;
}

/** Silhouette skyline; `lit` windows glow in the accent colour. */
function skyline(seed: number, base: number, lit: boolean, scale = 1): SVGElement {
  const g = group({ fill: C('paper'), stroke: C('land'), 'stroke-width': 0.8 }, []);
  let x = 2;
  for (let i = 0; x < 94; i++) {
    const w = 7 + Math.round(rnd(seed, i) * 7);
    const h = Math.round((12 + rnd(seed, i + 40) * 22) * scale);
    g.append(rect(x, base - h, w, h + 10));
    if (rnd(seed, i + 80) > 0.5) g.append(rect(x + w / 2 - 0.5, base - h - 5, 1, 5, { stroke: 'none' })); // antenna
    if (lit) for (let wy = base - h + 4; wy < base - 3; wy += 6) if (rnd(seed, i * 9 + wy) > 0.6) g.append(rect(x + 2, wy, 2, 2, { fill: C('accent'), stroke: 'none', opacity: 0.85 }));
    x += w + 1;
  }
  return g;
}

/** Cranes at work: the recovery card's repair motif. */
function crane(x: number, base: number): SVGElement {
  const top = base - 40;
  return path(`M${x} ${base}V${top}M${x - 7} ${top + 2}H${x + 15}M${x} ${top - 5}L${x + 12} ${top + 2}M${x} ${top - 5}L${x - 7} ${top + 2}M${x + 12} ${top + 2}V${top + 11}`,
    { stroke: C('paper'), 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
}

/** Six-point snow crystal. */
function flake(x: number, y: number, r: number): SVGElement {
  const c = r * 0.5;
  const s = r * 0.87;
  return path(`M${f(x - r)} ${f(y)}H${f(x + r)}M${f(x - c)} ${f(y - s)}L${f(x + c)} ${f(y + s)}M${f(x - c)} ${f(y + s)}L${f(x + c)} ${f(y - s)}`,
    { stroke: C('ink'), 'stroke-width': 1, 'stroke-linecap': 'round' });
}

/** 0 for a gale bulletin, 1..3 for the damage tier encoded in `city-<id>-<level>-<tick>`. */
function citySeverity(id: string): number {
  if (id.endsWith('gale')) return 0;
  const level = /-(\d+)-\d+$/.exec(id);
  return Math.min(3, Math.max(1, level ? Number(level[1]) : 1));
}

/**
 * Code-native news illustration for a breaking-news item. 96×64, token-coloured, decorative
 * (aria-hidden); the text next to it carries the information.
 */
export function newsArt(item: Pick<NewsItem, 'kind' | 'id' | 'cityId'>): SVGSVGElement {
  const kind: Kind = item.kind;
  const seed = hashString(item.cityId ?? item.id);
  const uid = hashString(item.id).toString(36);
  const tilt = (rnd(seed, 500) - 0.5) * 30; // seeded ±15° so cards differ
  const sky = `sky-${uid}`;
  const svg = svgEl('svg', { viewBox: '0 0 96 64', width: 96, height: 64, role: 'presentation', 'aria-hidden': 'true', class: `art art--${kind}`, focusable: 'false' });
  const backdrop = (stops: [string, number?][]) => svg.append(gradient(sky, stops), rect(0, 0, 96, 64, { fill: `url(#${sky})` }));
  switch (kind) {
    case 'merger':
      backdrop([['paper-3'], ['sea']]);
      svg.append(graticule(), cycloneSymbol(27, 25, 14, 2, { rot: tilt }), cycloneSymbol(68, 38, 20, 2, { rot: -tilt }),
        path('M39 28l5 5-5 5M44 28l5 5-5 5', { stroke: C('accent'), 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      break;
    case 'formation':
      backdrop([['paper-3'], ['sea']]);
      svg.append(graticule(), circle(48, 32, 24, { fill: 'none', stroke: C('accent'), 'stroke-width': 1, 'stroke-dasharray': '1 3.5', 'stroke-linecap': 'round' }),
        cycloneSymbol(48, 32, 17, 0, { rot: tilt, ghost: true }));
      break;
    case 'intensity': {
      backdrop([['paper-3'], ['sea']]);
      const bars = [8, 15, 23, 33].map((h, i) => rect(64 + i * 7, 56 - h, 5, h, { rx: 1, fill: C(i === 3 ? 'danger' : 'warn') }));
      svg.append(graticule(), circle(33, 32, 29, { fill: 'none', stroke: C('storm'), 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.45 }),
        cycloneSymbol(33, 32, 23, 4, { rot: tilt }), path('M60 57.5H94', { stroke: C('coast'), 'stroke-width': 1, opacity: 0.6 }), ...bars);
      break;
    }
    case 'landfall':
      backdrop([['paper-3'], ['sea']]);
      svg.append(path('M60 0C52 14 57 24 51 34C46 44 57 54 52 64H96V0Z', { fill: C('land') }),
        path('M64 0C56 14 61 24 55 34C50 44 61 54 56 64', { stroke: C('coast'), 'stroke-width': 0.9, 'stroke-dasharray': '3 2', opacity: 0.55 }),
        path('M60 0C52 14 57 24 51 34C46 44 57 54 52 64', { stroke: C('coast'), 'stroke-width': 1.6, 'stroke-linecap': 'round' }),
        group({ fill: C('paper') }, [rect(74, 38, 9, 18), rect(83, 45, 7, 11), rect(86, 51, 2, 5, { fill: C('accent') }), rect(77, 42, 2, 2, { fill: C('accent') }), rect(77, 48, 2, 2, { fill: C('accent') })]),
        cycloneSymbol(46, 31, 21, 2, { rot: tilt }));
      break;
    case 'city': {
      const sev = citySeverity(item.id);
      const top = 58 - sev * 5;
      backdrop([['paper-2'], ['paper-4']]);
      let rain = '';
      for (let i = 0; i < 8 + sev * 4; i++) rain += `M${f(rnd(seed, i + 200) * 100 - 6)} ${f(rnd(seed, i + 300) * 44)}l${2 + sev} 7`;
      svg.append(skyline(seed, 56, sev < 3), path(rain, { stroke: C('wind'), 'stroke-width': 1, 'stroke-linecap': 'round', opacity: 0.8 }),
        rect(0, top, 96, 64 - top, { fill: C('sea'), opacity: 0.95 }), waves(top + 1, 1, sev === 3 ? 'danger' : 'wind', 0.9));
      if (sev === 3) svg.append(rect(0, top, 96, 64 - top, { fill: C('danger'), opacity: 0.28 }));
      break;
    }
    case 'blizzard': {
      backdrop([['paper-2'], ['rule']]);
      const x = 14 + (seed % 20);
      const tree = group({ transform: `rotate(10 ${x} 50)`, fill: C('paper') }, [rect(x - 1, 42, 2, 8),
        path(`M${x - 10} 44L${x} 28L${x + 10} 44Z M${x - 8} 34L${x} 18L${x + 8} 34Z M${x - 6} 25L${x} 10L${x + 6} 25Z`, { fill: C('paper') })]);
      let streaks = '';
      for (let i = 0; i < 9; i++) streaks += `M${f(rnd(seed, i) * 96 - 8)} ${f(4 + rnd(seed, i + 30) * 48)}l${13 + Math.round(rnd(seed, i + 60) * 8)} 3`;
      svg.append(tree, path('M0 50Q30 44 56 50T96 47V64H0Z', { fill: C('ink'), opacity: 0.92 }), path('M0 58Q40 52 96 57V64H0Z', { fill: C('muted'), opacity: 0.5 }),
        path(streaks, { stroke: C('ink'), 'stroke-width': 1.5, 'stroke-linecap': 'round', opacity: 0.75 }),
        flake(60 + rnd(seed, 90) * 10, 14, 3), flake(78, 30 + rnd(seed, 91) * 8, 2.6), flake(44, 22, 2.2), flake(86, 10, 2));
      break;
    }
    case 'recovery':
      backdrop([['paper-3'], ['accent', 0.7]]);
      svg.append(circle(62, 36, 12, { fill: C('accent') }), skyline(seed, 52, false, 0.7), crane(8 + (seed % 24), 52),
        rect(0, 52, 96, 12, { fill: C('sea') }), waves(56, 2, 'wind', 0.45), path('M52 54H72M56 58H68', { stroke: C('accent'), 'stroke-width': 1.4, 'stroke-linecap': 'round', opacity: 0.8 }));
      break;
    case 'ended': {
      const fade = `fade-${uid}`;
      backdrop([['paper'], ['paper-3']]);
      svg.append(gradient(fade, [['storm', 0.9], ['storm', 0.05]], { gradientUnits: 'userSpaceOnUse', x1: 0, y1: -18, x2: 0, y2: 18 }),
        rect(0, 44, 96, 20, { fill: C('sea') }), path('M0 44H96', { stroke: C('coast'), 'stroke-width': 0.8, opacity: 0.5 }),
        cycloneSymbol(46, 26, 18, 2, { rot: tilt, fill: `url(#${fade})` }),
        ...[[74, 14, 1.6], [80, 22, 1.2], [68, 8, 1], [85, 12, 0.9]].map(([x, y, r]) => circle(x, y, r, { fill: C('storm'), opacity: 0.4 })),
        waves(49, 3, 'wind', 0.5, 5));
      break;
    }
    default: {
      backdrop([['paper'], ['paper-3']]);
      const a = rnd(seed, 7) * Math.PI * 2;
      svg.append(circle(48, 32, 15, { fill: C('sea'), stroke: C('wind'), 'stroke-width': 1.5 }),
        path('M48 17Q40 32 48 47M48 17Q56 32 48 47M33 32H63', { stroke: C('wind'), 'stroke-width': 1, opacity: 0.55 }),
        path('M56 18.5A15 15 0 0 1 56 45.5A12 14 0 0 0 56 18.5Z', { fill: C('paper'), opacity: 0.75 }),
        svgEl('ellipse', { cx: 48, cy: 32, rx: 33, ry: 9, transform: 'rotate(-22 48 32)', fill: 'none', stroke: C('muted'), 'stroke-width': 1, 'stroke-dasharray': '2 3', opacity: 0.7 }),
        circle(0, 0, 2.4, { fill: C('accent'), transform: `translate(48 32) rotate(-22) translate(${f(33 * Math.cos(a))} ${f(9 * Math.sin(a))})` }));
    }
  }
  return svg;
}
