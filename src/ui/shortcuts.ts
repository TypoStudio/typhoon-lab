/** Palette shortcut characters: letters plus `, . / ;`. Pure so the mapping can be tested without a DOM. */
export interface KeyLike { key: string; code: string; altKey?: boolean; shiftKey?: boolean }

const PHYSICAL: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';' };

/**
 * The shortcut character of a key press, or '' when it is not one. Follows the typed character first and
 * falls back to the physical key under a non-Latin layout (Korean, Japanese, Chinese input). Punctuation counts when the
 * typed character is itself `, . / ;` whatever Shift says, because on QWERTZ and AZERTY layouts `/` and `.` need it; Shift + `/`
 * on a US layout types `?`, which stays free. Letters and the physical fallback never take Shift or Alt.
 */
export function shortcutChar(ev: KeyLike): string {
  if (ev.altKey) return '';
  if (ev.key.length === 1 && ',./;'.includes(ev.key)) return ev.key;
  if (ev.shiftKey) return '';
  if (/^[a-z]$/i.test(ev.key)) return ev.key.toLowerCase();
  return /^Key([A-Z])$/.exec(ev.code)?.[1].toLowerCase() ?? PHYSICAL[ev.code] ?? '';
}

/**
 * Speed keys: backtick (₩ on a Korean keyboard, or the physical Backquote key) resets the speed; `-` and `=` (or the numpad
 * minus and plus) step it one slower or faster. Shift is excluded so Shift + `-` / `+` keep zooming the map, and `~` stays free.
 * The numpad plus types `+` without Shift, so it is matched by code before the zoom handler sees it.
 */
export function speedKey(ev: KeyLike): 'reset' | 'prev' | 'next' | '' {
  if (ev.altKey || ev.shiftKey) return '';
  if (ev.code === 'NumpadSubtract') return 'prev';
  if (ev.code === 'NumpadAdd') return 'next';
  if (ev.key === '`' || ev.key === '₩' || ev.code === 'Backquote') return 'reset';
  if (ev.key === '-') return 'prev';
  if (ev.key === '=') return 'next';
  const plain = /^[\x20-\x7e]$/.test(ev.key); // a physical fallback only for non-Latin layouts, where the typed character is not ASCII
  if (!plain && ev.code === 'Minus') return 'prev';
  if (!plain && ev.code === 'Equal') return 'next';
  return '';
}
