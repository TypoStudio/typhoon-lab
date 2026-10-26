import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { destination, geoToUnit, limbFade } from '../src/render/camera';
import { GlobeView } from '../src/render/globe-view';
import { FlatView, MapView, lonDelta } from '../src/render/view';

const W = 1440, H = 900;
const globe = (lon = 150, lat = 0, span = 60): GlobeView => {
  const v = new GlobeView(); v.resize(W, H); v.setHome(lon, lat, span); return v;
};
const CENTRES: [number, number][] = [[0, 0], [150, 30], [179, -60], [-100, 80]];

describe('camera helpers', () => {
  it('geoToUnit gives unit vectors on the expected axes', () => {
    const u = new Float64Array(6);
    geoToUnit(0, 0, u); geoToUnit(90, 0, u, 3);
    expect(Array.from(u)).toEqual([0, 0, 1, 1, 0, 6.123233995736766e-17]);
    expect(geoToUnit(10, 90, new Float64Array(3))[1]).toBe(1);
  });

  it('destination follows great circles', () => {
    const [lon, lat] = destination(10, 0, 111.19492664455873, Math.PI / 2);
    expect(lon).toBeCloseTo(11, 6); expect(lat).toBeCloseTo(0, 9);
    const [nl, nlat] = destination(30, 80, 2 * 111.19492664455873, 0);
    expect(nlat).toBeCloseTo(82, 6); expect(nl).toBeCloseTo(30, 9);
    expect(destination(179.5, 0, 111.2, Math.PI / 2)[0]).toBeLessThan(-179);
  });

  it('limbFade ramps between z = 0.05 and 0.2', () => {
    expect(limbFade(0)).toBe(0); expect(limbFade(0.05)).toBe(0);
    expect(limbFade(0.125)).toBeCloseTo(0.5, 12); expect(limbFade(0.2)).toBe(1); expect(limbFade(1)).toBe(1);
  });
});

describe('GlobeView projection', () => {
  it('round-trips lon/lat through pixels at several centres', () => {
    for (const [lon0, lat0] of CENTRES) {
      const v = globe(lon0, lat0, 90);
      for (const dLon of [-60, -20, 0, 15, 50]) for (const dLat of [-40, -10, 0, 20, 35]) {
        const lon = lon0 + dLon, lat = Math.max(-89, Math.min(89, lat0 + dLat));
        const px = v.lonLatToPx(lon, lat);
        if (!px) continue;
        const back = v.pxToLonLat(px[0], px[1])!;
        expect(Math.abs(lonDelta(lon, back[0])) * Math.cos(lat * Math.PI / 180)).toBeLessThan(1e-7);
        expect(Math.abs(back[1] - lat)).toBeLessThan(1e-7);
      }
    }
  });

  it('puts the centre at the disc centre and hides the antipode', () => {
    const v = globe(150, 30);
    const [x, y] = v.lonLatToPx(150, 30)!;
    expect(x).toBeCloseTo(W / 2, 9); expect(y).toBeCloseTo(H / 2, 9);
    expect(v.lonLatToPx(-30, -30)).toBeNull();
    expect(v.projectZ(-30, -30)[2]).toBeCloseTo(-1, 12);
  });

  it('has z ~ 0 on the limb and null px just beyond the disc', () => {
    const v = globe(150, 0, 150);
    const lat = 0, lon = 150 + 90;
    const p = v.projectZ(lon, lat);
    expect(Math.abs(p[2])).toBeLessThan(1e-12);
    expect(Math.hypot(p[0] - W / 2, p[1] - H / 2)).toBeCloseTo(v.radius, 6);
    expect(v.pxToLonLat(W / 2 + v.radius * 1.001, H / 2)).toBeNull();
    expect(v.pxToLonLat(W / 2 + v.radius * 0.999, H / 2)).not.toBeNull();
    expect(v.pxToLonLat(0, 0)).toBeNull();
  });

  it('projectZ is allocation-free with out and matches lonLatToPx', () => {
    const v = globe();
    const out = new Float64Array(4);
    expect(v.projectZ(140, 16, out)).toBe(out);
    const px = v.lonLatToPx(140, 16)!;
    expect(out[0]).toBe(px[0]); expect(out[1]).toBe(px[1]); expect(out[2]).toBeGreaterThan(0);
    const u = geoToUnit(140, 16, new Float64Array(3));
    const o2 = new Float64Array(5);
    v.projectUnit(u[0], u[1], u[2], o2, 2);
    expect(o2[2]).toBeCloseTo(out[0], 9); expect(o2[3]).toBeCloseTo(out[1], 9); expect(o2[4]).toBeCloseTo(out[2], 12);
  });

  it('keeps scale = R·π/180 and clamps R and lat0', () => {
    const v = globe(); 
    expect(v.scale).toBeCloseTo(v.radius * Math.PI / 180, 12);
    expect(v.fitScale).toBeCloseTo(0.45 * 900 * Math.PI / 180, 12);
    v.zoomAt(1e-6, W / 2, H / 2); expect(v.radius).toBeCloseTo(0.6 * 0.45 * 900, 9);
    v.zoomAt(1e6, W / 2, H / 2); expect(v.radius).toBeCloseTo(20 * 0.45 * 900, 6);
    v.centerOn(0, 89); expect(v.lat0).toBe(80);
    expect(v.kmRadiiPx(110.57, 40)[0]).toBeCloseTo(v.scale, 9);
  });
});

describe('GlobeView interaction', () => {
  it('dragPx keeps the grabbed point under the cursor', () => {
    for (const [lon0, lat0] of [[0, 0], [150, 30], [179, -40], [-100, 60]] as [number, number][]) {
      const v = globe(lon0, lat0, 90);
      const x0 = W / 2 + 120, y0 = H / 2 - 90, x1 = x0 - 140, y1 = y0 + 70;
      const g = v.pxToLonLat(x0, y0)!;
      v.dragPx(x0, y0, x1, y1);
      const at = v.lonLatToPx(g[0], g[1])!;
      expect(Math.abs(at[0] - x1)).toBeLessThan(1e-6); expect(Math.abs(at[1] - y1)).toBeLessThan(1e-6);
      expect(v.isAtHome).toBe(false);
    }
  });

  it('dragging off the globe falls back to a plain rotation', () => {
    const v = globe(150, 0, 60);
    const [lon0] = v.centerLonLat();
    v.dragPx(5, 5, 105, 5);
    expect(v.centerLonLat()[0]).toBeLessThan(lon0);
  });

  it('panPx moves content by (dx, dy)', () => {
    const v = globe(150, 20, 90);
    const before = v.lonLatToPx(150, 20)!;
    v.panPx(60, 40);
    const after = v.lonLatToPx(150, 20)!;
    expect(after[0] - before[0]).toBeCloseTo(60, 6); expect(after[1] - before[1]).toBeCloseTo(40, 6);
  });

  it('zoomAt keeps the cursor point fixed', () => {
    for (const f of [1.7, 0.8, 3]) {
      const v = globe(140, 15, 90);
      const px = W / 2 + 150, py = H / 2 - 60;
      const g = v.pxToLonLat(px, py)!;
      v.zoomAt(f, px, py);
      const at = v.lonLatToPx(g[0], g[1])!;
      expect(Math.abs(at[0] - px)).toBeLessThan(1e-6); expect(Math.abs(at[1] - py)).toBeLessThan(1e-6);
    }
  });

  it('setHome sets scale = min(W,H)/span exactly and reset restores it', () => {
    const v = globe(150, 20, 45);
    expect(v.scale).toBe(900 / 45);
    expect(v.isAtHome).toBe(true);
    v.dragPx(500, 400, 300, 300); v.zoomAt(2, 700, 450);
    v.reset();
    expect(v.scale).toBe(900 / 45); expect(v.centerLonLat()).toEqual([150, 20]); expect(v.offsetX).toBe(0);
    v.resize(375, 812);
    expect(v.scale).toBe(375 / 45); expect(v.isAtHome).toBe(true);
  });

  it('fitTrack frames a dateline-crossing track left of the sidebar', () => {
    const v = globe();
    const track = [
      { lon: 160, lat: 8 }, { lon: 172, lat: 10 }, { lon: 179.5, lat: 14 }, { lon: -176, lat: 19 },
      { lon: -168, lat: 26 }, { lon: -160, lat: 33 }, { lon: -150, lat: 40 },
    ];
    v.fitTrack(track, 352);
    expect(v.offsetX).toBe(-176);
    for (const p of track) {
      const z = v.projectZ(p.lon, p.lat);
      expect(z[2]).toBeGreaterThan(0);
      expect(z[0]).toBeGreaterThanOrEqual(50 - 1e-6); expect(z[0]).toBeLessThanOrEqual(W - 352 - 50 + 1e-6);
      expect(z[1]).toBeGreaterThanOrEqual(120 - 1e-6); expect(z[1]).toBeLessThanOrEqual(H - 120 + 1e-6);
    }
    const [lon] = v.centerLonLat();
    expect(Math.abs(lonDelta(-170, lon))).toBeLessThan(25);
  });

  it('fitTrack handles one point and a track too large to see at once', () => {
    const v = globe();
    v.fitTrack([{ lon: 10, lat: 10 }]);
    expect(v.lonLatToPx(10, 10)![0]).toBeCloseTo(W / 2, 6);
    v.fitTrack([{ lon: 0, lat: 0 }, { lon: 120, lat: 0 }, { lon: -120, lat: 0 }], 0);
    expect(v.scale).toBeCloseTo(v.fitScale, 12);
  });
});

describe('GlobeView visibleBounds', () => {
  const contains = (v: GlobeView, lon: number, lat: number) => {
    const b = v.visibleBounds();
    expect(lat).toBeGreaterThanOrEqual(b.south - 1e-9); expect(lat).toBeLessThanOrEqual(b.north + 1e-9);
    if (b.east - b.west >= 360) return;
    const l = b.west + ((((lon - b.west) % 360) + 360) % 360);
    expect(l).toBeLessThanOrEqual(b.east + 1e-9);
  };

  it('contains every globe point of a 20x20 px grid', () => {
    for (const [lon0, lat0, span] of [[150, 20, 40], [0, 0, 90], [179, -60, 60], [-100, 80, 30], [150, 0, 200]] as [number, number, number][]) {
      const v = globe(lon0, lat0, span);
      for (const inset of [0, 352]) {
        if (inset) v.fitTrack([{ lon: lon0, lat: lat0 }, { lon: lon0 + 5, lat: Math.min(85, lat0 + 4) }], inset);
        for (let x = 0; x <= W; x += 20) for (let y = 0; y <= H; y += 20) {
          const g = v.pxToLonLat(x, y);
          if (g) contains(v, g[0], g[1]);
        }
      }
    }
  });

  it('reports all longitudes when a pole is in view', () => {
    const v = globe(0, 75, 90);
    const b = v.visibleBounds();
    expect(b.east - b.west).toBeGreaterThanOrEqual(360); expect(b.north).toBe(90);
  });
});

describe('rotation()', () => {
  it('a three.js Matrix4 from rotation() matches projectZ', () => {
    for (const [lon0, lat0] of CENTRES) {
      const v = globe(lon0, lat0, 80);
      v.panPx(31, -17);
      const r = v.rotation();
      const mat = new Matrix4().set(r[0], r[1], r[2], 0, r[3], r[4], r[5], 0, r[6], r[7], r[8], 0, 0, 0, 0, 1);
      for (const [lon, lat] of [[lon0, lat0], [lon0 + 30, lat0 - 20], [lon0 - 70, 10], [lon0 + 170, -30], [12, 85]] as [number, number][]) {
        const u = geoToUnit(lon, lat, new Float64Array(3));
        const c = new Vector3(u[0], u[1], u[2]).applyMatrix4(mat);
        const p = v.projectZ(lon, lat);
        expect(Math.abs(W / 2 + v.offsetX + v.radius * c.x - p[0])).toBeLessThan(1e-6);
        expect(Math.abs(H / 2 - v.radius * c.y - p[1])).toBeLessThan(1e-6);
        expect(Math.abs(c.z - p[2])).toBeLessThan(1e-9);
        expect(Math.abs(c.x - (p[0] - W / 2 - v.offsetX) / v.radius)).toBeLessThan(1e-9);
        expect(Math.abs(c.y - (H / 2 - p[1]) / v.radius)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('FlatView as a MapCamera', () => {
  const flat = (): FlatView => { const v = new FlatView(); v.resize(W, H); v.setHome(110, 15, 60); return v; };

  it('keeps the MapView alias, kind and identity rotation', () => {
    expect(MapView).toBe(FlatView);
    const v = flat();
    expect(v.kind).toBe('flat');
    expect(Array.from(v.rotation())).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(v.isAtHome).toBe(true);
    v.panPx(10, 5); expect(v.isAtHome).toBe(false);
  });

  it('projectZ matches lonLatToPx with z = 1, also outside the outline', () => {
    const v = flat();
    for (const [lon, lat] of [[110, 15], [-30.5, 80], [179, -85]] as [number, number][]) {
      const px = v.lonLatToPx(lon, lat);
      const p = v.projectZ(lon, lat);
      expect(p[0]).toBe(px[0]); expect(p[1]).toBe(px[1]); expect(p[2]).toBe(1);
    }
    const out = new Float64Array(3);
    expect(v.projectZ(-170, 40, out)).toBe(out);
  });

  it('dragPx pans by the pointer delta', () => {
    const a = flat(), b = flat();
    a.dragPx(100, 100, 160, 130); b.panPx(60, 30);
    expect(a.cx).toBe(b.cx); expect(a.cy).toBe(b.cy);
  });

  it('visibleBounds bounds the viewport and spans all longitudes at world zoom', () => {
    const v = flat();
    const b = v.visibleBounds();
    expect(b.west).toBeLessThan(110); expect(b.east).toBeGreaterThan(110);
    expect(b.south).toBeGreaterThanOrEqual(-90); expect(b.north).toBeLessThanOrEqual(90);
    for (let x = 0; x <= W; x += 20) for (let y = 0; y <= H; y += 20) {
      const g = v.pxToLonLat(x, y);
      if (!g) continue;
      const lon = 150 + lonDelta(150, g[0]);
      expect(lon).toBeGreaterThanOrEqual(b.west - 1e-6); expect(lon).toBeLessThanOrEqual(b.east + 1e-6);
      expect(g[1]).toBeGreaterThanOrEqual(b.south - 1e-6); expect(g[1]).toBeLessThanOrEqual(b.north + 1e-6);
    }
    const world = new FlatView(); world.resize(W, H); world.reset();
    const wb = world.visibleBounds();
    expect(wb.east - wb.west).toBeGreaterThanOrEqual(360); expect(wb.south).toBe(-90); expect(wb.north).toBe(90);
  });
});
