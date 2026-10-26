import type { GeoPoint } from '../types';

export interface PaletteHandlers<T extends string> {
  /** Geographic point under the pointer if it is over the map itself (not over a floating control). */
  mapPoint(clientX: number, clientY: number): GeoPoint | null;
  onDragStart(tool: T): void;
  onDragMove(tool: T, point: GeoPoint | null): void;
  /** Pointer released: `point` is null when it was not over the map. */
  onDrop(tool: T, point: GeoPoint | null): void;
  onCancel(tool: T): void;
}

const DRAG_SLOP = 8;

/**
 * Pointer-event drag and drop from the weather palette onto the map. Works for mouse, pen and touch
 * (the buttons set `touch-action: none`). Capture plus window listeners track the gesture;
 * a palette press never starts a map pan, even if capture is lost. A press that does not move
 * past the slop is left to the normal click handler (arm the tool).
 */
export function attachPalette<T extends string>(buttons: Map<T, HTMLButtonElement>, handlers: PaletteHandlers<T>): void {
  let suppressClick = false;
  let active: {
    tool: T; button: HTMLButtonElement; pointerId: number;
    startX: number; startY: number; dragging: boolean; ghost: HTMLElement | null;
  } | null = null;

  const cleanup = () => {
    const drag = active;
    if (!drag) return null;
    // Clear first: releasing capture can itself dispatch lostpointercapture.
    active = null;
    drag.ghost?.remove();
    drag.button.classList.remove('is-dragging');
    document.documentElement.classList.remove('is-tool-dragging');
    try { drag.button.releasePointerCapture(drag.pointerId); } catch { /* already released */ }
    return drag;
  };

  // Use the icon centre for preview and release alike. On touch it is raised above
  // the finger so the chosen location remains visible instead of being covered.
  const target = (ev: PointerEvent) => ({ x: ev.clientX, y: ev.clientY + (ev.pointerType === 'touch' ? -44 : 0) });
  // A palette that scrolls sideways under the finger (touch-action: pan-x) keeps horizontal moves for the scroller:
  // only a mostly vertical move starts a drag there. Everywhere else any move past the slop does.
  const moved = (ev: PointerEvent, drag: NonNullable<typeof active>) => {
    const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
    if (ev.pointerType === 'touch' && getComputedStyle(drag.button).touchAction.includes('pan-x')) return Math.abs(dy) >= DRAG_SLOP && Math.abs(dy) > Math.abs(dx);
    return Math.hypot(dx, dy) >= DRAG_SLOP;
  };

  const cancel = () => {
    const drag = cleanup();
    if (drag?.dragging) { suppressClick = true; handlers.onCancel(drag.tool); }
  };

  // Keep the first gesture in charge. A second finger must not cancel the tool or
  // start panning the map underneath it. A new intentional press clears click suppression.
  window.addEventListener('pointerdown', ev => {
    if (active && ev.pointerId !== active.pointerId) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    suppressClick = false;
  }, { capture: true, passive: false });
  // Some browsers deliver a delayed compatibility click after a drop. Suppress it
  // regardless of its retargeted element, but preserve keyboard activation (detail 0).
  window.addEventListener('click', ev => {
    if (active?.dragging && ev.detail !== 0) { ev.preventDefault(); ev.stopImmediatePropagation(); return; }
    if (!suppressClick || ev.detail === 0) return;
    suppressClick = false;
    ev.preventDefault(); ev.stopImmediatePropagation();
  }, true);

  // Listen at the window as well as requesting capture: a release may be retargeted
  // outside the palette when the browser interrupts a drag or capture is unavailable.
  window.addEventListener('pointermove', ev => {
    const drag = active;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    if (ev.pointerType === 'mouse' && !(ev.buttons & 1)) { cancel(); return; }
    if (!drag.dragging) {
      if (!moved(ev, drag)) return;
      drag.dragging = true;
      drag.ghost = document.createElement('div');
      drag.ghost.className = `drag-ghost drag-ghost--${drag.tool}`;
      drag.ghost.setAttribute('aria-hidden', 'true');
      drag.ghost.innerHTML = (drag.button.querySelector('svg')?.outerHTML ?? '').replace('tool__icon', 'drag-ghost__icon');
      document.body.append(drag.ghost);
      drag.button.classList.add('is-dragging');
      document.documentElement.classList.add('is-tool-dragging');
      handlers.onDragStart(drag.tool);
    }
    ev.preventDefault();
    const { x, y } = target(ev);
    drag.ghost!.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    handlers.onDragMove(drag.tool, handlers.mapPoint(x, y));
  }, { capture: true, passive: false });

  window.addEventListener('pointerup', ev => {
    if (!active || ev.pointerId !== active.pointerId) return;
    const drag = cleanup()!;
    // A quick/coalesced gesture may reach release before any pointermove is delivered.
    if (drag.dragging || moved(ev, drag)) {
      suppressClick = true;
      const { x, y } = target(ev);
      handlers.onDrop(drag.tool, handlers.mapPoint(x, y));
    }
  }, true);
  window.addEventListener('pointercancel', ev => { if (ev.pointerId === active?.pointerId) cancel(); }, true);
  // Once a drag is under way the browser must not also scroll the palette or the page.
  window.addEventListener('touchmove', ev => { if (active?.dragging && ev.cancelable) ev.preventDefault(); }, { capture: true, passive: false });
  window.addEventListener('blur', cancel);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  window.addEventListener('keydown', ev => { if (ev.key === 'Escape') cancel(); });

  for (const [tool, button] of buttons) {
    button.addEventListener('pointerdown', ev => {
      if (ev.button !== 0) return;
      if (active) return;
      active = { tool, button, pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY, dragging: false, ghost: null };
      try { button.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers may not capture */ }
    });
    // Capture is an optimisation, not the gesture's lifetime. Window listeners still
    // receive moves/releases if capture is lost; cancel only on actual interruption.

    // A drag must never be mistaken for a press on the palette button.
    button.addEventListener('dragstart', ev => ev.preventDefault());
    button.addEventListener('contextmenu', ev => { if (active?.dragging) ev.preventDefault(); });
  }
}
