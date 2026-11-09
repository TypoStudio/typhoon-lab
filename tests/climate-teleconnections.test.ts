import { describe, expect, it } from 'vitest';
import { TELE_COLS, TELE_ROWS, teleconnectionInto } from '../src/data/climate-teleconnections';

type Out = { slp: Float32Array; air: Float32Array; rhum: Float32Array; shear: Float32Array };
const make = (): Out => ({
  slp: new Float32Array(TELE_COLS * TELE_ROWS),
  air: new Float32Array(TELE_COLS * TELE_ROWS),
  rhum: new Float32Array(TELE_COLS * TELE_ROWS),
  shear: new Float32Array(TELE_COLS * TELE_ROWS),
});
const idx = (lat: number, lon: number) => Math.floor((lat + 90) / 5) * TELE_COLS + Math.floor((lon + 180) / 5);

// mean over 5 degree cells whose centres lie inside the box (south, north, west, east)
function boxMean(a: Float32Array, lat0: number, lat1: number, lon0: number, lon1: number): number {
  let sum = 0;
  let n = 0;
  for (let lat = lat0 + 2.5; lat < lat1; lat += 5) {
    for (let lon = lon0 + 2.5; lon < lon1; lon += 5) {
      sum += a[idx(lat, lon)];
      n++;
    }
  }
  return sum / n;
}

const JAN = 0.5;
const JUL = 6.5;
const djf = make();
const jja = make();
const son = make();
teleconnectionInto(JAN, djf);
teleconnectionInto(JUL, jja);
teleconnectionInto(9.5, son);

describe('ENSO teleconnection regression maps', () => {
  it('has the 72x36 grid', () => {
    expect([TELE_COLS, TELE_ROWS]).toEqual([72, 36]);
  });

  it('DJF SLP is negative in the Aleutian low (45N 165W)', () => {
    const v = djf.slp[idx(45, -165)];
    expect(v, `slp(45N,165W)=${v}`).toBeLessThan(-1);
  });

  it('DJF SLP seesaw: positive at Darwin, negative at Tahiti', () => {
    const darwin = djf.slp[idx(-12, 130)];
    const tahiti = djf.slp[idx(-17, -150)];
    expect(darwin, `darwin=${darwin}`).toBeGreaterThan(0);
    expect(tahiti, `tahiti=${tahiti}`).toBeLessThan(0);
  });

  it('DJF air is warmer over western Canada/Alaska', () => {
    // the single 5 degree box at 55N 120W is below the |r| threshold, so check the region (50-60N, 150W-120W)
    let sum = 0;
    let n = 0;
    for (let lat = 52.5; lat <= 57.5; lat += 5) {
      for (let lon = -147.5; lon <= -122.5; lon += 5) {
        sum += djf.air[idx(lat, lon)];
        n++;
      }
    }
    const mean = sum / n;
    expect(mean, `mean air 52.5-57.5N 147.5-122.5W=${mean}, 55N 120W=${djf.air[idx(55, -120)]}`).toBeGreaterThan(0.3);
    expect(djf.air[idx(55, -120)]).toBeGreaterThanOrEqual(0);
  });

  it('JJA monsoon: humidity not rising over India', () => {
    const n = jja.rhum[idx(20, 78)];
    const s = jja.rhum[idx(15, 78)];
    expect(n, `rhum(20N,78E)=${n}`).toBeLessThanOrEqual(0);
    expect(s, `rhum(15N,78E)=${s}`).toBeLessThan(0);
  });

  it('DJF humidity is not positive over northern Australia', () => {
    const c = djf.rhum[idx(-15, 135)];
    const w = djf.rhum[idx(-15, 130)];
    expect(c, `rhum(15S,135E)=${c}`).toBeLessThanOrEqual(0);
    expect(w, `rhum(15S,130E)=${w}`).toBeLessThan(0);
  });

  it('200-850 hPa shear rises over the tropical North Atlantic and does not rise in the east Pacific', () => {
    const mdrJ = boxMean(jja.shear, 10, 20, -60, -30);
    const mdrS = boxMean(son.shear, 10, 20, -60, -30);
    const epJ = boxMean(jja.shear, 10, 15, -140, -110);
    const epS = boxMean(son.shear, 10, 15, -140, -110);
    expect(mdrJ, `MDR shear JJA=${mdrJ} SON=${mdrS}`).toBeGreaterThan(0);
    expect(mdrS, `MDR shear JJA=${mdrJ} SON=${mdrS}`).toBeGreaterThan(0);
    expect((epJ + epS) / 2, `east Pacific shear JJA=${epJ} SON=${epS}`).toBeLessThanOrEqual(0.05);
  });

  it('reports the western North Pacific shear pattern', () => {
    const v = {
      'JJA 5-15N 150-170E': boxMean(jja.shear, 5, 15, 150, 170),
      'JJA 20-30N 120-140E': boxMean(jja.shear, 20, 30, 120, 140),
      'SON 5-15N 150-170E': boxMean(son.shear, 5, 15, 150, 170),
      'SON 20-30N 120-140E': boxMean(son.shear, 20, 30, 120, 140),
    };
    console.info('WNP shear slope (m/s per degC)', v);
    for (const x of Object.values(v)) expect(Number.isFinite(x)).toBe(true);
  });

  it('interpolates continuously, cyclically and exactly at season centres', () => {
    const a = make();
    const b = make();
    const oct = make();
    teleconnectionInto(9.5, oct);
    teleconnectionInto(12.5, a);
    expect(Array.from(a.slp)).toEqual(Array.from(djf.slp));
    teleconnectionInto(0.5, b);
    teleconnectionInto(0.5 + 12, a);
    expect(Array.from(a.air)).toEqual(Array.from(b.air));
    // 11.0 lies between Oct and Jan centres: value between the two at the Aleutian box
    teleconnectionInto(11, a);
    const i = idx(45, -165);
    const lo = Math.min(oct.slp[i], djf.slp[i]);
    const hi = Math.max(oct.slp[i], djf.slp[i]);
    expect(a.slp[i]).toBeGreaterThanOrEqual(lo - 1e-6);
    expect(a.slp[i]).toBeLessThanOrEqual(hi + 1e-6);
    // small steps change little
    let maxJump = 0;
    let prev = make();
    teleconnectionInto(0, prev);
    const cur = make();
    for (let m = 0.05; m <= 12.0001; m += 0.05) {
      teleconnectionInto(m, cur);
      for (let k = 0; k < cur.slp.length; k++) maxJump = Math.max(maxJump, Math.abs(cur.slp[k] - prev.slp[k]));
      prev.slp.set(cur.slp);
    }
    expect(maxJump, `max slp jump per 0.05 month=${maxJump}`).toBeLessThan(0.1);
  });

  it('works without a shear array', () => {
    const { shear: _s, ...o } = make();
    expect(() => teleconnectionInto(3, o)).not.toThrow();
  });

  it('fills every cell with finite values, including negative months', () => {
    for (const m of [0, 3.3, 11.99, 12, -1.5, 25.25]) {
      const o = make();
      teleconnectionInto(m, o);
      for (const arr of [o.slp, o.air, o.rhum, o.shear]) for (const v of arr) expect(Number.isFinite(v)).toBe(true);
    }
    expect(Math.abs(djf.rhum[idx(-15, 130)])).toBeLessThan(0.1); // fraction, not percent
  });
});
