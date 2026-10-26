import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SEAS, seaName } from '../src/data/seas';
import { FlatView } from '../src/render/view';
import { seaEligible, visibleSeas } from '../src/render/seas';
import { isLand } from '../src/simulation/engine';

const sources = (dir: string): string[] => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? sources(p) : /\.(ts|json|css)$/.test(f) ? [p] : [];
});

describe('seas data', () => {
  it('puts every anchor in the ocean and inside the map', () => {
    for (const s of SEAS) {
      expect(s.lon, s.name).toBeGreaterThanOrEqual(-180); expect(s.lon, s.name).toBeLessThanOrEqual(180);
      expect(s.lat, s.name).toBeGreaterThanOrEqual(-85); expect(s.lat, s.name).toBeLessThanOrEqual(85);
      expect(isLand(s.lon, s.lat), `${s.name} (${s.lon}, ${s.lat}) is on land`).toBe(false);
    }
  });

  it('never names the sea between Korea and Japan "Sea of Japan"', () => {
    const files = [...sources('src')].filter(f => !f.includes('generated'));
    for (const f of files) expect(/Sea of Japan/i.test(readFileSync(f, 'utf8')), f).toBe(false);
    const east = SEAS.find(s => s.name === 'East Sea');
    expect(east?.nameKo).toBe('동해');
    expect(seaName(east!, 'en')).toBe('East Sea');
    expect(seaName(east!, 'ko')).toBe('동해');
    for (const lang of ['ja', 'zh-CN', 'zh-TW'] as const) expect(seaName(east!, lang), lang).not.toBe('East Sea');
  });

  it('has at least five oceans', () => {
    expect(SEAS.filter(s => s.rank === 0).length).toBeGreaterThanOrEqual(5);
  });
});

describe('seas eligibility', () => {
  it('shows only oceans at world zoom', () => {
    const f = new FlatView(); f.resize(1440, 900);
    f.zoomAt(0.0001, 720, 450);
    expect(f.scale).toBe(f.minScale);
    const seas = visibleSeas(f, 'en');
    expect(seas.length).toBeGreaterThanOrEqual(5);
    expect(seas.every(s => s.rank === 0)).toBe(true);
  });

  it('includes marginal seas at 30 px/deg', () => {
    const zoom = Math.log2((30 * 360) / 256);
    expect(seaEligible(SEAS.find(s => s.name === 'Korea Strait')!, zoom)).toBe(true);
    expect(SEAS.filter(s => seaEligible(s, zoom)).some(s => s.rank === 2)).toBe(true);
  });
});
