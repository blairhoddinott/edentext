// The right-click menu's contents (Word's text menu). Drives a real body editor so the
// entries are built against a live selection, exactly as Editor.svelte does.
import { describe, it, expect } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../../src/lib/editor/extensions';
import { buildContextMenu, type MenuEntry } from '../../src/lib/editor/contextMenuItems';
import { setAi } from '../../src/lib/storage/ai.svelte';

type N = any;

function makeEditor(content: N) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({ element: el, extensions, content });
}

const para = (text: string, marks?: N[]): N => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] }],
});

const labels = (entries: MenuEntry[]) =>
  entries.filter((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item').map((e) => e.label);

const item = (entries: MenuEntry[], label: string) =>
  entries.find((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && e.label === label);

describe('context menu items', () => {
  it('disables cut/copy without a selection and enables them with one', () => {
    const editor = makeEditor(para('Hello world'));
    editor.commands.setTextSelection(3);
    expect(item(buildContextMenu(editor), 'Cut')!.disabled).toBe(true);
    expect(item(buildContextMenu(editor), 'Copy')!.disabled).toBe(true);

    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(item(buildContextMenu(editor), 'Cut')!.disabled).toBe(false);
    expect(item(buildContextMenu(editor), 'Copy')!.disabled).toBe(false);
    editor.destroy();
  });

  it('shows spelling suggestions in the first section, above the clipboard', () => {
    const editor = makeEditor(para('Helo'));
    const plain = buildContextMenu(editor);
    expect(labels(plain)).not.toContain('Hello');

    const withSpell = buildContextMenu(editor, {
      spell: { suggestions: ['Hello', 'Halo'], onReplace: () => {}, onAdd: () => {}, onIgnore: () => {} },
    });
    const names = labels(withSpell);
    expect(names.slice(0, 2)).toEqual(['Hello', 'Halo']);
    expect(names.indexOf('Ignore All')).toBeLessThan(names.indexOf('Cut'));
    editor.destroy();
  });

  it('offers edit/remove only when the cursor sits in a link', () => {
    const editor = makeEditor(para('Hello'));
    expect(labels(buildContextMenu(editor))).toContain('Link…');
    expect(labels(buildContextMenu(editor))).not.toContain('Remove Link');

    const linked = makeEditor(para('Hello', [{ type: 'link', attrs: { href: 'https://example.com' } }]));
    linked.commands.setTextSelection(3);
    const names = labels(buildContextMenu(linked));
    expect(names).toContain('Edit Link…');
    expect(names).toContain('Remove Link');
    editor.destroy();
    linked.destroy();
  });

  it('clears direct formatting through its entry', () => {
    const editor = makeEditor(para('Hello'));
    editor.commands.setTextSelection({ from: 1, to: 6 });
    editor.commands.setFontSize('20pt');
    item(buildContextMenu(editor), 'Clear Formatting')!.run();
    expect(JSON.stringify(editor.getJSON())).not.toContain('20pt');
    editor.destroy();
  });

  it('groups the AI actions in a submenu, greyed with a hint while the assistant is off', () => {
    const editor = makeEditor(para('Hello world'));
    const aiSub = () => buildContextMenu(editor).find((e): e is Extract<MenuEntry, { kind: 'sub' }> => e.kind === 'sub');
    setAi({ enabled: false });
    expect(aiSub()!.disabled).toBe(true);
    expect(aiSub()!.title).toMatch(/Settings/);

    setAi({ enabled: true });
    expect(aiSub()!.disabled).toBe(false);
    editor.commands.setTextSelection(3);
    expect(item(aiSub()!.items, 'Shorten')!.disabled).toBe(true);
    expect(item(aiSub()!.items, 'Open chat')!.disabled).toBeFalsy();
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(item(aiSub()!.items, 'Shorten')!.disabled).toBe(false);
    editor.destroy();
  });
});
