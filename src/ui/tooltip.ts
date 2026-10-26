import { t } from '../i18n';

const SHOW_DELAY = 250;
const LONG_PRESS = 450;
const TOUCH_LINGER = 1600;
const TOUCH_SLOP = 10;
const MARGIN = 8;
const GAP = 10;

/**
 * One shared in-game tooltip. Any element with `data-tip` (and optionally `data-tip-title`) gets it:
 * the attributes hold English source text, translated with t() each time the tip opens, so a language
 * change needs no re-labelling. Mouse and pen show it after a short hover, keyboard focus shows it at once,
 * touch shows it on long-press. A press anywhere hides it first, so it never gets in the way of a palette drag.
 */
export function attachTooltips(root: HTMLElement, tip: HTMLElement): () => void {
  const title = document.createElement('strong');
  title.className = 'tip__title';
  const text = document.createElement('span');
  text.className = 'tip__text';
  tip.append(title, text);
  tip.id ||= 'tip';

  let current: HTMLElement | null = null;
  let timer = 0;
  let linger = 0;
  /** Element whose tip was dismissed by a press; stays quiet until the pointer leaves it. */
  let muted: HTMLElement | null = null;
  let touch: { el: HTMLElement; x: number; y: number } | null = null;

  const owner = (node: EventTarget | null): HTMLElement | null =>
    node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null;

  function place(target: HTMLElement): void {
    const box = target.getBoundingClientRect();
    const width = Math.min(tip.offsetWidth, innerWidth - MARGIN * 2);
    const height = tip.offsetHeight;
    const above = box.top - GAP - height >= MARGIN;
    const top = above ? box.top - GAP - height : Math.min(box.bottom + GAP, innerHeight - height - MARGIN);
    const centre = box.left + box.width / 2;
    const left = Math.max(MARGIN, Math.min(centre - width / 2, innerWidth - width - MARGIN));
    tip.dataset.side = above ? 'top' : 'bottom';
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
    tip.style.setProperty('--caret-x', `${Math.round(Math.max(12, Math.min(centre - left, width - 12)))}px`);
  }

  function show(target: HTMLElement): void {
    window.clearTimeout(timer);
    window.clearTimeout(linger);
    if (!target.isConnected) return;
    if (current && current !== target) current.removeAttribute('aria-describedby');
    current = target;
    const heading = target.dataset.tipTitle;
    title.textContent = heading ? t(heading) : '';
    title.hidden = !heading;
    text.textContent = t(target.dataset.tip ?? '');
    tip.classList.remove('is-in');
    tip.hidden = false;
    target.setAttribute('aria-describedby', tip.id);
    place(target);
    void tip.offsetWidth; // commit the hidden state so the fade-in runs
    tip.classList.add('is-in');
  }

  function hide(): void {
    window.clearTimeout(timer);
    window.clearTimeout(linger);
    current?.removeAttribute('aria-describedby');
    current = null;
    tip.classList.remove('is-in');
    tip.hidden = true;
  }

  const schedule = (target: HTMLElement, delay: number) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => show(target), delay);
  };

  const onOver = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch' || ev.buttons) return;
    const target = owner(ev.target);
    if (!target || target === current || target === muted) return;
    // Moving between neighbours keeps the tip open, so skip the wait.
    schedule(target, current && !tip.hidden ? 0 : SHOW_DELAY);
  };
  const onOut = (ev: PointerEvent) => {
    if (ev.pointerType === 'touch') return;
    const target = owner(ev.target);
    if (!target) return;
    const into = ev.relatedTarget instanceof Node ? ev.relatedTarget : null;
    if (into && target.contains(into)) return;
    if (muted === target) muted = null;
    // Leaving for a neighbour: its own pointerover swaps the tip without a pause.
    if (owner(into)) return;
    hide();
  };
  const onDown = (ev: PointerEvent) => {
    const target = owner(ev.target);
    muted = target;
    hide();
    if (ev.pointerType !== 'touch' || !target) return;
    touch = { el: target, x: ev.clientX, y: ev.clientY };
    timer = window.setTimeout(() => { if (touch) show(touch.el); }, LONG_PRESS);
  };
  const onMove = (ev: PointerEvent) => {
    if (!touch || ev.pointerType !== 'touch') return;
    if (Math.hypot(ev.clientX - touch.x, ev.clientY - touch.y) > TOUCH_SLOP) { touch = null; hide(); }
  };
  const onUp = (ev: PointerEvent) => {
    if (ev.pointerType !== 'touch') return;
    touch = null;
    window.clearTimeout(timer);
    if (current) linger = window.setTimeout(hide, TOUCH_LINGER);
  };
  const onFocus = (ev: FocusEvent) => {
    const target = owner(ev.target);
    if (!target || !target.matches(':focus-visible')) return;
    muted = null;
    show(target);
  };
  const onBlur = (ev: FocusEvent) => { if (owner(ev.target) === current) hide(); };
  const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') hide(); };
  // Touch long-press on a button would otherwise open the browser's context menu over the tip.
  const onMenu = (ev: Event) => { if (touch && owner(ev.target)) ev.preventDefault(); };

  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onUp, true);
  document.addEventListener('pointercancel', onUp, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('contextmenu', onMenu, true);
  window.addEventListener('blur', hide);
  window.addEventListener('resize', hide);
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', onBlur);

  return () => {
    hide();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('pointerup', onUp, true);
    document.removeEventListener('pointercancel', onUp, true);
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('contextmenu', onMenu, true);
    window.removeEventListener('blur', hide);
    window.removeEventListener('resize', hide);
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('focusin', onFocus);
    root.removeEventListener('focusout', onBlur);
  };
}
