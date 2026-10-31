import { describe, expect, it } from 'vitest';
import {
  EDGE_LON, LON0, MAP_H, MAP_W, MAP_X0, MAP_X1, MAP_Y0, MAP_Y1, MapView, edgeBetween, inOutline, kmToWorld, lonDelta, project, projectLambda, unproject, wrapLon,
} from '../src/render/view';
import { coastSegments, projectedLand } from '../src/render/geometry';
import { LAND_POLYGONS } from '../src/data/world';
import { ParticleSystem } from '../src/render/particles';
import { buildFieldData, sampleGrid } from '../src/render/fields';
import { createGame } from '../src/simulation/engine';
import { moveKm } from '../src/simulation/geo';

describe('Equal Earth projection', () => {
  it('round-trips project/unproject between -89 and 89 degrees latitude and -179..179 longitude', () => {
    for (let lat = -89; lat <= 89; lat += 2.5) {
      for (const lon of [-179, -150, -90, -30.5, 0, 37.25, 149.9, 150, 179]) {
        const [x, y] = project(lon, lat);
        const [lon2, lat2] = unproject(x, y);
        expect(Math.abs(wrapLon(lon2 - lon))).toBeLessThan(1e-7);
        expect(Math.abs(lat2 - lat)).toBeLessThan(1e-7);
      }
    }
  });

  it('centres on LON0, puts the cut meridian on the outline and draws the poles as flat edges', () => {
    expect(LON0).toBe(150);
    expect(EDGE_LON).toBe(-30);
    const [cx, cy] = project(LON0, 0);
    expect(cx).toBeCloseTo(0, 12); expect(cy).toBeCloseTo(0, 12);
    expect(project(LON0 + 179.999, 0)[0]).toBeCloseTo(MAP_X1, 2);
    expect(project(LON0 - 179.999, 0)[0]).toBeCloseTo(MAP_X0, 2);
    expect(MAP_X1).toBeCloseTo(155.08, 1);
    expect(MAP_Y1).toBeCloseTo(75.48, 1);
    expect(MAP_X0).toBe(-MAP_X1); expect(MAP_Y0).toBe(-MAP_Y1);
    expect(MAP_W).toBeCloseTo(2 * MAP_X1, 9); expect(MAP_H).toBeCloseTo(2 * MAP_Y1, 9);
    expect(project(0, 90)[1]).toBeCloseTo(MAP_Y1, 9);
    expect(project(0, -90)[1]).toBeCloseTo(MAP_Y0, 9);
    // At the pole θ = 60° and cos θ = 0.5: the pole is a line a little over half as wide as the equator.
    const poleHalfWidth = projectLambda(180, 90)[0];
    expect(poleHalfWidth / MAP_X1).toBeGreaterThan(0.55);
    expect(poleHalfWidth / MAP_X1).toBeLessThan(0.65);
    expect(projectLambda(-180, 90)[0]).toBeCloseTo(-poleHalfWidth, 9);
  });

  it('is equal-area: the Jacobian determinant is proportional to cos(latitude)', () => {
    const h = 0.01;
    for (const [lon, lat] of [[150, 0], [120, 20], [-170, 35], [100, -50], [30, 70], [-40, -75], [179, 10]]) {
      const dxdLon = (project(lon + h, lat)[0] - project(lon - h, lat)[0]) / (2 * h);
      const dxdLat = (project(lon, lat + h)[0] - project(lon, lat - h)[0]) / (2 * h);
      const dydLon = (project(lon + h, lat)[1] - project(lon - h, lat)[1]) / (2 * h);
      const dydLat = (project(lon, lat + h)[1] - project(lon, lat - h)[1]) / (2 * h);
      const ratio = (dxdLon * dydLat - dxdLat * dydLon) / Math.cos((lat * Math.PI) / 180);
      expect(ratio).toBeGreaterThan(0.99);
      expect(ratio).toBeLessThan(1.01);
    }
  });

  it('keeps parallels horizontal and meridians curved', () => {
    expect(project(10, 40)[1]).toBeCloseTo(project(-120, 40)[1], 12);
    const xs = [0, 30, 60, 85].map(lat => project(LON0 + 90, lat)[0]);
    expect(xs[0]).toBeGreaterThan(xs[1]); expect(xs[1]).toBeGreaterThan(xs[2]); expect(xs[2]).toBeGreaterThan(xs[3]);
  });

  it('detects paths that cross the cut meridian but not the dateline', () => {
    expect(edgeBetween(-31, -29)).toBe(true);
    expect(edgeBetween(-29, -31)).toBe(true);
    expect(edgeBetween(-60, -10)).toBe(true);
    expect(edgeBetween(179, -179)).toBe(false);
    expect(edgeBetween(100, 160)).toBe(false);
    expect(edgeBetween(-20, 100)).toBe(false);
    expect(edgeBetween(-60, 100)).toBe(true);
  });

  it('sizes ground circles with the local scale factors', () => {
    for (const lat of [0, 20, 45, 70]) {
      // dx/dLon · km/(111.32·cos φ) × dy/dLat · km/110.57, and the projection is equal-area.
      const [rx, ry] = kmToWorld(100, lat);
      expect(rx * ry).toBeCloseTo((100 * 100) / (111.32 * 110.57), 6);
    }
  });

  it('keeps land inside the outline', () => {
    for (const p of projectedLand()) {
      for (const ring of [p.outer, ...p.holes]) {
        for (let i = 0; i < ring.length; i += 2) expect(inOutline(ring[i], ring[i + 1], 1e-3)).toBe(true);
      }
    }
  });

  it('cuts Greenland at the map edge into two rings', () => {
    const inGreenland = (lon: number, lat: number) => lon > -50 && lon < -12 && lat > 75;
    const raw = LAND_POLYGONS.filter(p => p.outer.length > 100 && p.outer.some(([lon, lat]) => inGreenland(lon, lat))).length;
    const cut = projectedLand().filter(p => {
      if (p.outer.length < 200) return false;
      for (let i = 0; i < p.outer.length; i += 2) {
        const [lon, lat] = unproject(p.outer[i], p.outer[i + 1]);
        if (inGreenland(lon, lat)) return true;
      }
      return false;
    }).length;
    expect(raw).toBe(1);
    expect(cut).toBe(2);
  });

  it('draws no coastline along the map edge, the poles or the original dateline split', () => {
    const c = coastSegments();
    expect(c.length).toBeGreaterThan(4 * 20000);
    for (let i = 0; i < c.length; i += 4) {
      const [lonA, latA] = unproject(c[i], c[i + 1]);
      const [lonB, latB] = unproject(c[i + 2], c[i + 3]);
      expect(Math.abs(latA) > 89.99 && Math.abs(latB) > 89.99).toBe(false);
      expect(Math.abs(Math.abs(lonA) - 180) < 1e-3 && Math.abs(Math.abs(lonB) - 180) < 1e-3).toBe(false);
      expect(Math.abs(lonA - EDGE_LON) < 1e-3 && Math.abs(lonB - EDGE_LON) < 1e-3).toBe(false);
    }
  });
});

describe('world map camera', () => {
  it('geographic points round-trip at different viewport sizes, after zoom and pan', () => {
    for (const [width, height] of [[320, 420], [414, 896], [1440, 900]]) {
      const view = new MapView();
      view.resize(width, height);
      view.zoomAt(2.5, width * 0.7, height * 0.4);
      view.panPx(73, -29);
      for (const [lon, lat] of [[126.98, 37.57], [139.69, 35.69], [-55, 16], [179.5, -20], [-179.5, 60]]) {
        const [x, y] = view.lonLatToPx(lon, lat);
        const back = view.pxToLonLat(x, y)!;
        expect(back[0]).toBeCloseTo(lon, 8);
        expect(back[1]).toBeCloseTo(lat, 8);
      }
    }
  });

  it('shows the test drop sites at the initial fit on desktop and phone', () => {
    for (const [width, height, sites] of [[1440, 900, [[140, 16], [-55, 16]]], [414, 896, [[140, 16]]]] as const) {
      const view = new MapView();
      view.resize(width, height);
      for (const [lon, lat] of sites) {
        const [x, y] = view.lonLatToPx(lon, lat);
        expect(x).toBeGreaterThan(20);
        expect(x).toBeLessThan(width - 20);
        expect(y).toBeGreaterThan(20);
        expect(y).toBeLessThan(height - 20);
      }
    }
  });

  it('fits the whole map in either orientation', () => {
    const wide = new MapView();
    wide.resize(1440, 900);
    expect(wide.scale * MAP_W).toBeCloseTo(1440, 6);
    expect(wide.scale * MAP_H).toBeLessThan(900);
    const tall = new MapView();
    tall.resize(414, 896);
    expect(tall.scale * MAP_W).toBeCloseTo(414, 6);
    expect(tall.minScale).toBeCloseTo(tall.scale, 10);
    // The world is smaller than the viewport vertically: it stays centred.
    tall.panPx(0, 500);
    expect(tall.cy).toBe(0);
  });

  it('does not wrap: the camera stops at the outline and points beyond it are not geography', () => {
    const view = new MapView();
    view.resize(900, 600);
    view.zoomAt(4, 450, 300);
    view.panPx(1e6, 0);
    expect(view.worldRect()[0]).toBeCloseTo(MAP_X0, 9);
    view.panPx(-1e6, 0);
    expect(view.worldRect()[2]).toBeCloseTo(MAP_X1, 9);
    // The map's edge meridian is the left edge (-30°) and the far side is the right edge.
    view.panPx(1e6, 0);
    const edge = view.lonLatToPx(EDGE_LON, 0)[0];
    expect(edge).toBeCloseTo(view.lonLatToPx(LON0 - 179.999, 0)[0], 1);
    expect(view.lonLatToPx(-31, 0)[0]).toBeGreaterThan(view.lonLatToPx(-29, 0)[0] + view.width);
    expect(view.pxToLonLat(1, 1)).toBeNull();
    expect(wrapLon(190)).toBe(-170);
    expect(lonDelta(170, -170)).toBe(20);
    expect(lonDelta(-170, 170)).toBe(-20);
  });

  it('zoom holds the geographic point under the pointer in place', () => {
    const view = new MapView();
    view.resize(900, 700);
    const point = view.pxToLonLat(450, 200)!;
    view.zoomAt(3, 450, 200);
    expect(view.pxToLonLat(450, 200)![0]).toBeCloseTo(point[0], 8);
    expect(view.pxToLonLat(450, 200)![1]).toBeCloseTo(point[1], 8);
    expect(view.lonLatToPx(130, 40)[1]).toBeLessThan(view.lonLatToPx(130, 10)[1]);
  });

  it('never shows beyond the poles or the sides when zoomed in', () => {
    const view = new MapView();
    view.resize(800, 600);
    view.zoomAt(8, 400, 300);
    view.panPx(0, 10_000);
    expect(view.worldRect()[3]).toBeLessThanOrEqual(MAP_Y1 + 1e-9);
    view.panPx(0, -50_000);
    expect(view.worldRect()[1]).toBeGreaterThanOrEqual(MAP_Y0 - 1e-9);
    view.panPx(50_000, 0);
    expect(view.worldRect()[0]).toBeGreaterThanOrEqual(MAP_X0 - 1e-9);
  });

  it('centres on a point through the projection and round-trips pixels at zoom', () => {
    const view = new MapView();
    view.resize(1200, 800);
    view.zoomAt(6, 600, 400);
    view.centerOn(139.7, 35.7);
    const [wx, wy] = project(139.7, 35.7);
    expect(view.cx).toBeCloseTo(wx, 9);
    expect(view.cy).toBeCloseTo(wy, 9);
    const [x, y] = view.lonLatToPx(139.7, 35.7);
    expect(x).toBeCloseTo(600, 6);
    expect(y).toBeCloseTo(400, 6);
    for (const [px, py] of [[10, 20], [900, 700], [600, 400]]) {
      const [lon, lat] = view.pxToLonLat(px, py)!;
      const [bx, by] = view.lonLatToPx(lon, lat);
      expect(bx).toBeCloseTo(px, 6);
      expect(by).toBeCloseTo(py, 6);
    }
    expect(view.centerLonLat()[0]).toBeCloseTo(139.7, 8);
    expect(view.centerLonLat()[1]).toBeCloseTo(35.7, 8);
  });

  it('fits a track using projected extents', () => {
    const view = new MapView();
    view.resize(1440, 900);
    const track = [{ lon: 130, lat: 5 }, { lon: 132, lat: 50 }];
    view.fitTrack(track);
    expect(view.cy).toBeCloseTo((project(130, 5)[1] + project(132, 50)[1]) / 2, 6);
    for (const p of track) {
      const [x, y] = view.lonLatToPx(p.lon, p.lat);
      expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(1440);
      expect(y).toBeGreaterThan(0); expect(y).toBeLessThan(900);
    }
  });
});

describe('field and particle alignment with the simulation', () => {
  it('field sampling keeps north/south and east/west aligned with the 2° cells', () => {
    const state = createGame();
    expect(state.grid).toHaveLength(180 * 90);
    for (const cell of state.grid) { cell.u = cell.lon; cell.v = cell.lat; }
    const field = buildFieldData(state.grid)!;
    expect(sampleGrid(field, field.u, 121.56, 25.03)).toBeCloseTo(121.56, 4);
    expect(sampleGrid(field, field.v, 121.56, 25.03)).toBeCloseTo(25.03, 4);
    expect(sampleGrid(field, field.v, 130, 70.25)).toBeCloseTo(70.25, 4);
    expect(sampleGrid(field, field.v, 130, -60.5)).toBeCloseTo(-60.5, 4);
  });

  it('grid sampling is periodic across the dateline', () => {
    const state = createGame();
    for (const cell of state.grid) { cell.u = Math.cos((cell.lon * Math.PI) / 180); cell.v = 0; }
    const field = buildFieldData(state.grid)!;
    expect(sampleGrid(field, field.u, 180, 10)).toBeCloseTo(sampleGrid(field, field.u, -180, 10), 8);
    expect(sampleGrid(field, field.u, 179.9, 10)).toBeCloseTo(sampleGrid(field, field.u, -180.1, 10), 8);
  });

  it('tool-range previews match simulation distances at tropical, mid and polar latitudes', () => {
    const view = new MapView();
    view.resize(900, 700);
    for (const lat of [10, 25, 40, -55]) {
      const [x, y] = view.lonLatToPx(130, lat);
      const east = moveKm(130, lat, 450, 0);
      const north = moveKm(130, lat, 0, 450);
      const [rx, ry] = view.kmRadiiPx(450, lat);
      expect(view.lonLatToPx(east.lon, east.lat)[0] - x).toBeCloseTo(rx, 6);
      // The y scale varies with latitude, so a 450 km northward step differs slightly from the local radius.
      expect(Math.abs(y - view.lonLatToPx(north.lon, north.lat)[1]) / ry).toBeCloseTo(1, 1);
    }
  });

  it('particle direction uses the same latitude correction as geographic motion', () => {
    const state = createGame();
    for (const cell of state.grid) { cell.u = 10; cell.v = 10; }
    const field = buildFieldData(state.grid)!;
    const particles = new ParticleSystem();
    particles.resize(1);
    for (const lat of [10, 40, -30]) {
      particles.lon[0] = 130; particles.lat[0] = lat;
      particles.life[0] = 100; particles.age[0] = 0;
      particles.update(0, field, { west: -30, east: 30, south: -25, north: 25 }, 5);
      const tinyStep = moveKm(130, lat, 0.001, 0.001);
      expect(particles.vLon[0] / particles.vLat[0]).toBeCloseTo((tinyStep.lon - 130) / (tinyStep.lat - lat), 4);
    }
  });

  it('streak tails follow the on-screen flow direction under the curved meridians', () => {
    const particles = new ParticleSystem();
    particles.resize(1);
    particles.life[0] = 100;
    const tail = new Float64Array(2);
    for (const [lon, lat, vLon, vLat] of [[-100, 60, 3, 0], [-100, 60, 0, 3], [60, -50, -2, 2], [150, 5, 1, 1]]) {
      particles.lon[0] = lon; particles.lat[0] = lat; particles.vLon[0] = vLon; particles.vLat[0] = vLat;
      particles.tailLonLat(0, tail);
      const [hx, hy] = project(lon, lat);
      const [tx, ty] = project(tail[0], tail[1]);
      const ahead = project(lon + vLon * 1e-4, lat + vLat * 1e-4);
      const flow = [ahead[0] - hx, ahead[1] - hy];
      const behind = [hx - tx, hy - ty];
      const cosine = (flow[0] * behind[0] + flow[1] * behind[1]) / (Math.hypot(...flow) * Math.hypot(...behind));
      expect(cosine).toBeGreaterThan(0.999);
    }
  });

  it('particles preserve their original display speed while zooming and wrap at the dateline', () => {
    const state = createGame();
    for (const cell of state.grid) { cell.u = 10; cell.v = 0; }
    const field = buildFieldData(state.grid)!;
    const particles = new ParticleSystem();
    particles.resize(1);
    const b = { west: -10, east: 10, south: -10, north: 10 };
    particles.lon[0] = 150; particles.lat[0] = 0; particles.life[0] = 100; particles.age[0] = 0;
    particles.update(0, field, b, 4);
    const slow = particles.vLon[0];
    particles.update(0, field, b, 40);
    expect(particles.vLon[0] / slow).toBeCloseTo(0.1, 4);
    particles.lon[0] = 179.99999; particles.lat[0] = 0; particles.age[0] = 0;
    particles.update(1, field, b, 1);
    expect(particles.lon[0]).toBeLessThan(0);
    expect(particles.lon[0]).toBeGreaterThanOrEqual(-180);
  });

  it('reseeds a particle that would cross the map edge instead of drawing it across the map', () => {
    const state = createGame();
    for (const cell of state.grid) { cell.u = 10; cell.v = 0; }
    const field = buildFieldData(state.grid)!;
    const particles = new ParticleSystem();
    particles.resize(1);
    particles.lon[0] = -30.00001; particles.lat[0] = 10; particles.life[0] = 100; particles.age[0] = 3;
    particles.update(1, field, { west: -30, east: 30, south: -30, north: 30 }, 1, undefined, edgeBetween);
    expect(particles.age[0]).toBe(0);
    expect(particles.lon[0]).toBeGreaterThanOrEqual(-30);
    expect(particles.lon[0]).toBeLessThanOrEqual(30);
  });

  it('seeds particles inside the visible bounds of the flat view', () => {
    const view = new MapView();
    view.resize(1000, 700);
    view.setHome(120, 25, 40);
    const b = view.visibleBounds();
    const particles = new ParticleSystem();
    particles.resize(400);
    particles.reseed(b);
    for (let i = 0; i < particles.count; i++) {
      expect(particles.lat[i]).toBeGreaterThanOrEqual(b.south - 1e-4); expect(particles.lat[i]).toBeLessThanOrEqual(b.north + 1e-4);
      expect(wrapLon(particles.lon[i] - b.west + 1e-4)).toBeGreaterThanOrEqual(-180);
      expect(((particles.lon[i] - b.west + 1e-4) % 360 + 360) % 360).toBeLessThanOrEqual(b.east - b.west + 2e-4);
    }
  });
});
