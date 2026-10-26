#!/usr/bin/env node
// Builds src/data/generated/environment/<typhoonId>.json for every storm in typhoons.json.
// Usage: node scripts/prepare-environment.mjs   (needs network on first run; raw responses are cached in .cache/environment/)
// Sources (NOAA PSL OPeNDAP, ASCII responses, no key and no NetCDF library):
//   NCEP/NCAR Reanalysis 1 daily averages, surface / sigma 0.995: air, rhum, uwnd, vwnd; slp.
//   NOAA ERSST v5 monthly 2 degree SST.
// Output is deterministic for a given cache: nothing depends on the current time.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = resolve(ROOT, 'src/data/generated/typhoons.json');
const OUT_DIR = resolve(ROOT, 'src/data/generated/environment');
const CACHE_DIR = resolve(ROOT, '.cache/environment');

const NCEP_BASE = 'https://psl.noaa.gov/thredds/dodsC/Datasets/ncep.reanalysis.dailyavgs/surface';
const ERSST_URL = 'https://psl.noaa.gov/thredds/dodsC/Datasets/noaa.ersst.v5/sst.mnmean.nc';
// variable name in file, file stem, output field
const NCEP_VARS = [
  { v: 'air', stem: 'air.sig995', field: 'air', convert: (x) => x - 273.15 },
  { v: 'rhum', stem: 'rhum.sig995', field: 'rhum', convert: (x) => x },
  { v: 'slp', stem: 'slp', field: 'slp', convert: (x) => x / 100 },
  { v: 'uwnd', stem: 'uwnd.sig995', field: 'u', convert: (x) => x },
  { v: 'vwnd', stem: 'vwnd.sig995', field: 'v', convert: (x) => x },
];

// Game lattice: 2 degree cells, odd-degree centres. Window covers all tracks with margin.
const LON_MIN = 97; // degrees east, 97..199 (wrapped to -179..-161 on output)
const LON_MAX = 199;
const LAT_MIN = -5;
const LAT_MAX = 65;
const STEP = 2;
const SCALE = { sst: 0.01, air: 0.01, rhum: 0.1, slp: 0.1, u: 0.01, v: 0.01 };
const FIELDS = ['sst', 'air', 'rhum', 'slp', 'u', 'v'];

const MISSING_BELOW = -1e30; // OPeNDAP fill value is -9.96921E36
const DAY_MS = 86400000;
const CONCURRENCY = 4;
const RETRIES = 4;

const srcLabel = {
  reanalysis: 'NCEP/NCAR Reanalysis 1 daily averages (NOAA PSL)',
  sst: 'NOAA ERSST v5 monthly (NOAA PSL)',
};

// ---------- fetching with cache ----------

const usedEntries = new Map(); // url -> fetchedAt (YYYY-MM-DD)

async function fetchText(url) {
  const key = createHash('sha256').update(url).digest('hex').slice(0, 24);
  const file = resolve(CACHE_DIR, `${key}.json`);
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    usedEntries.set(url, hit.fetchedAt);
    return hit.body;
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
      const fetchedAt = new Date().toISOString().slice(0, 10);
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(file, JSON.stringify({ url, fetchedAt, body }));
      usedEntries.set(url, fetchedAt);
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

// Returns { data: Float64Array[nt*ny*nx] (NaN for missing), coords: { name: number[] } } for one Grid variable.
function parseGrid(text, varName, dims) {
  const lines = text.split('\n');
  const data = new Float64Array(dims.reduce((a, b) => a * b, 1));
  const coords = {};
  let section = null;
  let rows = 0;
  for (const line of lines) {
    const head = line.match(/^([\w.]+)\[([\d\]\[]+)\]$/);
    if (head) {
      section = head[1];
      continue;
    }
    if (section === `${varName}.${varName}`) {
      const m = line.match(/^((?:\[\d+\])+),\s*(.*)$/);
      if (!m) continue;
      const idx = [...m[1].matchAll(/\[(\d+)\]/g)].map((x) => Number(x[1]));
      const vals = m[2].split(',').map((s) => Number(s.trim()));
      // all but the last index identify the row; the last dimension is listed in order
      let base = 0;
      for (let k = 0; k < idx.length; k++) base = base * dims[k] + idx[k];
      base *= dims[dims.length - 1];
      if (vals.length !== dims[dims.length - 1]) throw new Error(`${varName}: row length ${vals.length}`);
      for (let k = 0; k < vals.length; k++) data[base + k] = vals[k] < MISSING_BELOW ? NaN : vals[k];
      rows++;
    } else if (section && line.trim() !== '') {
      const name = section.split('.').pop();
      coords[name] = line.split(',').map((s) => Number(s.trim()));
    }
  }
  const expectedRows = dims.slice(0, -1).reduce((a, b) => a * b, 1);
  if (rows !== expectedRows) throw new Error(`${varName}: parsed ${rows} rows, expected ${expectedRows}`);
  return { data, coords };
}

function parse1d(text, name) {
  const m = text.match(new RegExp(`^${name}\\[\\d+\\]\\n([^\\n]+)`, 'm'));
  if (!m) throw new Error(`no ${name} array in response`);
  return m[1].split(',').map((s) => Number(s.trim()));
}

const q = (s) => s.replace(/\[/g, '%5B').replace(/\]/g, '%5D');

// ---------- calendar helpers ----------

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const hoursSince1800 = (ms) => (ms - Date.UTC(1800, 0, 1)) / 3600000;
const daysSince1800 = (ms) => (ms - Date.UTC(1800, 0, 1)) / DAY_MS;

// ---------- resampling ----------

// Bilinear sample of grid g[ny][nx] with strictly monotonic lats (either direction) and increasing lons (0..360).
// Missing (NaN) neighbours are dropped and weights renormalised; result is NaN if valid weight < 0.5.
function makeSampler(srcLats, srcLons, grid) {
  const nx = srcLons.length;
  const ny = srcLats.length;
  const descending = srcLats[0] > srcLats[ny - 1];
  const lonStep = srcLons[1] - srcLons[0];
  return (lat, lon) => {
    const lon360 = ((lon % 360) + 360) % 360;
    const fx = (lon360 - srcLons[0]) / lonStep;
    const fy = descending ? (srcLats[0] - lat) / (srcLats[0] - srcLats[1]) : (lat - srcLats[0]) / (srcLats[1] - srcLats[0]);
    if (fx < 0 || fx > nx - 1 || fy < 0 || fy > ny - 1) throw new Error(`sample point ${lat},${lon} outside fetched window`);
    const x0 = Math.min(Math.floor(fx), nx - 2);
    const y0 = Math.min(Math.floor(fy), ny - 2);
    const tx = fx - x0;
    const ty = fy - y0;
    let sum = 0;
    let wsum = 0;
    for (const [dy, dx, w] of [
      [0, 0, (1 - tx) * (1 - ty)],
      [0, 1, tx * (1 - ty)],
      [1, 0, (1 - tx) * ty],
      [1, 1, tx * ty],
    ]) {
      const v = grid[(y0 + dy) * nx + x0 + dx];
      if (Number.isNaN(v) || w === 0) continue;
      sum += v * w;
      wsum += w;
    }
    return wsum >= 0.5 ? sum / wsum : NaN;
  };
}

// ---------- main ----------

const lonCentres = [];
for (let l = LON_MIN; l <= LON_MAX; l += STEP) lonCentres.push(l); // unwrapped, degrees east
const latCentres = [];
for (let l = LAT_MIN; l <= LAT_MAX; l += STEP) latCentres.push(l);
const outLons = lonCentres.map((l) => (l > 180 ? l - 360 : l));

function toScaled(v, scale) {
  if (Number.isNaN(v)) return null;
  return Math.round(v / scale) || 0; // `|| 0` avoids -0
}

async function loadErsstTimes() {
  const text = await fetchText(`${ERSST_URL}.ascii?${q('time[0:2072]')}`);
  const t = parse1d(text, 'time');
  if (t.length !== 2073) throw new Error(`ERSST time axis length ${t.length}`);
  return t.map((d) => Date.UTC(1800, 0, 1) + d * DAY_MS); // first day of each month, 00 UTC
}

async function buildStorm(storm, ersstMonthStarts) {
  const firstMs = dayMs(storm.points[0].t.slice(0, 10)) - DAY_MS;
  const lastMs = dayMs(storm.points.at(-1).t.slice(0, 10)) + DAY_MS;
  const dayList = [];
  for (let ms = firstMs; ms <= lastMs; ms += DAY_MS) dayList.push(ms);
  const nDays = dayList.length;
  usedEntries.clear(); // storms run sequentially, so this tracks only this storm
  const urls = new Set();
  const fields = Object.fromEntries(FIELDS.map((f) => [f, Array.from({ length: nDays })]));

  // ----- reanalysis -----
  const years = [...new Set(dayList.map((ms) => new Date(ms).getUTCFullYear()))];
  const latI0 = Math.floor((90 - LAT_MAX) / 2.5);
  const latI1 = Math.ceil((90 - LAT_MIN) / 2.5);
  const lonI0 = Math.floor(LON_MIN / 2.5);
  const lonI1 = Math.ceil(LON_MAX / 2.5);
  const nLat = latI1 - latI0 + 1;
  const nLon = lonI1 - lonI0 + 1;
  const jobs = [];
  for (const year of years) {
    const yearDays = dayList.map((ms, i) => ({ ms, i })).filter((d) => new Date(d.ms).getUTCFullYear() === year);
    const doy = (ms) => Math.round((ms - Date.UTC(year, 0, 1)) / DAY_MS);
    const t0 = doy(yearDays[0].ms);
    const t1 = doy(yearDays.at(-1).ms);
    for (const nv of NCEP_VARS) jobs.push({ year, yearDays, t0, t1, nv });
  }
  await pool(jobs, async ({ year, yearDays, t0, t1, nv }) => {
    const file = `${NCEP_BASE}/${nv.stem}.${year}.nc`;
    urls.add(file);
    const nT = t1 - t0 + 1;
    const query = `${nv.v}[${t0}:${t1}][${latI0}:${latI1}][${lonI0}:${lonI1}]`;
    const text = await fetchText(`${file}.ascii?${q(query)}`);
    const { data, coords } = parseGrid(text, nv.v, [nT, nLat, nLon]);
    if (coords.lat[0] !== 90 - latI0 * 2.5 || coords.lon[0] !== lonI0 * 2.5) throw new Error(`${file}: unexpected grid origin`);
    for (let k = 0; k < nT; k++) {
      const expectHours = hoursSince1800(yearDays[0].ms) + k * 24;
      if (coords.time[k] !== expectHours) throw new Error(`${file}: time[${k}] = ${coords.time[k]}, expected ${expectHours}`);
      const sample = makeSampler(coords.lat, coords.lon, data.subarray(k * nLat * nLon, (k + 1) * nLat * nLon));
      const out = new Array(latCentres.length * lonCentres.length);
      for (let r = 0; r < latCentres.length; r++) {
        for (let c = 0; c < lonCentres.length; c++) {
          out[r * lonCentres.length + c] = toScaled(nv.convert(sample(latCentres[r], lonCentres[c])), SCALE[nv.field]);
        }
      }
      fields[nv.field][yearDays[k].i] = out;
    }
  });

  // ----- SST: monthly fields, linear in time between month midpoints (noon UTC of each day) -----
  const monthIdx = (ms) => {
    let lo = 0;
    let hi = ersstMonthStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ersstMonthStarts[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const midpoint = (m) => (ersstMonthStarts[m] + ersstMonthStarts[m + 1]) / 2;
  const needed = new Set();
  const plan = dayList.map((ms) => {
    const noon = ms + DAY_MS / 2;
    let m = monthIdx(noon);
    if (noon < midpoint(m)) m -= 1; // before this month's midpoint: use previous and this month
    const w = (noon - midpoint(m)) / (midpoint(m + 1) - midpoint(m));
    needed.add(m);
    needed.add(m + 1);
    return { m, w };
  });
  const mMin = Math.min(...needed);
  const mMax = Math.max(...needed);
  const sLatI0 = Math.floor((88 - LAT_MAX) / 2);
  const sLatI1 = Math.ceil((88 - LAT_MIN) / 2);
  const sLonI0 = Math.floor(LON_MIN / 2);
  const sLonI1 = Math.ceil(LON_MAX / 2);
  const sNLat = sLatI1 - sLatI0 + 1;
  const sNLon = sLonI1 - sLonI0 + 1;
  const sNT = mMax - mMin + 1;
  urls.add(ERSST_URL);
  const sstText = await fetchText(`${ERSST_URL}.ascii?${q(`sst[${mMin}:${mMax}][${sLatI0}:${sLatI1}][${sLonI0}:${sLonI1}]`)}`);
  const sst = parseGrid(sstText, 'sst', [sNT, sNLat, sNLon]);
  if (sst.coords.lat[0] !== 88 - sLatI0 * 2 || sst.coords.lon[0] !== sLonI0 * 2) throw new Error('ERSST: unexpected grid origin');
  for (let k = 0; k < sNT; k++) {
    const got = daysSince1800(ersstMonthStarts[mMin + k]);
    if (sst.coords.time[k] !== got) throw new Error(`ERSST time[${k}] mismatch`);
  }
  // resample each needed month once, then blend in time
  const monthGrids = new Map();
  for (const m of needed) {
    const k = m - mMin;
    const sample = makeSampler(sst.coords.lat, sst.coords.lon, sst.data.subarray(k * sNLat * sNLon, (k + 1) * sNLat * sNLon));
    const g = new Float64Array(latCentres.length * lonCentres.length);
    for (let r = 0; r < latCentres.length; r++) {
      for (let c = 0; c < lonCentres.length; c++) g[r * lonCentres.length + c] = sample(latCentres[r], lonCentres[c]);
    }
    monthGrids.set(m, g);
  }
  plan.forEach(({ m, w }, i) => {
    const a = monthGrids.get(m);
    const b = monthGrids.get(m + 1);
    fields.sst[i] = Array.from(a, (va, j) => {
      const vb = b[j];
      if (Number.isNaN(va) && Number.isNaN(vb)) return null;
      const v = Number.isNaN(va) ? vb : Number.isNaN(vb) ? va : va * (1 - w) + vb * w;
      return toScaled(v, SCALE.sst);
    });
  });

  const fetchedAt = [...usedEntries.values()].sort().at(-1);
  return {
    typhoonId: storm.id,
    source: { ...srcLabel, urls: [...urls].sort(), fetchedAt },
    lons: outLons,
    lats: latCentres,
    days: dayList.map(isoDay),
    scale: SCALE,
    fields,
  };
}

function serialize(env) {
  const field = (name) => `"${name}":[\n${env.fields[name].map((d) => JSON.stringify(d)).join(',\n')}\n]`;
  return (
    '{\n' +
    [
      `"typhoonId":${JSON.stringify(env.typhoonId)}`,
      `"source":${JSON.stringify(env.source)}`,
      `"lons":${JSON.stringify(env.lons)}`,
      `"lats":${JSON.stringify(env.lats)}`,
      `"days":${JSON.stringify(env.days)}`,
      `"scale":${JSON.stringify(env.scale)}`,
      `"fields":{\n${FIELDS.map(field).join(',\n')}\n}`,
    ].join(',\n') +
    '\n}\n'
  );
}

const typhoons = JSON.parse(await readFile(INPUT, 'utf8')).typhoons;
await mkdir(OUT_DIR, { recursive: true });
const ersstMonthStarts = await loadErsstTimes();

let total = 0;
const rows = [];
for (const storm of typhoons) {
  const env = await buildStorm(storm, ersstMonthStarts);
  const text = serialize(env);
  await writeFile(resolve(OUT_DIR, `${storm.id}.json`), text);
  const bytes = Buffer.byteLength(text);
  total += bytes;
  const cells = env.lats.length * env.lons.length;
  const nullSst = env.fields.sst.reduce((n, d) => n + d.filter((x) => x === null).length, 0);
  const nullOther = FIELDS.filter((f) => f !== 'sst').reduce((n, f) => n + env.fields[f].reduce((m, d) => m + d.filter((x) => x === null).length, 0), 0);
  rows.push({ id: storm.id, days: env.days.length, cells, bytes, nullSst, nullOther });
  console.log(`${storm.id.padEnd(16)} days=${String(env.days.length).padStart(2)} cells/day=${cells} bytes=${bytes} sstNull=${nullSst} otherNull=${nullOther}`);
}
console.log(`total ${rows.length} files, ${total} bytes (${(total / 1e6).toFixed(2)} MB)`);
