import { describe, expect, test } from 'vitest';
import {
  addSstPatch,
  addThermoclinePulse,
  addWesterlyBurst,
  climateFields,
  climateIndices,
  createClimate,
  expectedBurst,
  restoreClimate,
  serializeClimate,
  setSstHold,
  setTradeWindAnomaly,
  stepClimateDay,
  type ClimateState,
} from '../src/simulation/climate-core';
import observed from './fixtures/enso-observed.json';

// ---- statistics helpers ----
const mean = (x: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i]; return s / x.length; };
const std = (x: ArrayLike<number>): number => { const m = mean(x); let s = 0; for (let i = 0; i < x.length; i++) s += (x[i] - m) ** 2; return Math.sqrt(s / x.length); };
function corr(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const mx = mean(x), my = mean(y);
  let a = 0, b = 0, c = 0;
  for (let i = 0; i < x.length; i++) { a += (x[i] - mx) * (y[i] - my); b += (x[i] - mx) ** 2; c += (y[i] - my) ** 2; }
  return a / Math.sqrt(b * c);
}
function skewness(x: number[]): number { const m = mean(x), sd = std(x); let a = 0; for (const v of x) a += ((v - m) / sd) ** 3; return a / x.length; }
/** Peak Nino 3.4 of each warm (>= +0.5) and cold (<= -0.5) excursion of a monthly series. */
function eventPeaks(x: number[]): { warm: number[]; cold: number[] } {
  const warm: number[] = [], cold: number[] = [];
  let run = 0, ext = 0;
  for (const v of x) {
    const sign = v >= 0.5 ? 1 : v <= -0.5 ? -1 : 0;
    if (sign !== run) { if (run === 1) warm.push(ext); if (run === -1) cold.push(ext); run = sign; ext = v; }
    else if (sign === 1) ext = Math.max(ext, v);
    else if (sign === -1) ext = Math.min(ext, v);
  }
  return { warm, cold };
}
/** Smoothed (7-point) raw periodogram of a monthly series: dominant period (years, 1..20) and variance share in the 1.5-8 yr band. */
function spectrum(x: number[]): { peakYears: number; bandShare: number } {
  const n = x.length, m = mean(x);
  const power: number[] = [];
  for (let k = 1; k <= n / 2; k++) {
    let re = 0, im = 0;
    for (let t = 0; t < n; t++) { const a = (2 * Math.PI * k * t) / n; re += (x[t] - m) * Math.cos(a); im += (x[t] - m) * Math.sin(a); }
    power[k] = re * re + im * im;
  }
  const smooth: number[] = [];
  for (let k = 1; k <= n / 2; k++) {
    let a = 0, c = 0;
    for (let d = -3; d <= 3; d++) if (power[k + d] !== undefined) { a += power[k + d]; c++; }
    smooth[k] = a / c;
  }
  let best = 1, total = 0, band = 0;
  for (let k = 1; k <= n / 2; k++) {
    const years = n / k / 12;
    if (years <= 20 && smooth[k] > smooth[best]) best = k;
    total += power[k];
    if (years >= 1.5 && years <= 8) band += power[k];
  }
  return { peakYears: n / best / 12, bandShare: band / total };
}

// ---- long runs ----
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
interface Monthly { nino34: number[]; soi: number[]; wwv: number[] }
/** Calendar-month means of the daily indices (365-day years starting 1 Jan). */
function simulate(seed: number, years: number): Monthly {
  const s = createClimate(seed, 1, 2000);
  const out: Monthly = { nino34: [], soi: [], wwv: [] };
  let a = 0, b = 0, c = 0, n = 0, month = 0, day = 0;
  for (let d = 0; d < years * 365; d++) {
    stepClimateDay(s);
    const i = climateIndices(s);
    a += i.nino34; b += i.soi; c += i.wwv; n++;
    if (++day === MONTH_DAYS[month]) {
      out.nino34.push(a / n); out.soi.push(b / n); out.wwv.push(c / n);
      a = b = c = n = day = 0; month = (month + 1) % 12;
    }
  }
  return out;
}
/** Share of local maxima of |x| above 1 sigma that fall in Nov-Feb (month index t % 12 in {10, 11, 0, 1}). */
function winterShare(x: number[], sd: number): number {
  let events = 0, winter = 0;
  for (let i = 1; i < x.length - 1; i++) {
    const a = Math.abs(x[i]);
    if (a > sd && a >= Math.abs(x[i - 1]) && a > Math.abs(x[i + 1])) { events++; const m = i % 12; if (m >= 10 || m <= 1) winter++; }
  }
  return winter / Math.max(events, 1);
}
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const YEARS = 200;
interface SeedStats { sd: number; maxWindow: number; peakYears: number; bandShare: number; soiCorr: number; winter: number; lag: number; lagCorr: number; dCorr: number; skew: number; warm: number[]; cold: number[]; finite: boolean }
let cached: SeedStats[] | null = null;
function allSeeds(): SeedStats[] {
  return (cached ??= SEEDS.map((seed) => {
    const { nino34: x, soi, wwv } = simulate(seed, YEARS);
    const sd = std(x), sp = spectrum(x);
    let maxWindow = 0;
    for (let w = 0; w + 240 <= x.length; w += 240) maxWindow = Math.max(maxWindow, Math.abs(mean(x.slice(w, w + 240))));
    let lag = 0, lagCorr = -2;
    for (let L = 0; L <= 24; L++) { const r = corr(wwv.slice(0, x.length - L), x.slice(L)); if (r > lagCorr) { lagCorr = r; lag = L; } }
    const dN = x.slice(2).map((v, i) => (v - x[i]) / 2);
    const { warm, cold } = eventPeaks(x);
    return { sd, maxWindow, peakYears: sp.peakYears, bandShare: sp.bandShare, soiCorr: corr(x, soi), winter: winterShare(x, sd), lag, lagCorr, dCorr: corr(wwv.slice(1, x.length - 1), dN), skew: skewness(x), warm, cold, finite: x.every(Number.isFinite) };
  }));
}
const count = (rows: SeedStats[], f: (r: SeedStats) => boolean): number => rows.filter(f).length;

const obs = observed.nino34;
const obsSd = std(obs);
const obsSpec = spectrum(obs);
const obsWinter = winterShare(obs, obsSd);
const obsSkew = skewness(obs);
const obsEvents = eventPeaks(obs);
const BIG = 2; // degC, Nino 3.4 peak of a "big" El Nino

describe('ENSO climate core: free-running statistics (20 seeds x 200 yr)', () => {
  // 4000 simulated years plus 20 periodograms take ~10 s; the first test pays for it, so give it headroom.
  test('table', () => {
    const rows = allSeeds();
    console.log('seed   sd  maxWin  peak(yr) band  corr(soi) winter  lag(mo) r(lag) corr(wwv,dN)  skew  big/century  warm  cold');
    rows.forEach((r, i) => console.log(`${String(SEEDS[i]).padStart(4)} ${r.sd.toFixed(2)}  ${r.maxWindow.toFixed(2)}   ${r.peakYears.toFixed(1).padStart(6)}   ${r.bandShare.toFixed(2)}  ${r.soiCorr.toFixed(2).padStart(7)}  ${r.winter.toFixed(2)}   ${String(r.lag).padStart(6)}  ${r.lagCorr.toFixed(2)}  ${r.dCorr.toFixed(2)}  ${r.skew.toFixed(2).padStart(5)}  ${((r.warm.filter((v) => v >= BIG).length / YEARS) * 100).toFixed(1).padStart(6)}  ${mean(r.warm).toFixed(2)} ${mean(r.cold).toFixed(2)}`));
    console.log(`observed: sd ${obsSd.toFixed(2)}, peak ${obsSpec.peakYears.toFixed(1)} yr, band share ${obsSpec.bandShare.toFixed(2)}, winter share ${obsWinter.toFixed(2)}, skewness ${obsSkew.toFixed(2)}, big events ${((obsEvents.warm.filter((v) => v >= BIG).length / (obs.length / 12)) * 100).toFixed(1)}/century, warm ${mean(obsEvents.warm).toFixed(2)}, cold ${mean(obsEvents.cold).toFixed(2)}`);
  }, 120_000);

  test('1. no drift; std near observed on >= 18/20 seeds', () => {
    const rows = allSeeds();
    expect(rows.every((r) => r.finite)).toBe(true);
    expect(rows.every((r) => r.maxWindow < 0.3)).toBe(true);
    expect(count(rows, (r) => r.sd >= 0.7 && r.sd <= 1.1)).toBeGreaterThanOrEqual(18);
  });

  test('2. spontaneous 2-7 yr variability on >= 18/20 seeds', () => {
    expect(count(allSeeds(), (r) => r.peakYears >= 2 && r.peakYears <= 7 && r.bandShare >= 0.45)).toBeGreaterThanOrEqual(18);
  });

  test('3. SOI is anticorrelated with Nino 3.4 on every seed', () => {
    expect(allSeeds().every((r) => r.soiCorr < -0.6)).toBe(true);
  });

  test('4. events phase-lock to boreal winter', () => {
    const w = allSeeds().map((r) => r.winter).sort((a, b) => a - b);
    expect(w[Math.floor(w.length / 2)]).toBeGreaterThanOrEqual(0.55);
    expect(count(allSeeds(), (r) => r.winter >= 0.45)).toBeGreaterThanOrEqual(18);
  });

  test('5. recharge: warm water volume leads Nino 3.4 by 4-12 months on >= 18/20 seeds', () => {
    const rows = allSeeds();
    expect(count(rows, (r) => r.lag >= 4 && r.lag <= 12 && r.lagCorr > 0.4)).toBeGreaterThanOrEqual(18);
    expect(count(rows, (r) => r.dCorr > 0)).toBeGreaterThanOrEqual(18);
  });

  test('5b. positive skewness on >= 16/20 seeds', () => {
    expect(count(allSeeds(), (r) => r.skew > 0)).toBeGreaterThanOrEqual(16);
  });

  test('5c. big El Ninos exist; La Nina minima are smaller in magnitude than El Nino maxima', () => {
    const rows = allSeeds();
    const warm = rows.flatMap((r) => r.warm), cold = rows.flatMap((r) => r.cold);
    const big = warm.filter((v) => v >= BIG).length;
    console.log(`[5c] big El Ninos (>= ${BIG} C): ${((big / (SEEDS.length * YEARS)) * 100).toFixed(1)}/century; mean warm peak ${mean(warm).toFixed(2)}, mean cold peak ${mean(cold).toFixed(2)}`);
    expect(big).toBeGreaterThan(0);
    expect(mean(warm)).toBeGreaterThan(-mean(cold));
  });
});

const cellOf = (lonEast: number): number => (lonEast - 120) / 2.5 - 0.5; // fractional ocean cell index
const hAt = (s: ClimateState, lonEast: number): number => {
  const f = cellOf(lonEast), j = Math.floor(f), w = f - j;
  return (s.K[j] + s.R[j]) * (1 - w) + (s.K[j + 1] + s.R[j + 1]) * w;
};

describe('causal chain (noise off)', () => {
  test('6a. westerly burst at 160E sends a downwelling Kelvin wave east, then Nino 3 warms', () => {
    const s = createClimate(1, 1, 2000, false);
    expect(addWesterlyBurst(s, { lonEast: 160, speed: 8, days: 10 })).toBe(true);
    let peakDay = 0, peak = -Infinity;
    const nino3: number[] = [];
    for (let d = 0; d < 200; d++) {
      stepClimateDay(s);
      const h = hAt(s, 250);
      if (d < 140 && h > peak) { peak = h; peakDay = d + 1; } // direct wave, before the reflected one
      nino3.push(climateIndices(s).nino3);
    }
    const before = nino3[Math.max(0, peakDay - 40)];
    const after = Math.max(...nino3.slice(peakDay, peakDay + 60));
    console.log(`[6a] h peak ${peak.toFixed(2)} m reaches 110W on day ${peakDay}; nino3 ${before.toFixed(3)} (day ${peakDay - 40}) -> ${after.toFixed(3)} within 60 d after arrival`);
    expect(peak).toBeGreaterThan(1);
    // 90 deg of Kelvin propagation (10000 km) at c >= 2.2 m/s takes 40-53 days, plus the burst's duration and wave-front spreading.
    expect(peakDay).toBeGreaterThanOrEqual(40);
    expect(peakDay).toBeLessThanOrEqual(70);
    expect(after).toBeGreaterThan(before + 0.1);
  });

  test('6b. stronger trade winds cool the east (La Nina sign)', () => {
    const s = createClimate(1, 1, 2000, false);
    expect(setTradeWindAnomaly(s, 2)).toBe(true);
    let min34 = Infinity, min3 = Infinity, h110 = 0;
    for (let d = 0; d < 150; d++) { // before the Rossby wave reflected at the west wall returns
      stepClimateDay(s);
      const i = climateIndices(s);
      min34 = Math.min(min34, i.nino34); min3 = Math.min(min3, i.nino3);
      if (d === 59) h110 = hAt(s, 250);
    }
    console.log(`[6b] +2 m/s trades: min nino34 ${min34.toFixed(2)}, min nino3 ${min3.toFixed(2)}, h(110W) at day 60 ${h110.toFixed(1)} m`);
    expect(h110).toBeLessThan(-1);
    expect(min3).toBeLessThan(-0.3);
    expect(min34).toBeLessThan(-0.3);
  });
});

describe('deterministic part', () => {
  const warmStart = (amp: number): ClimateState => {
    const s = createClimate(1, 1, 2000, false);
    for (let j = 0; j < 64; j++) { const lon = 121.25 + 2.5 * j; if (lon >= 170 && lon <= 260) s.T[j] = amp; }
    return s;
  };
  test('6c. the noise-free model decays, with bursts off and with bursts replaced by their expected wind', () => {
    for (const amp of [0.5, 2.5]) {
      const off = warmStart(amp), mean = warmStart(amp), zero = createClimate(1, 1, 2000, false);
      let offMax = 0, meanMax = 0;
      for (let y = 0; y < 40; y++) {
        offMax = 0; meanMax = 0;
        for (let d = 0; d < 365; d++) {
          stepClimateDay(off); offMax = Math.max(offMax, Math.abs(climateIndices(off).nino34));
          zero.day = mean.day;
          const b = expectedBurst(mean), b0 = expectedBurst(zero);
          addWesterlyBurst(mean, { lonEast: b.lonEast, speed: b.speed, days: 1 });
          addWesterlyBurst(mean, { lonEast: b0.lonEast, speed: -b0.speed, days: 1 });
          stepClimateDay(mean); meanMax = Math.max(meanMax, Math.abs(climateIndices(mean).nino34));
        }
      }
      console.log(`[6c] initial ${amp} C over 170E-100W: max |Nino 3.4| in year 40: bursts off ${offMax.toFixed(3)}, bursts replaced by expectation ${meanMax.toFixed(3)}`);
      expect(offMax).toBeLessThan(0.1);
      expect(meanMax).toBeLessThan(0.1);
    }
  });
});

describe('Gill atmosphere signs', () => {
  test('equatorial heating: low pressure, easterlies east, westerlies west, convergence', () => {
    const s = createClimate(1, 1, 2000, false);
    for (let j = 0; j < 64; j++) { const lon = 121.25 + 2.5 * j; if (lon >= 190 && lon <= 220) s.T[j] = 2; }
    const f = climateFields(s);
    const at = (a: Float32Array, lonEast: number, row: number): number => a[row * 72 + (((Math.round((lonEast - 182.5) / 5) % 72) + 72) % 72)];
    const eq = 18; // 2.5N
    expect(at(f.slp, 205, eq)).toBeLessThan(-0.5);
    expect(at(f.precip, 205, eq)).toBeGreaterThan(0);
    expect(at(f.u, 250, eq)).toBeLessThan(-0.2);
    expect(at(f.u, 150, eq)).toBeGreaterThan(0.2);
    // convergence over the heating: du/dx + dv/dy < 0 (m/s per m)
    const dx = 5 * 111.32e3;
    const dudx = (at(f.u, 210, eq) - at(f.u, 200, eq)) / (2 * dx);
    const dvdy = (at(f.v, 205, eq) - at(f.v, 205, eq - 1)) / (5 * 110.57e3);
    expect(dudx + dvdy).toBeLessThan(0);
    // 1 C in Nino 3.4 -> order 1 m/s of equatorial wind
    const t = createClimate(1, 1, 2000, false);
    for (let j = 0; j < 64; j++) { const lon = 121.25 + 2.5 * j; if (lon >= 190 && lon <= 240) t.T[j] = 1; }
    const g = climateFields(t);
    let umax = 0;
    for (let c = 0; c < 72; c++) umax = Math.max(umax, Math.abs(g.u[eq * 72 + c]));
    console.log(`[gill] 1 C over Nino 3.4 -> max |u| ${umax.toFixed(2)} m/s, slp(205E) ${at(g.slp, 205, eq).toFixed(2)} hPa`);
    expect(umax).toBeGreaterThan(0.8);
    expect(umax).toBeLessThan(1.8);
  });
});

describe('1997-98 hindcast (noise off)', () => {
  // Westerly-burst sequence of 1997 (approximate timing and strength), after McPhaden (1999, Science 283, 950-954):
  // late Dec 1996-Jan, early Mar, May-Jun (three strong events near 145-165E), plus the smaller Jul-Aug events.
  const bursts = [
    { day: 1, lonEast: 150, speed: 6, days: 12 },
    { day: 58, lonEast: 155, speed: 7, days: 15 },
    { day: 125, lonEast: 160, speed: 8, days: 20 },
    { day: 165, lonEast: 165, speed: 6, days: 12 },
  ];
  const lons = observed.profileLonsEast;
  const mask = lons.map((l) => l >= 210 && l <= 270);
  const n3 = (p: ArrayLike<number>): number => mean(Array.from(p).filter((_, i) => mask[i]));
  /** DJF 1997/98 equatorial SST profile (days 335..425) from an initial zonal-mean thermocline anomaly of `h` metres. */
  function hindcast(h: number): Float64Array {
    const model = new Float64Array(lons.length);
    const t = createClimate(1, 1, 1997, false);
    t.K.fill(h / 2); t.R.fill(h / 2);
    for (let d = 0; d < 425; d++) {
      for (const b of bursts) if (b.day === t.day + 1) addWesterlyBurst(t, b);
      stepClimateDay(t);
      if (d >= 334) {
        for (let i = 0; i < lons.length; i++) {
          const f = Math.min(62.999, Math.max(0, cellOf(lons[i]))), j = Math.floor(f), w = f - j;
          model[i] += (t.T[j] * (1 - w) + t.T[j + 1] * w) / 91;
        }
      }
    }
    return model;
  }

  test('7. the 1997 bursts on a recharged ocean give a large, realistically shaped El Nino; on a discharged ocean at most half', () => {
    const model = hindcast(10), discharged = hindcast(-10);
    const obsProfile = observed.equatorProfiles['DJF 1997/98'];
    const pattern = corr(model, obsProfile);
    console.log(`[7] recharged: pattern corr ${pattern.toFixed(2)}, Nino-3 model ${n3(model).toFixed(2)} vs observed ${n3(obsProfile).toFixed(2)}, 160E ${model[lons.indexOf(160)].toFixed(2)}; discharged: Nino-3 ${n3(discharged).toFixed(2)}`);
    console.log('[7] lon  model  observed\n' + lons.map((l, i) => `    ${l}E  ${model[i].toFixed(2).padStart(5)}  ${obsProfile[i].toFixed(2).padStart(5)}`).join('\n'));
    expect(n3(model)).toBeGreaterThanOrEqual(1.5);
    expect(pattern).toBeGreaterThanOrEqual(0.7);
    expect(model[lons.indexOf(160)]).toBeLessThanOrEqual(0); // western cooling
    expect(n3(discharged)).toBeLessThanOrEqual(0.5 * n3(model)); // recharge state matters
  });
});

// ---- twin experiments: same seed, so both members share every random draw and differ only through physics ----
type Patch = Parameters<typeof addSstPatch>[1];
interface Twin {
  /** perturbed - control daily differences of the indices, index = day - 1 after the patch is applied. */
  dn3: number[]; dn34: number[]; dsoi: number[]; dh110: number[]; dwwv: number[];
  extraBursts: number;
  /** perturbed - control stochastic bursts spawned up to the given day. */
  burstsBy: Map<number, number>;
  /** perturbed - control fields on the requested days. */
  fields: Map<number, { sst: number[]; slp: number[]; u: number[]; v: number[]; precip: number[] }>;
  /** Control Nino 3 on each day (for the discharge check). */
  n3: number[];
}
const SPIN_YEARS = 8;
const APR_1 = 91; // day of year: events are started before the boreal-summer growth season
/** Spins a free run up, then advances to the next 1 April with a neutral Nino 3.4 (|.| < 0.4). */
function neutralState(seed: number): ClimateState {
  const s = createClimate(seed, 1, 2000);
  for (let d = 0; d < SPIN_YEARS * 365; d++) stepClimateDay(s);
  for (let d = 0; d < 60 * 365; d++) {
    if ((s.startDayOfYear - 1 + s.day) % 365 === APR_1 - 1 && Math.abs(climateIndices(s).nino34) < 0.4) return s;
    stepClimateDay(s);
  }
  throw new Error(`no neutral 1 April within 60 years for seed ${seed}`);
}
function runTwin(seed: number, patch: Patch, days: number, fieldDays: number[] = []): Twin {
  const control = neutralState(seed);
  const perturbed = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(control))))!;
  const b0 = control.burstCount;
  expect(addSstPatch(perturbed, patch)).toBe(true);
  const out: Twin = { dn3: [], dn34: [], dsoi: [], dh110: [], dwwv: [], n3: [], extraBursts: 0, burstsBy: new Map(), fields: new Map() };
  for (let d = 1; d <= days; d++) {
    stepClimateDay(control); stepClimateDay(perturbed);
    const c = climateIndices(control), p = climateIndices(perturbed);
    out.dn3.push(p.nino3 - c.nino3); out.dn34.push(p.nino34 - c.nino34); out.dsoi.push(p.soi - c.soi); out.dh110.push(hAt(perturbed, 250) - hAt(control, 250)); out.dwwv.push(p.wwv - c.wwv); out.n3.push(c.nino3);
    out.burstsBy.set(d, perturbed.burstCount - control.burstCount);
    if (fieldDays.includes(d)) {
      const fc = climateFields(control), fp = climateFields(perturbed);
      const diff = (a: Float32Array, b: Float32Array): number[] => Array.from(a, (v, i) => v - b[i]);
      out.fields.set(d, { sst: diff(fp.sst, fc.sst), slp: diff(fp.slp, fc.slp), u: diff(fp.u, fc.u), v: diff(fp.v, fc.v), precip: diff(fp.precip, fc.precip) });
    }
  }
  out.extraBursts = perturbed.burstCount - b0 - (control.burstCount - b0);
  return out;
}
const TWIN_SEEDS = [1, 2, 3, 4, 5];
/** Seed-mean of `f` over a set of twins. */
const seedMean = (ts: Twin[], f: (t: Twin) => number): number => mean(ts.map(f));
const colOf = (lonEast: number): number => ((Math.round((lonEast - 182.5) / 5) % 72) + 72) % 72;
const rowOf = (lat: number): number => Math.round((lat + 87.5) / 5);
const atF = (a: number[], lonEast: number, lat: number): number => a[rowOf(lat) * 72 + colOf(lonEast)];
const fieldOf = (t: Twin, day: number) => t.fields.get(day)!;
const EQ = 2.5; // deg, the grid row just north of the equator
/** Horizontal divergence (1/s) of a difference wind field at a grid point. */
function divergence(f: { u: number[]; v: number[] }, lonEast: number, lat: number): number {
  const dx = 5 * 111.32e3 * Math.cos((lat * Math.PI) / 180), dy = 5 * 110.57e3;
  return (atF(f.u, lonEast + 5, lat) - atF(f.u, lonEast - 5, lat)) / (2 * dx) + (atF(f.v, lonEast, lat + 5) - atF(f.v, lonEast, lat - 5)) / (2 * dy);
}
/** Relative vorticity (1/s) of a difference wind field at a grid point. */
function vorticity(f: { u: number[]; v: number[] }, lonEast: number, lat: number): number {
  const dx = 5 * 111.32e3 * Math.cos((lat * Math.PI) / 180), dy = 5 * 110.57e3;
  return (atF(f.v, lonEast + 5, lat) - atF(f.v, lonEast - 5, lat)) / (2 * dx) - (atF(f.u, lonEast, lat + 5) - atF(f.u, lonEast, lat - 5)) / (2 * dy);
}

describe('player SST patches: cause and effect (twin experiments, noise on, 5 seeds)', () => {
  // Each scenario runs 5 x (spin-up + twin) free-running years; the first test of a scenario pays for it, hence the longer timeouts.
  const TIMEOUT = 60_000;
  const RELEASE_D2 = 90;

  test('D1. a small warm patch acts locally and is forgotten within a year', () => {
    const release = 30, days = release + 410;
    const ts = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 210, lat: 0, radiusDeg: 5, deltaC: 1, days: release }, days, [15]));
    const precip = seedMean(ts, (t) => atF(fieldOf(t, 15).precip, 210, EQ));
    const slp = seedMean(ts, (t) => atF(fieldOf(t, 15).slp, 210, EQ));
    const div = seedMean(ts, (t) => divergence(fieldOf(t, 15), 210, EQ));
    // Per-seed mean of |dNino 3.4| over the three months centred one year after release.
    const after = seedMean(ts, (t) => mean(t.dn34.slice(release + 320, release + 410).map(Math.abs)));
    console.log(`[D1] day 15: dPrecip ${precip.toFixed(2)} mm/day, dSLP ${slp.toFixed(2)} hPa, div ${(div * 1e6).toFixed(2)}e-6 /s; mean |dNino3.4| 11-13 months after release ${after.toFixed(3)} (threshold < 0.3)`);
    expect(precip).toBeGreaterThan(0);
    expect(slp).toBeLessThan(0);
    expect(div).toBeLessThan(0);
    expect(after).toBeLessThan(0.3);
  }, TIMEOUT);

  test('D2. an extreme warm patch starts Bjerknes feedback, an El Nino that outlives the patch, then discharge', () => {
    const days = RELEASE_D2 + 730;
    const ts = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 190, lat: 0, radiusDeg: 15, deltaC: 4, days: RELEASE_D2 }, days, [60, RELEASE_D2]));
    const u = (lon: number): number => seedMean(ts, (t) => atF(fieldOf(t, 60).u, lon, EQ));
    // Beyond the footprint (radius 15 deg around 190E, nudging cut-off at 1.73 radii = 216E), at the end of the patch.
    const sstEast = mean([230, 240, 250, 260].map((l) => seedMean(ts, (t) => atF(fieldOf(t, RELEASE_D2).sst, l, EQ))));
    const kelvin = Math.max(...Array.from({ length: 60 }, (_, i) => seedMean(ts, (t) => t.dh110[30 + i])));
    const dDarwin = seedMean(ts, (t) => atF(fieldOf(t, 60).slp, 130, -12.5)), dTahiti = seedMean(ts, (t) => atF(fieldOf(t, 60).slp, 210, -17.5));
    const soi = seedMean(ts, (t) => t.dsoi[59]);
    const release3 = seedMean(ts, (t) => t.dn3[RELEASE_D2 + 90 - 1]);
    // Discharge: the warm water volume falls below the control after the event, and Nino 3 is back near neutral about 2 yr after release.
    const late = seedMean(ts, (t) => mean(t.dn3.slice(RELEASE_D2 + 640, RELEASE_D2 + 730)));
    const wwvLow = Math.min(...Array.from({ length: 16 }, (_, m) => seedMean(ts, (t) => mean(t.dwwv.slice(RELEASE_D2 + 90 + 30 * m, RELEASE_D2 + 120 + 30 * m)))));
    // Bursts through the event only (release + 3 months): after it the discharged ocean has fewer bursts, so a whole-run count mixes the two signs.
    const extra = seedMean(ts, (t) => t.burstsBy.get(RELEASE_D2 + 90)!);
    console.log(`[D2] day 60: du(150E) ${u(150).toFixed(2)}, du(170E) ${u(170).toFixed(2)} m/s; dSST(130-100W, day ${RELEASE_D2}) ${sstEast.toFixed(2)}, peak dh(110W) ${kelvin.toFixed(1)} m; dSLP Darwin ${dDarwin.toFixed(2)}, Tahiti ${dTahiti.toFixed(2)} hPa; dSOI ${soi.toFixed(1)}; extra bursts by release+3 mo ${extra.toFixed(1)}; dNino3 at release+3 mo ${release3.toFixed(2)}, 21-24 mo after release ${late.toFixed(2)}, lowest monthly dWWV after release+3 mo ${wwvLow.toFixed(1)} m`);
    expect(u(150)).toBeGreaterThan(0);
    expect(u(170)).toBeGreaterThan(0);
    expect(u(170)).toBeLessThanOrEqual(10); // saturated convection keeps the wind anomaly plausible
    expect(sstEast).toBeGreaterThan(0.3);
    expect(kelvin).toBeGreaterThan(5); // downwelling Kelvin wave reaches 110W
    expect(dDarwin).toBeGreaterThan(0);
    expect(dTahiti).toBeLessThan(0);
    expect(soi).toBeLessThan(0);
    expect(extra).toBeGreaterThan(0);
    expect(release3).toBeGreaterThanOrEqual(1);
    expect(wwvLow).toBeLessThan(0);
    expect(late).toBeLessThanOrEqual(0.3);
  }, TIMEOUT);

  test('D3. an extreme cold patch gives the La Nina sign', () => {
    const ts = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 190, lat: 0, radiusDeg: 15, deltaC: -3, days: RELEASE_D2 }, RELEASE_D2 + 90, [60]));
    const soi = seedMean(ts, (t) => t.dsoi[59]);
    const u = seedMean(ts, (t) => atF(fieldOf(t, 60).u, 170, EQ));
    const n3 = seedMean(ts, (t) => t.dn3[RELEASE_D2 + 90 - 1]);
    console.log(`[D3] day 60: du(170E) ${u.toFixed(2)} m/s, dSOI ${soi.toFixed(1)}; dNino3 at release+3 mo ${n3.toFixed(2)}`);
    expect(soi).toBeGreaterThan(0);
    expect(u).toBeLessThan(0);
    expect(n3).toBeLessThan(0);
  }, TIMEOUT);

  // 4 C / 1 C > 2.5: deliberately relaxed from > 4 (coordinator's decision); the ratio is seed-dependent (2.8-5.0 before these fixes) because the 1 C
  // response depends on the ocean state at release while the 4 C response is capped by Tsub saturation. Monotonicity is the unrelaxed check. See VALIDATION.md.
  test('D4. the basin response grows monotonically and nonlinearly with the patch amplitude', () => {
    const amps = [0.5, 1, 2, 3, 4];
    const seeds = Array.from({ length: 10 }, (_, i) => i + 1);
    const curve = amps.map((a) => seedMean(seeds.map((s) => runTwin(s, { lonEast: 190, lat: 0, radiusDeg: 15, deltaC: a, days: RELEASE_D2 }, RELEASE_D2 + 90)), (t) => t.dn3[RELEASE_D2 + 90 - 1]));
    console.log(`[D4] seeds 1-10, deltaC ${amps.join(', ')} -> dNino3 at release+3 mo ${curve.map((v) => v.toFixed(2)).join(', ')}; ratio(4/1) ${(curve[4] / curve[1]).toFixed(1)}`);
    for (let i = 1; i < curve.length; i++) expect(curve[i]).toBeGreaterThan(curve[i - 1]);
    expect(curve[4]).toBeGreaterThan(2.5 * curve[1]);
  }, TIMEOUT);

  test('D5. remote and off-equatorial patches give the Gill sign', () => {
    const ind = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 80, lat: 0, radiusDeg: 15, deltaC: 2, days: 120 }, 120, [90]));
    const uWest = mean([140, 150, 160].map((l) => seedMean(ind, (t) => atF(fieldOf(t, 90).u, l, EQ))));
    const n34End = seedMean(ind, (t) => t.dn34[119]);
    const off = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 140, lat: 15, radiusDeg: 15, deltaC: 3, days: 90 }, 90, [60]));
    const on = TWIN_SEEDS.map((s) => runTwin(s, { lonEast: 140, lat: 0, radiusDeg: 15, deltaC: 3, days: 90 }, 90, [60]));
    const slp = seedMean(off, (t) => atF(fieldOf(t, 60).slp, 140, 17.5));
    const vort = seedMean(off, (t) => vorticity(fieldOf(t, 60), 130, 12.5));
    const uOff = seedMean(off, (t) => atF(fieldOf(t, 60).u, 160, EQ)), uOn = seedMean(on, (t) => atF(fieldOf(t, 60).u, 160, EQ));
    console.log(`[D5] Indian Ocean: du(140-160E) ${uWest.toFixed(2)} m/s, dNino3.4 after 120 d ${n34End.toFixed(2)}; 15N 140E: dSLP ${slp.toFixed(2)} hPa, vorticity ${(vort * 1e6).toFixed(2)}e-6 /s, du(160E,eq) off ${uOff.toFixed(2)} vs on-equator ${uOn.toFixed(2)}`);
    expect(uWest).toBeLessThan(0);
    expect(n34End).toBeLessThan(0);
    expect(slp).toBeLessThan(0);
    expect(vort).toBeGreaterThan(0);
    expect(Math.abs(uOff)).toBeLessThan(Math.abs(uOn));
  }, TIMEOUT);
});

describe('determinism and serialisation', () => {
  const drive = (s: ClimateState, from: number, to: number): void => {
    for (let d = from; d < to; d++) {
      if (d === 100) addWesterlyBurst(s, { lonEast: 155, speed: 6, days: 15 });
      if (d === 400) setTradeWindAnomaly(s, 1);
      if (d === 900) addThermoclinePulse(s, { lonEast: 200, metres: -10 });
      if (d === 1200) setSstHold(s, 1);
      if (d === 1500) setSstHold(s, null);
      if (d === 1700) addSstPatch(s, { lonEast: 190, lat: 2, radiusDeg: 12, deltaC: 2, days: 200 });
      if (d === 1800) addSstPatch(s, { lonEast: 80, lat: -5, radiusDeg: 15, deltaC: -1.5, days: 120 });
      if (d === 1810) setSstHold(s, 0.5); // still held at the restore on day 1825
      if (d === 1820) addWesterlyBurst(s, { lonEast: 165, speed: 7, days: 12 }); // active at the restore
      stepClimateDay(s);
    }
  };
  test.each([[true], [false]])('8. same seed and actions are bit-identical; restore mid-run continues identically (stochastic %s)', (stochastic) => {
    const make = (): ClimateState => createClimate(5, 40, 2001, stochastic);
    const a = make(), b = make();
    drive(a, 0, 3650); drive(b, 0, 3650);
    expect(JSON.stringify(serializeClimate(a))).toBe(JSON.stringify(serializeClimate(b)));
    expect(Object.is(a.T[40], b.T[40])).toBe(true);

    const c = make();
    drive(c, 0, 1825);
    expect(c.nPatches).toBeGreaterThan(0); // the restore below happens with active patches, a held Nino 3.4 and a live player burst
    expect(c.hold).toBe(0.5);
    expect(c.nBursts).toBeGreaterThan(0);
    const r = restoreClimate(JSON.parse(JSON.stringify(serializeClimate(c))));
    expect(r).not.toBeNull();
    drive(r!, 1825, 3650);
    expect(JSON.stringify(serializeClimate(r!))).toBe(JSON.stringify(serializeClimate(a)));
  });

  test('the stochastic mode cannot be flipped mid-run', () => {
    const s = createClimate(1, 1, 2000);
    expect(() => { (s as { stochastic: boolean }).stochastic = false; }).toThrow();
    expect(s.stochastic).toBe(true);
  });

  test('restoreClimate rejects out-of-range states', () => {
    const s = createClimate(1, 1, 2000);
    addSstPatch(s, { lonEast: 190, lat: 0, radiusDeg: 15, deltaC: 2, days: 30 });
    addWesterlyBurst(s, { lonEast: 160, speed: 8, days: 10 });
    addThermoclinePulse(s, { lonEast: 200, metres: 5 });
    const good = (): Record<string, unknown> => JSON.parse(JSON.stringify(serializeClimate(s))) as Record<string, unknown>;
    expect(restoreClimate(good())).not.toBeNull();
    const broken = (f: (d: Record<string, any>) => void): unknown => { const d = good(); f(d); return restoreClimate(d); }; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(broken((d) => { d.tradeAnomaly = 9; })).toBeNull();
    expect(broken((d) => { d.hold = 50; })).toBeNull();
    expect(broken((d) => { d.patches[2] = 0; })).toBeNull(); // radius
    expect(broken((d) => { d.patches[3] = 40; })).toBeNull(); // deltaC
    expect(broken((d) => { d.bursts[1] = 1000; })).toBeNull(); // burst speed
    expect(broken((d) => { d.K[3] = 1e6; })).toBeNull();
    expect(broken((d) => { d.R3[3] = -1e6; })).toBeNull();
    expect(broken((d) => { d.T[3] = 100; })).toBeNull();
    expect(broken((d) => { d.T[3] = null; })).toBeNull();
    expect(broken((d) => { d.pulses = [1, 2]; })).toBeNull();
    expect(broken((d) => { d.pulses = [0, 200, 5000]; })).toBeNull();
  });

  test('inputs are validated', () => {
    const s = createClimate(1, 1, 2000);
    expect(addWesterlyBurst(s, { lonEast: NaN, speed: 5, days: 10 })).toBe(false);
    expect(addWesterlyBurst(s, { lonEast: 400, speed: 5, days: 10 })).toBe(false);
    expect(addWesterlyBurst(s, { lonEast: 160, speed: 50, days: 10 })).toBe(false);
    expect(addWesterlyBurst(s, { lonEast: 160, speed: 5, days: 0 })).toBe(false);
    expect(setTradeWindAnomaly(s, Infinity)).toBe(false);
    expect(addThermoclinePulse(s, { lonEast: 100, metres: 5 })).toBe(false);
    expect(setSstHold(s, NaN)).toBe(false);
    const ok = { lonEast: 190, lat: 0, radiusDeg: 15, deltaC: 2, days: 30 };
    expect(addSstPatch(s, { ...ok, lonEast: NaN })).toBe(false);
    expect(addSstPatch(s, { ...ok, lat: 45 })).toBe(false);
    expect(addSstPatch(s, { ...ok, radiusDeg: 0 })).toBe(false);
    expect(addSstPatch(s, { ...ok, deltaC: Infinity })).toBe(false);
    expect(addSstPatch(s, { ...ok, deltaC: 20 })).toBe(false);
    expect(addSstPatch(s, { ...ok, days: 0 })).toBe(false);
    expect(s.nPatches).toBe(0);
    expect(addSstPatch(s, { ...ok, deltaC: -2 })).toBe(true); // cooling is valid
    expect(s.nPatches).toBe(1);
    expect(s.nBursts).toBe(0);
    expect(restoreClimate({ day: 1 })).toBeNull();
    expect(restoreClimate(null)).toBeNull();
  });

  test('hold experiment pulls Nino 3.4 toward the target', () => {
    const s = createClimate(2, 1, 2000, false);
    setSstHold(s, 2);
    for (let d = 0; d < 60; d++) stepClimateDay(s);
    expect(climateIndices(s).nino34).toBeGreaterThan(1.5);
  });
});

describe('stress: extreme but valid player inputs', () => {
  const bounds = (s: ClimateState, label: string): number => {
    const fields = climateFields(s);
    let umax = 0;
    for (let j = 0; j < 64; j++) {
      expect(Number.isFinite(s.T[j])).toBe(true);
      expect(Math.abs(s.K[j])).toBeLessThanOrEqual(150);
      expect(Math.abs(s.R[j])).toBeLessThanOrEqual(150);
      expect(Math.abs(s.R3[j])).toBeLessThanOrEqual(150);
      expect(s.K[j] + s.R[j]).toBeLessThanOrEqual(120 + 1e-9);
      expect(s.K[j] + s.R[j]).toBeGreaterThanOrEqual(-145);
      expect(Math.abs(s.T[j])).toBeLessThanOrEqual(15.5);
    }
    for (let i = 0; i < fields.u.length; i++) { expect(Number.isFinite(fields.u[i])).toBe(true); umax = Math.max(umax, Math.abs(fields.u[i])); }
    expect(umax, label).toBeLessThanOrEqual(25);
    return umax;
  };
  // Three model years with the reviewer's four abuse scenarios; bounds are checked monthly (daily checks would only repeat the same clamp).
  const run = (setup: (s: ClimateState) => number): { s: ClimateState; umax: number; accepted: number } => {
    const s = createClimate(7, 1, 2000);
    const accepted = setup(s);
    let umax = 0;
    for (let d = 0; d < 3 * 365; d++) { stepClimateDay(s); if (d % 30 === 0) umax = Math.max(umax, bounds(s, `day ${d}`)); }
    return { s, umax, accepted };
  };
  test('stacked bursts, stacked patches, repeated pulses, and trade + hold stay within physical limits', () => {
    const bursts = run((s) => { let n = 0; for (let i = 0; i < 24; i++) if (addWesterlyBurst(s, { lonEast: 160, speed: 15, days: 60 })) n++; return n; });
    const patches = run((s) => { let n = 0; for (let i = 0; i < 8; i++) if (addSstPatch(s, { lonEast: 190, lat: 0, radiusDeg: 40, deltaC: 6, days: 730 })) n++; return n; });
    const pulses = run((s) => { let n = 0; for (let i = 0; i < 20; i++) if (addThermoclinePulse(s, { lonEast: 200, metres: 60 })) n++; return n; });
    const trade = run((s) => { setTradeWindAnomaly(s, -5); setSstHold(s, 5); return 1; });
    console.log(`[stress] accepted bursts ${bursts.accepted}/24, patches ${patches.accepted}/8, pulses ${pulses.accepted}/20; max |u| over the fields: bursts ${bursts.umax.toFixed(1)}, patches ${patches.umax.toFixed(1)}, pulses ${pulses.umax.toFixed(1)}, trade+hold ${trade.umax.toFixed(1)} m/s`);
    expect(bursts.accepted).toBe(16); // 8 slots stay reserved for natural bursts
    expect(bursts.s.burstCount).toBeGreaterThan(0); // natural bursts keep occurring
    expect(pulses.accepted).toBe(4);
  }, 30_000);
});

describe('budget', () => {
  test('9. per-day cost, fields cost, state size', () => {
    const s = createClimate(3, 1, 2000);
    for (let d = 0; d < 365; d++) stepClimateDay(s); // warm up the JIT
    const days = 3650;
    const t0 = performance.now();
    for (let d = 0; d < days; d++) stepClimateDay(s);
    const perDay = (performance.now() - t0) / days;
    const t1 = performance.now();
    const hundred = createClimate(4, 1, 2000);
    for (let d = 0; d < 36500; d++) stepClimateDay(hundred);
    const wall = performance.now() - t1;
    const out = climateFields(s);
    const t2 = performance.now();
    const reps = 50;
    for (let r = 0; r < reps; r++) climateFields(s, out);
    const fieldsMs = (performance.now() - t2) / reps;
    const bytes = JSON.stringify(serializeClimate(s)).length;
    console.log(`[9] stepClimateDay ${(perDay * 1000).toFixed(1)} us/day, 100 yr wall ${wall.toFixed(0)} ms, climateFields ${fieldsMs.toFixed(3)} ms, serialised ${bytes} bytes`);
    expect(perDay).toBeLessThan(1);
    expect(fieldsMs).toBeLessThan(2);
    expect(bytes).toBeLessThan(50_000);
  });
});
