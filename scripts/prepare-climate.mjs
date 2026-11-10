#!/usr/bin/env node
// Builds the ENSO climate data from NOAA ERSST v5 monthly 2 degree SST.
//   src/data/generated/climate-normals.json   1991-2020 monthly SST climatology on a global 5 degree grid (shipped)
//   src/data/generated/nino34-observed.json   observed Nino-3.4 index 1950-2024, monthly (shipped: the Measure chart draws it beside a climate scenario)
//   tests/fixtures/enso-observed.json         the same index and the equatorial El Nino profiles (tests only)
// Usage: node scripts/prepare-climate.mjs   (needs network on first run; raw responses are cached in .cache/climate/)
// Source: NOAA PSL OPeNDAP ASCII responses, one year per request. Output is deterministic for a given cache.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_DIR = resolve(ROOT, '.cache/climate');
const OUT_NORMALS = resolve(ROOT, 'src/data/generated/climate-normals.json');
const OUT_FIXTURE = resolve(ROOT, 'tests/fixtures/enso-observed.json');
const OUT_NINO34 = resolve(ROOT, 'src/data/generated/nino34-observed.json');

const ERSST_URL = 'https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.ersst.v5/sst.mnmean.nc';
const NLAT = 89; // lat 88..-88
const NLON = 180; // lon 0..358
const FIRST_YEAR = 1854; // time index 0 = 1854-01
const YEAR_MIN = 1950;
const YEAR_MAX = 2024;
const CLIM_MIN = 1991;
const CLIM_MAX = 2020;
const MIN_CLIM_YEARS = 20; // a 2 degree cell needs this many valid years of a month to have a normal

const STEP = 5;
const COLS = 72;
const ROWS = 36;
const SCALE = 0.01;
const MISSING = -32768;

const MISSING_BELOW = -1e30;
const CONCURRENCY = 4;
const RETRIES = 4;

// ---------- fetching with cache ----------

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

// ---------- OPeNDAP ASCII parsing ----------

// Returns Float64Array[dims product] (NaN for missing) for one Grid variable.
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

const lats = Array.from({ length: NLAT }, (_, i) => 88 - 2 * i);
const lons = Array.from({ length: NLON }, (_, i) => 2 * i);

async function checkAxes() {
  const text = await fetchText(`${ERSST_URL}.ascii?${q(`lat[0:${NLAT - 1}],lon[0:${NLON - 1}],time[0:1]`)}`);
  const lat = parse1d(text, 'lat');
  const lon = parse1d(text, 'lon');
  if (lat.length !== NLAT || lat[0] !== 88 || lat.at(-1) !== -88) throw new Error('unexpected ERSST lat axis');
  if (lon.length !== NLON || lon[0] !== 0 || lon.at(-1) !== 358) throw new Error('unexpected ERSST lon axis');
  const t0 = parse1d(text, 'time')[0];
  if (t0 !== (Date.UTC(1854, 0, 1) - Date.UTC(1800, 0, 1)) / 86400000) throw new Error('unexpected ERSST time origin');
}

// years -> Float64Array[12][NLAT][NLON]
async function loadYears(years) {
  const out = await pool(years, async (year) => {
    const t0 = (year - FIRST_YEAR) * 12;
    const text = await fetchText(`${ERSST_URL}.ascii?${q(`sst[${t0}:${t0 + 11}][0:${NLAT - 1}][0:${NLON - 1}]`)}`);
    return parseGrid(text, 'sst', [12, NLAT, NLON]);
  });
  return new Map(years.map((y, i) => [y, out[i]]));
}

// ---------- processing ----------

await checkAxes();
const years = [];
for (let y = YEAR_MIN; y <= YEAR_MAX; y++) years.push(y);
const sstByYear = await loadYears(years);
const CELL = NLAT * NLON;

// 1991-2020 monthly climatology per 2 degree cell: clim[month*CELL + cell] (NaN when too few valid years)
const clim = new Float64Array(12 * CELL).fill(NaN);
for (let m = 0; m < 12; m++) {
  for (let c = 0; c < CELL; c++) {
    let sum = 0;
    let n = 0;
    for (let y = CLIM_MIN; y <= CLIM_MAX; y++) {
      const v = sstByYear.get(y)[m * CELL + c];
      if (!Number.isNaN(v)) {
        sum += v;
        n++;
      }
    }
    if (n >= MIN_CLIM_YEARS) clim[m * CELL + c] = sum / n;
  }
}

// ---------- output A: 5 degree normals ----------

const lonSigned = (lon) => (lon >= 180 ? lon - 360 : lon);
const col5 = (lon) => Math.floor((lonSigned(lon) + 180) / STEP);
const row5 = (lat) => Math.floor((lat + 90) / STEP);

const total = new Int32Array(ROWS * COLS);
for (let i = 0; i < NLAT; i++) for (let j = 0; j < NLON; j++) total[row5(lats[i]) * COLS + col5(lons[j])]++;

const sst = new Array(12 * ROWS * COLS).fill(MISSING);
for (let m = 0; m < 12; m++) {
  const sum = new Float64Array(ROWS * COLS);
  const cnt = new Int32Array(ROWS * COLS);
  for (let i = 0; i < NLAT; i++) {
    for (let j = 0; j < NLON; j++) {
      const v = clim[m * CELL + i * NLON + j];
      if (Number.isNaN(v)) continue;
      const k = row5(lats[i]) * COLS + col5(lons[j]);
      sum[k] += v;
      cnt[k]++;
    }
  }
  for (let k = 0; k < ROWS * COLS; k++) {
    if (cnt[k] > 0 && cnt[k] * 2 >= total[k]) sst[m * ROWS * COLS + k] = Math.round(sum[k] / cnt[k] / SCALE);
  }
}

const normals = {
  source: 'NOAA ERSST v5 monthly SST (NOAA PSL), 1991-2020 monthly climatology, box-averaged from 2 degree to 5 degree cells',
  period: `${CLIM_MIN}-${CLIM_MAX}`,
  lonStart: -180 + STEP / 2,
  latStart: -90 + STEP / 2,
  step: STEP,
  cols: COLS,
  rows: ROWS,
  scale: SCALE,
  missing: MISSING,
  sst,
};
await mkdir(dirname(OUT_NORMALS), { recursive: true });
await writeFile(OUT_NORMALS, JSON.stringify(normals) + '\n');

// ---------- output B: observed ENSO fixture ----------

const r2 = (x) => Math.round(x * 100) / 100;
const anomaly = (year, m, i, j) => sstByYear.get(year)[m * CELL + i * NLON + j] - clim[m * CELL + i * NLON + j];

// cos-lat weighted mean anomaly over 2 degree cells with lat in [latLo, latHi] and lon (east) in [lonLo, lonHi)
function areaMean(year, m, latLo, latHi, lonLo, lonHi) {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < NLAT; i++) {
    if (lats[i] < latLo || lats[i] > latHi) continue;
    for (let j = 0; j < NLON; j++) {
      if (lons[j] < lonLo || lons[j] >= lonHi) continue;
      const a = anomaly(year, m, i, j);
      if (Number.isNaN(a)) continue;
      const cw = Math.cos((lats[i] * Math.PI) / 180);
      sum += a * cw;
      w += cw;
    }
  }
  return w > 0 ? sum / w : NaN;
}

const nino34 = [];
for (let y = YEAR_MIN; y <= YEAR_MAX; y++) for (let m = 0; m < 12; m++) nino34.push(r2(areaMean(y, m, -5, 5, 190, 240)));
if (nino34.some(Number.isNaN)) throw new Error('Nino-3.4 has missing months');

// DJF mean (Dec of startYear, Jan and Feb of startYear + 1) of the equatorial anomaly in 5 degree longitude boxes
const profileLons = [];
for (let lon = 120; lon <= 280; lon += 5) profileLons.push(lon);
function djfProfile(startYear) {
  return profileLons.map((lon) => {
    const parts = [
      areaMean(startYear, 11, -5, 5, lon - 2.5, lon + 2.5),
      areaMean(startYear + 1, 0, -5, 5, lon - 2.5, lon + 2.5),
      areaMean(startYear + 1, 1, -5, 5, lon - 2.5, lon + 2.5),
    ];
    return r2(parts.reduce((a, b) => a + b, 0) / 3);
  });
}

const fixture = {
  source: 'NOAA ERSST v5 monthly SST (NOAA PSL); anomalies relative to the 1991-2020 monthly climatology of the same data',
  nino34Start: `${YEAR_MIN}-01`,
  nino34,
  profileLonsEast: profileLons,
  equatorProfiles: {
    'DJF 1997/98': djfProfile(1997),
    'DJF 2010/11': djfProfile(2010),
  },
};
await mkdir(dirname(OUT_FIXTURE), { recursive: true });
await writeFile(OUT_FIXTURE, JSON.stringify(fixture, null, 1) + '\n');

await writeFile(
  OUT_NINO34,
  JSON.stringify({
    source: 'NOAA ERSST v5 monthly SST (NOAA PSL); Nino 3.4 (5S-5N, 170W-120W) anomaly relative to the 1991-2020 monthly climatology of the same data',
    start: `${YEAR_MIN}-01`,
    nino34,
  }) + '\n',
);

console.log(`wrote ${OUT_NORMALS}`);
console.log(`wrote ${OUT_NINO34}`);
console.log(`wrote ${OUT_FIXTURE}`);
