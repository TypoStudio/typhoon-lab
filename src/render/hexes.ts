/** Pure helpers for the rain/snow hexagon tiling drawn by the overlay canvas. */

export const HEX_RADIUS = 14;
export const HEX_RADIUS_SMALL = 11;
export const HEX_BUCKETS = 8;
/** Circumradius lost per hexagon; 0 so tiles touch and the blurred tiling stays continuous. */
export const HEX_INSET = 0;
/** Rain below this rate (mm/h) draws no hexagon. */
export const HEX_MIN_RAIN = 0.5;
/** Rain rate (mm/h) at which hexagon opacity stops growing and the top bucket starts. */
const HEX_FULL_RAIN = 20;
/** Snow is a faint haze; the wind streaks carry the effect. */
export const SNOW_HAZE_ALPHA = 0.22;
const HEX_ALPHA_SCALE = 0.9;

/** Circumradius in CSS px; phones get smaller tiles. */
export const hexRadius = (viewWidth: number): number => (viewWidth < 700 ? HEX_RADIUS_SMALL : HEX_RADIUS);

/**
 * Centres (x0, y0, x1, y1, …) of a pointy-top hex grid covering [0, width] × [0, height]:
 * hex width √3·R, row step 1.5·R, odd rows shifted half a width.
 */
export function hexCentres(width: number, height: number, R: number): Float32Array {
  const w = Math.sqrt(3) * R;
  const step = 1.5 * R;
  const out: number[] = [];
  for (let row = 0, y = 0; y - R <= height; row++, y = row * step) {
    for (let x = row & 1 ? -w / 2 : 0; x - w / 2 <= width; x += w) out.push(x, y);
  }
  return Float32Array.from(out);
}

/** Blur radius (CSS px) that softens a tiling of circumradius R while keeping the hexagon shape visible. */
export const blurRadiusFor = (R: number): number => 0.45 * R;

/** Corner offsets (x0, y0, …, x5, y5) of one pointy-top hexagon, shrunk by `inset`. */
export function hexCorners(R: number, inset = HEX_INSET): Float32Array {
  const r = R - inset;
  const out = new Float32Array(12);
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3;
    out[2 * k] = r * Math.cos(a);
    out[2 * k + 1] = r * Math.sin(a);
  }
  return out;
}

/** Intensity bucket 0..HEX_BUCKETS-1 for a rain rate (mm/h); heavier than 20 mm/h shares the top bucket. */
export function hexBucket(rain: number): number {
  const t = (rain - HEX_MIN_RAIN) / (HEX_FULL_RAIN - HEX_MIN_RAIN);
  return Math.max(0, Math.min(HEX_BUCKETS - 1, Math.floor(t * HEX_BUCKETS)));
}

/** Representative rain rate (mm/h) at the middle of a bucket, used for colour and opacity. */
export const hexBucketRain = (bucket: number): number =>
  HEX_MIN_RAIN + ((HEX_FULL_RAIN - HEX_MIN_RAIN) * (bucket + 0.5)) / HEX_BUCKETS;

/** Hexagon opacity for a rain rate: a concave ramp 0.08..0.80 so light and moderate rain stay distinguishable, capped for snow, ×0.9 to keep the map readable. */
export function hexAlpha(rain: number, snow: boolean): number {
  const a = 0.08 + 0.72 * Math.min(1, Math.max(0, (rain - HEX_MIN_RAIN) / (HEX_FULL_RAIN - HEX_MIN_RAIN))) ** 0.7;
  return (snow ? Math.min(SNOW_HAZE_ALPHA, a) : a) * HEX_ALPHA_SCALE;
}
