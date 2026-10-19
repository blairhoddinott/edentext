// The chrome default is the ribbon; a stored choice wins, and the floating
// island's legacy stored name 'classic' still selects it. The accent survives a
// reload, preset or custom, and reaches the page's --brand-slate.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadChromeMode, saveChromeMode, loadAccent, saveAccent, applyAccent, type Accent } from '../../src/lib/storage/theme';

describe('chrome mode', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to the ribbon', () => {
    expect(loadChromeMode()).toBe('ribbon');
  });

  it('keeps a stored choice, the legacy name included', () => {
    saveChromeMode('modern');
    expect(loadChromeMode()).toBe('modern');
    localStorage.setItem('edentext-chrome', 'classic');
    expect(loadChromeMode()).toBe('modern');
  });
});

describe('accent', () => {
  beforeEach(() => localStorage.clear());

  it.each<[Accent, string | null]>([['slate', null], ['teal', 'teal'], ['#245bff', 'custom']])(
    'keeps %s across a reload and applies it', (accent, attr) => {
      saveAccent(accent);
      expect(loadAccent()).toBe(accent);
      applyAccent(loadAccent());
      const root = document.documentElement;
      expect(root.getAttribute('data-accent')).toBe(attr);
      expect(root.style.getPropertyValue('--brand-slate')).toBe(attr === 'custom' ? accent : '');
    });

  it('falls back to slate for an unreadable value', () => {
    localStorage.setItem('edentext-accent', '#12345');
    expect(loadAccent()).toBe('slate');
  });
});
