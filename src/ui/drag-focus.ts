import { t } from '../i18n';

/**
 * Focus mode while a palette icon is dragged onto the map: CSS (keyed on `html.is-tool-dragging`) fades out the legend,
 * the notes and the palette, and this card describes the dragged item where the palette was. Nothing is removed or
 * re-rendered, so the palette tab and its scroll position come back untouched.
 */
interface DragFocusOptions {
  host: HTMLElement;
  announce(text: string): void;
  /** Extra line for an item (a condition's radius); empty for none. */
  detail(button: HTMLElement): string;
}

let options: DragFocusOptions | null = null;
let card: HTMLElement | null = null;

export function configureDragFocus(o: DragFocusOptions): void {
  options = o;
  card = document.createElement('div');
  card.className = 'drag-card';
  card.setAttribute('data-testid', 'drag-card');
  card.setAttribute('aria-hidden', 'true');
  card.hidden = true;
  o.host.append(card);
}

export function showDragFocus(button: HTMLElement): void {
  if (!options || !card) return;
  const icon = button.querySelector('svg:not(.tool__icon--secondary)')?.outerHTML.replace('tool__icon', 'drag-card__icon') ?? '';
  const title = t(button.dataset.tipTitle ?? button.querySelector('.tool__name')?.textContent ?? '');
  const text = t(button.dataset.tip ?? '');
  const detail = options.detail(button);
  card.innerHTML = `<span class="drag-card__art" style="color:${getComputedStyle(button.querySelector('svg')!).color}">${icon}</span>`
    + '<span class="drag-card__text"><strong class="drag-card__name"></strong><span class="drag-card__desc"></span><span class="drag-card__meta"></span></span>';
  card.querySelector('.drag-card__name')!.textContent = title;
  card.querySelector('.drag-card__desc')!.textContent = text;
  const meta = card.querySelector<HTMLElement>('.drag-card__meta')!;
  meta.textContent = detail;
  meta.hidden = !detail;
  card.hidden = false;
  options.announce([title, text, detail].filter(Boolean).join('. '));
}

export function hideDragFocus(): void {
  if (card) card.hidden = true;
}
