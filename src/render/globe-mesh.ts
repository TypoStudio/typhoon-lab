import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Float32BufferAttribute, Matrix4, Mesh, RingGeometry, ShaderMaterial, ShapeUtils, SRGBColorSpace, Vector2,
} from 'three';
import { geoToUnit } from './camera';
import { lakeLonLatTiers, landLonLat, type LonLatPolygon } from './geometry';
import type { RGB } from './theme';

/** Longest land triangle edge, degrees of lon/lat, so flat triangles hug the sphere. */
const MAX_EDGE_DEG = 3;
const MAX_SPLIT_DEPTH = 16;

/**
 * Unit sphere with a vertex per (lon, lat) grid node: lon = -180 + 360 i / cols, lat = -90 + 180 j / rows,
 * uv = ((lon + 180) / 360, (lat + 90) / 180) so it samples the equirectangular field texture
 * (row 0 = south). The seam column is duplicated so u runs 0..1 without wrapping. Faces are CCW seen from outside.
 */
export function uvSphere(cols = 128, rows = 64): BufferGeometry {
  const stride = cols + 1;
  const pos = new Float32Array((rows + 1) * stride * 3);
  const uv = new Float32Array((rows + 1) * stride * 2);
  const u = new Float64Array(3);
  for (let j = 0; j <= rows; j++) {
    const lat = -90 + (180 * j) / rows;
    for (let i = 0; i <= cols; i++) {
      const lon = -180 + (360 * i) / cols;
      const v = j * stride + i;
      geoToUnit(lon, lat, u);
      pos.set(u, v * 3);
      uv[v * 2] = (lon + 180) / 360;
      uv[v * 2 + 1] = (lat + 90) / 180;
    }
  }
  const index = new Uint32Array(rows * cols * 6);
  let k = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      index[k++] = a; index[k++] = b; index[k++] = c;
      index[k++] = c; index[k++] = b; index[k++] = d;
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setIndex(new BufferAttribute(index, 1));
  return geo;
}

/** World-to-view rotation as a Matrix4: row-major 3x3 `m` (GlobeView.rotation()) maps a unit vector to camera-space (X, Y, Z). */
export function rotationMatrix(m: ArrayLike<number>, out = new Matrix4()): Matrix4 {
  return out.set(m[0], m[1], m[2], 0, m[3], m[4], m[5], 0, m[6], m[7], m[8], 0, 0, 0, 0, 1);
}

const dist = (t: number[], a: number, b: number): number => Math.hypot(t[a * 2] - t[b * 2], t[a * 2 + 1] - t[b * 2 + 1]);

/**
 * Splits every edge longer than MAX_EDGE_DEG at its midpoint. The rule depends only on an edge's
 * endpoints, so neighbouring triangles agree on every split vertex and the mesh stays watertight.
 * `t` = [lon0, lat0, lon1, lat1, lon2, lat2]; emits triangles to `out`.
 */
function subdivide(t: number[], depth: number, out: number[]): void {
  const split = [0, 1, 2].map(e => depth < MAX_SPLIT_DEPTH && dist(t, e, (e + 1) % 3) > MAX_EDGE_DEG);
  const count = split.filter(Boolean).length;
  if (count === 0) { out.push(...t); return; }
  // Rotate so one split edge is b-c (count 1) or both split edges meet at a (count 2).
  let r = 0;
  if (count === 1) r = (split.indexOf(true) + 2) % 3;
  else if (count === 2) r = (split.indexOf(false) + 2) % 3;
  const p = (k: number): [number, number] => { const v = (r + k) % 3; return [t[v * 2], t[v * 2 + 1]]; };
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const a = p(0); const b = p(1); const c = p(2);
  const emit = (...tri: [number, number][]) => subdivide(tri.flat(), depth + 1, out);
  if (count === 3) {
    const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
    emit(a, ab, ca); emit(ab, b, bc); emit(ca, bc, c); emit(ab, bc, ca);
  } else if (count === 1) {
    // Split edge is b-c.
    const bc = mid(b, c);
    emit(a, b, bc); emit(a, bc, c);
  } else {
    // Split edges are a-b and c-a.
    const ab = mid(a, b); const ca = mid(c, a);
    emit(a, ab, ca); emit(ab, b, c); emit(ab, c, ca);
  }
}

let landCache: BufferGeometry | null = null;
let lakeCache: BufferGeometry[] | null = null;

/**
 * Natural Earth land triangulated in lon/lat (holes included), refined to edges <= 3°, then mapped onto
 * the unit sphere. Non-indexed, CCW seen from outside. Built once and cached; the caller must not mutate it.
 */
export function landGlobeGeometry(): BufferGeometry {
  return (landCache ??= globeGeometry(landLonLat()));
}

/** Natural Earth lakes built like `landGlobeGeometry`, one geometry per area tier (`LAKE_TIER_MIN_ZOOM`), on the unit sphere; the caller scales the meshes (1.0005) to sit above the land. */
export function lakeGlobeGeometries(): BufferGeometry[] {
  return (lakeCache ??= lakeLonLatTiers().map(globeGeometry));
}

function globeGeometry(polygons: readonly LonLatPolygon[]): BufferGeometry {
  const tris: number[] = [];
  for (const poly of polygons) {
    const ring = (r: Float32Array): Vector2[] => {
      const pts: Vector2[] = [];
      for (let i = 0; i < r.length; i += 2) pts.push(new Vector2(r[i], r[i + 1]));
      return pts;
    };
    const outer = ring(poly.outer);
    const holes = poly.holes.map(ring);
    const faces = ShapeUtils.triangulateShape(outer, holes);
    const all = outer.concat(...holes);
    for (const f of faces) {
      subdivide([all[f[0]].x, all[f[0]].y, all[f[1]].x, all[f[1]].y, all[f[2]].x, all[f[2]].y], 0, tris);
    }
  }
  const n = tris.length / 6;
  const pos = new Float32Array(n * 9);
  const a = new Float64Array(3); const b = new Float64Array(3); const c = new Float64Array(3);
  for (let i = 0; i < n; i++) {
    geoToUnit(tris[i * 6], tris[i * 6 + 1], a);
    geoToUnit(tris[i * 6 + 2], tris[i * 6 + 3], b);
    geoToUnit(tris[i * 6 + 4], tris[i * 6 + 5], c);
    const nx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const nz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const outward = nx * (a[0] + b[0] + c[0]) + ny * (a[1] + b[1] + c[1]) + nz * (a[2] + b[2] + c[2]) >= 0;
    pos.set(a, i * 9);
    pos.set(outward ? b : c, i * 9 + 3);
    pos.set(outward ? c : b, i * 9 + 6);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  return geo;
}

const ATMOSPHERE_VERT = `
varying vec2 vPos;
void main() {
  vPos = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const ATMOSPHERE_FRAG = `
uniform vec3 uColor;
varying vec2 vPos;
void main() {
  float r = length(vPos);
  float inner = 0.35 * smoothstep(0.85, 1.0, r);
  float outer = 0.5 * (1.0 - smoothstep(1.0, 1.06, r));
  float a = r < 1.0 ? inner : outer;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

/** Camera-facing halo around the unit disc (rim glow inside, soft falloff outside); colour is the sea colour lightened. */
export function atmosphereRing(sea: RGB): Mesh {
  const color = new Color().setRGB(sea[0] / 255, sea[1] / 255, sea[2] / 255, SRGBColorSpace).lerp(new Color(1, 1, 1), 0.35);
  const material = new ShaderMaterial({
    uniforms: { uColor: { value: color } },
    vertexShader: ATMOSPHERE_VERT,
    fragmentShader: ATMOSPHERE_FRAG,
    transparent: true, depthTest: false, depthWrite: false, side: DoubleSide,
  });
  const mesh = new Mesh(new RingGeometry(0.85, 1.08, 128), material);
  mesh.renderOrder = 3;
  mesh.frustumCulled = false;
  return mesh;
}
