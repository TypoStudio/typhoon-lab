#!/usr/bin/env node
// Builds src/data/generated/typhoons.json from the JMA RSMC Tokyo best-track archive.
// Usage: node scripts/prepare-typhoons.mjs   (needs network; output is deterministic for the pinned input)
// Offline: TYPHOON_BST_ZIP=/path/to/bst_all.zip node scripts/prepare-typhoons.mjs
// The zip is verified by SHA-256 before use; its single entry (bst_all.txt) is unpacked without external tools.
// This script writes the JMA storms only; run scripts/prepare-world-storms.mjs afterwards to add the NHC and IBTrACS storms.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src/data/generated/typhoons.json');

const SOURCE_URL = 'https://www.jma.go.jp/jma/jma-eng/jma-center/rsmc-hp-pub-eg/Besttracks/bst_all.zip';
const SOURCE_SHA256 = '76b65a4210e0a9f69c6ce56b401ac572d4203c11edf1f30691a20a891353cef6';
// Set once when the pinned file was downloaded (the file's Last-Modified is 2026-09-29); keeps the output deterministic.
const FETCHED_AT = '2026-10-23';
const ENTRY = 'bst_all.txt';
const KT_TO_MS = 0.514444;

// [JMA id, display name, Korean name, year]
const STORMS = [
  ['5914', 'Sarah', '사라', 1959],
  ['0215', 'Rusa', '루사', 2002],
  ['0314', 'Maemi', '매미', 2003],
  ['0711', 'Nari', '나리', 2007],
  ['1007', 'Kompasu', '곤파스', 2010],
  ['1215', 'Bolaven', '볼라벤', 2012],
  ['1216', 'Sanba', '산바', 2012],
  ['1618', 'Chaba', '차바', 2016],
  ['1913', 'Lingling', '링링', 2019],
  ['1918', 'Mitag', '미탁', 2019],
  ['2211', 'Hinnamnor', '힌남노', 2022],
  ['7920', 'Tip', '팁', 1979],
  ['1330', 'Haiyan', '하이옌', 2013],
  ['1822', 'Mangkhut', '망쿳', 2018],
];
const GRADES = { 2: 'TD', 3: 'TS', 4: 'STS', 5: 'TY', 6: 'L', 9: 'TS' }; // 9 = "TS or higher": only the lower bound is known

async function loadZip() {
  const local = process.env.TYPHOON_BST_ZIP;
  if (local) return readFile(local);
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`${SOURCE_URL} returned HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Reads the entry through the central directory: the local header may carry zero sizes (data descriptor).
function unzipEntry(zip, name) {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: end of central directory not found');
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central directory entry');
    const method = zip.readUInt16LE(p + 10);
    const compressedSize = zip.readUInt32LE(p + 20);
    const nameLength = zip.readUInt16LE(p + 28);
    const extraLength = zip.readUInt16LE(p + 30);
    const commentLength = zip.readUInt16LE(p + 32);
    const localOffset = zip.readUInt32LE(p + 42);
    const entryName = zip.toString('latin1', p + 46, p + 46 + nameLength);
    if (entryName === name) {
      if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('zip: bad local header');
      const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const raw = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return raw;
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`zip: unsupported compression method ${method}`);
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip: ${name} not found`);
}

// Slice by 1-based inclusive columns, as in the JMA format description.
const col = (line, from, to) => line.slice(from - 1, to).trim();

function parseTime(yymmddhh) {
  const yy = Number(yymmddhh.slice(0, 2));
  const year = (yy >= 50 ? 1900 : 2000) + yy;
  return `${year}-${yymmddhh.slice(2, 4)}-${yymmddhh.slice(4, 6)}T${yymmddhh.slice(6, 8)}:00:00Z`;
}

function parsePoint(line, id) {
  const grade = GRADES[Number(col(line, 14, 14))];
  const lat = Number(col(line, 16, 18)) / 10;
  const lon = Number(col(line, 20, 23)) / 10;
  const pressure = Number(col(line, 25, 28));
  const windKt = col(line, 34, 36);
  if (!grade || ![lat, lon, pressure].every(Number.isFinite) || pressure <= 0) {
    throw new Error(`${id}: unusable data line "${line.trimEnd()}"`);
  }
  const windMs = windKt === '' || Number(windKt) <= 0 ? null : Number((Number(windKt) * KT_TO_MS).toFixed(1));
  return { t: parseTime(line.slice(0, 8)), lat, lon, pressure, windMs, grade };
}

function parseStorms(text) {
  const lines = text.split(/\r?\n/);
  const wanted = new Map(STORMS.map((s) => [s[0], s]));
  const found = new Map();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('66666')) continue;
    const id = col(lines[i], 7, 10);
    const rows = Number(col(lines[i], 13, 15));
    if (!wanted.has(id)) { i += rows; continue; }
    if (found.has(id)) throw new Error(`${id}: appears twice`);
    const [, name, nameKo, year] = wanted.get(id);
    if (col(lines[i], 31, 50).toLowerCase() !== name.toLowerCase()) throw new Error(`${id}: header name "${col(lines[i], 31, 50)}" is not ${name}`);
    const points = lines.slice(i + 1, i + 1 + rows).map((line) => parsePoint(line, id));
    if (points.length !== rows) throw new Error(`${id}: expected ${rows} data lines, found ${points.length}`);
    for (let k = 1; k < points.length; k++) {
      if (points[k].t <= points[k - 1].t) throw new Error(`${id}: time is not increasing at ${points[k].t}`);
    }
    const winds = points.map((p) => p.windMs).filter((w) => w !== null);
    found.set(id, {
      id: `${name.toLowerCase()}-${year}`,
      jmaId: id,
      name,
      nameKo,
      year,
      agency: 'JMA',
      basin: 'Western North Pacific',
      peakPressure: Math.min(...points.map((p) => p.pressure)),
      peakWindMs: winds.length > 0 ? Math.max(...winds) : null,
      points,
    });
    i += rows;
  }
  for (const id of wanted.keys()) if (!found.has(id)) throw new Error(`${id}: not found in ${ENTRY}`);
  return STORMS.map((s) => found.get(s[0])).sort((a, b) => a.year - b.year || a.jmaId.localeCompare(b.jmaId));
}

async function main() {
  const zip = await loadZip();
  const digest = createHash('sha256').update(zip).digest('hex');
  if (digest !== SOURCE_SHA256) throw new Error(`bst_all.zip: SHA-256 ${digest} does not match pinned ${SOURCE_SHA256}`);
  const typhoons = parseStorms(unzipEntry(zip, ENTRY).toString('latin1'));

  const output = {
    source: {
      name: 'Japan Meteorological Agency, RSMC Tokyo best track data',
      url: SOURCE_URL,
      licence: 'JMA Public Data License 1.0, compatible with CC BY 4.0; attribution required (https://www.jma.go.jp/jma/en/copyright.html)',
      sha256: digest,
      fetchedAt: FETCHED_AT,
    },
    typhoons,
  };
  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
  console.log(`wrote ${OUTPUT}`);
  for (const t of typhoons) console.log(`${t.jmaId} ${t.id} ${t.points.length} points, peak ${t.peakPressure} hPa, ${t.peakWindMs ?? 'no'} m/s`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
