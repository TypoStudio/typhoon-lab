import { padSpan, type MinSpan, type Series } from './measure-store';

export interface SparkLine { n: number; color: string; dashed: boolean; s: Series | undefined }
export interface SparkColors { ink: string; rule: string; surface: string }

export const lastOf = (s: Series | undefined): number => {
  if (!s) return NaN;
  for (let i = s.v.length - 1; i >= 0; i--) if (!Number.isNaN(s.v[i])) return s.v[i];
  return NaN;
};

export function sparkColors(host: Element): SparkColors {
  const css = getComputedStyle(host);
  return { ink: css.getPropertyValue('--color-ink').trim() || '#fff', rule: css.getPropertyValue('--color-rule').trim() || '#888', surface: css.getPropertyValue('--color-paper-3').trim() || '#222' };
}

/** A sparkline of every line on one canvas (its CSS size): no axes, a dashed zero line for anomalies, the observed Niño 3.4 dashed in ink, an end marker per line. */
export function drawSparkline(canvas: HTMLCanvasElement, lines: SparkLine[], zero: boolean | undefined, span: MinSpan | undefined, observed: Series | null, c: SparkColors): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.round(canvas.clientWidth), h = Math.round(canvas.clientHeight);
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    let t0 = Infinity, t1 = -Infinity, lo = Infinity, hi = -Infinity;
    for (const l of lines) if (l.s) l.s.t.forEach((time, k) => {
      t0 = Math.min(t0, time); t1 = Math.max(t1, time);
      if (!Number.isNaN(l.s!.v[k])) { lo = Math.min(lo, l.s!.v[k]); hi = Math.max(hi, l.s!.v[k]); }
    });
    if (!Number.isFinite(t0)) return;
    t1 = Math.max(t1, t0 + 2 / 24);
    if (observed) observed.t.forEach((time, k) => { if (time >= t0 && time <= t1) { lo = Math.min(lo, observed.v[k]); hi = Math.max(hi, observed.v[k]); } });
    if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    if (!Number.isFinite(lo)) return;
    [lo, hi] = padSpan(lo, hi, span);
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    const padX = 4, padY = 4;
    const X = (time: number) => padX + ((time - t0) / (t1 - t0)) * (w - 2 * padX);
    const Y = (v: number) => h - padY - ((v - lo) / (hi - lo)) * (h - 2 * padY);
    if (zero) { // the only reference a sparkline keeps: the zero line of an anomaly or index
      ctx.strokeStyle = c.rule; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(padX, Math.round(Y(0)) + 0.5); ctx.lineTo(w - padX, Math.round(Y(0)) + 0.5); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 1.75;
    const stroke = (time: number[], v: number[], color: string, dash: number[]) => {
      ctx.strokeStyle = color; ctx.setLineDash(dash); ctx.beginPath();
      let pen = false;
      for (let k = 0; k < time.length; k++) {
        if (Number.isNaN(v[k])) { pen = false; continue; }
        if (pen) ctx.lineTo(X(time[k]), Y(v[k])); else { ctx.moveTo(X(time[k]), Y(v[k])); pen = true; }
      }
      ctx.stroke(); ctx.setLineDash([]);
    };
    if (observed) stroke(observed.t.map(x => Math.min(Math.max(x, t0), t1)), observed.v, c.ink, [4, 3]);
    for (const l of lines) {
      if (!l.s?.t.length) continue;
      stroke(l.s.t, l.s.v, l.color, l.dashed ? [5, 3] : []);
      let last = l.s.t.length - 1;
      while (last >= 0 && Number.isNaN(l.s.v[last])) last--;
      if (last >= 0) { // end marker with a ring in the surface colour, as in the full charts
        ctx.fillStyle = l.color; ctx.strokeStyle = c.surface; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X(l.s.t[last]), Y(l.s.v[last]), 2.5, 0, Math.PI * 2); ctx.stroke(); ctx.fill();
        ctx.lineWidth = 1.75;
      }
    }
}
