import { describe, expect, it } from 'vitest';
import { Mesh, Vector3 } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { geoToUnit } from '../src/render/camera';
import { LAKE_TIER_MIN_ZOOM } from '../src/render/detail';
import { coastSegmentsLonLat, landLonLat } from '../src/render/geometry';
import { GlobeView } from '../src/render/globe-view';
import { atmosphereRing, lakeGlobeGeometries, landGlobeGeometry, rotationMatrix, uvSphere } from '../src/render/globe-mesh';

const R2D = 180 / Math.PI;
const unitToLonLat = (x: number, y: number, z: number): [number, number] => [Math.atan2(x, z) * R2D, Math.asin(Math.max(-1, Math.min(1, y))) * R2D];

describe('uvSphere', () => {
  const cols = 16, rows = 8;
  const geo = uvSphere(cols, rows);
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');

  it('has a duplicated seam column and the expected counts', () => {
    expect(pos.count).toBe((cols + 1) * (rows + 1));
    expect(geo.index!.count).toBe(cols * rows * 6);
  });

  it('puts geoToUnit(lon, lat) at uv ((lon+180)/360, (lat+90)/180)', () => {
    const u = new Float64Array(3);
    for (const [i, j] of [[0, 0], [0, 4], [8, 4], [16, 4], [4, 6], [12, 2], [16, 8]]) {
      const lon = -180 + (360 * i) / cols, lat = -90 + (180 * j) / rows;
      const v = j * (cols + 1) + i;
      geoToUnit(lon, lat, u);
      expect(pos.getX(v)).toBeCloseTo(u[0], 6); expect(pos.getY(v)).toBeCloseTo(u[1], 6); expect(pos.getZ(v)).toBeCloseTo(u[2], 6);
      expect(uv.getX(v)).toBeCloseTo((lon + 180) / 360, 9); expect(uv.getY(v)).toBeCloseTo((lat + 90) / 180, 9);
    }
  });

  it('winds every non-degenerate face counter-clockwise seen from outside', () => {
    const idx = geo.index!;
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    let checked = 0;
    for (let f = 0; f < idx.count; f += 3) {
      a.fromBufferAttribute(pos, idx.getX(f)); b.fromBufferAttribute(pos, idx.getX(f + 1)); c.fromBufferAttribute(pos, idx.getX(f + 2));
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.length() < 1e-9) continue; // pole triangles collapse to a line
      expect(n.dot(a.clone().add(b).add(c))).toBeGreaterThan(0);
      checked++;
    }
    expect(checked).toBeGreaterThan(cols * rows * 2 - 4 * cols);
  });
});

describe('landGlobeGeometry', () => {
  const geo = landGlobeGeometry();
  const pos = geo.getAttribute('position');
  const tris = pos.count / 3;

  it('is cached and sanely sized', () => {
    expect(landGlobeGeometry()).toBe(geo);
    expect(pos.count % 3).toBe(0);
    expect(tris).toBeGreaterThan(10_000);
    expect(tris).toBeLessThan(200_000);
  });

  it('has every edge at most 3 degrees in lon/lat', () => {
    let worst = 0;
    for (let t = 0; t < tris; t++) {
      const ll = [0, 1, 2].map(k => unitToLonLat(pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)));
      for (let k = 0; k < 3; k++) {
        const p = ll[k], q = ll[(k + 1) % 3];
        // lon is meaningless at the poles, and a triangle may sit on the +-180 seam
        if (Math.abs(p[1]) > 89.99 || Math.abs(q[1]) > 89.99) continue;
        let dlon = Math.abs(p[0] - q[0]);
        if (dlon > 180) dlon = 360 - dlon;
        worst = Math.max(worst, Math.hypot(dlon, p[1] - q[1]));
      }
    }
    expect(worst).toBeLessThanOrEqual(3 + 1e-3);
  });

  it('winds all faces outward and keeps vertices on the unit sphere', () => {
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      expect(a.length()).toBeCloseTo(1, 5);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      // Slivers at the south pole line are float32 noise; they cover no pixels.
      if (n.length() < 1e-9) continue;
      expect(n.dot(a.clone().add(b).add(c))).toBeGreaterThan(0);
    }
  });

  it('covers Japan: a vertex lies near Tokyo and Hokkaido', () => {
    const near = (lon: number, lat: number) => {
      const u = geoToUnit(lon, lat, new Float64Array(3));
      for (let i = 0; i < pos.count; i++) {
        if (Math.hypot(pos.getX(i) - u[0], pos.getY(i) - u[1], pos.getZ(i) - u[2]) < 0.05) return true;
      }
      return false;
    };
    expect(near(139.7, 35.7)).toBe(true);
    expect(near(142.8, 43.4)).toBe(true);
    expect(near(-170, 0)).toBe(false);
  });
});

describe('lakeGlobeGeometries', () => {
  const tiers = lakeGlobeGeometries();
  const geo = mergeGeometries(tiers)!;
  const pos = geo.getAttribute('position');
  const tris = pos.count / 3;

  it('is cached and holds triangles on the unit sphere', () => {
    expect(lakeGlobeGeometries()).toBe(tiers);
    expect(tiers).toHaveLength(LAKE_TIER_MIN_ZOOM.length);
    expect(pos.count % 3).toBe(0);
    expect(tris).toBeGreaterThan(500);
    expect(tris).toBeLessThan(landGlobeGeometry().getAttribute('position').count / 3);
  });

  it('has every edge at most 3 degrees in lon/lat', () => {
    let worst = 0;
    for (let t = 0; t < tris; t++) {
      const ll = [0, 1, 2].map(k => unitToLonLat(pos.getX(t * 3 + k), pos.getY(t * 3 + k), pos.getZ(t * 3 + k)));
      for (let k = 0; k < 3; k++) {
        const p = ll[k], q = ll[(k + 1) % 3];
        if (Math.abs(p[1]) > 89.99 || Math.abs(q[1]) > 89.99) continue;
        let dlon = Math.abs(p[0] - q[0]);
        if (dlon > 180) dlon = 360 - dlon;
        worst = Math.max(worst, Math.hypot(dlon, p[1] - q[1]));
      }
    }
    expect(worst).toBeLessThanOrEqual(3 + 1e-3);
  });

  it('winds all faces outward and keeps vertices on the unit sphere', () => {
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let t = 0; t < tris; t++) {
      a.fromBufferAttribute(pos, t * 3); b.fromBufferAttribute(pos, t * 3 + 1); c.fromBufferAttribute(pos, t * 3 + 2);
      expect(a.length()).toBeCloseTo(1, 5);
      const n = b.clone().sub(a).cross(c.clone().sub(a));
      if (n.length() < 1e-12) continue;
      expect(n.dot(a.clone().add(b).add(c))).toBeGreaterThan(0);
    }
  });
});

describe('lon/lat geometry', () => {
  it('landLonLat returns raw degrees and coastSegmentsLonLat drops the seams', () => {
    const land = landLonLat();
    expect(land.length).toBeGreaterThan(1000);
    for (const p of land) for (let i = 0; i < p.outer.length; i += 2) {
      expect(Math.abs(p.outer[i])).toBeLessThanOrEqual(180); expect(Math.abs(p.outer[i + 1])).toBeLessThanOrEqual(90);
    }
    const coast = coastSegmentsLonLat();
    expect(coast.length % 4).toBe(0);
    for (let i = 0; i < coast.length; i += 4) {
      const bothSeam180 = Math.abs(Math.abs(coast[i]) - 180) < 1e-6 && Math.abs(Math.abs(coast[i + 2]) - 180) < 1e-6;
      const bothPole = Math.abs(coast[i + 1]) > 89.999 && Math.abs(coast[i + 3]) > 89.999;
      expect(bothSeam180 || bothPole).toBe(false);
    }
  });
});

describe('group matrix', () => {
  it('maps geoToUnit to the same (X, Y, Z) as GlobeView.projectZ', () => {
    for (const [lon0, lat0] of [[0, 0], [150, 30], [179, -60], [-100, 80]]) {
      const view = new GlobeView();
      view.resize(1440, 900);
      view.setHome(lon0, lat0, 60);
      const m = rotationMatrix(view.rotation());
      const p = new Float64Array(3);
      for (const [lon, lat] of [[lon0, lat0], [lon0 + 20, lat0 - 10], [lon0 - 35, lat0 + 15], [10, 20], [-170, -40]]) {
        view.projectZ(lon, lat, p);
        // projectZ: px = W/2 + offsetX + R·X, py = H/2 − R·Y, z = Z
        const X = (p[0] - view.width / 2 - view.offsetX) / view.radius;
        const Y = (view.height / 2 - p[1]) / view.radius;
        const u = geoToUnit(lon, lat, new Float64Array(3));
        const v = new Vector3(u[0], u[1], u[2]).applyMatrix4(m);
        expect(v.x).toBeCloseTo(X, 9); expect(v.y).toBeCloseTo(Y, 9); expect(v.z).toBeCloseTo(p[2], 9);
        expect(v.length()).toBeCloseTo(1, 9);
      }
      // The view centre faces the camera.
      const centre = new Vector3(...(geoToUnit(lon0, lat0, new Float64Array(3)) as unknown as [number, number, number])).applyMatrix4(m);
      expect(centre.z).toBeCloseTo(1, 9);
    }
  });
});

describe('atmosphereRing', () => {
  it('is a ring from 0.85 to 1.08 at render order 3', () => {
    const ring = atmosphereRing([20, 33, 58]) as Mesh;
    expect(ring.renderOrder).toBe(3);
    const pos = ring.geometry.getAttribute('position');
    let lo = Infinity, hi = 0;
    for (let i = 0; i < pos.count; i++) { const r = Math.hypot(pos.getX(i), pos.getY(i)); lo = Math.min(lo, r); hi = Math.max(hi, r); }
    expect(lo).toBeCloseTo(0.85, 5); expect(hi).toBeCloseTo(1.08, 5);
  });
});
