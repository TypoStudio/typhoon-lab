import type { MapCamera } from '../render/camera';
import { t } from '../i18n';
import { el } from './dom';
import { MEASURE_BY_ID, pinStyle, type MeasureId, type ProbeBook } from './measure';
import { fmtMeasure } from './measure-panel';
import { drawSparkline, lastOf, sparkColors } from './measure-spark';
import { toolIconSvg } from './shell';

/** Where a basin chart lives: the Niño 3.4 box (170°W-120°W, 5°S-5°N) or the equatorial Pacific for the SOI and warm water volume. */
export const BASIN_SPOTS: Record<string, { lon: number; lat: number; box?: [number, number, number, number] }> = {
  'measure-nino34': { lon: -145, lat: 0, box: [-170, 5, -120, -5] },
  'measure-soi-wwv': { lon: -160, lat: 0 },
};

const MAX_CARDS = 8;
const GAP = 12;
const MARGIN = 4;
const INFO_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/></svg>';

interface Rect { left: number; top: number; right: number; bottom: number }
type Box = [number, number, number, number];
interface Row { id: string; value: HTMLElement; canvas: HTMLCanvasElement }
interface Card {
  key: string; pin: number | null; lon: number; lat: number; items: string[];
  root: HTMLElement; main: HTMLButtonElement; rows: Row[]; cw: number; ch: number; chw: number; chh: number; placed: boolean; stale: boolean;
  /** Where it sat last time, relative to its anchor, so it stays put while that spot stays free. */
  last: { dx: number; dy: number; chip: boolean } | null;
}

export interface MeasureOnMapOptions {
  /** Element laid exactly over the map stage; the cards are positioned inside it. */
  host: HTMLElement;
  book: ProbeBook;
  view(): MapCamera | null;
  /** The user's "Graphs on map" switch, and whether the sidebar leaves the map visible. */
  enabled(): boolean;
  /** Boxes (viewport coordinates) the cards stay clear of: the floating UI. */
  obstacles(): DOMRect[];
  /** What the map drew last frame (stage pixels): disaster objects nothing may cover, every claimed label (cities among them), and a counter that changes when they may have. */
  mapObstacles(): { hard: Box[]; soft: Box[] } | null;
  /** Changes whenever `mapObstacles` may have (a counter of overlay draws). */
  mapRev(): number;
  onLocate(itemId: string, pin: number | null): void;
  onOpen(itemId: string): void;
}

export interface MeasureOnMap {
  /** Call every frame: it only works when the view, the samples, the layout or the free space changed. */
  update(): void;
  /** Marks the free space as changed (a toast came, the palette resized). */
  invalidate(): void;
  stats(): { runs: number; totalMs: number; lastMs: number };
}

/**
 * Small translucent charts anchored beside the measured pins that are on screen: pin badge, the latest value with its unit
 * and a sparkline in the pin's colour; one card per pin (a pin used by several charts stacks their lines), plus a card for each
 * basin chart at its ocean spot. A handful of reused DOM nodes: positions are recomputed only when the view moves, the sparklines
 * only when a new sample arrives. The host ignores the pointer; only the cards' two buttons take it.
 */
export function createMeasureOnMap(o: MeasureOnMapOptions): MeasureOnMap {
  const cards = new Map<string, Card>();
  const box = el('div', { class: 'onmap-box', 'aria-hidden': 'true', hidden: true });
  o.host.append(box);
  let builtLayout = -1, drawnRev = -1, lang = '', lastKey = '', dirty = true, shown = true, lastRev = -1, lastPlaced = 0;
  const compact = window.matchMedia('(max-width: 47.9375rem)');
  const syncCompact = () => o.host.classList.toggle('onmap-graphs--compact', compact.matches);
  syncCompact();
  compact.addEventListener('change', () => { syncCompact(); dirty = true; for (const c of cards.values()) c.cw = 0; });
  const stats = { runs: 0, totalMs: 0, lastMs: 0 };
  const tmp = new Float64Array(3);

  function build(): void {
    for (const c of cards.values()) c.root.remove();
    cards.clear();
    const { book } = o;
    const pinItems = new Map<number, string[]>();
    for (const [id, pins] of book.charts) {
      if (BASIN_SPOTS[id]) continue;
      for (const n of pins) pinItems.set(n, [...(pinItems.get(n) ?? []), id]);
    }
    for (const [n, items] of pinItems) {
      const pin = book.pins.find(p => p.n === n);
      if (pin) cards.set(`p${n}`, make(`p${n}`, n, pin.lon, pin.lat, items));
    }
    for (const id of book.charts.keys()) {
      const spot = BASIN_SPOTS[id];
      if (spot) cards.set(`b:${id}`, make(`b:${id}`, null, spot.lon, spot.lat, [id]));
    }
  }

  function make(key: string, pin: number | null, lon: number, lat: number, items: string[]): Card {
    const rows: Row[] = items.map(id => ({ id, value: el('span', { class: 'onmap-val' }), canvas: el('canvas', { class: 'onmap-spark', 'aria-hidden': 'true' }) }));
    const style = pinStyle(pin ?? 1);
    // What is measured: the item's palette icon before its value (the pin's own number is already on the map pin beside the card).
    const rowEls = rows.map(r => {
      const item = MEASURE_BY_ID.get(r.id)!;
      const icon = el('span', { class: 'onmap-icon', 'aria-hidden': 'true' });
      icon.innerHTML = toolIconSvg(r.id as MeasureId).replace('tool__icon', 'onmap-icon__svg');
      return el('span', { class: 'onmap-row', 'data-tip-title': item.name, 'data-tip': item.plots[0].label }, [icon, r.value, r.canvas]);
    });
    const name = pin === null ? el('span', { class: 'onmap-name' }) : null;
    const main = el('button', { type: 'button', class: 'onmap-card__main', 'data-testid': pin === null ? `onmap-${items[0]}` : `onmap-pin-${pin}` },
      [name, el('span', { class: 'onmap-rows' }, rowEls)]);
    main.addEventListener('click', () => o.onLocate(items[0], pin));
    const info = el('button', { type: 'button', class: 'onmap-card__info', 'data-testid': pin === null ? `onmap-info-${items[0]}` : `onmap-info-${pin}`, 'aria-label': t('Open in the Measure tab') });
    info.innerHTML = INFO_ICON;
    info.addEventListener('click', () => o.onOpen(items[0]));
    const root = el('div', { class: 'onmap-card', hidden: true }, [main, info]);
    root.style.borderInlineStartColor = style.color; // the line colour of the pin it belongs to
    root.addEventListener('pointerdown', ev => ev.stopPropagation()); // a press on a card is not a map pan
    o.host.append(root);
    return { key, pin, lon, lat, items, root, main, rows, cw: 0, ch: 0, chw: 0, chh: 0, placed: false, stale: true, last: null };
  }

  function content(): void {
    for (const c of cards.values()) {
      const names: string[] = [];
      c.rows.forEach(r => {
        const item = MEASURE_BY_ID.get(r.id)!;
        const plot = item.plots[0];
        const n = c.pin ?? 0;
        const s = o.book.seriesOf(r.id, 0, n);
        const style = c.pin === null ? pinStyle(1) : pinStyle(c.pin);
        r.value.textContent = `${fmtMeasure(lastOf(s), plot.digits)} ${t(plot.unit)}`;
        names.push(`${t(item.name)} ${r.value.textContent}`);
      });
      c.stale = true; // the sparklines are drawn when the card is on screen: a hidden canvas has no size
      if (c.pin === null) c.root.querySelector('.onmap-name')!.textContent = t(MEASURE_BY_ID.get(c.items[0])!.name);
      c.main.setAttribute('aria-label', `${c.pin === null ? '' : `#${c.pin} `}${names.join('; ')} · ${t('Show on the map')}`);
      c.root.querySelector('.onmap-card__info')!.setAttribute('aria-label', t('Open in the Measure tab'));
    }
  }

  function sparks(c: Card): void {
    const colors = sparkColors(o.host);
    for (const r of c.rows) {
      const plot = MEASURE_BY_ID.get(r.id)!.plots[0];
      const n = c.pin ?? 0;
      const style = pinStyle(c.pin ?? 1);
      drawSparkline(r.canvas, [{ n, color: style.color, dashed: style.dashed, s: o.book.seriesOf(r.id, 0, n) }], plot.zero, r.id === 'measure-nino34' ? o.book.observed : null, colors);
    }
  }

  function place(view: MapCamera): void {
    const t0 = performance.now();
    const hostBox = o.host.getBoundingClientRect();
    const ui: Rect[] = o.obstacles().map(r => ({ left: r.left - hostBox.left - 3, top: r.top - hostBox.top - 3, right: r.right - hostBox.left + 3, bottom: r.bottom - hostBox.top + 3 }));
    const map = o.mapObstacles();
    const asRects = (boxes: Box[], pad: number): Rect[] => boxes.map(b => ({ left: b[0] - pad, top: b[1] - pad, right: b[2] + pad, bottom: b[3] + pad }));
    const hard = [...ui, ...(map ? asRects(map.hard, 3) : [])];
    const soft = map ? asRects(map.soft, 0) : [];
    lastRev = o.mapRev();
    const w = view.width, h = view.height;
    const anchors: { c: Card; x: number; y: number }[] = [];
    for (const c of cards.values()) {
      view.projectZ(c.lon, c.lat, tmp);
      const on = tmp[2] > 0 && tmp[0] >= 0 && tmp[0] <= w && tmp[1] >= 0 && tmp[1] <= h;
      c.placed = false;
      if (on) anchors.push({ c, x: tmp[0], y: tmp[1] });
      else c.root.hidden = true;
    }
    // Newest pins first (highest number), then the basin cards; the least recent are the ones dropped when crowded.
    anchors.sort((a, b) => (b.c.pin ?? 0) - (a.c.pin ?? 0));
    // A pin marker is a dot with a stem and a numbered head above it.
    const taken: Rect[] = anchors.map(a => ({ left: a.x - 11, top: a.y - 30, right: a.x + 11, bottom: a.y + 8 }));
    const inside = (r: Rect) => r.left >= MARGIN && r.top >= MARGIN && r.right <= w - MARGIN && r.bottom <= h - MARGIN;
    const clear = (r: Rect, useSoft: boolean) => inside(r) && !hard.some(b => hit(r, b)) && !taken.some(b => hit(r, b)) && !(useSoft && soft.some(b => hit(r, b)));
    let placedCount = 0;
    for (const a of anchors) {
      const c = a.c;
      if (placedCount >= MAX_CARDS) { c.root.hidden = true; c.last = null; continue; }
      if (!c.cw) measure(c);
      const rectAt = (dx: number, dy: number, chip: boolean): Rect => {
        const width = chip ? c.chw : c.cw, height = chip ? c.chh : c.ch;
        const left = Math.round(a.x + dx), top = Math.round(a.y + dy);
        return { left, top, right: left + width, bottom: top + height };
      };
      // Offsets from the anchor for a card of size (cw, ch): beside the pin first, above and below next; farther rings after that.
      const offsets = (cw: number, ch: number, ring: number): [number, number][] => ring === 0
        ? [[GAP, -ch - 2], [-GAP - cw, -ch - 2], [GAP, 2], [-GAP - cw, 2], [-cw / 2, -GAP - ch - 6], [-cw / 2, GAP]]
        : [0, 1, 2, 3, 4, 5, 6, 7].map(k => { const ang = (k / 8) * Math.PI * 2; return [Math.cos(ang) * (cw / 2 + ring) - cw / 2, Math.sin(ang) * (ch / 2 + ring) - ch / 2] as [number, number]; });
      let choice: { dx: number; dy: number; chip: boolean } | null = null;
      // Stay where it was while that spot is still free: nothing jumps when a storm moves elsewhere.
      if (c.last && clear(rectAt(c.last.dx, c.last.dy, c.last.chip), false)) choice = c.last;
      if (!choice) {
        // Full card beside the pin (avoiding cities too), then ignoring cities, then farther out; then the compact chip the same way; else hidden.
        const plans: { chip: boolean; ring: number; soft: boolean }[] = [
          { chip: false, ring: 0, soft: true }, { chip: false, ring: 0, soft: false }, { chip: false, ring: 28, soft: false }, { chip: false, ring: 52, soft: false },
          { chip: true, ring: 0, soft: true }, { chip: true, ring: 0, soft: false }, { chip: true, ring: 28, soft: false }, { chip: true, ring: 52, soft: false },
        ];
        outer: for (const plan of plans) {
          const width = plan.chip ? c.chw : c.cw, height = plan.chip ? c.chh : c.ch;
          for (const [dx, dy] of offsets(width, height, plan.ring)) {
            if (clear(rectAt(dx, dy, plan.chip), plan.soft)) { choice = { dx, dy, chip: plan.chip }; break outer; }
          }
        }
      }
      if (!choice) { c.root.hidden = true; c.last = null; continue; }
      c.last = choice;
      const spot = rectAt(choice.dx, choice.dy, choice.chip);
      taken.push(spot);
      c.root.hidden = false;
      c.root.classList.toggle('onmap-card--chip', choice.chip);
      if (!choice.chip && c.stale) { sparks(c); c.stale = false; }
      c.root.style.transform = `translate(${spot.left}px, ${spot.top}px)`;
      c.placed = true;
      placedCount++;
    }
    // The Niño 3.4 box, outlined faintly while its chart is on the map and the box is on screen.
    const nino = BASIN_SPOTS['measure-nino34'].box!;
    const a = o.book.charts.has('measure-nino34') ? view.lonLatToPx(nino[0], nino[1]) : null;
    const b = a ? view.lonLatToPx(nino[2], nino[3]) : null;
    if (a && b) {
      box.hidden = false;
      Object.assign(box.style, { left: `${Math.min(a[0], b[0])}px`, top: `${Math.min(a[1], b[1])}px`, width: `${Math.abs(b[0] - a[0])}px`, height: `${Math.abs(b[1] - a[1])}px` });
    } else box.hidden = true;
    stats.lastMs = performance.now() - t0; stats.totalMs += stats.lastMs; stats.runs++;
  }

  /** The card's size as a full card and as a compact chip (icon and value only), measured off-screen. */
  function measure(c: Card): void {
    c.root.hidden = false;
    c.root.style.transform = 'translate(-9999px, 0)';
    c.root.classList.remove('onmap-card--chip');
    c.cw = c.root.offsetWidth; c.ch = c.root.offsetHeight;
    c.root.classList.add('onmap-card--chip');
    c.chw = c.root.offsetWidth; c.chh = c.root.offsetHeight;
    c.root.classList.remove('onmap-card--chip');
  }

  const hit = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

  return {
    update() {
      const view = o.view();
      const on = o.enabled() && !!view && o.book.charts.size > 0;
      if (!on) {
        if (shown) { o.host.hidden = true; shown = false; }
        return;
      }
      if (!shown) { o.host.hidden = false; shown = true; dirty = true; }
      const book = o.book;
      const language = document.documentElement.lang;
      let changed = dirty;
      if (builtLayout !== book.layoutRev || lang !== language) { builtLayout = book.layoutRev; lang = language; build(); drawnRev = -1; changed = true; }
      if (drawnRev !== book.rev) { drawnRev = book.rev; content(); changed = true; for (const c of cards.values()) { c.cw = 0; } }
      const key = `${view!.version}|${view!.width}|${view!.height}`;
      if (!changed && key === lastKey) {
        // Storms move on every state: re-place when the map's objects changed, a few times a second at most.
        const rev = o.mapRev();
        const now = performance.now();
        if (rev === lastRev || now - lastPlaced < 200) return;
        lastPlaced = now;
      }
      lastKey = key; dirty = false; lastPlaced = performance.now();
      place(view!);
    },
    invalidate() { dirty = true; },
    stats: () => ({ ...stats }),
  };
}
