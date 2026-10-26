import type { MapCamera } from '../render/camera';

export interface MapInputHandlers {
  /** A click or tap that was not a drag. Coordinates are CSS px inside the element. */
  onTap(px: number, py: number): void;
  /** Mouse hover position, or null when the pointer leaves. */
  onHover(px: number | null, py: number | null): void;
  /** True while the camera is being moved by pan, pinch or wheel; false when the gesture ends. */
  onInteract(active: boolean): void;
}

const DRAG_SLOP = 6;
const WHEEL_IDLE_MS = 180;

/**
 * Pointer input for the map: drag to pan, wheel / pinch to zoom, tap to select. Taps and drags are
 * distinguished by a small movement threshold so panning never places a tool by accident.
 */
export function attachMapInput(el: HTMLElement, getView: () => MapCamera, handlers: MapInputHandlers): () => void {
  const pointers = new Map<number, { x: number; y: number }>();
  let start = { x: 0, y: 0 };
  let moved = false;
  let pinch = 0;
  let active = false;
  let wheelTimer = 0;

  const setActive = (on: boolean) => {
    if (on === active) return;
    active = on;
    handlers.onInteract(on);
  };

  const local = (ev: PointerEvent | WheelEvent) => {
    const r = el.getBoundingClientRect();
    return { x: ev.clientX - r.left, y: ev.clientY - r.top };
  };

  const down = (ev: PointerEvent) => {
    if (ev.pointerType === 'mouse' && ev.button !== 0) return;
    const p = local(ev);
    pointers.set(ev.pointerId, p);
    try { el.setPointerCapture(ev.pointerId); } catch { /* capture can fail for synthetic events */ }
    if (pointers.size === 1) { start = p; moved = false; }
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = Math.hypot(a.x - b.x, a.y - b.y);
      moved = true;
      setActive(true);
    }
  };

  const move = (ev: PointerEvent) => {
    const p = local(ev);
    const prev = pointers.get(ev.pointerId);
    if (!prev) {
      if (ev.pointerType === 'mouse') handlers.onHover(p.x, p.y);
      return;
    }
    if (pointers.size === 1) {
      if (!moved && Math.hypot(p.x - start.x, p.y - start.y) > DRAG_SLOP) {
        moved = true;
        setActive(true);
        getView().dragPx(start.x, start.y, p.x, p.y);
      } else if (moved) {
        getView().dragPx(prev.x, prev.y, p.x, p.y);
      }
      pointers.set(ev.pointerId, p);
    } else if (pointers.size === 2) {
      const before = [...pointers.values()];
      const c0 = { x: (before[0].x + before[1].x) / 2, y: (before[0].y + before[1].y) / 2 };
      pointers.set(ev.pointerId, p);
      const [a, b] = [...pointers.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const c1 = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const view = getView();
      view.dragPx(c0.x, c0.y, c1.x, c1.y);
      if (pinch > 0 && dist > 0) view.zoomAt(dist / pinch, c1.x, c1.y);
      pinch = dist;
    }
  };

  const up = (ev: PointerEvent) => {
    const wasOnly = pointers.size === 1;
    const had = pointers.delete(ev.pointerId);
    if (!had) return;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* already released */ }
    if (wasOnly && !moved && ev.type === 'pointerup') {
      const p = local(ev);
      handlers.onTap(p.x, p.y);
    }
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 1) { start = [...pointers.values()][0]; moved = true; }
    if (pointers.size === 0) setActive(wheelTimer !== 0);
  };

  const leave = (ev: PointerEvent) => { if (ev.pointerType === 'mouse') handlers.onHover(null, null); };

  const wheel = (ev: WheelEvent) => {
    ev.preventDefault();
    const p = local(ev);
    const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
    const strength = ev.ctrlKey ? 0.01 : 0.0016;
    setActive(true);
    getView().zoomAt(Math.exp(-ev.deltaY * unit * strength), p.x, p.y);
    window.clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => { wheelTimer = 0; if (pointers.size === 0) setActive(false); }, WHEEL_IDLE_MS);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', leave);
  el.addEventListener('wheel', wheel, { passive: false });
  return () => {
    window.clearTimeout(wheelTimer);
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', leave);
    el.removeEventListener('wheel', wheel);
  };
}
