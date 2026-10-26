import { afterEach, describe, expect, it } from 'vitest';
import { typhoonById } from '../src/data/typhoons';
import { setLanguage, t, typhoonName } from '../src/i18n';
import { STEP_HOURS, createGame, loadHistoric, stageFor, stepGame, totalWind, trackAt } from '../src/simulation/engine';
import { distanceKm, wrapLon } from '../src/simulation/geo';
import type { GameState } from '../src/types';

const START = 10; // hour of the running world at which typhoons are loaded
function stepTo(state: GameState, hours: number): void {
  while (state.hours < hours - 1e-9) stepGame(state);
}
function world(id: string): GameState {
  const s = createGame(1);
  stepTo(s, START);
  expect(loadHistoric(s, id)).toEqual({ ok: true });
  return s;
}
const hoursAt = (id: string, k: number) => {
  const pts = typhoonById(id)!.points;
  return (Date.parse(pts[k].t) - Date.parse(pts[0].t)) / 3_600_000;
};
/** East-minus-west north-south wind a little beyond the radius of maximum wind: positive for a counter-clockwise vortex, negative for a clockwise one. */
function spin(s: GameState): number {
  const storm = s.storms[0];
  const dLon = (1.5 * storm.radiusKm) / (111.32 * Math.cos((storm.lat * Math.PI) / 180));
  return totalWind(s, storm.lon + dLon, storm.lat).v - totalWind(s, storm.lon - dLon, storm.lat).v;
}

afterEach(() => setLanguage('en'));

describe('storms from outside East Asia in the engine', () => {
  it('Katrina (North Atlantic) starts at its first recorded point, west longitude, and rotates counter-clockwise', () => {
    const katrina = typhoonById('katrina-2005')!;
    const first = katrina.points[0];
    const s = world('katrina-2005');
    expect(first.lon).toBeLessThan(0);
    expect(s.storms[0]).toMatchObject({ name: 'Katrina', lat: first.lat, pressure: first.pressure });
    expect(s.storms[0].lon).toBeCloseTo(first.lon, 9);
    expect(s.news.at(-1)!.text).toContain('NOAA NHC HURDAT2');
    expect(s.news.at(-1)!.text).not.toContain('JMA');
    expect(spin(s)).toBeGreaterThan(1);
  });

  it('Katrina is named a Hurricane at its recorded peak', () => {
    const katrina = typhoonById('katrina-2005')!;
    const peak = katrina.points.findIndex(p => p.pressure === katrina.peakPressure);
    const s = world('katrina-2005');
    stepTo(s, START + hoursAt('katrina-2005', peak) + STEP_HOURS);
    expect(s.storms[0].stage).toMatch(/Hurricane/);
    expect(s.storms[0].stage).not.toMatch(/Typhoon/);
    expect(stageFor(40, -88, 28)).toBe('Hurricane');
    expect(stageFor(40, -105, 18)).toBe('Hurricane');
    expect(stageFor(40, 135, -8)).toBe('Cyclone');
    expect(stageFor(40, 65, 18)).toBe('Cyclone');
  });

  it('Tracy (south of the equator) follows the record and rotates clockwise', () => {
    const tracy = typhoonById('tracy-1974')!;
    const s = world('tracy-1974');
    expect(s.storms[0].lat).toBeLessThan(0);
    expect(s.storms[0]).toMatchObject({ name: 'Tracy', lat: tracy.points[0].lat });
    expect(s.storms[0].lon).toBeCloseTo(tracy.points[0].lon, 9);
    expect(s.news.at(-1)!.text).toContain('NOAA IBTrACS');
    expect(spin(s)).toBeLessThan(-1);
    stepTo(s, START + hoursAt('tracy-1974', 3));
    expect(Math.abs(s.storms[0].lat - tracy.points[3].lat)).toBeLessThan(0.05);
    expect(Math.abs(wrapLon(s.storms[0].lon - tracy.points[3].lon))).toBeLessThan(0.05);
    expect(s.storms[0].stage).toMatch(/Cyclone|Tropical/);
  });

  it('Winston crosses the date line without a jump', () => {
    const winston = typhoonById('winston-2016')!;
    const k = winston.points.findIndex((p, i) => i > 0 && Math.abs(p.lon - winston.points[i - 1].lon) > 180);
    expect(k).toBeGreaterThan(0);
    const a = winston.points[k - 1];
    const b = winston.points[k];
    const mid = trackAt(winston, (hoursAt('winston-2016', k - 1) + hoursAt('winston-2016', k)) / 2)!;
    expect(Math.abs(mid.lon)).toBeGreaterThan(170);
    expect(distanceKm(mid.lon, mid.lat, a.lon, a.lat)).toBeLessThan(distanceKm(a.lon, a.lat, b.lon, b.lat));
  });

  it('translates the load news of an NHC storm in every language, naming its agency and Korean name', () => {
    const news = world('katrina-2005').news.at(-1)!;
    expect(typhoonName(typhoonById('katrina-2005')!)).toBe('Katrina');
    for (const lang of ['ko', 'ja', 'zh-CN', 'zh-TW'] as const) {
      setLanguage(lang);
      const text = t(news.text);
      expect(text, lang).not.toContain('{');
      expect(text.replace(/NOAA|NHC|HURDAT2/g, ''), lang).not.toMatch(/[A-Za-z]{3,}/);
      expect(t(news.title), lang).not.toBe(news.title);
    }
    setLanguage('ko');
    expect(typhoonName(typhoonById('katrina-2005')!)).toBe('카트리나');
  });
});
