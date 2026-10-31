import {
  BufferAttribute, BufferGeometry, ClampToEdgeWrapping, Color, RepeatWrapping, DataTexture, DoubleSide, DynamicDrawUsage,
  Float32BufferAttribute, FrontSide, Group, LinearFilter, Mesh, MeshBasicMaterial, OrthographicCamera, Path, RGBAFormat, SRGBColorSpace,
  Scene, Shape, ShapeGeometry, ShaderMaterial, type Side, UnsignedByteType, Vector2, WebGLRenderer,
} from 'three';
import { HUMIDITY_BUCKETS, humidityBucket, type BaseRenderer } from './base';
import { limbFade, type MapCamera } from './camera';
import { LAKE_TIER_MIN_ZOOM, visibleTierCount } from './detail';
import { projectedLakeTiers, projectedLand, type ProjectedPolygon } from './geometry';
import { webZoom } from './places';
import type { GlobeView } from './globe-view';
import { atmosphereRing, lakeGlobeGeometries, landGlobeGeometry, rotationMatrix, uvSphere } from './globe-mesh';
import { WIND_STREAK_SEGMENTS, type ParticleSystem } from './particles';
import type { Theme, RGB } from './theme';
import { LON0, MAP_OUTLINE, projectLambda, type MapView } from './view';
import { surfaceMaterial } from './surface-material';

const srgbToLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const linear = (rgb: RGB): RGB => [srgbToLinear(rgb[0]), srgbToLinear(rgb[1]), srgbToLinear(rgb[2])];
/** Field grid: 170 rows × 72 columns of quads spanning λ ∈ [-180, 180] around LON0 and φ ∈ [-90, 90]. */
const FIELD_ROWS = 170;
const FIELD_COLS = 72;

/**
 * A grid whose vertices sit at Equal Earth positions but whose UVs are linear in longitude and
 * latitude, so the equirectangular field texture (u = (lon + 180) / 360, v = (lat + 90) / 180) lands
 * on the right place on the map. u runs from LON0 / 360 to LON0 / 360 + 1 (repeat wrapping), so
 * there is no seam inside the map.
 */
function fieldGridGeometry(): BufferGeometry {
  const cols = FIELD_COLS + 1;
  const pos = new Float32Array((FIELD_ROWS + 1) * cols * 3);
  const uv = new Float32Array((FIELD_ROWS + 1) * cols * 2);
  for (let r = 0; r <= FIELD_ROWS; r++) {
    const lat = -90 + (180 * r) / FIELD_ROWS;
    for (let c = 0; c <= FIELD_COLS; c++) {
      const lambda = -180 + (360 * c) / FIELD_COLS;
      const [x, y] = projectLambda(lambda, lat);
      const v = r * cols + c;
      pos.set([x, y, 0], v * 3);
      uv.set([(LON0 + lambda + 180) / 360, (lat + 90) / 180], v * 2);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < FIELD_ROWS; r++) {
    for (let c = 0; c < FIELD_COLS; c++) {
      const a = r * cols + c;
      index.push(a, a + 1, a + cols, a + cols, a + 1, a + cols + 1);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uv, 2));
  geo.setIndex(index);
  return geo;
}

function overlayMaterial(map: DataTexture | null, color: Color, opacity = 1, side: Side = DoubleSide): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, map, transparent: true, opacity, depthTest: false, depthWrite: false, side });
}

/** Everything the globe pass draws, built on first use. The group carries the world-to-view rotation. */
interface GlobeScene {
  scene: Scene;
  group: Group;
  sphere: BufferGeometry;
  fieldMaterial: MeshBasicMaterial;
  field: Mesh;
  lakes: Mesh[];
  atmosphere: Mesh;
  materials: MeshBasicMaterial[];
  surfaces: ShaderMaterial[];
}

/** Three.js (WebGL2) base layer: sea outline, land, data texture, and GPU-drawn wind streaks. */
export class ThreeBase implements BaseRenderer {
  readonly kind = 'webgl' as const;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10);
  private readonly particleScene = new Scene();
  /** Pixel space, y up: particle positions are (x, H - y). */
  private readonly screenCamera = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  private readonly globeCamera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 20);
  private globeScene: GlobeScene | null = null;
  private readonly theme: Theme;
  private readonly head = new Float64Array(3);
  private readonly streak = new Float64Array((WIND_STREAK_SEGMENTS + 1) * 2);
  private readonly sea: Mesh;
  private readonly landUnder: Mesh;
  /** One mesh per lake area tier (`LAKE_TIER_MIN_ZOOM`); `visible` follows the zoom. */
  private readonly lakes: Mesh[];
  private readonly field: Mesh;
  private particleMesh: Mesh | null = null;
  private fieldMaterial: MeshBasicMaterial;
  private hasPrecipitation = false;
  private texture: DataTexture | null = null;
  private seaTexture: DataTexture | null = null;
  private landTexture: DataTexture | null = null;
  private texData: Uint8Array | null = null;
  private texSize = '';
  private particleGeo: BufferGeometry | null = null;
  private particleMaterial: MeshBasicMaterial | null = null;
  private particleCapacity = 0;
  private positions = new Float32Array(0);
  private colors = new Float32Array(0);
  private windLin: RGB;
  private inkLin: RGB;
  private rainLin: RGB;
  private snowLin: RGB;
  private readonly humidityLin: RGB[] = [];
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, theme: Theme) {
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 is not available.');
    const col = (rgb: RGB) => new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
    this.theme = theme;
    this.renderer.setClearColor(col(theme.rgb.paper), 1);
    this.renderer.autoClear = false;
    this.camera.position.z = 5;
    this.globeCamera.position.z = 10;
    this.windLin = linear(theme.rgb.wind);
    this.inkLin = linear(theme.rgb.ink);
    const rainColor = new Uint8Array(3);
    theme.ramps.rain.at(5, rainColor, 0);
    this.rainLin = linear([rainColor[0], rainColor[1], rainColor[2]]);
    const snowColor = new Uint8Array(3);
    theme.ramps.snow.at(5, snowColor, 0);
    this.snowLin = linear([snowColor[0], snowColor[1], snowColor[2]]);
    const humidityColor = new Uint8Array(3);
    for (let b = 0; b < HUMIDITY_BUCKETS; b++) {
      theme.ramps.humidity.at(b / (HUMIDITY_BUCKETS - 1), humidityColor, 0);
      this.humidityLin.push(linear([humidityColor[0], humidityColor[1], humidityColor[2]]));
    }

    // The sea is the filled map outline; outside it the paper colour shows.
    this.sea = new Mesh(new ShapeGeometry(new Shape(MAP_OUTLINE.map(([x, y]) => new Vector2(x, y)))), surfaceMaterial(theme.rgb.sea, 'flat'));
    this.sea.renderOrder = 0;
    this.scene.add(this.sea);

    this.landUnder = new Mesh(this.buildShapeGeometry(projectedLand()), surfaceMaterial(theme.rgb.land, 'flat'));
    this.landUnder.renderOrder = 1;
    // Lakes keep their sea colour above the field raster.
    const lakeMaterial = overlayMaterial(null, col(theme.rgb.sea));
    this.lakes = projectedLakeTiers().map(polygons => {
      const mesh = new Mesh(this.buildShapeGeometry(polygons), lakeMaterial);
      mesh.renderOrder = 2.5;
      return mesh;
    });
    this.fieldMaterial = overlayMaterial(null, new Color(1, 1, 1));
    this.field = new Mesh(fieldGridGeometry(), this.fieldMaterial);
    this.field.renderOrder = 2;
    this.field.visible = false;
    this.scene.add(this.landUnder, ...this.lakes, this.field);
  }

  private buildShapeGeometry(polygons: ProjectedPolygon[]): BufferGeometry {
    const shapes: Shape[] = [];
    for (const p of polygons) {
      const pts: Vector2[] = [];
      for (let i = 0; i < p.outer.length; i += 2) pts.push(new Vector2(p.outer[i], p.outer[i + 1]));
      const shape = new Shape(pts);
      for (const h of p.holes) {
        const hp: Vector2[] = [];
        for (let i = 0; i < h.length; i += 2) hp.push(new Vector2(h[i], h[i + 1]));
        shape.holes.push(new Path(hp));
      }
      shapes.push(shape);
    }
    return new ShapeGeometry(shapes);
  }

  resize(width: number, height: number, dpr: number): void {
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(width, height, false);
  }

  setFieldImage(rgba: Uint8Array, cols: number, rows: number): void {
    this.hasPrecipitation = rgba.some((value, index) => index % 4 === 3 && value > 0);
    const size = `${cols}x${rows}`;
    if (!this.texture || this.texSize !== size) {
      this.texture?.dispose();
      this.texData = new Uint8Array(cols * rows * 4);
      const tex = new DataTexture(this.texData, cols, rows, RGBAFormat, UnsignedByteType);
      tex.minFilter = LinearFilter;
      tex.magFilter = LinearFilter;
      tex.wrapS = RepeatWrapping; // u runs past 1 on the map's eastern half; longitude is periodic
      tex.wrapT = ClampToEdgeWrapping;
      tex.generateMipmaps = false;
      tex.colorSpace = SRGBColorSpace;
      this.texture = tex;
      this.texSize = size;
      this.fieldMaterial.map = tex;
      this.fieldMaterial.needsUpdate = true;
      if (this.globeScene) { this.globeScene.fieldMaterial.map = tex; this.globeScene.fieldMaterial.needsUpdate = true; }
    }
    this.texData!.set(rgba);
    this.texture!.needsUpdate = true;
  }

  setSurfaceImages(sea: Uint8Array, land: Uint8Array, cols: number, rows: number): void {
    const upload = (texture: DataTexture | null, rgba: Uint8Array): DataTexture => {
      if (!texture || texture.image.width !== cols || texture.image.height !== rows) {
        texture?.dispose();
        texture = new DataTexture(new Uint8Array(rgba.length), cols, rows, RGBAFormat, UnsignedByteType);
        texture.minFilter = LinearFilter; texture.magFilter = LinearFilter;
        texture.wrapS = RepeatWrapping; texture.wrapT = ClampToEdgeWrapping;
        texture.generateMipmaps = false; texture.colorSpace = SRGBColorSpace;
      }
      (texture.image.data as Uint8Array).set(rgba);
      texture.needsUpdate = true;
      return texture;
    };
    this.seaTexture = upload(this.seaTexture, sea);
    this.landTexture = upload(this.landTexture, land);
    const materials = [this.sea.material, this.landUnder.material] as ShaderMaterial[];
    for (const [i, texture] of [this.seaTexture, this.landTexture].entries()) {
      materials[i].uniforms.surface.value = texture;
      materials[i].uniforms.hasSurface.value = true;
      if (this.globeScene) {
        this.globeScene.surfaces[i].uniforms.surface.value = texture;
        this.globeScene.surfaces[i].uniforms.hasSurface.value = true;
      }
    }
  }

  private ensureParticles(capacity: number): void {
    if (this.particleGeo && capacity <= this.particleCapacity) return;
    if (this.particleMesh) this.particleScene.remove(this.particleMesh);
    this.particleGeo?.dispose();
    this.particleCapacity = capacity;
    const vertices = (WIND_STREAK_SEGMENTS + 1) * 2;
    this.positions = new Float32Array(capacity * vertices * 3);
    this.colors = new Float32Array(capacity * vertices * 4);
    const index = new Uint32Array(capacity * WIND_STREAK_SEGMENTS * 6);
    for (let i = 0; i < capacity; i++) {
      for (let j = 0; j < WIND_STREAK_SEGMENTS; j++) {
        const v = i * vertices + j * 2;
        index.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], (i * WIND_STREAK_SEGMENTS + j) * 6);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage));
    geo.setAttribute('color', new BufferAttribute(this.colors, 4).setUsage(DynamicDrawUsage));
    geo.setIndex(new BufferAttribute(index, 1));
    this.particleMaterial ??= new MeshBasicMaterial({ vertexColors: true, transparent: true, depthTest: false, depthWrite: false, side: DoubleSide });
    this.particleMesh = new Mesh(geo, this.particleMaterial);
    this.particleMesh.frustumCulled = false;
    this.particleMesh.renderOrder = 4;
    this.particleScene.add(this.particleMesh);
    this.particleGeo = geo;
  }

  private ensureGlobe(): GlobeScene {
    if (this.globeScene) return this.globeScene;
    const col = (rgb: RGB) => new Color().setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, SRGBColorSpace);
    const scene = new Scene();
    const group = new Group();
    group.matrixAutoUpdate = false;
    const sphere = uvSphere();
    const seaMaterial = surfaceMaterial(this.theme.rgb.sea, 'globe', this.seaTexture);
    const landMaterial = surfaceMaterial(this.theme.rgb.land, 'globe', this.landTexture);
    const lakeMaterial = overlayMaterial(null, col(this.theme.rgb.sea), 1, FrontSide);
    const fieldMaterial = overlayMaterial(this.texture, new Color(1, 1, 1), 1, FrontSide);
    const sea = new Mesh(sphere, seaMaterial);
    sea.renderOrder = 0;
    const land = new Mesh(landGlobeGeometry(), landMaterial);
    land.renderOrder = 1;
    const lakes = lakeGlobeGeometries().map(geometry => {
      const mesh = new Mesh(geometry, lakeMaterial);
      mesh.renderOrder = 2.5;
      mesh.scale.setScalar(1.0005);
      return mesh;
    });
    const field = new Mesh(sphere, fieldMaterial);
    field.renderOrder = 2;
    field.scale.setScalar(1.001);
    group.add(sea, land, ...lakes, field);
    const atmosphere = atmosphereRing(this.theme.rgb.sea);
    scene.add(group, atmosphere);
    this.globeScene = { scene, group, sphere, fieldMaterial, field, lakes, atmosphere, materials: [lakeMaterial], surfaces: [seaMaterial, landMaterial] };
    return this.globeScene;
  }

  draw(view: MapCamera, particles: ParticleSystem, particleAlpha: number, _theme: Theme, humidity = false): void {
    if (this.disposed || this.isLost()) return;
    this.renderer.clear();
    if (view.kind === 'globe') this.drawGlobe(view as GlobeView);
    else this.drawFlat(view as MapView);
    if (this.particleMesh) this.particleMesh.visible = particleAlpha > 0;
    if (particleAlpha <= 0) return;
    this.drawParticles(view, particles, particleAlpha, humidity);
    this.renderer.render(this.particleScene, this.screenCamera);
  }

  private drawFlat(view: MapView): void {
    const [x0, y0, x1, y1] = view.worldRect();
    this.camera.left = x0; this.camera.right = x1; this.camera.top = y1; this.camera.bottom = y0;
    this.camera.updateProjectionMatrix();
    this.field.visible = !!this.texture && this.hasPrecipitation;
    const lakeTiers = visibleTierCount(LAKE_TIER_MIN_ZOOM, webZoom(view));
    this.lakes.forEach((mesh, t) => { mesh.visible = t < lakeTiers; });
    this.renderer.render(this.scene, this.camera);
  }

  private drawGlobe(view: GlobeView): void {
    const g = this.ensureGlobe();
    rotationMatrix(view.rotation(), g.group.matrix);
    g.group.matrixWorldNeedsUpdate = true;
    g.field.visible = !!this.texture && this.hasPrecipitation;
    const lakeTiers = visibleTierCount(LAKE_TIER_MIN_ZOOM, webZoom(view));
    g.lakes.forEach((mesh, t) => { mesh.visible = t < lakeTiers; });
    const cam = this.globeCamera;
    const r = view.radius;
    cam.left = -(view.width / 2 + view.offsetX) / r; cam.right = (view.width / 2 - view.offsetX) / r;
    cam.top = view.height / (2 * r); cam.bottom = -view.height / (2 * r);
    cam.updateProjectionMatrix();
    this.renderer.render(g.scene, cam);
  }

  /** Curved screen-space ribbons follow the local wind field. */
  private drawParticles(view: MapCamera, particles: ParticleSystem, particleAlpha: number, humidity: boolean): void {
    const sc = this.screenCamera;
    const w = view.width;
    const h = view.height;
    sc.right = w; sc.top = h;
    sc.updateProjectionMatrix();
    this.ensureParticles(particles.count);
    const geo = this.particleGeo!;
    const n = particles.count;
    const pos = this.positions;
    const col = this.colors;
    const head = this.head;
    const streak = this.streak;
    const [wr, wg, wb] = this.windLin;
    const [ir, ig, ib] = this.inkLin;
    const [rr, rg, rb] = this.rainLin;
    const [sr, sg, sb] = this.snowLin;
    let nv = 0;
    for (let i = 0; i < n; i++) {
      view.projectZ(particles.lon[i], particles.lat[i], head);
      const z = head[2];
      if (z <= 0) continue;
      const limb = limbFade(z);
      if (limb <= 0) continue;
      const count = particles.traceStreak(i, view, streak);
      if (count < 2) continue;
      const rainF = particles.rainFactor(i);
      const bliz = particles.blizzardFactor(i);
      const widen = 1 + 2 * rainF * (1 - bliz) + 0.8 * bliz;
      const vertices = (WIND_STREAK_SEGMENTS + 1) * 2;
      for (let j = 0; j <= WIND_STREAK_SEGMENTS; j++) {
        const point = Math.min(j, count - 1);
        const before = Math.max(0, point - 1), after = Math.min(count - 1, point + 1);
        const dx = streak[before * 2] - streak[after * 2];
        const dy = streak[after * 2 + 1] - streak[before * 2 + 1];
        const length = Math.hypot(dx, dy) || 1;
        const nx = -dy / length, ny = dx / length;
        const half = (0.6 - 0.45 * j / WIND_STREAK_SEGMENTS) * widen;
        const x = streak[point * 2], y = h - streak[point * 2 + 1];
        const p = (nv * vertices + j * 2) * 3;
        pos[p] = x + nx * half; pos[p + 1] = y + ny * half; pos[p + 2] = 0;
        pos[p + 3] = x - nx * half; pos[p + 4] = y - ny * half; pos[p + 5] = 0;
      }
      const t = Math.min(1, particles.speed[i] / 35);
      const humidColor = humidity ? this.humidityLin[humidityBucket(particles.humidity[i])] : null;
      const mix = 0.6 * rainF;
      const r0 = humidColor ? humidColor[0] : wr + (ir - wr) * t;
      const g0 = humidColor ? humidColor[1] : wg + (ig - wg) * t;
      const b0 = humidColor ? humidColor[2] : wb + (ib - wb) * t;
      let r = r0 + (rr - r0) * mix;
      let g = g0 + (rg - g0) * mix;
      let b = b0 + (rb - b0) * mix;
      const sm = 0.7 * particles.snowFactor(i);
      r += (sr - r) * sm; g += (sg - g) * sm; b += (sb - b) * sm;
      if (bliz > 0) { const white = 0.85 * bliz; r += (1 - r) * white; g += (1 - g) * white; b += (1 - b) * white; }
      const a = Math.min(1, particles.fade(i) * particleAlpha * (humidity ? 0.85 : 0.55 + 0.4 * t) * limb * (1 - 0.3 * bliz));
      for (let j = 0; j <= WIND_STREAK_SEGMENTS; j++) {
        const alpha = a * (1 - Math.min(j, count - 1) / (count - 1));
        const c = (nv * vertices + j * 2) * 4;
        for (let side = 0; side < 2; side++) {
          const k = c + side * 4;
          col[k] = r; col[k + 1] = g; col[k + 2] = b; col[k + 3] = alpha;
        }
      }
      nv++;
    }
    geo.setDrawRange(0, nv * WIND_STREAK_SEGMENTS * 6);
    (geo.getAttribute('position') as BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as BufferAttribute).needsUpdate = true;
  }

  isLost(): boolean {
    return this.renderer.getContext().isContextLost();
  }

  dispose(): void {
    this.disposed = true;
    this.texture?.dispose();
    this.seaTexture?.dispose();
    this.landTexture?.dispose();
    this.particleGeo?.dispose();
    this.particleMaterial?.dispose();
    this.fieldMaterial.dispose();
    (this.sea.material as MeshBasicMaterial).dispose();
    this.sea.geometry.dispose();
    (this.landUnder.material as MeshBasicMaterial).dispose();
    this.landUnder.geometry.dispose();
    (this.lakes[0].material as MeshBasicMaterial).dispose();
    for (const mesh of this.lakes) mesh.geometry.dispose();
    this.field.geometry.dispose();
    if (this.globeScene) {
      const g = this.globeScene;
      g.sphere.dispose();
      landGlobeGeometry().dispose();
      for (const geometry of lakeGlobeGeometries()) geometry.dispose();
      g.fieldMaterial.dispose();
      for (const m of g.materials) m.dispose();
      for (const m of g.surfaces) m.dispose();
      g.atmosphere.geometry.dispose();
      (g.atmosphere.material as ShaderMaterial).dispose();
    }
    this.renderer.dispose();
  }
}
