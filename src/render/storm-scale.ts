/** Web zoom (see `webZoom`) at or below which storm symbols are at their smallest, and at or above which they are full size. */
export const STORM_FAR_ZOOM = 3.4;
export const STORM_NEAR_ZOOM = 5.4;
/** Share of the full radius kept at the far end, and the smallest radius in px (an eye plus a ring must stay legible). */
const MIN_SHARE = 0.32;
const MIN_RADIUS = 5;

/** 0 when zoomed far out, 1 from regional zoom on; linear in between so the glyph size never jumps. */
export function stormZoomFactor(zoom: number): number {
  return Math.min(1, Math.max(0, (zoom - STORM_FAR_ZOOM) / (STORM_NEAR_ZOOM - STORM_FAR_ZOOM)));
}

/** On-screen glyph radius in px: the full radius at regional zoom, shrinking towards `MIN_SHARE` of it (never below 5 px or above the full radius) when zoomed out. */
export function stormGlyphRadiusAt(fullRadius: number, zoom: number): number {
  const share = MIN_SHARE + (1 - MIN_SHARE) * stormZoomFactor(zoom);
  return Math.min(fullRadius, Math.max(MIN_RADIUS, fullRadius * share));
}

/** Label font size in px: 10 when zoomed out, 12 at regional zoom. */
export const stormLabelSize = (zoom: number): number => Math.round(10 + 2 * stormZoomFactor(zoom));

/** The radius/motion second line shows once zoomed in, or for the selected or hovered storm. */
export const stormDetailLine = (zoom: number, selected: boolean, hovered: boolean): boolean => selected || hovered || zoom >= STORM_NEAR_ZOOM - 0.4;
