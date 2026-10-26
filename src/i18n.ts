import * as jaModule from './locales/ja';
import { ko, koTemplates } from './locales/ko';
import * as zhCNModule from './locales/zh-CN';
import * as zhTWModule from './locales/zh-TW';

// Sea names are exported as `<code>Seas` (English sea name -> name); a locale may instead keep them in its main table.
const { ja, jaTemplates } = jaModule;
const { zhCN, zhCNTemplates } = zhCNModule;
const { zhTW, zhTWTemplates } = zhTWModule;
const seasOf = (module: object, key: string): Record<string, string> => (module as Record<string, Record<string, string> | undefined>)[key] ?? {};
const jaSeas = seasOf(jaModule, 'jaSeas');
const zhCNSeas = seasOf(zhCNModule, 'zhCNSeas');
const zhTWSeas = seasOf(zhTWModule, 'zhTWSeas');

export type Language = 'en' | 'ko' | 'ja' | 'zh-CN' | 'zh-TW';
/** Languages whose data names ride along as `names` on cities and places (Korean keeps its own `nameKo`). */
export type NameLanguage = 'ja' | 'zh-CN' | 'zh-TW';
export type LocalNames = Partial<Record<NameLanguage, string>>;

export interface Locale {
  code: Language;
  /** The language's own name, shown in the language selector. */
  label: string;
  /** Value for `<html lang>` and the selector option. */
  htmlLang: string;
  /** Exact English text -> translation. */
  table: Record<string, string>;
  /** English patterns with `{n}` placeholders -> translation. */
  templates: Record<string, string>;
  /** English sea name -> translation, for locales that keep sea names outside `table`. */
  seas: Record<string, string>;
  /** Fallback for a bare "37h". */
  hoursUnit: string;
  /** Fallback for "140°E": compass prefixes and the separator before the number. */
  compass: { E: string; W: string; N: string; S: string; separator: string };
}
export const LOCALES: Locale[] = [
  { code: 'en', label: 'English', htmlLang: 'en', table: {}, templates: {}, seas: {}, hoursUnit: 'h', compass: { E: '°E', W: '°W', N: '°N', S: '°S', separator: '' } },
  { code: 'ko', label: '한국어', htmlLang: 'ko', table: ko, templates: koTemplates, seas: {}, hoursUnit: '시간', compass: { E: '동경', W: '서경', N: '북위', S: '남위', separator: ' ' } },
  { code: 'ja', label: '日本語', htmlLang: 'ja', table: ja, templates: jaTemplates, seas: jaSeas, hoursUnit: '時間', compass: { E: '東経', W: '西経', N: '北緯', S: '南緯', separator: '' } },
  { code: 'zh-CN', label: '简体中文', htmlLang: 'zh-CN', table: zhCN, templates: zhCNTemplates, seas: zhCNSeas, hoursUnit: '小时', compass: { E: '东经', W: '西经', N: '北纬', S: '南纬', separator: '' } },
  { code: 'zh-TW', label: '繁體中文', htmlLang: 'zh-TW', table: zhTW, templates: zhTWTemplates, seas: zhTWSeas, hoursUnit: '小時', compass: { E: '東經', W: '西經', N: '北緯', S: '南緯', separator: '' } },
];
const localeOf = (code: Language): Locale => LOCALES.find(l => l.code === code)!;
const STORAGE_KEY = 'typhoon-lab-language';
/** Matches a language code case-insensitively ("zh-tw" -> 'zh-TW'); undefined when it is not a supported code. */
const parse = (value: unknown): Language | undefined =>
  typeof value === 'string' ? LOCALES.find(l => l.code.toLowerCase() === value.toLowerCase())?.code : undefined;
/** Browser language -> game language: ja*, ko*, zh-TW/HK/MO/Hant* -> Traditional, other zh* -> Simplified. */
export function detectLanguage(browserLanguage: string): Language {
  const tag = browserLanguage.toLowerCase();
  if (tag.startsWith('ko')) return 'ko';
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('zh')) return /^zh-(tw|hk|mo|hant)/.test(tag) ? 'zh-TW' : 'zh-CN';
  return 'en';
}
function initialLanguage(): Language {
  if (typeof window === 'undefined') return 'en';
  const query = parse(new URL(window.location.href).searchParams.get('lang'));
  if (query) return query;
  try { const saved = parse(localStorage.getItem(STORAGE_KEY)); if (saved) return saved; } catch { /* private browsing */ }
  return detectLanguage(navigator.language);
}
let language = initialLanguage();
const translatedCache = new Map<string, string>();
// Names for places that have no entry in the locale tables (the generated city list); consulted after the table.
const registeredNames = new Map<Language, Map<string, string>>();
/** Adds English name -> local name pairs for t() in one language (Korean by default); locale-table entries win. */
export function registerNames(names: Record<string, string>, lang: Language = 'ko'): void {
  let map = registeredNames.get(lang);
  if (!map) { map = new Map(); registeredNames.set(lang, map); }
  for (const [name, local] of Object.entries(names)) map.set(name, local);
  translatedCache.clear();
}
export const getLanguage = (): Language => language;
export function setLanguage(value: Language): void {
  if (!parse(value)) return;
  language = value;
  translatedCache.clear();
  if (typeof window !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, value); } catch { /* storage is optional */ }
  }
  if (typeof document !== 'undefined') {
    document.documentElement.lang = localeOf(value).htmlLang;
    document.title = t('Typhoon Lab');
  }
  if (typeof window !== 'undefined') {
    const url = new URL(window.location.href);
    if (url.searchParams.has('lang')) { url.searchParams.set('lang', value); history.replaceState(null, '', url); }
  }
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const compiledTemplates = new Map<Language, { pattern: RegExp; indices: number[]; result: string }[]>();
function templatesFor(locale: Locale) {
  let compiled = compiledTemplates.get(locale.code);
  if (!compiled) {
    compiled = Object.entries(locale.templates)
      .sort(([a], [b]) => b.replace(/\{\d+\}/g, '').length - a.replace(/\{\d+\}/g, '').length)
      .map(([source, result]) => {
        const indices: number[] = [];
        const parts = source.split(/(\{\d+\})/g).map(part => {
          const match = /^\{(\d+)\}$/.exec(part);
          if (!match) return escapeRegex(part);
          indices.push(Number(match[1])); return '([^·]+?)';
        });
        return { pattern: new RegExp(`^${parts.join('')}$`), indices, result };
      });
    compiledTemplates.set(locale.code, compiled);
  }
  return compiled;
}

/** Translate display text only. Never use this for IDs, simulation state or exported JSON. */
export function t(source: string, depth = 0): string {
  if (language === 'en' || depth > 6 || !source.trim()) return source;
  if (depth === 0 && translatedCache.has(source)) return translatedCache.get(source)!;
  const locale = localeOf(language);
  const text = source.trim();
  let translated: string | undefined = Object.hasOwn(locale.table, text) ? locale.table[text] : registeredNames.get(language)?.get(text);
  if (translated === undefined) {
    for (const entry of templatesFor(locale)) {
      const match = entry.pattern.exec(text);
      if (!match) continue;
      const values: string[] = [];
      entry.indices.forEach((index, i) => { values[index] = t(match[i + 1], depth + 1); });
      translated = entry.result.replace(/\{(\d+)\}/g, (_, index) => values[Number(index)]);
      break;
    }
  }
  if (translated === undefined && text.includes(' · ')) translated = text.split(' · ').map(part => t(part, depth + 1)).join(' · ');
  if (translated === undefined && /^\d+(?:\.\d+)?\s?h$/.test(text)) translated = text.replace(/\s?h$/, locale.hoursUnit);
  if (translated === undefined) translated = text.replace(/(\d+(?:\.\d+)?)°([EWNS])/g, (_, n, side: 'E' | 'W' | 'N' | 'S') => `${locale.compass[side]}${locale.compass.separator}${n}°`);
  const output = source.slice(0, source.indexOf(text)) + translated + source.slice(source.indexOf(text) + text.length);
  if (depth === 0) {
    if (translatedCache.size >= 2048) translatedCache.clear();
    translatedCache.set(source, output);
  }
  return output;
}

// Retain source text so switching languages never translates an already translated string.
const textSources = new WeakMap<Node, { source: string; output: string }>();
const attributeSources = new WeakMap<Element, Map<string, { source: string; output: string }>>();
const ATTRIBUTES = ['aria-label', 'aria-roledescription', 'title', 'placeholder', 'alt'];
function localizeText(node: Node): void {
  const current = node.textContent ?? '';
  const previous = textSources.get(node);
  const source = previous?.output === current ? previous.source : current;
  const output = t(source);
  if (current !== output) node.textContent = output;
  textSources.set(node, { source, output });
}
export function localizedText(source: string): Text {
  const node = document.createTextNode(source);
  localizeText(node);
  return node;
}
export function setText(node: Node, source: string | null): void {
  const text = source ?? '';
  const child = node.childNodes.length === 1 ? node.firstChild : null;
  if (child?.nodeType === Node.TEXT_NODE) {
    const output = t(text);
    if (child.textContent !== output) child.textContent = output;
    textSources.set(child, { source: text, output });
  } else { node.textContent = ''; node.appendChild(localizedText(text)); }
}
export function localizeTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) { localizeText(root); return; }
  if (root instanceof Element) {
    if (root.matches('script, style, textarea')) return;
    let stored = attributeSources.get(root);
    if (!stored) { stored = new Map(); attributeSources.set(root, stored); }
    for (const name of ATTRIBUTES) {
      const current = root.getAttribute(name);
      if (current === null) continue;
      const previous = stored.get(name);
      const source = previous?.output === current ? previous.source : current;
      const output = t(source);
      if (output !== current) root.setAttribute(name, output);
      stored.set(name, { source, output });
    }
  }
  for (const child of root.childNodes) localizeTree(child);
}

/** A place's display name: a locale-table entry first, then the Natural Earth name for the language, else English. */
export function cityLabel(city: { name: string; nameKo?: string | null; names?: LocalNames }): string {
  if (language === 'en') return city.name;
  const { table } = localeOf(language);
  if (Object.hasOwn(table, city.name)) return table[city.name];
  return (language === 'ko' ? city.nameKo : city.names?.[language]) || city.name;
}

/** Sea map, then table name for a language (for data that is not tied to the current language, such as sea labels); English if absent. */
export function localName(name: string, lang: Language): string {
  const { table, seas } = localeOf(lang);
  if (Object.hasOwn(seas, name)) return seas[name];
  return Object.hasOwn(table, name) ? table[name] : name;
}

/** A historic typhoon's display name: Korean uses its stored `nameKo`; other languages use the locale tables (English if absent). */
export function typhoonName(typhoon: { name: string; nameKo: string }): string {
  return language === 'ko' ? typhoon.nameKo : t(typhoon.name);
}
