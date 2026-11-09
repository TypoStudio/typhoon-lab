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
