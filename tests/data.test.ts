import { describe, expect, it } from 'vitest';
import generated from '../src/data/generated/world-land.json';
import { MANUAL_ISLANDS } from '../src/data/islands';
import { CITIES, LAND_POLYGONS, SCENARIO, isLand } from '../src/data/world';
import { ORIGINAL_CITY_IDS } from './fixtures/original-cities';

const WORLD = { west: -180, east: 180, south: -90, north: 90 };
const rings = LAND_POLYGONS.flatMap((polygon) => [polygon.outer, ...(polygon.holes ?? [])]);

// Even-odd point test for one ring, used to check that holes lie inside their outer ring.
function ringContains(ring: [number, number][], lon: number, lat: number): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  return inside;
}

describe('bundled world geometry', () => {
  it('exports the counts recorded by the preparation script', () => {
    const holes = LAND_POLYGONS.reduce((sum, polygon) => sum + (polygon.holes?.length ?? 0), 0);
    // The hand-made islands in src/data/islands.ts come on top of the generated file; each is one outer ring.
    const manualVertices = MANUAL_ISLANDS.reduce((sum, polygon) => sum + polygon.outer.length, 0);
    const vertices = rings.reduce((sum, ring) => sum + ring.length, 0) - manualVertices;
    expect(LAND_POLYGONS.length - MANUAL_ISLANDS.length).toBe(generated.meta.counts.polygons);
    expect(rings.length - MANUAL_ISLANDS.length).toBe(generated.meta.counts.rings);
    expect(holes).toBe(generated.meta.counts.holes);
    expect(vertices).toBe(generated.meta.counts.vertices);
  });

  it('keeps the geometry bounded for the browser', () => {
    expect(generated.meta.counts.vertices).toBeLessThan(40_000);
  });

  it('covers the whole world from -180 to 180 longitude and -90 to 90 latitude', () => {
    const lons = rings.flatMap((ring) => ring.map(([lon]) => lon));
    const lats = rings.flatMap((ring) => ring.map(([, lat]) => lat));
    expect(Math.min(...lons)).toBe(WORLD.west);
    expect(Math.max(...lons)).toBe(WORLD.east);
    expect(Math.min(...lats)).toBeLessThan(-89);
    expect(Math.max(...lats)).toBeGreaterThan(83);
  });

  it('keeps every ring valid and inside the world bounds', () => {
    for (const ring of rings) {
      expect(ring.length).toBeGreaterThanOrEqual(3);
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const next = ring[(i + 1) % ring.length];
        expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
        expect(lon).toBeGreaterThanOrEqual(WORLD.west);
        expect(lon).toBeLessThanOrEqual(WORLD.east);
        expect(lat).toBeGreaterThanOrEqual(WORLD.south);
        expect(lat).toBeLessThanOrEqual(WORLD.north);
        expect(lon === next[0] && lat === next[1]).toBe(false);
      }
    }
  });

  // Simplification can join two points on either side of ±180 with one chord. That is only
  // allowed along the Antarctic pole edge, where the chord runs at the map's southern limit.
  it('has no edge that jumps across the antimeridian except along the pole edge', () => {
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const [lon, lat] = ring[i];
        const next = ring[(i + 1) % ring.length];
        if (Math.abs(next[0] - lon) > 180) {
          expect(Math.abs(lat)).toBeGreaterThan(89);
          expect(Math.abs(next[1])).toBeGreaterThan(89);
        }
      }
    }
  });

  it('keeps each hole inside its outer ring', () => {
    const polygonsWithHoles = LAND_POLYGONS.filter((polygon) => polygon.holes && polygon.holes.length > 0);
    expect(polygonsWithHoles.length).toBeGreaterThan(0);
    for (const polygon of polygonsWithHoles) {
      for (const hole of polygon.holes ?? []) {
        expect(hole.length).toBeGreaterThanOrEqual(3);
        for (const [lon, lat] of hole) expect(ringContains(polygon.outer, lon, lat)).toBe(true);
      }
    }
  });

  it('records the Natural Earth source and public-domain license', () => {
    expect(generated.meta.source.version).toBe('v5.1.2');
    expect(generated.meta.source.license).toMatch(/Public domain/);
    for (const file of generated.meta.source.files) expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isLand on every continent and ocean', () => {
  const landSamples: [string, number, number][] = [
    ['Denver, North America', -104.99, 39.74],
    ['Brasilia, South America', -47.88, -15.79],
    ['Nairobi, Africa', 36.82, -1.29],
    ['Paris, Europe', 2.35, 48.86],
    ['Beijing, Asia', 116.4, 39.9],
    ['Alice Springs, Australia', 133.88, -23.7],
    ['Interior Antarctica', 0, -80],
    ['Central Greenland', -40, 72],
    ['Siberia', 100, 60],
    ['Tokyo', 139.69, 35.69],
    ['Manila', 120.98, 14.6],
    ['Chukotka interior, near the dateline', 172, 66],
    ['Viti Levu, Fiji', 177.8, -18],
  ];
  const oceanSamples: [string, number, number][] = [
    ['Atlantic', -30, 20],
    ['Pacific', -150, 0],
    ['Indian Ocean', 80, -20],
    ['Southern Ocean', 0, -60],
    ['Arctic Ocean', 0, 85],
    ['Philippine Sea', 130, 15],
    ['Yellow Sea', 123, 35],
    ['Pacific at the dateline', 179.5, 0],
    ['Caspian Sea (hole)', 51, 41],
  ];

  it.each(landSamples)('reports land at %s', (_name, lon, lat) => {
    expect(isLand(lon, lat)).toBe(true);
  });

  it.each(oceanSamples)('reports water at %s', (_name, lon, lat) => {
    expect(isLand(lon, lat)).toBe(false);
  });

  it('wraps longitude so the dateline is seamless', () => {
    expect(isLand(180, 65)).toBe(isLand(-180, 65));
    expect(isLand(172 + 360, 66)).toBe(isLand(172, 66));
    expect(isLand(-179.5, 0)).toBe(isLand(180.5, 0));
  });

  it('returns false outside latitude range and for invalid input', () => {
    expect(isLand(0, 95)).toBe(false);
    expect(isLand(0, -95)).toBe(false);
    expect(isLand(Number.NaN, 35)).toBe(false);
    expect(isLand(0, Number.NaN)).toBe(false);
  });
});

const byId = new Map(CITIES.map((city) => [city.id, city]));

describe('cities', () => {
  it('lists about a thousand impact cities with unique ids, largest first', () => {
    expect(CITIES.length).toBeGreaterThanOrEqual(800);
    expect(CITIES.length).toBeLessThanOrEqual(1500);
    expect(new Set(CITIES.map((city) => city.id)).size).toBe(CITIES.length);
    for (let i = 1; i < CITIES.length; i++) expect(CITIES[i - 1].population).toBeGreaterThanOrEqual(CITIES[i].population);
  });

  it('keeps the original 71 cities with their ids and English names, drawn from the same Natural Earth source', () => {
    expect(ORIGINAL_CITY_IDS).toHaveLength(71);
    for (const id of ORIGINAL_CITY_IDS) expect(byId.has(id), id).toBe(true);
    expect(byId.get('sao-paulo')?.name).toBe('São Paulo');
    expect(byId.get('baguio')?.name).toBe('Baguio');
    expect(byId.get('yangon')?.name).toBe('Yangon');
    expect(byId.get('ho-chi-minh-city')?.name).toBe('Ho Chi Minh City');
    // Natural Earth pop_max replaced the invented round numbers (Tokyo was 20 M).
    expect(byId.get('tokyo')?.population).toBeGreaterThan(30_000_000);
  });

  it('has Daegu and Ulsan with Korean names, and a Korean name for nearly every city', () => {
    expect(byId.get('daegu')?.nameKo).toBe('대구');
    expect(byId.get('ulsan')?.nameKo).toBe('울산');
    expect(CITIES.filter((city) => !city.nameKo).length).toBeLessThan(CITIES.length * 0.02);
  });

  it('has Japanese and Chinese names for Daegu and nearly every city', () => {
    expect(byId.get('daegu')?.names).toEqual({ ja: '大邱', 'zh-CN': '大邱', 'zh-TW': '大邱' });
    expect(byId.get('seoul')?.names).toEqual({ ja: 'ソウル', 'zh-CN': '首尔', 'zh-TW': '首爾' });
    expect(byId.get('tokyo')?.names).toEqual({ ja: '東京', 'zh-CN': '东京', 'zh-TW': '東京' });
    for (const code of ['ja', 'zh-CN', 'zh-TW'] as const) {
      expect(CITIES.filter((city) => !city.names?.[code]).length, code).toBeLessThan(CITIES.length * 0.02);
    }
  });

  it('gives cities sharing an English name distinct, readable ids', () => {
    expect(CITIES.filter((city) => city.name === 'San Jose' || city.name === 'San José').length).toBeGreaterThanOrEqual(2);
    for (const city of CITIES) expect(city.id, city.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('covers Korea, Japan, China, and the Philippines, plus cyclone coasts elsewhere', () => {
    const ids = new Set(CITIES.map((city) => city.id));
    const focus = {
      korea: ['seoul', 'busan', 'incheon', 'daejeon', 'gwangju', 'pyongyang', 'wonsan'],
      japan: ['tokyo', 'osaka', 'sapporo', 'sendai', 'fukuoka', 'nagoya', 'naha'],
      china: ['shanghai', 'hong-kong', 'guangzhou', 'shenzhen', 'xiamen', 'fuzhou', 'wenzhou', 'qingdao'],
      philippines: ['manila', 'cebu', 'davao', 'zamboanga', 'iloilo', 'laoag', 'baguio'],
      cyclone: ['miami', 'houston', 'new-orleans', 'havana', 'kingston', 'dhaka', 'kolkata', 'mumbai', 'karachi', 'yangon', 'maputo', 'beira', 'port-louis', 'darwin'],
    };
    for (const [region, list] of Object.entries(focus)) {
      for (const id of list) expect(ids.has(id), `${region}: ${id}`).toBe(true);
    }
  });

  it('uses coordinates inside the world bounds', () => {
    for (const city of CITIES) {
      expect(city.lon).toBeGreaterThanOrEqual(WORLD.west);
      expect(city.lon).toBeLessThanOrEqual(WORLD.east);
      expect(city.lat).toBeGreaterThanOrEqual(WORLD.south);
      expect(city.lat).toBeLessThanOrEqual(WORLD.north);
    }
  });

  // Natural Earth 50m generalizes coastlines, so some harbour cities sit a few kilometres off
  // the drawn land (New York is about 0.035° from it). The original 71 must be within 0.05° (about 5 km);
  // the others come from the 10m file against our simplified coastline, and many are inland or on estuaries,
  // so they only need to be within 0.5° of land (this still catches a swapped or wrong-signed coordinate).
  it('places each city on land or near the generalized coastline', () => {
    const originals = new Set(ORIGINAL_CITY_IDS);
    const STEP = 0.01;
    for (const city of CITIES) {
      const radius = originals.has(city.id) ? 0.05 : 0.5;
      const step = radius > 0.05 ? 0.05 : STEP;
      let onOrNearLand = false;
      for (let dLon = -radius; dLon <= radius + 1e-9 && !onOrNearLand; dLon += step) {
        for (let dLat = -radius; dLat <= radius + 1e-9 && !onOrNearLand; dLat += step) {
          if (Math.hypot(dLon, dLat) <= radius && isLand(city.lon + dLon, city.lat + dLat)) onOrNearLand = true;
        }
      }
      expect(onOrNearLand, city.name).toBe(true);
    }
  });

  it('uses whole Natural Earth populations: at least 500,000 except for the originals', () => {
    const originals = new Set(ORIGINAL_CITY_IDS);
    for (const city of CITIES) {
      expect(Number.isInteger(city.population)).toBe(true);
      expect(city.population).toBeGreaterThan(0);
      expect(city.populationYear).toBe(2025);
      if (!originals.has(city.id)) expect(city.population, city.name).toBeGreaterThanOrEqual(500_000);
    }
    // Originals below 500,000 (Darwin, Suva, ...) keep their place in the game with their real, smaller figure.
    expect(CITIES.filter((city) => city.population < 500_000).every((city) => originals.has(city.id))).toBe(true);
  });
});

describe('scenario', () => {
  it('has the fixed worldwide identity', () => {
    expect(SCENARIO.id).toBe('world-fictional-2025-a');
    expect(SCENARIO.version).toBe('0.8.0');
    expect(SCENARIO.seed).toBe(20261022);
  });

  it('has no budget or round limit', () => {
    expect(SCENARIO).not.toHaveProperty('budget');
    expect(SCENARIO).not.toHaveProperty('maxHours');
  });

  it('describes an unlimited, fictional real-time world', () => {
    expect(SCENARIO.description).toContain('unlimited');
    expect(SCENARIO.description).toContain('real-time');
    expect(SCENARIO.description).toContain('fictional');
    expect(SCENARIO.populationNote).toContain('2025');
  });

  it('cites Natural Earth and does not claim external weather or population ingestion', () => {
    const names = SCENARIO.sources.map((source) => source.name).join(' ');
    expect(names).toContain('Natural Earth');
    expect(names).not.toMatch(/GFS|OISST|GHS|IBTrACS|GEBCO/);
  });
});
