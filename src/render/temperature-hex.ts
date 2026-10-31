/** A pointy hexagon grid fixed to geographic coordinates; 120 columns wrap at the date line. */
const RADIUS = 3 / Math.sqrt(3);

export function temperatureHexCenter(lon: number, lat: number, out: Float64Array): void {
  const x = lon + 180, y = lat + 90;
  const q = (Math.sqrt(3) * x / 3 - y / 3) / RADIUS;
  const r = (2 * y / 3) / RADIUS;
  const cubeY = -q - r;
  let iq = Math.round(q), iy = Math.round(cubeY), ir = Math.round(r);
  const dq = Math.abs(iq - q), dy = Math.abs(iy - cubeY), dr = Math.abs(ir - r);
  if (dq > dy && dq > dr) iq = -iy - ir;
  else if (dy > dr) iy = -iq - ir;
  else ir = -iq - iy;
  out[0] = Math.sqrt(3) * RADIUS * (iq + ir / 2) - 180;
  out[1] = Math.max(-90, Math.min(90, 1.5 * RADIUS * ir - 90));
}
