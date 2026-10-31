import type { ParticleSystem } from './particles';
import type { Theme } from './theme';
import type { MapCamera } from './camera';

/** The raster layer under the vector overlay: sea, land, data field and wind particles. */
export interface BaseRenderer {
  readonly kind: 'webgl' | 'canvas';
  resize(width: number, height: number, dpr: number): void;
  /** RGBA image, cols × rows, row 0 = south. */
  setFieldImage(rgba: Uint8Array, cols: number, rows: number): void;
  /** Opaque colours applied directly to sea and land, without another overlay mesh. */
  setSurfaceImages(sea: Uint8Array, land: Uint8Array, cols: number, rows: number): void;
  draw(view: MapCamera, particles: ParticleSystem, particleAlpha: number, theme: Theme, humidity: boolean): void;
  isLost(): boolean;
  dispose(): void;
}

/** Shared colour buckets keep Canvas and WebGL humidity colours aligned. */
export const HUMIDITY_BUCKETS = 16;
export const humidityBucket = (humidity: number): number =>
  Math.min(HUMIDITY_BUCKETS - 1, Math.max(0, Math.round(humidity * (HUMIDITY_BUCKETS - 1))));
