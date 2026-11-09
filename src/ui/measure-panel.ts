import { getLanguage, setText, t, type Language } from '../i18n';
import { el, fmtCoord } from './dom';
import { MEASURE_BY_ID, pinStyle, type MeasureItem, type ProbeBook } from './measure';
import { niceRange, nearestIndex, elapsedTicks, trimNumber, type AxisUnit, type Series } from './measure-store';

/** Axis unit words per language (a tick reads "6h", "3 d", "2 mo", "1y"). */
const AXIS_UNITS: Record<Language, Record<AxisUnit, string>> = {
  en: { h: 'h', d: 'd', mo: 'mo', y: 'y' },
  ko: { h: '시간', d: '일', mo: '개월', y: '년' },
  ja: { h: '時間', d: '日', mo: 'か月', y: '年' },
  'zh-CN': { h: '小时', d: '天', mo: '个月', y: '年' },
  'zh-TW': { h: '小時', d: '天', mo: '個月', y: '年' },
};
const unitWord = (u: AxisUnit): string => AXIS_UNITS[getLanguage()][u];

const MINUS = '−';
export function fmtMeasure(v: number, digits: number): string {
  if (!Number.isFinite(v)) return '\u2014';
  const text = v.toFixed(digits);
  return /^-0\.?0*$/.test(text) ? text.slice(1) : text.replace('-', MINUS);
}

/** Elapsed model time (days since the chart's first sample) in the unit that suits it, for tooltips. */
export function elapsedLabel(days: number): string {
  if (days < 3) return `${Math.round(days * 24)}${unitWord('h')}`;
  if (days < 100) return `${days.toFixed(1)}${unitWord('d')}`;
  if (days < 730) return `${(days / (365 / 12)).toFixed(1)}${unitWord('mo')}`;
  return `${(days / 365).toFixed(1)}${unitWord('y')}`;
}

interface Line { n: number; name: string; short: string; color: string; dashed: boolean; series: (Series | undefined)[] }
interface Card {
  item: MeasureItem;
  root: HTMLElement;
  linesList: HTMLElement;
  note: HTMLElement;
  plots: { frame: HTMLElement; canvas: HTMLCanvasElement; tip: HTMLElement; width: number; height: number; alt: string }[];
  lines: Line[];
  /** Crosshair time, or null. */
  cursor: number | null;
  tipPlot: number;
  values: HTMLElement[][];
  /** Scrolled into view; cards out of view are not drawn until they come back. */
  onscreen: boolean;
}

export interface MeasurePanelOptions {
  cards: HTMLElement;
  hint: HTMLElement;
  clear: HTMLButtonElement;
  book: ProbeBook;
  /** True while the Measure tab is on screen; hidden tabs do no chart work. */
  visible(): boolean;
  /** Whether the world has an ENSO climate layer (the basin indices and the thermocline anomaly are 0 without one). */
  hasLayer(): boolean;
  onRemove(itemId: string): void;
  onClear(): void;
}

export interface MeasurePanel {
  /** Call after samples or layout changes, or when the tab is shown: redraws only if something changed. */
  refresh(): void;
  /** Rebuilds every text after a language change. */
  relocalize(): void;
  dispose(): void;
}

export function createMeasurePanel(o: MeasurePanelOptions): MeasurePanel {
  const cards = new Map<string, Card>();
  let drawnRev = -1, builtLayout = -1, raf = 0, disposed = false, noteShown: boolean | null = null;
  const byRoot = new WeakMap<Element, Card>();
  const view = new IntersectionObserver(entries => {
    for (const e of entries) {
      const card = byRoot.get(e.target);
      if (!card || card.onscreen === e.isIntersecting) continue;
      card.onscreen = e.isIntersecting;
      if (card.onscreen && o.visible()) drawCard(card);
    }
  });
  const colors = { muted: '', rule: '', ink: '', surface: '' };
  const readColors = () => {
    const css = getComputedStyle(o.cards);
    colors.muted = css.getPropertyValue('--color-muted').trim();
    colors.rule = css.getPropertyValue('--color-rule').trim();
    colors.ink = css.getPropertyValue('--color-ink').trim();
    colors.surface = css.getPropertyValue('--color-paper-3').trim();
  };
  const resize = new ResizeObserver(entries => {
    let changed = false;
    for (const e of entries) {
      for (const card of cards.values()) for (const p of card.plots) {
        if (p.frame !== e.target) continue;
        const w = Math.round(e.contentRect.width);
        if (w && w !== p.width) { p.width = w; changed = true; }
      }
    }
    if (changed) schedule();
  });

  const unitText = (unit: string): string => t(unit);
  const plotUnits = (item: MeasureItem): string => [...new Set(item.plots.map(p => unitText(p.unit)))].join(' · ');

  function lineName(item: MeasureItem, n: number): string {
    if (item.basin) return t('Pacific basin');
    const pin = o.book.pins.find(p => p.n === n)!;
    return t(`#${n} ${fmtCoord(pin.lon, pin.lat)}`);
  }

  function buildLines(card: Card): void {
    const { item } = card;
    const pinNs = item.basin ? [0] : [...(o.book.charts.get(item.id) ?? [])].sort((a, b) => a - b);
    card.lines = pinNs.map(n => ({
      n, name: lineName(item, n), short: item.basin ? '' : `#${n}`,
      ...(item.basin ? { color: pinStyle(1).color, dashed: false } : pinStyle(n)),
      series: item.plots.map((_, i) => o.book.seriesOf(item.id, i, n)),
    }));
    card.linesList.replaceChildren();
    card.values = card.lines.map(line => {
      const spans = item.plots.map(() => el('span', { class: 'measure-line__value' }));
      const values = el('span', { class: 'measure-line__values' });
      spans.forEach((span, i) => { if (i) values.append(el('span', { class: 'measure-line__sep', 'aria-hidden': 'true', text: '·' })); values.append(span); });
      const key = el('span', { class: 'measure-key', 'aria-hidden': 'true' });
      key.style.setProperty('--line', line.color);
      if (line.dashed) key.dataset.dashed = 'true';
      card.linesList.append(el('li', { class: 'measure-line', 'data-pin': line.n }, [key, el('span', { class: 'measure-line__name', text: line.name }), values]));
      return spans;
    });
  }

  function buildCard(item: MeasureItem): Card {
    const title = el('h3', { class: 'measure-card__title', id: `measure-title-${item.id}`, text: item.name });
    const remove = el('button', { type: 'button', class: 'icon-btn measure-card__remove', 'data-testid': `measure-remove-${item.id}`, 'aria-label': `Remove ${item.name}`, title: `Remove ${item.name}` });
    remove.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    remove.addEventListener('click', () => o.onRemove(item.id));
    const unit = el('span', { class: 'measure-card__unit', text: plotUnits(item) });
    const linesList = el('ul', { class: 'measure-lines' });
    const plotsBox = el('div', { class: 'measure-plots' });
    const card: Card = { item, root: null as unknown as HTMLElement, linesList, note: el('p', { class: 'fine measure-note', hidden: true, text: 'No ENSO climate layer is running, so this shows the long-term average and the anomalies are zero. Move the ENSO slider or place a warm or cool condition in the tropics to start it.' }), plots: [], lines: [], cursor: null, tipPlot: 0, values: [], onscreen: true };
    item.plots.forEach((plot, i) => {
      const canvas = el('canvas', { class: 'measure-plot__canvas', tabindex: 0, role: 'img', 'data-testid': `measure-plot-${item.id}-${i}` });
      const tip = el('div', { class: 'measure-tip', hidden: true, 'aria-hidden': 'true' });
      const frame = el('div', { class: 'measure-plot__frame' }, [canvas, tip]);
      const caption = el('p', { class: 'measure-plot__label' }, [el('span', { text: plot.label }), el('span', { class: 'measure-plot__unit', text: unitText(plot.unit) })]);
      plotsBox.append(el('figure', { class: 'measure-plot' }, [item.plots.length > 1 || plot.label !== item.name ? caption : null, frame]));
      const p = { frame, canvas, tip, width: 0, height: 0, alt: '' };
      card.plots.push(p);
      resize.observe(frame);
      canvas.addEventListener('pointermove', ev => {
        const rect = canvas.getBoundingClientRect();
        setCursor(card, i, timeAt(card, i, ev.clientX - rect.left, rect.width));
      });
      canvas.addEventListener('pointerleave', () => setCursor(card, i, null));
      canvas.addEventListener('focus', () => { const s = reference(card); if (s) setCursor(card, i, s.t[s.t.length - 1]); });
      canvas.addEventListener('blur', () => setCursor(card, i, null));
      canvas.addEventListener('keydown', ev => {
        const s = reference(card);
        if (!s || !['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(ev.key)) return;
        ev.preventDefault();
        if (ev.key === 'Escape') { setCursor(card, i, null); return; }
        const at = card.cursor === null ? s.t.length - 1 : nearestIndex(s, card.cursor);
        const next = ev.key === 'Home' ? 0 : ev.key === 'End' ? s.t.length - 1 : Math.max(0, Math.min(s.t.length - 1, at + (ev.key === 'ArrowRight' ? 1 : -1)));
        setCursor(card, i, s.t[next]);
      });
    });
    card.root = el('section', { class: 'measure-card', 'data-testid': `measure-card-${item.id}`, 'data-item': item.id, 'data-plots': item.plots.length, 'aria-labelledby': title.id }, [
      el('header', { class: 'measure-card__head' }, [title, unit, remove]), linesList, plotsBox, card.note,
    ]);
    buildLines(card);
    byRoot.set(card.root, card);
    view.observe(card.root);
    return card;
  }

  /** The line with the most points: the crosshair and arrow keys step along it. */
  function reference(card: Card): Series | undefined {
    let best: Series | undefined;
    for (const line of card.lines) { const s = line.series[0]; if (s && s.t.length > (best?.t.length ?? 0)) best = s; }
    return best;
  }

  function domain(card: Card): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (const line of card.lines) for (const s of line.series) if (s?.t.length) { lo = Math.min(lo, s.t[0]); hi = Math.max(hi, s.t[s.t.length - 1]); }
    if (!Number.isFinite(lo)) return [0, 1];
    return [lo, Math.max(hi, lo + 2 / 24)];
  }

  const PAD = { l: 38, r: 10, t: 8, b: 18 };
  function timeAt(card: Card, _plot: number, x: number, width: number): number {
    const [t0, t1] = domain(card);
    return t0 + Math.max(0, Math.min(1, (x - PAD.l) / Math.max(1, width - PAD.l - PAD.r))) * (t1 - t0);
  }

  function setCursor(card: Card, plot: number, time: number | null): void {
    if (card.cursor === time && card.tipPlot === plot) return;
    card.cursor = time; card.tipPlot = plot;
    drawCard(card);
  }

  function drawCard(card: Card): void {
    if (disposed) return;
    const [t0, t1] = domain(card);
    card.plots.forEach((p, i) => drawPlot(card, i, t0, t1));
    card.root.dataset.points = String(Math.max(0, ...card.lines.map(l => l.series[0]?.t.length ?? 0)));
    card.values.forEach((spans, li) => spans.forEach((span, pi) => {
      const plot = card.item.plots[pi];
      const v = lastFinite(card.lines[li].series[pi]);
      span.textContent = `${fmtMeasure(v, plot.digits)} ${unitText(plot.unit)}`;
    }));
    const note = !!card.item.needsLayer && !o.hasLayer();
    card.note.hidden = !note;
    // A text alternative with the current values for every line, kept in step with the picture.
    card.plots.forEach((p, i) => {
      const plot = card.item.plots[i];
      const alt = `${t(plot.label)}: ${card.lines.map(l => `${l.name} ${fmtMeasure(lastFinite(l.series[i]), plot.digits)} ${unitText(plot.unit)}`).join('; ')}`;
      if (alt !== p.alt) { p.alt = alt; p.canvas.setAttribute('aria-label', alt); }
    });
  }

  const lastFinite = (s: Series | undefined): number => {
    if (!s) return NaN;
    for (let i = s.v.length - 1; i >= 0; i--) if (!Number.isNaN(s.v[i])) return s.v[i];
    return NaN;
  };

  function drawPlot(card: Card, index: number, t0: number, t1: number): void {
    const p = card.plots[index];
    const plot = card.item.plots[index];
    const w = p.width || Math.round(p.frame.clientWidth);
    const h = Math.round(p.canvas.clientHeight) || 110;
    if (!w) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (p.canvas.width !== Math.round(w * dpr) || p.canvas.height !== Math.round(h * dpr)) {
      p.canvas.width = Math.round(w * dpr); p.canvas.height = Math.round(h * dpr);
    }
    p.height = h;
    const ctx = p.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    let lo = Infinity, hi = -Infinity;
    for (const line of card.lines) {
      const s = line.series[index];
      if (s) for (const v of s.v) if (!Number.isNaN(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (plot.zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    for (const g of plot.guides ?? []) { lo = Math.min(lo, g.value); hi = Math.max(hi, g.value); }
    const y = niceRange(lo, hi, h < 100 ? 2 : 3);
    const x0 = PAD.l, x1 = w - PAD.r, yTop = PAD.t, yBottom = h - PAD.b;
    const X = (time: number) => x0 + ((time - t0) / (t1 - t0)) * (x1 - x0);
    const Y = (v: number) => yBottom - ((v - y.min) / (y.max - y.min)) * (yBottom - yTop);

    ctx.font = `10px ${getComputedStyle(p.canvas).fontFamily}`;
    ctx.textBaseline = 'middle';
    // Recessive grid: hairlines one step off the surface, labels in the muted text colour.
    ctx.lineWidth = 1;
    const step = y.ticks.length > 1 ? Math.abs(y.ticks[1] - y.ticks[0]) : 1;
    const tickDigits = step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
    for (const v of y.ticks) {
      const yy = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = colors.rule; ctx.globalAlpha = plot.zero && v === 0 ? 1 : 0.55;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = colors.muted; ctx.textAlign = 'right';
      ctx.fillText(fmtMeasure(v, tickDigits), x0 - 5, yy);
    }
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    // Five labels, evenly spaced from 0 to the elapsed time, all in one unit; the ends hug the plot edges.
    for (const tick of elapsedTicks(t1 - t0)) {
      const xx = x0 + tick.frac * (x1 - x0);
      ctx.fillStyle = colors.muted;
      ctx.textAlign = tick.frac === 0 ? 'left' : tick.frac === 1 ? 'right' : 'center';
      ctx.fillText(tick.value === 0 ? '0' : `${trimNumber(tick.value)}${unitWord(tick.unit)}`, xx, h - 4);
    }
    // Reference values the reader knows (the formation threshold, El Niño and La Niña): thin dashes with a label.
    ctx.setLineDash([4, 4]);
    for (const g of plot.guides ?? []) {
      const yy = Math.round(Y(g.value)) + 0.5;
      ctx.strokeStyle = colors.muted; ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.setLineDash([]);
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = colors.muted;
    for (const g of plot.guides ?? []) ctx.fillText(t(g.label), x1 - 2, Math.round(Y(g.value)) - 2);

    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const line of card.lines) {
      const s = line.series[index];
      if (!s?.t.length) continue;
      ctx.strokeStyle = line.color; ctx.lineWidth = 2;
      ctx.setLineDash(line.dashed ? [6, 4] : []);
      ctx.beginPath();
      let pen = false;
      for (let k = 0; k < s.t.length; k++) {
        if (Number.isNaN(s.v[k])) { pen = false; continue; }
        if (pen) ctx.lineTo(X(s.t[k]), Y(s.v[k])); else { ctx.moveTo(X(s.t[k]), Y(s.v[k])); pen = true; }
      }
      ctx.stroke();
      ctx.setLineDash([]);
      let last = s.t.length - 1;
      while (last >= 0 && Number.isNaN(s.v[last])) last--;
      if (last >= 0) dot(ctx, X(s.t[last]), Y(s.v[last]), line.color);
    }

    if (card.cursor !== null) {
      const cx = Math.round(X(card.cursor)) + 0.5;
      ctx.strokeStyle = colors.muted; ctx.lineWidth = 1; ctx.globalAlpha = 0.9;
      ctx.beginPath(); ctx.moveTo(cx, yTop); ctx.lineTo(cx, yBottom); ctx.stroke();
      ctx.globalAlpha = 1;
      for (const line of card.lines) {
        const s = line.series[index];
        if (!s?.t.length) continue;
        const k = nearestIndex(s, card.cursor);
        if (!Number.isNaN(s.v[k])) dot(ctx, X(s.t[k]), Y(s.v[k]), line.color);
      }
    }
    showTip(card, index);
  }

  /** An 8 px end marker with a 2 px ring in the surface colour so it stays legible over lines. */
  function dot(ctx: CanvasRenderingContext2D, x: number, y: number, color: string): void {
    ctx.fillStyle = color; ctx.strokeStyle = colors.surface; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
  }

  function showTip(card: Card, index: number): void {
    const p = card.plots[index];
    if (card.cursor === null || card.tipPlot !== index) { p.tip.hidden = true; return; }
    const plot = card.item.plots[index];
    const rows: HTMLElement[] = [el('p', { class: 'measure-tip__time' })];
    rows[0].textContent = elapsedLabel(card.cursor - domain(card)[0]);
    for (const line of card.lines) {
      const s = line.series[index];
      if (!s?.t.length) continue;
      const k = nearestIndex(s, card.cursor);
      const key = el('span', { class: 'measure-key', 'aria-hidden': 'true' });
      key.style.setProperty('--line', line.color);
      if (line.dashed) key.dataset.dashed = 'true';
      const value = el('strong', { class: 'measure-tip__value' });
      value.textContent = `${fmtMeasure(s.v[k], plot.digits)} ${unitText(plot.unit)}`;
      const name = el('span', { class: 'measure-tip__name' });
      name.textContent = line.short;
      rows.push(el('p', { class: 'measure-tip__row' }, [key, value, name]));
    }
    p.tip.replaceChildren(...rows);
    p.tip.hidden = false;
    const [t0, t1] = domain(card);
    const w = p.width || p.frame.clientWidth;
    const px = PAD.l + ((card.cursor - t0) / (t1 - t0)) * (w - PAD.l - PAD.r);
    const tw = p.tip.offsetWidth;
    p.tip.style.left = `${Math.max(0, Math.min(w - tw, px < w / 2 ? px + 10 : px - tw - 10))}px`;
  }

  function sync(): void {
    const { book } = o;
    if (builtLayout !== book.layoutRev) {
      builtLayout = book.layoutRev;
      for (const [id, card] of cards) if (!book.charts.has(id)) { for (const p of card.plots) resize.unobserve(p.frame); view.unobserve(card.root); card.root.remove(); cards.delete(id); }
      for (const id of book.charts.keys()) {
        let card = cards.get(id);
        if (!card) {
          card = buildCard(MEASURE_BY_ID.get(id)!);
          cards.set(id, card);
          o.cards.append(card.root);
        } else buildLines(card);
      }
      o.clear.hidden = !book.charts.size;
      setText(o.hint, book.charts.size
        ? 'Each line follows one pin over model time. Drop the same icon on another spot to compare.'
        : 'Nothing measured yet. Open the Measure tab of the palette and drop an icon on the map to graph that point over time.');
    }
    for (const card of cards.values()) if (card.onscreen) drawCard(card);
    drawnRev = book.rev;
  }

  function schedule(): void {
    if (raf || disposed) return;
    raf = requestAnimationFrame(() => { raf = 0; if (o.visible() && !disposed) sync(); });
  }

  readColors();
  o.clear.addEventListener('click', () => o.onClear());
  return {
    refresh() {
      if (disposed || !o.visible()) return;
      const noteNow = !o.hasLayer();
      if (drawnRev !== o.book.rev || builtLayout !== o.book.layoutRev || noteShown !== noteNow) { noteShown = noteNow; schedule(); }
    },
    relocalize() {
      for (const card of cards.values()) { for (const p of card.plots) resize.unobserve(p.frame); view.unobserve(card.root); card.root.remove(); }
      cards.clear();
      builtLayout = -1;
      readColors();
      if (o.visible()) sync();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      view.disconnect();
      cards.clear();
      o.cards.replaceChildren();
    },
  };
}
