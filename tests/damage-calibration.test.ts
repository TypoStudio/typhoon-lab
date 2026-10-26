import { describe, expect, it } from 'vitest';
import { CITIES } from '../src/data/world';
import { createGame, loadHistoric, stepGame } from '../src/simulation/engine';
import { estimateCityDamage } from '../src/simulation/damage-news';
import { KRW_PER_USD } from '../src/ui/dom';

/** Replays each recorded typhoon alone and sums city damage as `renderDefense` does. */
function run(id: string) {
  const s = createGame(1);
  expect(loadHistoric(s, id)).toEqual({ ok: true });
  while (!s.historic.every(h => h.finished) && s.tick < 400_000) stepGame(s);
  const t = s.cities.reduce((sum, impact, i) => {
    const r = estimateCityDamage(CITIES[i], impact);
    sum.displaced += r.displaced; sum.missing += r.missing; sum.deaths += r.deaths;
    sum.flooded += r.floodedHomes; sum.lossUsd += r.lossUsd;
    return sum;
  }, { displaced: 0, missing: 0, deaths: 0, flooded: 0, lossUsd: 0 });
  return t;
}

/** Public-record references (approximate). Maemi 2003 is the anchor (+-40%); the others are order-of-magnitude checks:
 * the impact cities are Natural Earth places of 500,000+ people (about 1,000), so a storm that misses or overloads them can be off by a wide margin.
 * Rusa 2002: ~5.1 trillion KRW (~USD 3.8 B), 246 dead/missing, ~88,000 displaced (the track mostly misses our cities).
 * Hinnamnor 2022: ~1.7-2.4 trillion KRW (~USD 1.3-1.8 B), 11-12 dead, ~1,900 displaced.
 * Haiyan 2013: ~USD 2.9 B, 6,300 dead, ~4 M displaced (few Philippine cities here).
 * Tip 1979 (Japan): ~USD 0.5-1 B (our Japanese cities carry today's populations, so it reads high).
 */
const CASES = [
  { id: 'maemi-2003', ref: 'USD 3.5-4.5 B; 117 dead + 14 missing; ~61,000 displaced; ~40,000 homes', lossB: [2.5, 6.3], displaced: [37_000, 85_000], dead: [74, 183], flooded: [24_000, 56_000] },
  { id: 'rusa-2002', ref: 'USD ~3.8 B; 246 dead/missing; ~88,000 displaced', lossB: [0.02, 2], displaced: [300, 30_000], dead: [0, 60], flooded: [300, 20_000] },
  { id: 'hinnamnor-2022', ref: 'USD ~1.3-1.8 B; 11-12 dead; ~1,900 displaced', lossB: [0.4, 5], displaced: [5_000, 60_000], dead: [10, 100], flooded: [3_000, 40_000] },
  { id: 'haiyan-2013', ref: 'USD ~2.9 B; 6,300 dead; ~4 M displaced', lossB: [1, 9], displaced: [20_000, 150_000], dead: [30, 300], flooded: [10_000, 100_000] },
  { id: 'tip-1979', ref: 'USD ~0.5-1 B', lossB: [0.3, 15], displaced: [20_000, 300_000], dead: [30, 600], flooded: [10_000, 200_000] },
] as const;

describe('damage estimates calibrated against recorded typhoons', () => {
  it('stays within the record-based ranges and prints the table', () => {
    const rows: Record<string, unknown>[] = [];
    for (const c of CASES) {
      const t = run(c.id);
      rows.push({ id: c.id, lossUsdB: +(t.lossUsd / 1e9).toFixed(2), lossKrwTril: +(t.lossUsd * KRW_PER_USD / 1e12).toFixed(2), displaced: t.displaced, missing: t.missing, deaths: t.deaths, flooded: t.flooded, reference: c.ref });
      expect(t.lossUsd / 1e9, `${c.id} loss`).toBeGreaterThanOrEqual(c.lossB[0]);
      expect(t.lossUsd / 1e9, `${c.id} loss`).toBeLessThanOrEqual(c.lossB[1]);
      expect(t.displaced, `${c.id} displaced`).toBeGreaterThanOrEqual(c.displaced[0]);
      expect(t.displaced, `${c.id} displaced`).toBeLessThanOrEqual(c.displaced[1]);
      expect(t.deaths + t.missing, `${c.id} dead/missing`).toBeGreaterThanOrEqual(c.dead[0]);
      expect(t.deaths + t.missing, `${c.id} dead/missing`).toBeLessThanOrEqual(c.dead[1]);
      expect(t.flooded, `${c.id} flooded`).toBeGreaterThanOrEqual(c.flooded[0]);
      expect(t.flooded, `${c.id} flooded`).toBeLessThanOrEqual(c.flooded[1]);
    }
    console.table(rows);
  }, 300_000);
});
