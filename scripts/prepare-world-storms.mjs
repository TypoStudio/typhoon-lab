#!/usr/bin/env node
// Adds famous storms from outside East Asia to src/data/generated/typhoons.json (the JMA storms written by
// prepare-typhoons.mjs stay untouched). Sources, all NOAA and public domain:
//   - NHC HURDAT2 (North Atlantic, Northeast/Central Pacific)
//   - NCEI IBTrACS v04r01 basin files (NI, SI, SP, SA)
// Usage: node scripts/prepare-world-storms.mjs   (downloads into .cache/world-storms/ once; later runs reuse the cache)
// Run it after prepare-typhoons.mjs, which rewrites typhoons.json from the JMA archive alone.
//
// Conversions
//   Wind: HURDAT2 and IBTrACS USA_WIND are 1-minute sustained winds in knots. The game uses 10-minute winds (JMA, WMO), and the
//   WMO conversion factor from 1-minute to 10-minute is 0.93, so windMs = kt * 0.514444 * 0.93. IBTrACS WMO_WIND is taken as is
//   (10-minute for most agencies; New Delhi reports 3-minute winds, which are left unconverted) and is preferred over USA_WIND.
//   Pressure: HURDAT2 -999 / IBTrACS blank means missing. Points before the first known pressure are dropped (the schema has no
//   null pressure), later gaps carry the previous pressure forward. A storm with no pressure at all is skipped.
//   Time: only 00/06/12/18 UTC rows are kept (this drops the off-hour landfall / peak-intensity records of HURDAT2 and the 3-hourly
//   interpolated rows of IBTrACS); a landfall record that falls on a synoptic hour is kept.
//   Grade: from the 10-minute wind, <17.2 TD, <24.5 TS, <32.7 STS, else TY; extratropical / disturbance / low / wave rows are 'L'.
//   Longitude is wrapped to -180..180 (IBTrACS gives some Pacific longitudes as 0..360); southern latitudes are negative.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src/data/generated/typhoons.json');
const CACHE = resolve(ROOT, '.cache/world-storms');

const KT_TO_MS = 0.514444;
const ONE_MIN_TO_TEN_MIN = 0.93;
const NHC_LICENCE = 'Public domain (US Government work, NOAA National Hurricane Center); attribution requested';
const NCEI_LICENCE = 'Public domain (US Government work, NOAA NCEI); cite Knapp et al. 2010, doi:10.1175/2009BAMS2755.1';
const IBTRACS = 'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv';

const FILES = {
  AL: { kind: 'hurdat', file: 'hurdat2-1851-2025-092326.txt', url: 'https://www.nhc.noaa.gov/data/hurdat/hurdat2-1851-2025-092326.txt', name: 'NOAA NHC HURDAT2, North Atlantic best track', licence: NHC_LICENCE },
  EP: { kind: 'hurdat', file: 'hurdat2-nepac-1949-2025-092926.txt', url: 'https://www.nhc.noaa.gov/data/hurdat/hurdat2-nepac-1949-2025-092926.txt', name: 'NOAA NHC HURDAT2, Northeast and Central Pacific best track', licence: NHC_LICENCE },
  NI: { kind: 'ibtracs', file: 'ibtracs.NI.list.v04r01.csv', url: `${IBTRACS}/ibtracs.NI.list.v04r01.csv`, name: 'NOAA NCEI IBTrACS v04r01, North Indian Ocean', licence: NCEI_LICENCE },
  SI: { kind: 'ibtracs', file: 'ibtracs.SI.list.v04r01.csv', url: `${IBTRACS}/ibtracs.SI.list.v04r01.csv`, name: 'NOAA NCEI IBTrACS v04r01, South Indian Ocean', licence: NCEI_LICENCE },
  SP: { kind: 'ibtracs', file: 'ibtracs.SP.list.v04r01.csv', url: `${IBTRACS}/ibtracs.SP.list.v04r01.csv`, name: 'NOAA NCEI IBTrACS v04r01, South Pacific', licence: NCEI_LICENCE },
  SA: { kind: 'ibtracs', file: 'ibtracs.SA.list.v04r01.csv', url: `${IBTRACS}/ibtracs.SA.list.v04r01.csv`, name: 'NOAA NCEI IBTrACS v04r01, South Atlantic', licence: NCEI_LICENCE },
};

const AGENCY = { hurdat: 'NHC', ibtracs: 'IBTrACS' };
const NA = 'North Atlantic';
const EP = 'Eastern North Pacific';
const NI = 'North Indian Ocean';
const SWI = 'South-West Indian Ocean';
const AUS = 'Australian region';
const SP = 'South Pacific';
const SA = 'South Atlantic';

// [file, storm id (ATCF id or IBTrACS SID), name in the file ('' = unnamed), display name, Korean name, year, basin]
const STORMS = [
  ['AL', 'AL031900', '', 'Galveston', '갤버스턴', 1900, NA],
  ['AL', 'AL091969', 'CAMILLE', 'Camille', '카밀', 1969, NA],
  ['AL', 'AL041992', 'ANDREW', 'Andrew', '앤드루', 1992, NA],
  ['AL', 'AL131998', 'MITCH', 'Mitch', '미치', 1998, NA],
  ['AL', 'AL122005', 'KATRINA', 'Katrina', '카트리나', 2005, NA],
  ['AL', 'AL252005', 'WILMA', 'Wilma', '윌마', 2005, NA],
  ['AL', 'AL182012', 'SANDY', 'Sandy', '샌디', 2012, NA],
  ['AL', 'AL092017', 'HARVEY', 'Harvey', '하비', 2017, NA],
  ['AL', 'AL112017', 'IRMA', 'Irma', '어마', 2017, NA],
  ['AL', 'AL152017', 'MARIA', 'Maria', '마리아', 2017, NA],
  ['AL', 'AL052019', 'DORIAN', 'Dorian', '도리안', 2019, NA],
  ['AL', 'AL092022', 'IAN', 'Ian', '이언', 2022, NA],
  ['EP', 'EP202015', 'PATRICIA', 'Patricia', '퍼트리샤', 2015, EP],
  ['EP', 'EP182023', 'OTIS', 'Otis', '오티스', 2023, EP],
  ['NI', '1970312N12086', '', 'Bhola', '볼라', 1970, NI],
  ['NI', '1999298N12099', '', 'Odisha', '오디샤', 1999, NI],
  ['NI', '2007151N14072', 'GONU', 'Gonu', '고누', 2007, NI],
  ['NI', '2007314N10093', 'SIDR', 'Sidr', '시드르', 2007, NI],
  ['NI', '2008117N11090', 'NARGIS', 'Nargis', '나르기스', 2008, NI],
  ['NI', '2019116N02090', 'FANI', 'Fani', '파니', 2019, NI],
  ['NI', '2020136N10088', 'AMPHAN', 'Amphan', '암판', 2020, NI],
  ['SI', '2019063S18038', 'IDAI', 'Idai', '이다이', 2019, SWI],
  ['SI', '2023036S12117', 'FREDDY', 'Freddy', '프레디', 2023, SWI],
  ['SP', '1974354S08135', 'TRACY', 'Tracy', '트레이시', 1974, AUS],
  ['SP', '2016041S14170', 'WINSTON', 'Winston', '윈스턴', 2016, SP],
  ['SP', '2015066S08170', 'PAM', 'Pam', '팜', 2015, SP],
  ['SP', '2011028S13180', 'YASI', 'Yasi', '야시', 2011, SP],
  ['SA', '2004086S29318', '', 'Catarina', '카타리나', 2004, SA],
];

async function loadFile(key) {
  const spec = FILES[key];
  const path = resolve(CACHE, spec.file);
  let info = await stat(path).catch(() => null);
  if (!info) {
    await mkdir(CACHE, { recursive: true });
    console.log(`downloading ${spec.url}`);
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`${spec.url} returned HTTP ${response.status}`);
    await writeFile(`${path}.part`, Buffer.from(await response.arrayBuffer()));
    await rename(`${path}.part`, path);
    info = await stat(path);
  }
  const bytes = await readFile(path);
  return {
    text: bytes.toString('latin1'),
    source: { name: spec.name, url: spec.url, licence: spec.licence, sha256: createHash('sha256').update(bytes).digest('hex'), fetchedAt: info.mtime.toISOString().slice(0, 10) },
  };
}

const windMsFromKt = (kt, factor) => (Number.isFinite(kt) && kt > 0 ? Number((kt * KT_TO_MS * factor).toFixed(1)) : null);
const wrapLon = (lon) => (lon > 180 ? lon - 360 : lon < -180 ? lon + 360 : lon); // IBTrACS gives some Pacific longitudes as 0..360
const gradeFromWind = (ms) => (ms < 17.2 ? 'TD' : ms < 24.5 ? 'TS' : ms < 32.7 ? 'STS' : 'TY');

// HURDAT2: header "AL122005, KATRINA, 34," then rows "20050828, 1800, , HU, 26.3N, 88.6W, 150, 902, ...".
const HURDAT_LOW = new Set(['EX', 'LO', 'WV', 'DB']);
const HURDAT_FALLBACK = { TD: 'TD', SD: 'TD', TS: 'TS', SS: 'TS', HU: 'STS' }; // grade when a row has no wind
function parseHurdat(text, id, fileName) {
  const lines = text.split(/\r?\n/);
  const h = lines.findIndex((line) => line.startsWith(`${id},`));
  if (h < 0) return null;
  const [, headerName, count] = lines[h].split(',').map((s) => s.trim());
  if (headerName !== fileName.toUpperCase()) throw new Error(`${id}: header name "${headerName}" is not "${fileName.toUpperCase()}"`);
  const rows = [];
  for (const line of lines.slice(h + 1, h + 1 + Number(count))) {
    const f = line.split(',').map((s) => s.trim());
    if (!['0000', '0600', '1200', '1800'].includes(f[1])) continue;
    const lat = Number(f[4].slice(0, -1)) * (f[4].endsWith('S') ? -1 : 1);
    const lon = Number(f[5].slice(0, -1)) * (f[5].endsWith('W') ? -1 : 1);
    const windMs = windMsFromKt(Number(f[6]), ONE_MIN_TO_TEN_MIN);
    const pressure = Number(f[7]);
    rows.push({
      t: `${f[0].slice(0, 4)}-${f[0].slice(4, 6)}-${f[0].slice(6, 8)}T${f[1].slice(0, 2)}:00:00Z`,
      lat, lon, windMs, pressure: pressure > 0 ? pressure : null,
      grade: HURDAT_LOW.has(f[3]) ? 'L' : windMs === null ? (HURDAT_FALLBACK[f[3]] ?? 'TD') : gradeFromWind(windMs),
    });
  }
  return rows;
}

// IBTrACS: header row, units row, then one row per time. Prefers WMO_WIND / WMO_PRES and falls back to USA_WIND (1-minute) / USA_PRES.
function parseIbtracs(text, sid, fileName) {
  const lines = text.split(/\r?\n/);
  const head = lines[0].split(',');
  const at = (name) => head.indexOf(name);
  const [iTime, iNature, iLat, iLon, iName, iWmoW, iWmoP, iUsaW, iUsaP] = ['ISO_TIME', 'NATURE', 'LAT', 'LON', 'NAME', 'WMO_WIND', 'WMO_PRES', 'USA_WIND', 'USA_PRES'].map(at);
  if ([iTime, iNature, iLat, iLon, iName, iWmoW, iWmoP, iUsaW, iUsaP].includes(-1)) throw new Error(`${fileName}: expected IBTrACS columns not found`);
  const num = (s) => (s.trim() === '' ? NaN : Number(s));
  const rows = [];
  const names = new Set();
  for (const line of lines) {
    if (!line.startsWith(`${sid},`)) continue;
    const c = line.split(',');
    names.add(c[iName].trim());
    const time = c[iTime].trim();
    if (!/^\d{4}-\d\d-\d\d (00|06|12|18):00:00$/.test(time)) continue;
    const wmo = num(c[iWmoW]);
    const windMs = wmo > 0 ? windMsFromKt(wmo, 1) : windMsFromKt(num(c[iUsaW]), ONE_MIN_TO_TEN_MIN);
    const wmoP = num(c[iWmoP]);
    const usaP = num(c[iUsaP]);
    const nature = c[iNature].trim();
    rows.push({
      t: `${time.slice(0, 10)}T${time.slice(11, 13)}:00:00Z`,
      lat: Number(c[iLat]), lon: wrapLon(Number(c[iLon])), windMs, pressure: wmoP > 0 ? wmoP : usaP > 0 ? usaP : null,
      grade: nature === 'ET' || nature === 'DS' ? 'L' : windMs === null ? 'TD' : gradeFromWind(windMs),
    });
  }
  return rows.length === 0 ? null : { rows, names };
}

function finish(rows, [, id, , name, nameKo, year, basin], agency) {
  // Drop leading rows without pressure, carry the last known pressure forward after that.
  const first = rows.findIndex((r) => r.pressure !== null);
  if (first < 0) return null;
  let last = 0;
  const points = rows.slice(first).map((r) => {
    last = r.pressure ?? last;
    return { t: r.t, lat: r.lat, lon: r.lon, pressure: last, windMs: r.windMs, grade: r.grade };
  });
  for (let k = 0; k < points.length; k++) {
    const p = points[k];
    if (![p.lat, p.lon].every(Number.isFinite) || p.lon < -180 || p.lon > 180 || Math.abs(p.lat) > 90) throw new Error(`${id}: bad position at ${p.t}`);
    if (k > 0 && p.t <= points[k - 1].t) throw new Error(`${id}: time is not increasing at ${p.t}`);
  }
  if (Number(points[0].t.slice(0, 4)) !== year) throw new Error(`${id}: first point ${points[0].t} is not in ${year}`);
  const winds = points.map((p) => p.windMs).filter((w) => w !== null);
  return {
    id: `${name.toLowerCase()}-${year}`,
    jmaId: id, // the agency's own storm id: the ATCF id for NHC, the SID for IBTrACS
    name,
    nameKo,
    year,
    agency,
    basin,
    peakPressure: Math.min(...points.map((p) => p.pressure)),
    peakWindMs: winds.length > 0 ? Math.max(...winds) : null,
    points,
  };
}

async function main() {
  const loaded = {};
  const sources = [];
  for (const key of new Set(STORMS.map((s) => s[0]))) {
    loaded[key] = await loadFile(key);
    sources.push(loaded[key].source);
  }

  const added = [];
  const skipped = [];
  for (const storm of STORMS) {
    const [key, id, fileName, name] = storm;
    const spec = FILES[key];
    let rows;
    if (spec.kind === 'hurdat') {
      rows = parseHurdat(loaded[key].text, id, fileName || 'UNNAMED');
    } else {
      const parsed = parseIbtracs(loaded[key].text, id, spec.file);
      if (parsed) {
        const expected = fileName || 'UNNAMED';
        if (!parsed.names.has(expected) && !(fileName === '' && parsed.names.has('NOT_NAMED'))) throw new Error(`${id}: names ${[...parsed.names]} do not include ${expected}`);
      }
      rows = parsed?.rows ?? null;
    }
    if (!rows) { skipped.push(`${name} ${id}: not found in ${spec.file}`); continue; }
    const typhoon = finish(rows, storm, AGENCY[spec.kind]);
    if (!typhoon) { skipped.push(`${name} ${id}: the record has no pressure at all`); continue; }
    added.push(typhoon);
  }

  const existing = JSON.parse(await readFile(OUTPUT, 'utf8'));
  const jma = existing.typhoons.filter((t) => t.agency === 'JMA');
  if (jma.length === 0) throw new Error('typhoons.json has no JMA storms: run prepare-typhoons.mjs first');
  added.sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
  const typhoons = [...jma, ...added].map((t, i) => [t, i]).sort(([a, i], [b, j]) => a.year - b.year || i - j).map(([t]) => t);
  const output = { source: existing.source, sources: [existing.source, ...sources], typhoons };
  await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
  console.log(`wrote ${OUTPUT}: ${jma.length} JMA + ${added.length} added storms`);
  for (const t of added) console.log(`${t.jmaId} ${t.id} [${t.agency}, ${t.basin}] ${t.points.length} points, peak ${t.peakPressure} hPa, ${t.peakWindMs ?? 'no'} m/s`);
  for (const s of skipped) console.log(`skipped ${s}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
