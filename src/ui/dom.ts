/** Small DOM helpers and number/time formatting shared by the UI modules. */
import { getLanguage, localizeTree } from '../i18n';

type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Attrs = {}, children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'testid') node.setAttribute('data-testid', String(v));
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined) node.append(c);
  localizeTree(node);
  return node;
}

export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K, attrs: Attrs = {}, children: (Node | null)[] = [],
): SVGElementTagNameMap[K] {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) node.setAttribute(k, String(v));
  for (const c of children) if (c) node.append(c);
  localizeTree(node);
  return node;
}

export const fmtInt = (n: number): string => Math.round(n).toLocaleString('en-US');

/** Game constants (not live exchange rates): damage is simulated in USD and shown in the display language's currency. */
export const KRW_PER_USD = 1350;
export const JPY_PER_USD = 150;
export const CNY_PER_USD = 7.2;
export const TWD_PER_USD = 32;

/** Truncates (never rounds up) to one decimal place, e.g. 1.27 -> "1.2". */
const oneDecimal = (n: number): string => (Math.floor(n * 10) / 10).toLocaleString('en-US', { minimumFractionDigits: 1 });

/** Damage amount in the display currency: USD for English, otherwise the language's currency in its own units (one unit level, truncated; Korean also shows 억 after 조). */
export function fmtMoney(usd: number): string {
  switch (getLanguage()) {
    case 'ko': {
      const won = Math.round(usd * KRW_PER_USD);
      if (won >= 1e12) {
        const eok = Math.floor((won % 1e12) / 1e8);
        return `${fmtInt(Math.floor(won / 1e12))}조${eok ? ` ${fmtInt(eok)}억` : ''} 원`;
      }
      if (won >= 1e8) return `${fmtInt(Math.floor(won / 1e8))}억 원`;
      if (won >= 1e4) return `${fmtInt(Math.floor(won / 1e4))}만 원`;
      return `${fmtInt(won)}원`;
    }
    case 'ja': {
      const yen = Math.round(usd * JPY_PER_USD);
      if (yen >= 1e12) return `${oneDecimal(yen / 1e12)}兆円`;
      if (yen >= 1e8) return `${fmtInt(Math.floor(yen / 1e8))}億円`;
      if (yen >= 1e4) return `${fmtInt(Math.floor(yen / 1e4))}万円`;
      return `${fmtInt(yen)}円`;
    }
    case 'zh-CN': {
      const yuan = Math.round(usd * CNY_PER_USD);
      if (yuan >= 1e12) return `${oneDecimal(yuan / 1e12)}万亿元`;
      if (yuan >= 1e8) return `${oneDecimal(yuan / 1e8)}亿元`;
      if (yuan >= 1e4) return `${fmtInt(Math.floor(yuan / 1e4))}万元`;
      return `${fmtInt(yuan)}元`;
    }
    case 'zh-TW': {
      const dollars = Math.round(usd * TWD_PER_USD);
      if (dollars >= 1e12) return `NT$${oneDecimal(dollars / 1e12)}兆`;
      if (dollars >= 1e8) return `NT$${fmtInt(Math.floor(dollars / 1e8))}億`;
      if (dollars >= 1e4) return `NT$${fmtInt(Math.floor(dollars / 1e4))}萬`;
      return `NT$${fmtInt(dollars)}`;
    }
    default:
      return `USD ${fmtInt(usd)}`;
  }
}

export function fmtPop(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(Math.round(n));
}

export function fmtCoord(lon: number, lat: number): string {
  return `${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'} ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}`;
}

function clockParts(hours: number): { day: number; time: string } {
  const total = Math.round(hours * 60);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return { day: Math.floor(total / 1440) + 1, time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` };
}

export function fmtClock(hours: number): string {
  const { day, time } = clockParts(hours);
  return `Day ${day} · ${time}`;
}

/** `Day 3 · 02:45 · Oct 26`: the clock with the world's calendar date. */
export function fmtClockDate(hours: number, date: string): string {
  return `${fmtClock(hours)} · ${date}`;
}

/** The phone clock row's compact form, language-neutral: `D1 18:30`. */
export function fmtClockShort(hours: number): string {
  const { day, time } = clockParts(hours);
  return `D${day} ${time}`;
}

/** Real UTC date-time of a loaded historic typhoon: `startIso` plus model hours. */
export function fmtUtc(startIso: string, hours: number): string {
  const ms = Date.parse(startIso) + Math.round(hours * 60) * 60_000;
  return Number.isNaN(ms) ? '' : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Roving-tabindex arrow-key navigation for tab lists and radio groups. */
export function rovingKeys(container: HTMLElement, select: (button: HTMLElement) => void): void {
  container.addEventListener('keydown', ev => {
    const keys = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(ev.key)) return;
    const items = [...container.querySelectorAll<HTMLElement>('[role="tab"], [role="radio"]')].filter(b => !b.hasAttribute('disabled') && b.getClientRects().length > 0);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    let next = at;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (at + 1) % items.length;
    else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (at - 1 + items.length) % items.length;
    else if (ev.key === 'Home') next = 0;
    else next = items.length - 1;
    ev.preventDefault();
    items[next].focus();
    select(items[next]);
  });
}
