/**
 * SVG path data for the tropical-cyclone symbol, with exactly the geometry of `Overlay.cycloneSymbol` (canvas, y down):
 * a ring with a hollow eye plus, from rank 1 up, two tails leaving it tangentially on opposite sides.
 * Fill `ring` with `fill-rule="evenodd"`; `tails` is a plain fill. Both are drawn about the origin.
 */
export function cycloneSymbolPaths(R: number, rank: number): { ring: string; tails: string } {
  const hole = rank < 1 ? 0.6 : 0.41;
  const f = rank < 1 ? 0 : rank < 3 ? 0.5 : 1;
  const n = (v: number) => String(+v.toFixed(2) || 0);
  const pt = (x: number, y: number) => `${n(x)} ${n(y)}`;
  // Canvas point for polar (r in units of R, degrees counter-clockwise from +x) turned by `off` degrees.
  const P = (r: number, deg: number, off: number): [number, number] => {
    const a = (deg + off) * Math.PI / 180;
    return [R * r * Math.cos(a), -R * r * Math.sin(a)];
  };
  // A canvas full-circle arc becomes two SVG half arcs; `sweep` 1 = increasing angle (canvas default), 0 = anticlockwise.
  const circle = (r: number, sweep: 0 | 1) => `M${n(r)} 0A${n(r)} ${n(r)} 0 1 ${sweep} ${n(-r)} 0A${n(r)} ${n(r)} 0 1 ${sweep} ${n(r)} 0Z`;
  const ring = circle(R, 1) + circle(R * hole, 0);
  let tails = '';
  if (f > 0) {
    for (const off of [0, 180]) {
      const S = P(1, 115, off); // the outer edge leaves the ring here, heading clockwise
      const N = P(1, 55, off); // the inner edge rejoins the ring here
      const T = P(1 + 0.6 * f, 55 - 32 * f, off);
      const lead = R * (0.4 + 0.45 * f);
      const a = (115 + off) * Math.PI / 180;
      const droop = (off * Math.PI) / 180;
      tails += `M${pt(S[0], S[1])}C${pt(S[0] + Math.sin(a) * lead, S[1] + Math.cos(a) * lead)} `
        + `${pt(T[0] - Math.cos(droop) * 0.5 * R * f, T[1] - Math.sin(droop) * 0.5 * R * f - 0.28 * R * f * Math.cos(droop))} ${pt(T[0], T[1])}`
        + `Q${pt((T[0] + N[0]) / 2, (T[1] + N[1]) / 2)} ${pt(N[0], N[1])}Z`;
    }
  }
  return { ring, tails };
}
