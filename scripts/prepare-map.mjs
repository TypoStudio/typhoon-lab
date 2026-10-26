#!/usr/bin/env node
// Builds src/data/generated/world-land.json, world-lakes.json, world-rivers.json, cities.json and places.json from Natural Earth v5.1.2 GeoJSON.
// Usage: node scripts/prepare-map.mjs   (needs network; output is deterministic for pinned inputs)
// Inputs are fetched from an immutable git tag and verified by SHA-256 before use.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = resolve(ROOT, 'src/data/generated/world-land.json');
const LAKES_OUTPUT = resolve(ROOT, 'src/data/generated/world-lakes.json');
const RIVERS_OUTPUT = resolve(ROOT, 'src/data/generated/world-rivers.json');
const PLACES_OUTPUT = resolve(ROOT, 'src/data/generated/places.json');
const CITIES_OUTPUT = resolve(ROOT, 'src/data/generated/cities.json');

const NE_TAG = 'v5.1.2';
const NE_BASE = `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/${NE_TAG}/geojson`;
const INPUTS = {
  land: { file: 'ne_50m_land.geojson', sha256: 'e874b27a51d146452be360cafb3cc50c86001074a67d534113e6534682f9826b' },
  // Rendering only: lakes are drawn as water over land, the simulation still treats them as land.
  lakes: { file: 'ne_50m_lakes.geojson', sha256: 'd350b75978b26fe839b797c2c529b2fb8f47fb3983c03f4964e36d5df9378a52' },
  // The scale_rank variant is used because the plain 50m file has no NAME_KO / NAME_JA / NAME_ZH / NAME_ZHT / WIKIDATAID columns.
  rivers: { file: 'ne_50m_rivers_lake_centerlines_scale_rank.geojson', sha256: 'b0b2ec37ff3057d25fc3d6324e79f5b9a076a956ef9aee6e20b2349f7ce36796' },
  // Dokdo is too small for the 50m land file; the 10m minor islands file has its western island.
  minorIslands: { file: 'ne_10m_minor_islands.geojson', sha256: '8c933ca7a4760256bdc46408355706e39764b0fa01c160c28888b90b4faec29f' },
  places: { file: 'ne_50m_populated_places_simple.geojson', sha256: '8e70756b39fae9bcdc1e332bfc510c024c5edd3a13203ffd20092ee37b61d978' },
  // Full (not _simple) file: carries NAME_KO / NAME_JA / NAME_ZH / NAME_ZHT, POP_MAX, SCALERANK and MIN_ZOOM for the display-only places layer.
  // The 10m file is used because the 50m one has only 5 South Korean places (no Daegu, Ulsan, Jeonju, ...).
  placesFull: { file: 'ne_10m_populated_places.geojson', sha256: '9b8e3de09048ef00dfc70357dbb9fa324493f214b5e0ae4daf1aa79a8d10116b' },
};

// Whole world. Natural Earth already splits polygons at the antimeridian, so no clipping is needed.
const WORLD = { west: -180, east: 180, south: -90, north: 90 };
const SIMPLIFY_DEG = 0.03; // about 3 km; 27k vertices and about 0.5 MB, smooth at continent zoom
const COORD_DECIMALS = 4; // about 11 m at the equator
const MIN_RING_AREA_DEG2 = 0.0001; // about 1 km²; smaller rings are sub-pixel even at high zoom

// Islands the map must always be able to show (Ulleungdo, Dokdo): rings centred in this box are kept as published (no simplification, no minimum area) and flagged `pinned`,
// which lifts them out of the tiny-island coast tier. Rings from the 10m minor islands file that are not in the 50m land file are appended and flagged `source: 'ne10m'`.
const PINNED_ISLAND_BOX = { west: 130.5, east: 132.2, south: 37.0, north: 37.7 };

// Lakes: scalerank <= MAX_LAKE_SCALERANK or area >= MIN_LAKE_AREA_DEG2 (deg², outer ring minus holes, before simplification). Caspian is already a hole in the land data.
const MAX_LAKE_SCALERANK = 5;
const MIN_LAKE_AREA_DEG2 = 0.1;
const EXCLUDED_LAKES = new Set(['Caspian Sea']);

// Rivers: featurecla River only (lake centrelines run through lakes that are drawn as water; canals are not rivers), scalerank <= MAX_RIVER_SCALERANK.
// A river is every feature with the same Wikidata id (else the same name), after MERGE_RIVERS folds source streams and distributaries into the main river.
const MAX_RIVER_SCALERANK = 6;
const RIVER_SIMPLIFY_DEG = 0.03;
const MIN_RIVER_PIECE_DEG = 0.3; // path length; shorter pieces are sub-pixel at the zoom where their tier shows
const RIVER_COORD_DECIMALS = 2; // about 1 km, below the simplification tolerance
const MERGE_RIVERS = {
  Q1038418: 'Q5413', Q1538813: 'Q5413', Q7821148: 'Q5413', // Jinsha, Tuotuo, Tongtian -> Yangtze
  Q4814791: 'Q3392', Q2750140: 'Q3392', 'Rosetta Branch': 'Q3392', 'Damietta Branch': 'Q3392', // White Nile, Kagera, delta branches -> Nile
  Q836812: 'Q3503', // Lualaba -> Congo
  Q2599627: 'Q45403', Maquan: 'Q45403', // Yarlung, Maquan -> Brahmaputra
  Q1511505: 'Q78707', 'Verkhniy Yenisey': 'Q78707', // Kyzyl-Khem, Upper Yenisey -> Yenisey
  Q26439: 'Q6862', // Hailar / Argun -> Amur
  Q947477: 'Q5419', // Madison -> Missouri
  Q2220: 'Q3411', Q2226: 'Q3411', // Peace, Slave -> Mackenzie
  Q1344617: 'Q1653', Q1668781: 'Q1653', Q1369180: 'Q1653', Borcea: 'Q1653', // Danube delta
  'Bykovskaya Protoka': 'Q46841', 'Olenekskaya Protoka': 'Q46841', // Lena delta
  Za: 'Q41179', "N'Mai": 'Q26076', Q3334104: 'Q26076', Q7666170: 'Q7348', Ideriyn: 'Q75745', Q26301: 'Q75745',
};
// The great rivers of the brief rank 2 here even where Natural Earth ranks them 3 or 4, so the country view shows them.
// Yellow River, Ganges, Amur, Indus, Niger, Volga, Murray, Yenisey.
const GREAT_RIVERS = new Set(['Q7355', 'Q5089', 'Q6862', 'Q7348', 'Q3542', 'Q626', 'Q183078', 'Q78707']);
const GREAT_RIVER_SCALERANK = 2;

// The original demo cities keep their id, English name and coordinates (50m file); their population now comes from the
// 10m file's POP_MAX like every other impact city. Each entry: [id, nameascii, adm0name]; adm0name disambiguates names.
const CITY_SOURCES = [
  ['manila', 'Manila', 'Philippines'],
  ['taipei', 'Taipei', 'Taiwan'],
  ['kaohsiung', 'Kaohsiung', 'Taiwan'],
  ['hong-kong', 'Hong Kong', 'Hong Kong S.A.R.'],
  ['shanghai', 'Shanghai', 'China'],
  ['busan', 'Busan', 'South Korea'],
  ['seoul', 'Seoul', 'South Korea'],
  ['osaka', 'Osaka', 'Japan'],
  ['tokyo', 'Tokyo', 'Japan'],
  ['new-york', 'New York', 'United States of America'],
  ['los-angeles', 'Los Angeles', 'United States of America'],
  ['mexico-city', 'Mexico City', 'Mexico'],
  ['lima', 'Lima', 'Peru'],
  ['sao-paulo', 'Sao Paulo', 'Brazil'],
  ['buenos-aires', 'Buenos Aires', 'Argentina'],
  ['cairo', 'Cairo', 'Egypt'],
  ['lagos', 'Lagos', 'Nigeria'],
  ['nairobi', 'Nairobi', 'Kenya'],
  ['johannesburg', 'Johannesburg', 'South Africa'],
  ['london', 'London', 'United Kingdom'],
  ['paris', 'Paris', 'France'],
  ['moscow', 'Moscow', 'Russia'],
  ['sydney', 'Sydney', 'Australia'],
  ['auckland', 'Auckland', 'New Zealand'],
  // Korea, Japan, China, Taiwan, Philippines, Vietnam: focus region for typhoon tracks.
  ['incheon', 'Incheon', 'South Korea'],
  ['daejeon', 'Daejeon', 'South Korea'],
  ['gwangju', 'Gwangju', 'South Korea'],
  ['pyongyang', 'Pyongyang', 'North Korea'],
  ['wonsan', 'Wonsan', 'North Korea'],
  ['sapporo', 'Sapporo', 'Japan'],
  ['sendai', 'Sendai', 'Japan'],
  ['fukuoka', 'Fukuoka', 'Japan'],
  ['nagoya', 'Nagoya', 'Japan'],
  ['naha', 'Naha', 'Japan'],
  ['taichung', 'Taichung', 'Taiwan'],
  ['guangzhou', 'Guangzhou', 'China'],
  ['shenzhen', 'Shenzhen', 'China'],
  ['xiamen', 'Xiamen', 'China'],
  ['fuzhou', 'Fuzhou', 'China'],
  ['wenzhou', 'Wenzhou', 'China'],
  ['qingdao', 'Qingdao', 'China'],
  ['cebu', 'Cebu', 'Philippines'],
  ['davao', 'Davao', 'Philippines'],
  ['zamboanga', 'Zamboanga', 'Philippines'],
  ['iloilo', 'Iloilo', 'Philippines'],
  ['laoag', 'Laoag', 'Philippines'],
  ['baguio', 'Baguio City', 'Philippines'],
  ['hanoi', 'Hanoi', 'Vietnam'],
  ['ho-chi-minh-city', 'Ho Chi Minh City', 'Vietnam'],
  ['da-nang', 'Da Nang', 'Vietnam'],
  // Atlantic and Pacific hurricane coasts, Caribbean, Hawaii.
  ['miami', 'Miami', 'United States of America'],
  ['houston', 'Houston', 'United States of America'],
  ['new-orleans', 'New Orleans', 'United States of America'],
  ['honolulu', 'Honolulu', 'United States of America'],
  ['havana', 'Havana', 'Cuba'],
  ['santo-domingo', 'Santo Domingo', 'Dominican Republic'],
  ['san-juan', 'San Juan', 'Puerto Rico'],
  ['kingston', 'Kingston', 'Jamaica'],
  // Bay of Bengal, Arabian Sea, Indian Ocean, southwest Pacific.
  ['dhaka', 'Dhaka', 'Bangladesh'],
  ['chattogram', 'Chattogram', 'Bangladesh'],
  ['kolkata', 'Kolkata', 'India'],
  ['mumbai', 'Mumbai', 'India'],
  ['karachi', 'Karachi', 'Pakistan'],
  ['colombo', 'Colombo', 'Sri Lanka'],
  ['yangon', 'Rangoon', 'Myanmar'],
  ['port-louis', 'Port Louis', 'Mauritius'],
  ['maputo', 'Maputo', 'Mozambique'],
  ['beira', 'Beira', 'Mozambique'],
  ['suva', 'Suva', 'Fiji'],
  ['port-moresby', 'Port Moresby', 'Papua New Guinea'],
  ['darwin', 'Darwin', 'Australia'],
];

async function fetchVerified({ file, sha256 }) {
  const url = `${NE_BASE}/${file}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error(`${file}: SHA-256 ${digest} does not match pinned ${sha256}`);
  return { json: JSON.parse(bytes.toString('utf8')), url, sha256: digest, bytes: bytes.length };
}

function distanceToSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Douglas–Peucker over an open line: keeps both ends.
function simplifyLine(points, tolerance) {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDistance = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = distanceToSegment(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        maxIndex = i;
      }
    }
    if (maxDistance > tolerance) {
      keep[maxIndex] = 1;
      stack.push([start, maxIndex], [maxIndex, end]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

// Douglas–Peucker over a closed ring: keeps the first point and walks back to it.
function simplifyRing(points, tolerance) {
  return simplifyLine([...points, points[0]], tolerance).slice(0, -1);
}

function ringArea(points) {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

const round = (value) => Number(value.toFixed(COORD_DECIMALS));

// Returns an open ring (no repeated first point) or null when it is too small to keep.
function prepareRing(geojsonRing) {
  const open = geojsonRing.slice(0, -1);
  const simplified = simplifyRing(open, SIMPLIFY_DEG).map(([x, y]) => [round(x), round(y)]);
  const deduped = simplified.filter((p, i) => {
    const q = simplified[(i + simplified.length - 1) % simplified.length];
    return p[0] !== q[0] || p[1] !== q[1];
  });
  if (deduped.length < 3 || ringArea(deduped) < MIN_RING_AREA_DEG2) return null;
  return deduped;
}

const isPinnedIsland = (geojsonRing) => {
  const xs = geojsonRing.map((p) => p[0]);
  const ys = geojsonRing.map((p) => p[1]);
  const x = (Math.min(...xs) + Math.max(...xs)) / 2;
  const y = (Math.min(...ys) + Math.max(...ys)) / 2;
  return x >= PINNED_ISLAND_BOX.west && x <= PINNED_ISLAND_BOX.east && y >= PINNED_ISLAND_BOX.south && y <= PINNED_ISLAND_BOX.north;
};

// Open ring as published, rounded; for the pinned islands only.
const rawRing = (geojsonRing) => geojsonRing.slice(0, -1).map(([x, y]) => [round(x), round(y)]);

function buildLandPolygons(landGeoJson, minorIslandsGeoJson) {
  const polygons = [];
  for (const feature of landGeoJson.features) {
    const { type, coordinates } = feature.geometry;
    const parts = type === 'Polygon' ? [coordinates] : coordinates;
    for (const part of parts) {
      if (isPinnedIsland(part[0])) {
        polygons.push({ outer: rawRing(part[0]), pinned: true });
        continue;
      }
      const outer = prepareRing(part[0]);
      if (!outer) continue;
      const holes = part.slice(1).map(prepareRing).filter(Boolean);
      polygons.push(holes.length > 0 ? { outer, holes } : { outer });
    }
  }
  for (const feature of minorIslandsGeoJson.features) {
    const { type, coordinates } = feature.geometry;
    for (const part of type === 'Polygon' ? [coordinates] : coordinates) {
      if (isPinnedIsland(part[0])) polygons.push({ outer: rawRing(part[0]), pinned: true, source: 'ne10m' });
    }
  }
  return polygons;
}

const inRing = (ring, x, y) => {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inPolygon = ({ outer, holes = [] }, x, y) => inRing(outer, x, y) && !holes.some((h) => inRing(h, x, y));

function ringCentroid(points) {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  return [cx / (3 * area), cy / (3 * area)];
}

// Label anchor: the centroid of the outer ring when it is in the water; otherwise the in-water node of a fine grid closest to it.
function labelAnchor(polygon) {
  const [cx, cy] = ringCentroid(polygon.outer);
  if (inPolygon(polygon, cx, cy)) return [round(cx), round(cy)];
  const xs = polygon.outer.map((p) => p[0]);
  const ys = polygon.outer.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const steps = 60;
  let best = null;
  for (let i = 0; i <= steps; i++) {
    for (let j = 0; j <= steps; j++) {
      const x = x0 + ((x1 - x0) * i) / steps;
      const y = y0 + ((y1 - y0) * j) / steps;
      const d = Math.hypot(x - cx, y - cy);
      if ((!best || d < best.d) && inPolygon(polygon, x, y)) best = { d, x, y };
    }
  }
  if (!best) throw new Error(`no label anchor inside polygon near ${cx},${cy}`);
  return [round(best.x), round(best.y)];
}

// Lakes as polygons plus label rows. Each name row has `polygon`: the index of its polygon in `polygons`.
function buildLakes(lakesGeoJson) {
  const seen = new Set();
  const features = lakesGeoJson.features
    .map((feature) => {
      const { type, coordinates } = feature.geometry;
      const parts = type === 'Polygon' ? [coordinates] : coordinates;
      const areaDeg2 = parts.reduce((sum, part) => sum + ringArea(part[0].slice(0, -1)) - part.slice(1).reduce((a, h) => a + ringArea(h.slice(0, -1)), 0), 0);
      return { p: feature.properties, parts, areaDeg2 };
    })
    .filter(({ p, areaDeg2 }) => !EXCLUDED_LAKES.has(p.name) && (p.scalerank <= MAX_LAKE_SCALERANK || areaDeg2 >= MIN_LAKE_AREA_DEG2))
    .sort((a, b) => b.areaDeg2 - a.areaDeg2 || a.p.scalerank - b.p.scalerank)
    // Natural Earth lists a few lakes twice (Volta, Zaysan) at different scaleranks with the same outline.
    .filter(({ p, areaDeg2 }) => {
      const key = `${p.name}|${areaDeg2.toFixed(4)}`;
      if (p.name && seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const polygons = [];
  const names = [];
  for (const { p, parts, areaDeg2 } of features) {
    let largest = null;
    for (const part of parts) {
      const outer = prepareRing(part[0]);
      if (!outer) continue;
      const holes = part.slice(1).map(prepareRing).filter(Boolean);
      const polygon = holes.length > 0 ? { outer, holes } : { outer };
      polygons.push(polygon);
      if (!largest || ringArea(outer) > ringArea(largest.outer)) largest = { polygon, index: polygons.length - 1 };
    }
    if (!largest || !p.name) continue;
    const [lon, lat] = labelAnchor(largest.polygon);
    const row = { name: p.name };
    const ko = typeof p.name_ko === 'string' ? p.name_ko.trim() : '';
    if (ko) row.nameKo = ko;
    const local = {};
    for (const [code, property] of [['ja', 'name_ja'], ['zh-CN', 'name_zh'], ['zh-TW', 'name_zht']]) {
      if (typeof p[property] === 'string' && p[property].trim()) local[code] = p[property].trim();
    }
    if (Object.keys(local).length) row.names = local;
    names.push({ ...row, lon, lat, scalerank: p.scalerank, areaDeg2: Number(areaDeg2.toFixed(3)), polygon: largest.index });
  }
  return { polygons, names };
}

const pathLength = (line) => line.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p[0] - line[i - 1][0], p[1] - line[i - 1][1])), 0);

// Joins lines that meet end to end at a point no third line touches (Natural Earth cuts rivers into many features).
function chainLines(lines) {
  let work = lines.map((line) => line.slice());
  for (;;) {
    const ends = new Map();
    work.forEach((line, i) => {
      for (const [end, p] of [['head', line[0]], ['tail', line[line.length - 1]]]) {
        const key = `${p[0]},${p[1]}`;
        if (!ends.has(key)) ends.set(key, []);
        ends.get(key).push({ i, end });
      }
    });
    const join = [...ends.values()].find((at) => at.length === 2 && at[0].i !== at[1].i);
    if (!join) return work;
    const [a, b] = join;
    // Orient a so it ends at the join and b so it starts there.
    const first = a.end === 'tail' ? work[a.i] : work[a.i].slice().reverse();
    const second = b.end === 'head' ? work[b.i] : work[b.i].slice().reverse();
    work = work.filter((_, i) => i !== a.i && i !== b.i);
    work.push([...first, ...second.slice(1)]);
  }
}

// Rivers grouped by Wikidata id (else name). Names and translations come from the group's longest own feature.
function buildRivers(riversGeoJson) {
  const groups = new Map();
  for (const feature of riversGeoJson.features) {
    const p = feature.properties;
    if (p.featurecla !== 'River' || !(p.scalerank <= MAX_RIVER_SCALERANK) || !p.name) continue;
    const own = p.wikidataid || p.name;
    const key = MERGE_RIVERS[own] ?? own;
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const line of lines) {
      for (let i = 1; i < line.length; i++) {
        if (Math.abs(line[i][0] - line[i - 1][0]) > 180) throw new Error(`antimeridian jump in river ${p.name} near ${line[i]}`);
      }
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ p, own, lines });
  }
  const rivers = [];
  for (const [key, members] of groups) {
    const vertices = (m) => m.lines.reduce((n, l) => n + l.length, 0);
    const pool = members.some((m) => m.own === key) ? members.filter((m) => m.own === key) : members;
    const primary = pool.slice().sort((a, b) => vertices(b) - vertices(a) || a.p.name.localeCompare(b.p.name))[0].p;
    const lines = chainLines(members.flatMap((m) => m.lines))
      .map((line) => simplifyLine(line, RIVER_SIMPLIFY_DEG).map(([x, y]) => [Number(x.toFixed(RIVER_COORD_DECIMALS)), Number(y.toFixed(RIVER_COORD_DECIMALS))]))
      .map((line) => line.filter((q, i) => i === 0 || q[0] !== line[i - 1][0] || q[1] !== line[i - 1][1]))
      .filter((line) => line.length >= 2 && pathLength(line) >= MIN_RIVER_PIECE_DEG);
    if (lines.length === 0) continue;
    const scalerank = Math.min(...members.map((m) => m.p.scalerank), GREAT_RIVERS.has(key) ? GREAT_RIVER_SCALERANK : Infinity);
    const row = { name: primary.name };
    const ko = typeof primary.name_ko === 'string' ? primary.name_ko.trim() : '';
    if (ko) row.nameKo = ko;
    const local = {};
    for (const [code, property] of [['ja', 'name_ja'], ['zh-CN', 'name_zh'], ['zh-TW', 'name_zht']]) {
      if (typeof primary[property] === 'string' && primary[property].trim()) local[code] = primary[property].trim();
    }
    if (Object.keys(local).length) row.names = local;
    rivers.push({ ...row, scalerank, lines });
  }
  return rivers.sort((a, b) => a.scalerank - b.scalerank || b.lines.reduce((n, l) => n + pathLength(l), 0) - a.lines.reduce((n, l) => n + pathLength(l), 0) || a.name.localeCompare(b.name));
}

// Fails if any source edge jumps across the antimeridian. Such an edge would make the
// ray-cast in src/data/world.ts wrong, so the source would need unwrapping first.
function assertNoAntimeridianJumps(landGeoJson) {
  for (const feature of landGeoJson.features) {
    const { type, coordinates } = feature.geometry;
    for (const part of type === 'Polygon' ? [coordinates] : coordinates) {
      for (const ring of part) {
        for (let i = 0; i < ring.length - 1; i++) {
          if (Math.abs(ring[i + 1][0] - ring[i][0]) > 180) {
            throw new Error(`antimeridian jump in ${feature.properties.featurecla} near ${ring[i]}`);
          }
        }
      }
    }
  }
}

function buildCityLocations(placesGeoJson) {
  const locations = {};
  for (const [id, asciiName, country] of CITY_SOURCES) {
    const matches = placesGeoJson.features.filter(
      (f) => f.properties.nameascii === asciiName && f.properties.adm0name === country,
    );
    if (matches.length !== 1) {
      throw new Error(`${asciiName} (${country}): expected 1 Natural Earth match, found ${matches.length}`);
    }
    const [lon, lat] = matches[0].geometry.coordinates;
    locations[id] = { sourceName: asciiName, country, lon, lat };
  }
  return locations;
}

// Impact cities: every 10m place with POP_MAX >= MIN_CITY_POP, merged with the original demo cities above.
// Display places (labels only): POP_MAX >= MIN_PLACE_POP or a national capital, minus the impact cities.
const MIN_CITY_POP = 500_000;
const MIN_PLACE_POP = 250_000;
const PLACE_DECIMALS = 3;
const KO_ADMIN_SUFFIX = /(특별자치시|특별자치도|특별시|광역시)$/;
// NAME_KO carries the administrative form (창원시, 요코하마시, 서울특별시); drop it for readable map labels.
const CJK_CITY_COUNTRIES = new Set(['South Korea', 'North Korea', 'Japan', 'China', 'Taiwan']);
const koLabel = (p) => {
  const ko = typeof p.NAME_KO === 'string' ? p.NAME_KO.trim().replace(KO_ADMIN_SUFFIX, '') : '';
  return CJK_CITY_COUNTRIES.has(p.ADM0NAME) && ko.length > 2 && ko.endsWith('시') ? ko.slice(0, -1) : ko;
};
// NAME_JA / NAME_ZH / NAME_ZHT carry the same administrative forms (東京都, 大邱広域市, 横浜市, 臺北市); strip them like nameKo.
const CJK_ADMIN_SUFFIX = /(特別自治市|特別自治道|特別市|広域市|廣域市|广域市)$/;
const cjkLabel = (p, property) => {
  const name = typeof p[property] === 'string' ? p[property].trim().replace(CJK_ADMIN_SUFFIX, '') : '';
  if (name === '東京都') return '東京';
  return CJK_CITY_COUNTRIES.has(p.ADM0NAME) && name.length > 2 && name.endsWith('市') ? name.slice(0, -1) : name;
};
// Japanese, Simplified and Traditional Chinese names; only the languages Natural Earth has a name for are present.
const localNames = (p) => {
  const names = {};
  for (const [code, property] of [['ja', 'NAME_JA'], ['zh-CN', 'NAME_ZH'], ['zh-TW', 'NAME_ZHT']]) {
    const label = cjkLabel(p, property);
    if (label) names[code] = label;
  }
  return names;
};
// `{ names }` for a city object, or nothing when Natural Earth has none of the three names.
const withNames = (p) => { const names = localNames(p); return Object.keys(names).length ? { names } : {}; };
const fold = (name) => name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slug = (name) => fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const isCapitalFeature = (p) => typeof p.FEATURECLA === 'string' && p.FEATURECLA.startsWith('Admin-0 capital');

// Natural Earth has no POP_YEAR column in v5.1.2; the figures are its 2010s-2020s estimates, recorded as 2025 like the old table.
const POPULATION_YEAR = 2025;
// The original table's English names where they differ from the 50m ASCII name.
const ENGLISH_NAME_OVERRIDES = { 'sao-paulo': 'São Paulo', baguio: 'Baguio', yangon: 'Yangon' };

// Returns impact cities largest first: [{ id, name, nameKo, names?, lon, lat, population, populationYear }].
function buildCities(placesFull, cityLocations) {
  const features = placesFull.features;
  const used = new Set();
  const originals = CITY_SOURCES.map(([id, asciiName]) => {
    const loc = cityLocations[id];
    const matches = features.filter(({ properties: p, geometry }) => {
      const d = Math.hypot(geometry.coordinates[0] - loc.lon, geometry.coordinates[1] - loc.lat);
      return d < 0.3 && (fold(p.NAME) === fold(asciiName) || fold(p.NAMEASCII ?? '') === fold(asciiName));
    });
    if (matches.length !== 1) throw new Error(`${asciiName}: expected 1 10m match within 0.3 deg, found ${matches.length}`);
    used.add(matches[0]);
    const p = matches[0].properties;
    return {
      id,
      name: ENGLISH_NAME_OVERRIDES[id] ?? asciiName,
      nameKo: koLabel(p) || null,
      ...withNames(p),
      lon: loc.lon,
      lat: loc.lat,
      population: p.POP_MAX,
      populationYear: p.POP_YEAR ?? POPULATION_YEAR,
    };
  });
  const additions = features
    .filter((f) => f.properties.POP_MAX >= MIN_CITY_POP && !used.has(f))
    // Anything already drawn by an original within 0.05 deg is the same city under another name (Yangon / Rangoon).
    .filter(({ geometry }) => !originals.some((c) => Math.hypot(c.lon - geometry.coordinates[0], c.lat - geometry.coordinates[1]) < 0.05))
    .sort((a, b) => b.properties.POP_MAX - a.properties.POP_MAX)
    // Twin entries of one metro area (Kansas City, MO and KS) sit within 0.05 deg of each other: keep the larger.
    .filter(({ geometry }, i, list) => !list.slice(0, i).some((o) => Math.hypot(o.geometry.coordinates[0] - geometry.coordinates[0], o.geometry.coordinates[1] - geometry.coordinates[1]) < 0.05))
    .map((f) => ({ f, base: slug(f.properties.NAMEASCII || f.properties.NAME) }));
  // Ids: the plain slug when unique; otherwise the slug plus the ISO country code, then plus coordinates as a last resort.
  const count = (key, list) => list.filter((k) => k === key).length;
  const baseIds = [...originals.map((c) => c.id), ...additions.map((a) => a.base)];
  const withCountry = additions.map((a) => (count(a.base, baseIds) > 1 ? `${a.base}-${slug(a.f.properties.ADM0_A3)}` : a.base));
  const taken = new Set(originals.map((c) => c.id));
  const result = [...originals];
  additions.forEach(({ f }, i) => {
    const [lon, lat] = f.geometry.coordinates;
    let id = withCountry[i];
    if (count(id, withCountry) > 1 || taken.has(id)) id = `${id}-${Math.round(Math.abs(lat) * 10)}${lat < 0 ? 's' : 'n'}${Math.round(Math.abs(lon) * 10)}${lon < 0 ? 'w' : 'e'}`;
    if (taken.has(id)) throw new Error(`duplicate city id ${id}`);
    taken.add(id);
    result.push({
      id,
      name: f.properties.NAME,
      nameKo: koLabel(f.properties) || null,
      ...withNames(f.properties),
      lon: Number(lon.toFixed(PLACE_DECIMALS)),
      lat: Number(lat.toFixed(PLACE_DECIMALS)),
      population: f.properties.POP_MAX,
      populationYear: f.properties.POP_YEAR ?? POPULATION_YEAR,
    });
  });
  return result.sort((a, b) => b.population - a.population || a.id.localeCompare(b.id));
}

// Rows are [name, nameKo|null, lon, lat, popMax, scalerank, minZoom, names?], largest first.
function buildPlaces(placesGeoJson, cities) {
  const named = cities.map((c) => ({ name: fold(c.name), lon: c.lon, lat: c.lat }));
  const rows = [];
  for (const { properties: p, geometry } of placesGeoJson.features) {
    if (!(p.POP_MAX >= MIN_PLACE_POP) && !isCapitalFeature(p)) continue;
    const [lon, lat] = geometry.coordinates;
    // Drop what an impact city already draws: same name within 0.3 deg, or anything within 0.05 deg.
    const duplicate = named.some((c) => {
      const d = Math.hypot(c.lon - lon, c.lat - lat);
      return d < 0.05 || (d < 0.3 && (c.name === fold(p.NAME) || c.name === fold(p.NAMEASCII ?? '')));
    });
    if (duplicate) continue;
    // Every 10m place at or above the impact threshold is an impact city, so none of them may remain here.
    if (p.POP_MAX >= MIN_CITY_POP) throw new Error(`${p.NAME} (${p.POP_MAX}) is above the impact threshold but not an impact city`);
    const row = [p.NAME, koLabel(p) || null, Number(lon.toFixed(PLACE_DECIMALS)), Number(lat.toFixed(PLACE_DECIMALS)), p.POP_MAX ?? 0, p.SCALERANK, p.MIN_ZOOM];
    const names = localNames(p);
    rows.push(Object.keys(names).length ? [...row, names] : row);
  }
  return rows.sort((a, b) => b[4] - a[4] || a[0].localeCompare(b[0]));
}

function countGeometry(polygons) {
  let rings = 0;
  let holes = 0;
  let vertices = 0;
  for (const polygon of polygons) {
    const all = [polygon.outer, ...(polygon.holes ?? [])];
    rings += all.length;
    holes += polygon.holes?.length ?? 0;
    for (const ring of all) vertices += ring.length;
  }
  return { polygons: polygons.length, rings, holes, vertices };
}

async function main() {
  const [land, minorIslands, lakes, rivers, places, placesFull] = await Promise.all([fetchVerified(INPUTS.land), fetchVerified(INPUTS.minorIslands), fetchVerified(INPUTS.lakes), fetchVerified(INPUTS.rivers), fetchVerified(INPUTS.places), fetchVerified(INPUTS.placesFull)]);
  assertNoAntimeridianJumps(land.json);
  assertNoAntimeridianJumps(lakes.json);
  const lakeData = buildLakes(lakes.json);
  const riverRows = buildRivers(rivers.json);
  const landPolygons = buildLandPolygons(land.json, minorIslands.json);
  const cityLocations = buildCityLocations(places.json);
  const cities = buildCities(placesFull.json, cityLocations);
  const placeRows = buildPlaces(placesFull.json, cities);
  const counts = countGeometry(landPolygons);

  const output = {
    meta: {
      description:
        'Derived from Natural Earth public-domain vectors for the fictional worldwide map. Generated by scripts/prepare-map.mjs; do not edit by hand.',
      source: {
        name: 'Natural Earth',
        version: NE_TAG,
        license: 'Public domain (Natural Earth terms of use: https://www.naturalearthdata.com/about/terms-of-use/)',
        repository: `https://github.com/nvkelso/natural-earth-vector/tree/${NE_TAG}/geojson`,
        files: [
          { name: 'ne_50m_land', url: land.url, sha256: land.sha256, bytes: land.bytes, usedFor: 'landPolygons' },
          { name: 'ne_10m_minor_islands', url: minorIslands.url, sha256: minorIslands.sha256, bytes: minorIslands.bytes, usedFor: 'Dokdo (pinned islands inside the box lon 130.5..132.2, lat 37.0..37.7)' },
        ],
      },
      coverageDeg: WORLD,
      antimeridian:
        'Natural Earth splits polygons at ±180; coordinates are kept as published (checked: no raw edge jumps across ±180). Simplification may add one chord along the Antarctic pole edge (|lat| > 89).',
      simplifyToleranceDeg: SIMPLIFY_DEG,
      coordinateDecimals: COORD_DECIMALS,
      minRingAreaDeg2: MIN_RING_AREA_DEG2,
      ringOrder: 'open rings, outer ring first, GeoJSON lon/lat order',
      counts,
    },
    landPolygons,
  };

  const lakeOutput = {
    meta: {
      description:
        'Lakes from Natural Earth public-domain vectors, drawn as water over land (rendering only; the simulation still treats lake cells as land). Generated by scripts/prepare-map.mjs; do not edit by hand.',
      source: {
        name: 'Natural Earth',
        version: NE_TAG,
        license: 'Public domain (Natural Earth terms of use: https://www.naturalearthdata.com/about/terms-of-use/)',
        files: [{ name: 'ne_50m_lakes', url: lakes.url, sha256: lakes.sha256, bytes: lakes.bytes, usedFor: 'polygons, names' }],
      },
      filter: `scalerank <= ${MAX_LAKE_SCALERANK} or area >= ${MIN_LAKE_AREA_DEG2} deg2; excluded by name: ${[...EXCLUDED_LAKES].join(', ')}`,
      simplifyToleranceDeg: SIMPLIFY_DEG,
      coordinateDecimals: COORD_DECIMALS,
      minRingAreaDeg2: MIN_RING_AREA_DEG2,
      ringOrder: 'open rings, outer ring first, GeoJSON lon/lat order',
      counts: { ...countGeometry(lakeData.polygons), names: lakeData.names.length },
    },
    ...lakeData,
  };

  const riverOutput = {
    meta: {
      description:
        'Major rivers from Natural Earth public-domain vectors, drawn as thin lines (rendering only). Generated by scripts/prepare-map.mjs; do not edit by hand.',
      source: {
        name: 'Natural Earth',
        version: NE_TAG,
        license: 'Public domain (Natural Earth terms of use: https://www.naturalearthdata.com/about/terms-of-use/)',
        files: [{ name: 'ne_50m_rivers_lake_centerlines_scale_rank', url: rivers.url, sha256: rivers.sha256, bytes: rivers.bytes, usedFor: 'lines, names' }],
      },
      filter: `featurecla River, scalerank <= ${MAX_RIVER_SCALERANK}; grouped by Wikidata id or name; scalerank raised to ${GREAT_RIVER_SCALERANK} for ${GREAT_RIVERS.size} great rivers`,
      simplifyToleranceDeg: RIVER_SIMPLIFY_DEG,
      minPieceDeg: MIN_RIVER_PIECE_DEG,
      coordinateDecimals: RIVER_COORD_DECIMALS,
      counts: { rivers: riverRows.length, lines: riverRows.reduce((n, r) => n + r.lines.length, 0), vertices: riverRows.reduce((n, r) => n + r.lines.reduce((m, l) => m + l.length, 0), 0) },
    },
    rivers: riverRows,
  };

  await mkdir(dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(output)}\n`);
  await writeFile(LAKES_OUTPUT, `${JSON.stringify(lakeOutput)}\n`);
  await writeFile(RIVERS_OUTPUT, `${JSON.stringify(riverOutput)}\n`);
  await writeFile(CITIES_OUTPUT, `${JSON.stringify(cities)}\n`);
  await writeFile(PLACES_OUTPUT, `${JSON.stringify(placeRows)}\n`);
  console.log(`wrote ${OUTPUT}`);
  console.log(`wrote ${LAKES_OUTPUT}: ${JSON.stringify(lakeOutput.meta.counts)}`);
  console.log(`wrote ${RIVERS_OUTPUT}: ${JSON.stringify(riverOutput.meta.counts)}`);
  console.log(`wrote ${CITIES_OUTPUT}: ${cities.length} impact cities (POP_MAX >= ${MIN_CITY_POP}, plus the ${CITY_SOURCES.length} originals)`);
  console.log(`wrote ${PLACES_OUTPUT}: ${placeRows.length} places`);
  console.log(JSON.stringify(counts));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
