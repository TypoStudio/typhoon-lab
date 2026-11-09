#!/usr/bin/env node
// Builds ENSO teleconnection regression maps from NCEP/NCAR Reanalysis 1 monthly means.
//   src/data/generated/climate-teleconnections.json   per-season slope of slp/air/rhum/200-850 hPa shear 3-month anomaly on Nino-3.4, 5 degree grid (shipped)
// Needs tests/fixtures/enso-observed.json (npm run prepare:climate). Usage: node scripts/prepare-teleconnections.mjs
// Source: NOAA PSL OPeNDAP ASCII responses, one request per field and year, cached in .cache/climate/. Output is deterministic for a given cache.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = resolve(ROOT, '.cache/climate');
const OUT = resolve(ROOT, 'src/data/generated/climate-teleconnections.json');
const FIXTURE = resolve(ROOT, 'tests/fixtures/enso-observed.json');

const BASE_URL = 'https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.derived/surface/';
const FIELDS = [
  { name: 'slp', file: 'slp.mon.mean.nc', factor: 1 }, // hPa (converted below if the file is in Pa)
  { name: 'air', file: 'air.sig995.mon.mean.nc', factor: 1 }, // degC
  { name: 'rhum', file: 'rhum.sig995.mon.mean.nc', factor: 1 }, // percent
];
const PRESSURE_URL = 'https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.derived/pressure/';
const LEVEL_200 = 9; // index in the 17-level axis 1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, ...
const LEVEL_850 = 2;
const NLAT = 73; // lat 90..-90
const NLON = 144; // lon 0..357.5
const FIRST_YEAR = 1948; // time index 0 = 1948-01
const YEAR_MIN = 1950;
const YEAR_MAX = 2024;
const CLIM_MIN = 1991;
const CLIM_MAX = 2020;
const MIN_R = 0.3;

const STEP = 5;
const COLS = 72;
const ROWS = 36;
const SCALE = 0.01;
const SEASONS = ['DJF', 'MAM', 'JJA', 'SON'];
const SEASON_FIRST_MONTH = [11, 2, 5, 8]; // DJF starts in December of the previous year

const MISSING_BELOW = -1e30;
const CONCURRENCY = 4;
const RETRIES = 4;

// ---------- fetching with cache (same scheme as prepare-climate.mjs) ----------

async function fetchText(url) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
  const file = resolve(CACHE_DIR, `${key}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')).body;
  } catch {
    // not cached
  }
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.text();
      if (!body.startsWith('Dataset {')) throw new Error('unexpected response: ' + body.slice(0, 80));
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ url, fetchedAt: new Date().toISOString().slice(0, 10), body }));
      return body;
    } catch (err) {
      lastError = err;
      if (attempt < RETRIES) await new Promise((r) => setTimeout(r, 1000 * attempt * attempt));
    }
  }
  throw new Error(`fetch failed after ${RETRIES} attempts: ${url}: ${lastError?.message}`);
}

async function pool(items, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}

function parseGrid(text, varName, dims) {
  const data = new Float64Array(dims.reduce((a, b) => a * b, 1));
  let section = null;
  let rows = 0;
  for (const line of text.split('\n')) {
    const head = line.match(/^([\w.]+)\[([\d\]\[]+)\]$/);
    if (head) {
      section = head[1];
      continue;
    }
    if (section !== `${varName}.${varName}`) continue;
    const m = line.match(/^((?:\[\d+\])+),\s*(.*)$/);
    if (!m) continue;
    const idx = [...m[1].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
    const vals = m[2].split(',').map((s) => Number(s.trim()));
    let base = 0;
    for (let k = 0; k < idx.length; k++) base = base * dims[k] + idx[k];
    base *= dims[dims.length - 1];
    if (vals.length !== dims[dims.length - 1]) throw new Error(`${varName}: row length ${vals.length}`);
    for (let k = 0; k < vals.length; k++) data[base + k] = vals[k] < MISSING_BELOW ? NaN : vals[k];
    rows++;
  }
  const expectedRows = dims.slice(0, -1).reduce((a, b) => a * b, 1);
  if (rows !== expectedRows) throw new Error(`${varName}: parsed ${rows} rows, expected ${expectedRows}`);
  return data;
}

function parse1d(text, name) {
  const m = text.match(new RegExp(`^${name}\\[\\d+\\]\\n([^\\n]+)`, 'm'));
  if (!m) throw new Error(`no ${name} array in response`);
  return m[1].split(',').map((s) => Number(s.trim()));
}

const q = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

// ---------- load ----------

const lats = Array.from({ length: NLAT }, (_, i) => 90 - 2.5 * i);
const lonSigned = (lon) => (lon >= 180 ? lon - 360 : lon);
const NY = YEAR_MAX - YEAR_MIN + 1;
const NM = NY * 12;
const CELL = NLAT * NLON;

async function checkAxes(url) {
  const text = await fetchText(`${url}.ascii?${q(`lat[0:${NLAT - 1}],lon[0:${NLON - 1}],time[0:1]`)}`);
  const lat = parse1d(text, 'lat');
  const lon = parse1d(text, 'lon');
  if (lat.length !== NLAT || lat[0] !== 90 || lat.at(-1) !== -90) throw new Error(`unexpected lat axis: ${url}`);
  if (lon.length !== NLON || lon[0] !== 0 || lon.at(-1) !== 357.5) throw new Error(`unexpected lon axis: ${url}`);
  const t0 = parse1d(text, 'time')[0];
  // hours since 1800-01-01
  if (t0 !== (Date.UTC(FIRST_YEAR, 0, 1) - Date.UTC(1800, 0, 1)) / 3600000) throw new Error(`unexpected time origin: ${url}`);
}

// -> Float64Array[NM][CELL], month index (year - YEAR_MIN) * 12 + m
async function loadField(f, baseUrl = BASE_URL, level = null) {
  const url = baseUrl + f.file;
  await checkAxes(url);
  if (level !== null) {
    const lv = parse1d(await fetchText(`${url}.ascii?${q('level[0:16]')}`), 'level');
    if (lv[LEVEL_200] !== 200 || lv[LEVEL_850] !== 850) throw new Error(`unexpected level axis: ${url}`);
  }
  const years = Array.from({ length: NY }, (_, i) => YEAR_MIN + i);
  const out = new Float64Array(NM * CELL);
  const parts = await pool(years, async (year) => {
    const t0 = (year - FIRST_YEAR) * 12;
    const lvl = level === null ? '' : `[${level}:${level}]`;
    const text = await fetchText(`${url}.ascii?${q(`${f.name}[${t0}:${t0 + 11}]${lvl}[0:${NLAT - 1}][0:${NLON - 1}]`)}`);
    return parseGrid(text, f.name, level === null ? [12, NLAT, NLON] : [12, 1, NLAT, NLON]);
  });
  parts.forEach((p, i) => out.set(p, i * 12 * CELL));
  return out;
}

// ---------- processing ----------

const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
if (fixture.nino34Start !== `${YEAR_MIN}-01` || fixture.nino34.length !== NM) throw new Error('unexpected nino34 series');
const nino = fixture.nino34;

// area-weighted 5 degree box index per 2.5 degree cell
const row5 = (lat) => Math.min(ROWS - 1, Math.floor((lat + 90) / STEP));
const col5 = (lon) => Math.floor((lonSigned(lon) + 180) / STEP);
const boxOf = new Int32Array(CELL);
const weightOf = new Float64Array(CELL);
for (let i = 0; i < NLAT; i++) {
  for (let j = 0; j < NLON; j++) {
    boxOf[i * NLON + j] = row5(lats[i]) * COLS + col5(2.5 * j);
    weightOf[i * NLON + j] = Math.max(Math.cos((lats[i] * Math.PI) / 180), 0.02);
  }
}

// per 2.5 degree cell: anomaly vs 1991-2020 monthly climatology, then linear detrend in time (in place)
function anomalyDetrended(raw) {
  const clim = new Float64Array(12 * CELL);
  for (let m = 0; m < 12; m++) {
    for (let c = 0; c < CELL; c++) {
      let s = 0;
      let n = 0;
      for (let y = CLIM_MIN; y <= CLIM_MAX; y++) {
        const v = raw[((y - YEAR_MIN) * 12 + m) * CELL + c];
        if (!Number.isNaN(v)) {
          s += v;
          n++;
        }
      }
      clim[m * CELL + c] = n > 0 ? s / n : NaN;
    }
  }
  const tMean = (NM - 1) / 2;
  let stt = 0;
  for (let t = 0; t < NM; t++) stt += (t - tMean) ** 2;
  for (let c = 0; c < CELL; c++) {
    let sa = 0;
    let sta = 0;
    for (let t = 0; t < NM; t++) {
      const a = (raw[t * CELL + c] - clim[(t % 12) * CELL + c]);
      raw[t * CELL + c] = a;
      sa += a;
      sta += (t - tMean) * a;
    }
    const mean = sa / NM;
    const slope = sta / stt;
    for (let t = 0; t < NM; t++) raw[t * CELL + c] -= mean + slope * (t - tMean);
  }
  return raw;
}

// regression of the 3-month-mean 5 degree anomaly on the 3-month-mean Nino-3.4, per season -> Int32Array[4*ROWS*COLS]
function regress(anom) {
  const result = new Int32Array(SEASONS.length * ROWS * COLS);
  for (let s = 0; s < SEASONS.length; s++) {
    const m0 = SEASON_FIRST_MONTH[s];
    const xs = [];
    const fields = []; // Float64Array[ROWS*COLS] per usable year
    for (let y = YEAR_MIN; y <= YEAR_MAX; y++) {
      const t0 = (y - YEAR_MIN) * 12 + m0 - (s === 0 ? 12 : 0); // DJF belongs to the year of its January
      if (t0 < 0 || t0 + 2 >= NM) continue;
      xs.push((nino[t0] + nino[t0 + 1] + nino[t0 + 2]) / 3);
      const sum = new Float64Array(ROWS * COLS);
      const wsum = new Float64Array(ROWS * COLS);
      for (let k = 0; k < 3; k++) {
        for (let c = 0; c < CELL; c++) {
          const v = anom[(t0 + k) * CELL + c];
          if (Number.isNaN(v)) continue;
          sum[boxOf[c]] += v * weightOf[c];
          wsum[boxOf[c]] += weightOf[c];
        }
      }
      for (let b = 0; b < ROWS * COLS; b++) sum[b] = wsum[b] > 0 ? sum[b] / wsum[b] : NaN;
      fields.push(sum);
    }
    const n = xs.length;
    const xm = xs.reduce((a, b) => a + b, 0) / n;
    const sxx = xs.reduce((a, x) => a + (x - xm) ** 2, 0);
    for (let b = 0; b < ROWS * COLS; b++) {
      let ym = 0;
      for (let k = 0; k < n; k++) ym += fields[k][b];
      ym /= n;
      let sxy = 0;
      let syy = 0;
      for (let k = 0; k < n; k++) {
        sxy += (xs[k] - xm) * (fields[k][b] - ym);
        syy += (fields[k][b] - ym) ** 2;
      }
      const r = sxy / Math.sqrt(sxx * syy);
      result[s * ROWS * COLS + b] = Number.isFinite(r) && Math.abs(r) >= MIN_R ? Math.round(sxy / sxx / SCALE) : 0;
    }
  }
  return result;
}

const out = {
  source:
    'NCEP/NCAR Reanalysis 1 monthly means (NOAA PSL): per-season regression of 3-month-mean anomalies (vs 1991-2020, linearly detrended per grid point) on the Nino-3.4 index (NOAA ERSST v5), box-averaged to 5 degrees; slopes with |r| < 0.3 set to 0',
  period: `${YEAR_MIN}-${YEAR_MAX}`,
  index: 'Nino3.4',
  cols: COLS,
  rows: ROWS,
  step: STEP,
  lonStart: -180 + STEP / 2,
  latStart: -90 + STEP / 2,
  seasons: SEASONS,
  units: { slp: 'hPa/degC', air: 'degC/degC', rhum: 'percent/degC', shear: 'm s-1/degC' },
  scale: SCALE,
};
for (const f of FIELDS) {
  const raw = await loadField(f);
  let mean = 0;
  for (let c = 0; c < CELL; c++) mean += raw[c];
  mean /= CELL;
  // slp in the monthly file may be Pa; anomalies must end up in hPa
  const factor = f.name === 'slp' && Math.abs(mean) > 5000 ? 0.01 : f.factor;
  for (let i = 0; i < raw.length; i++) raw[i] *= factor;
  out[f.name] = Array.from(regress(anomalyDetrended(raw)));
}
// vertical wind shear magnitude between 200 and 850 hPa
{
  const comp = async (name) => {
    const f = { name, file: `${name}.mon.mean.nc` };
    const hi = await loadField(f, PRESSURE_URL, LEVEL_200);
    const lo = await loadField(f, PRESSURE_URL, LEVEL_850);
    for (let i = 0; i < hi.length; i++) hi[i] -= lo[i];
    return hi;
  };
  const du = await comp('uwnd');
  const dv = await comp('vwnd');
  for (let i = 0; i < du.length; i++) du[i] = Math.hypot(du[i], dv[i]);
  out.shear = Array.from(regress(anomalyDetrended(du)));
}
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(out) + '\n');
console.log(`wrote ${OUT}`);
