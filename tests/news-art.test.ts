import { beforeAll, describe, expect, it } from 'vitest';
import type { NewsItem } from '../src/types';
import { PLANE_PATH } from '../src/render/transport-symbol';
import { WEATHER_HAZARDS, WEATHER_HAZARD_KINDS } from '../src/data/weather-hazards';

// jsdom is not installed; art.ts only needs createElementNS/setAttribute/append, so a tiny element tree stands in for the DOM.
class FakeElement {
  readonly nodeType = 1;
  readonly attrs = new Map<string, string>();
  readonly childNodes: FakeElement[] = [];
  constructor(readonly tagName: string) {}
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  append(...kids: FakeElement[]) { this.childNodes.push(...kids); }
  matches() { return false; }
  *walk(): Generator<FakeElement> { yield this; for (const kid of this.childNodes) yield* kid.walk(); }
}

type Kind = NewsItem['kind'];
const KINDS: Kind[] = ['formation', 'intensity', 'landfall', 'city', 'ended', 'merger', 'blizzard', 'recovery', 'info', 'transport', 'weather'];
let newsArt: (item: Pick<NewsItem, 'kind' | 'id' | 'cityId' | 'transport' | 'phenomenon'>) => FakeElement;

beforeAll(async () => {
  Object.assign(globalThis, { Node: { TEXT_NODE: 3 }, Element: FakeElement, document: { createElementNS: (_ns: string, tag: string) => new FakeElement(tag) } });
  newsArt = (await import('../src/ui/art')).newsArt as unknown as typeof newsArt;
});

const COLOUR = /^(none|var\(--color-[a-z0-9-]+\)|url\(#[\w-]+\))$/;
const ids = (svg: FakeElement) => [...svg.walk()].filter(e => e.tagName === 'linearGradient').map(e => e.getAttribute('id'));

describe('newsArt', () => {
  it.each(['crash', 'diversion', 'landing'] as const)('uses the map aircraft silhouette for %s news', event => {
    const svg = newsArt({ kind: 'transport', id: event, transport: {
      vehicleId: 'AIR-0', kind: 'planes', event, from: 'Seoul', to: 'Tokyo', windMs: 40, lossUsd: event === 'crash' ? 150_000_000 : 0,
    } });
    const nodes = [...svg.walk()];
    expect(nodes.filter(node => node.getAttribute('d') === PLANE_PATH)).toHaveLength(1);
    expect(nodes.find(node => node.tagName === 'g')?.getAttribute('transform')).toMatch(event === 'crash' ? /rotate\(125\)/ : /rotate\(65\)/);
  });

  it.each(WEATHER_HAZARD_KINDS)('uses the %s symbol for event and damage news', phenomenon => {
    for (const kind of ['weather', 'city'] as const) {
      const svg = newsArt({ kind, phenomenon, id: `${phenomenon}-damage` });
      expect([...svg.walk()].some(node => node.getAttribute('d') === WEATHER_HAZARDS[phenomenon].iconPath)).toBe(true);
    }
  });

  const cases: [Kind, string][] = [...KINDS.map(kind => [kind, `${kind}-1`] as [Kind, string]), ['city', 'city-a-gale'], ['city', 'city-a-0-5'], ['city', 'city-a-3-9']];

  it.each(cases)('%s (%s) is a 96x64 token-coloured svg with paths', (kind, id) => {
    const svg = newsArt({ kind, id, cityId: kind === 'city' ? 'a' : undefined });
    expect(svg.tagName).toBe('svg');
    expect(svg.getAttribute('viewBox')).toBe('0 0 96 64');
    expect(svg.getAttribute('class')).toBe(`art art--${kind}`);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    const nodes = [...svg.walk()];
    expect(nodes.some(e => e.tagName === 'path')).toBe(true);
    for (const e of nodes) for (const name of ['fill', 'stroke', 'stop-color']) {
      const value = e.getAttribute(name);
      if (value !== null) expect(value, `${e.tagName}[${name}]`).toMatch(COLOUR);
    }
  });

  it('gradient ids are unique within a card and across cards with different ids', () => {
    for (const kind of KINDS) {
      const a = ids(newsArt({ kind, id: 'item-a' }));
      const b = ids(newsArt({ kind, id: 'item-b' }));
      expect(new Set(a).size).toBe(a.length);
      expect(a.length).toBeGreaterThan(0);
      expect(a.filter(id => b.includes(id))).toEqual([]);
    }
  });

  it('every url(#id) reference resolves to a gradient in the same card', () => {
    for (const kind of KINDS) {
      const svg = newsArt({ kind, id: 'item-a' });
      const defined = new Set(ids(svg));
      for (const e of svg.walk()) {
        const ref = /^url\(#([\w-]+)\)$/.exec(e.getAttribute('fill') ?? '');
        if (ref) expect(defined.has(ref[1])).toBe(true);
      }
    }
  });
});
