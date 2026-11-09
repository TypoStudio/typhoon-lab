import { describe, expect, it } from 'vitest';
import { shortcutChar } from '../src/ui/shortcuts';
import { FORMATION_KEYS, FORMATION_TOOLS, TOOL_KEYS } from '../src/ui/shell';
import { MEASURE_ITEMS, MEASURE_KEYS } from '../src/ui/measure';

const key = (k: string, code = '', mods: { altKey?: boolean; shiftKey?: boolean } = {}) => ({ key: k, code, ...mods });

describe('palette shortcuts', () => {
  it('maps typed letters and punctuation', () => {
    expect(shortcutChar(key('z', 'KeyZ'))).toBe('z');
    expect(shortcutChar(key('Z', 'KeyZ'))).toBe('z');
    for (const c of [',', '.', '/', ';']) expect(shortcutChar(key(c))).toBe(c);
  });

  it('falls back to the physical key under a non-Latin layout', () => {
    expect(shortcutChar(key('ㅋ', 'KeyZ'))).toBe('z');
    expect(shortcutChar(key('ー', 'Slash'))).toBe('/');
    expect(shortcutChar(key('，', 'Comma'))).toBe(',');
    expect(shortcutChar(key('。', 'Period'))).toBe('.');
    expect(shortcutChar(key('；', 'Semicolon'))).toBe(';');
  });

  it('follows the typed character with Shift, so / and . work on QWERTZ and AZERTY', () => {
    expect(shortcutChar(key('/', 'Digit7', { shiftKey: true }))).toBe('/'); // QWERTZ
    expect(shortcutChar(key('.', 'Semicolon', { shiftKey: true }))).toBe('.'); // AZERTY
    expect(shortcutChar(key(';', 'Comma', { shiftKey: true }))).toBe(';'); // QWERTZ
    expect(shortcutChar(key('/', 'Slash', { altKey: true }))).toBe('');
  });

  it('ignores Alt and Shift on letters, and the shifted US characters ? and < stay free', () => {
    expect(shortcutChar(key('?', 'Slash', { shiftKey: true }))).toBe('');
    expect(shortcutChar(key('<', 'Comma', { shiftKey: true }))).toBe('');
    expect(shortcutChar(key('Z', 'KeyZ', { shiftKey: true }))).toBe('');
    expect(shortcutChar(key('ー', 'Slash', { shiftKey: true }))).toBe('');
    expect(shortcutChar(key('z', 'KeyZ', { altKey: true }))).toBe('');
    expect(shortcutChar(key('Enter', 'Enter'))).toBe('');
    expect(shortcutChar(key('1', 'Digit1'))).toBe('');
  });

  it('gives each tool one key: Z moved off Formation, measure keys follow Z X C V B N M , . /', () => {
    expect(MEASURE_KEYS.join('')).toBe('zxcvbnm,./');
    expect(FORMATION_KEYS.join('')).toBe('asdfghjkl;');
    expect(FORMATION_KEYS).toHaveLength(FORMATION_TOOLS.length);
    expect(MEASURE_KEYS).toHaveLength(MEASURE_ITEMS.length);
    const all = [...TOOL_KEYS, ...FORMATION_KEYS, ...MEASURE_KEYS];
    expect(new Set(all).size).toBe(all.length);
    for (const k of all) expect(shortcutChar(key(k))).toBe(k);
  });
});
