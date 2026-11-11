/**
 * Also publishes the brand panel's right edge as `--brand-right`. Docks the notes (guidance, renderer note, toast) directly on the palette, with no gap, and stacks them upward.
 * The palette's box is also published as CSS variables on the map wrapper for
 * anything that takes the palette's place (the drag-focus card). With no palette box (display: none) everything drops
 * to the bottom edge. Layout is read on every size change of the wrapper or the palette, so the
 * sidebar, the phone layout, wrapping tabs and font loading all keep it docked.
 */
export function dockToPalette(wrap: HTMLElement, palette: HTMLElement, notes: HTMLElement, brand: HTMLElement): () => void {
  const sync = () => {
    const w = wrap.getBoundingClientRect();
    const p = palette.getBoundingClientRect();
    const shown = p.width > 0 && p.height > 0;
    const left = shown ? p.left - w.left : 0;
    const width = shown ? p.width : w.width;
    const paletteTop = shown ? w.bottom - p.top : 0;
    notes.style.left = `${left}px`;
    notes.style.width = `${width}px`;
    notes.style.right = 'auto';
    notes.style.bottom = `${paletteTop}px`;
    wrap.style.setProperty('--brand-right', `${brand.getBoundingClientRect().right - w.left}px`); // the speed bar starts one gap after the brand panel
    wrap.style.setProperty('--dock-left', `${left}px`);
    wrap.style.setProperty('--dock-width', `${width}px`);
    wrap.style.setProperty('--dock-floor', `${shown ? w.bottom - p.bottom : 0}px`);
  };
  const observer = new ResizeObserver(sync);
  observer.observe(wrap);
  observer.observe(palette);
  observer.observe(brand);
  window.addEventListener('resize', sync);
  sync();
  return () => { observer.disconnect(); window.removeEventListener('resize', sync); };
}
